// altimate_change start — OpenAI-compatible chat bridge for Open WebUI (OWUI).
//
// Exposes /v1/models and /v1/chat/completions (SSE) so any OpenAI client — most
// notably Open WebUI — can drive the altimate-code agent that is otherwise only
// reachable through the TUI. This is the sage equivalent of the Data-Agent-ADK
// `owui_client_v5.py` shim: it maps an OWUI chat to an altimate-code session,
// fires a single prompt turn, and translates the session event stream into
// OpenAI `chat.completion.chunk`s.
//
// Streamed chunks carry the same custom `message_type` tags that the ADK shim
// emits ("text", "tool call", "tool response") so the existing Open WebUI filter
// function renders tool activity identically. Reasoning parts stream as
// `delta.reasoning_content` for Open WebUI's native Thought collapsible.
//
// Configuration (env):
//   ALTIMATE_OWUI_PROJECT_DIR  Absolute path of the repo the agent operates on.
//                              Falls back to OPENCODE_PROJECT_DIR, the
//                              x-opencode-directory header, then process.cwd().
//   ALTIMATE_OWUI_OT_ROOT      If set, per-user Open Terminal workspace mode:
//                              project = $OT_ROOT/<sanitized-user-id>/altimate_context
//                              (seeded from ALTIMATE_OWUI_OT_SEED or $OT_ROOT/_skel).
//                              Host seed is never written. Requires Forward User Info.
//   ALTIMATE_OWUI_OT_SEED      Seed tree for per-user copies (default: $OT_ROOT/_skel).
//   ALTIMATE_OWUI_MODEL        Host /v1/models id when OT_ROOT unset (default "altimate-code").
//   ALTIMATE_OT_OWUI_MODEL     OT-mode /v1/models id when OT_ROOT set (default "altimate-ot").
//                              Host serve never advertises this id.
//   ALTIMATE_OWUI_AGENT        Agent to run (optional; uses the session default otherwise).
//                              When "analyst": /plan <q> → plan agent + gemini-3.6-flash;
//                              next msg without /plan prefix (or /execute) → analyst + flash-lite.
//   ALTIMATE_OWUI_PERMISSION   "approve" (default) auto-approves tool permission
//                              requests with reply "once"; anything else rejects.
//   ALTIMATE_OWUI_SESSION_MAP  Optional path for chat→session persistence
//                              (default: <$XDG_DATA_HOME>/altimate-code/owui-chat-sessions.json).
//   ALTIMATE_OWUI_SLASH_GROUP_IDS
//                              Comma-separated Open WebUI group ids (or names)
//                              allowed to use /model and /think. Empty = all
//                              builder/analyst users. Matched against body.user_groups /
//                              user_group_ids or X-OpenWebUI-User-Group-Ids.
import { Hono } from "hono"
import { streamSSE } from "hono/streaming"
import { lazy } from "../../util/lazy"
import { Log } from "../../util/log"
import { Session } from "../../session"
import { SessionPrompt } from "../../session/prompt"
import { PermissionNext } from "@/permission/next"
import { Bus } from "../../bus"
import { NamedError } from "@opencode-ai/core/util/error"
import { Instance } from "../../project/instance"
import { WorkspaceContext } from "../../control-plane/workspace-context"
import { InstanceBootstrap } from "../../project/bootstrap"
import { Filesystem } from "@/util/filesystem"
import type { SessionID } from "@/session/schema"
import type { QuestionID } from "@/question/schema"
import { Question } from "../../question"
import {
  deleteMappedSession,
  getMappedSession,
  setMappedSession,
} from "./owui-session-map"
import { clearSessionOverride, getSessionOverride, setSessionOverride } from "./owui-session-overrides"
import {
  MODEL_THINK_SLASH_DENIAL,
  collectOwuiGroupIds,
  formatGroupSlashDenial,
  allowsModelThinkSlash,
  isSlashGroupAllowed,
  parseOwuiSlashCommand,
} from "./owui-slash"
import { resolveAnalystPlanTurn } from "./owui-analyst-plan"
import { setOwuiTraceContext } from "./owui-trace-context"
import { makeOwuiWriter } from "./owui-sse"
import { ensureOtUserProject, resolveOtSeed } from "./owui-ot-workspace"
import { ModelID, ProviderID } from "../../provider/schema"

const log = Log.create({ service: "openai-bridge" })

// altimate_change start — pending question registry for OWUI sessions.
// When the agent calls AskUserQuestion, the OWUI turn ends with the question
// rendered as text. The user's next message is routed as the answer rather
// than as a new prompt.
const pendingOwuiQuestions = new Map<string, QuestionID>()

function formatQuestion(req: Question.Request): string {
  const parts: string[] = []
  for (const q of req.questions) {
    parts.push(`**${q.question}**`)
    if (q.options.length > 0) {
      for (const opt of q.options) {
        parts.push(`- **${opt.label}**: ${opt.description}`)
      }
    }
  }
  return parts.join("\n")
}
// altimate_change end

function modelID() {
  // OT serve (ALTIMATE_OWUI_OT_ROOT): only advertise the OT model id.
  // Host ./run.sh: only ALTIMATE_OWUI_MODEL — never altimate-ot.
  if ((process.env["ALTIMATE_OWUI_OT_ROOT"] || "").trim()) {
    return (process.env["ALTIMATE_OT_OWUI_MODEL"] || "altimate-ot").trim() || "altimate-ot"
  }
  const host = (process.env["ALTIMATE_OWUI_MODEL"] || "altimate-code").trim() || "altimate-code"
  const ot = (process.env["ALTIMATE_OT_OWUI_MODEL"] || "altimate-ot").trim() || "altimate-ot"
  if (host === ot) return "altimate-code"
  return host
}

/** Same as data-agent owui_client_v5: X-OpenWebUI-User-Email, else anonymous. */
function owuiUserId(c: { req: { header: (name: string) => string | undefined } }): string {
  const email = (c.req.header("x-openwebui-user-email") || "").trim()
  if (email) return email
  const name = (c.req.header("x-openwebui-user-name") || c.req.header("x-openwebui-user-id") || "").trim()
  if (name) return name
  return crypto.randomUUID()
}

/** Prefer stable id header (same value OWUI sends Open Terminal as X-User-Id). */
function owuiUserIdForOt(c: { req: { header: (name: string) => string | undefined } }): string {
  const id = (c.req.header("x-openwebui-user-id") || c.req.header("x-user-id") || "").trim()
  if (id) return id
  return owuiUserId(c)
}

function decode(value: string) {
  try {
    return decodeURIComponent(value)
  } catch {
    return value
  }
}

function resolveDirectory(
  c: { req: { header: (name: string) => string | undefined } },
  headerDir: string | undefined,
) {
  // Per-user OT workspace: $ALTIMATE_OWUI_OT_ROOT/<user>/altimate_context
  const otRoot = (process.env["ALTIMATE_OWUI_OT_ROOT"] || "").trim()
  if (otRoot) {
    const seed = resolveOtSeed(otRoot, (process.env["ALTIMATE_OWUI_OT_SEED"] || "").trim() || undefined)
    const project = ensureOtUserProject(otRoot, owuiUserIdForOt(c), seed)
    log.info("ot workspace", { user: owuiUserIdForOt(c), project })
    return Filesystem.resolve(project)
  }
  const raw =
    process.env["ALTIMATE_OWUI_PROJECT_DIR"] || process.env["OPENCODE_PROJECT_DIR"] || headerDir || process.cwd()
  return Filesystem.resolve(decode(raw))
}

function coerceContent(content: unknown): string {
  if (typeof content === "string") return content
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === "string") return part
        if (part && typeof part === "object" && "text" in part) return String((part as { text?: unknown }).text ?? "")
        return ""
      })
      .join("")
  }
  return ""
}

function lastUserMessage(messages: Array<{ role?: string; content?: unknown }>): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]
    if (m?.role === "user") return coerceContent(m.content).trim()
  }
  return ""
}

async function resolveSession(chatKey: string, firstMessage: string): Promise<SessionID> {
  // Disk-backed map so OWUI chats resume the same altimate session after
  // `run.sh` / serve restarts (session messages live in SQLite separately).
  const existing = getMappedSession(chatKey)
  if (existing) {
    const still = await Session.get(existing).catch(() => undefined)
    if (still) return existing
    deleteMappedSession(chatKey)
    clearSessionOverride(existing)
  }
  const title = firstMessage ? firstMessage.slice(0, 80) : "Open WebUI chat"
  const session = await Session.create({ title })
  setMappedSession(chatKey, session.id)
  return session.id
}

function assistantTextFromCommand(result: { parts: Array<{ type: string; text?: string }> }): string {
  return result.parts
    .filter((p): p is { type: "text"; text: string } => p.type === "text" && typeof p.text === "string")
    .map((p) => p.text)
    .join("")
}

type EmitKind = "text" | "reasoning" | "tool_call" | "tool_done"

function chunk(input: {
  id: string
  model: string
  author: string
  messageType: "text" | "reasoning" | "tool call" | "tool response"
  delta: Record<string, unknown>
  finishReason?: string | null
  overallDuration?: number
  streamComplete?: boolean
}) {
  const choice: Record<string, unknown> = {
    index: 0,
    delta: input.delta,
    finish_reason: input.finishReason ?? null,
  }
  // Completion sentinel fields the Open WebUI filter reads to render the
  // "Complete in Xs" status pill (mirrors the ADK shim contract).
  if (input.overallDuration !== undefined) choice["overall_duration"] = input.overallDuration
  if (input.streamComplete) choice["stream_complete"] = true
  return {
    id: input.id,
    object: "chat.completion.chunk",
    author: input.author,
    created: Math.floor(Date.now() / 1000),
    model: input.model,
    choices: [choice],
    message_type: input.messageType,
  }
}

/** OWUI often strips custom choice fields; the filter keys off this tool-call name. */
function executionCompleteChunk(input: { id: string; model: string; durationSec: number }) {
  return chunk({
    id: input.id,
    model: input.model,
    author: "tool call",
    messageType: "tool call",
    delta: {
      content: JSON.stringify({
        name: "Execution Complete",
        args: { duration: input.durationSec },
      }),
    },
  })
}

// altimate_change start — end-of-turn SQL recap
interface SqlStep {
  query: string
  warehouse?: string
  reason?: string
  failed: boolean
  /** Markdown table (or short note) of the first rows from the tool output. */
  preview?: string
}

const SQL_TOOLS = new Set(["sql_execute"])
const SQL_PREVIEW_ROWS = 10

function oneLine(value: string, limit = 70) {
  const text = value.split(/\s+/).filter(Boolean).join(" ")
  return text.length > limit ? text.slice(0, limit).trimEnd() + "..." : text
}

function sqlStepFromInput(input: unknown): SqlStep | undefined {
  if (!input || typeof input !== "object") return undefined
  const args = input as Record<string, unknown>
  const query = typeof args["query"] === "string" ? args["query"].trim() : ""
  if (!query) return undefined
  const warehouse = typeof args["warehouse"] === "string" ? args["warehouse"].trim() : undefined
  const reason = typeof args["reason"] === "string" ? args["reason"].trim() : undefined
  return { query, warehouse: warehouse || undefined, reason: reason || undefined, failed: false }
}

// Tool-call chunks go through the OWUI filter as JSON in delta.content. Shipping
// the full SQL there is unnecessary (Executed Queries is streamed at end-of-turn)
// and can break the filter when a large statement is truncated mid-SSE — the pill
// then silently disappears. Keep the status payload small and self-describing.
function extractEmbeds(metadata: unknown): string[] {
  if (!metadata || typeof metadata !== "object") return []
  const embeds = (metadata as { embeds?: unknown }).embeds
  if (!Array.isArray(embeds)) return []
  return embeds
    .map((item) => (typeof item === "string" ? item.trim() : ""))
    .filter((html) => html.length > 0)
}

function argsForOwui(tool: string, input: unknown): Record<string, unknown> {
  const args =
    input && typeof input === "object" ? { ...(input as Record<string, unknown>) } : ({} as Record<string, unknown>)
  if (tool === "plot_dataframe") {
    // Drop bulky row payloads / long SQL from status pills and SSE tool-call chunks.
    if (Array.isArray(args.data)) args.data = `[${args.data.length} rows]`
    if (typeof args.sql === "string" && args.sql.length > 120) {
      args.sql = `${args.sql.slice(0, 120)}…`
    }
    return args
  }
  if (tool !== "sql_execute") return args

  const reason = typeof args["reason"] === "string" ? args["reason"].trim() : ""
  const query = typeof args["query"] === "string" ? args["query"] : typeof args["sql"] === "string" ? args["sql"] : ""
  const warehouse = typeof args["warehouse"] === "string" ? args["warehouse"].trim() : ""
  const preview = reason || oneLine(query, 90)
  return {
    ...(reason ? { reason } : {}),
    ...(warehouse ? { warehouse } : {}),
    ...(query ? { query: oneLine(query, 120) } : {}),
    status_description: preview ? `🧮 Executing SQL | ${preview}` : "🧮 Executing SQL",
  }
}

function escapeMdCell(value: unknown): string {
  if (value === null || value === undefined) return "NULL"
  return String(value).replace(/\|/g, "\\|").replace(/\r?\n/g, " ")
}

/** Build a markdown table from row objects (first `limit` rows). */
function formatRecordsTable(records: Record<string, unknown>[], limit = SQL_PREVIEW_ROWS): string {
  if (records.length === 0) return "_(0 rows)_"
  const slice = records.slice(0, limit)
  const columns = Object.keys(slice[0] ?? {})
  if (columns.length === 0) return `_(${records.length} rows)_`
  const header = `| ${columns.join(" | ")} |`
  const sep = `| ${columns.map(() => "---").join(" | ")} |`
  const body = slice.map((row) => `| ${columns.map((c) => escapeMdCell(row[c])).join(" | ")} |`)
  let out = [header, sep, ...body].join("\n")
  if (records.length > limit) out += `\n\n_(showing first ${limit} of ${records.length} rows)_`
  return out
}

function escapeHtml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
}

/**
 * Pull the first N result rows from sql_execute tool output.
 * Prefers the trailing ```json records block; falls back to the ASCII table.
 */
function rowsPreviewFromOutput(output: unknown): string | undefined {
  if (typeof output !== "string" || !output.trim()) return undefined
  const text = output.trim()
  if (text === "(0 rows)" || /^\(0 rows\)/.test(text)) return "_(0 rows)_"

  const jsonMatch = text.match(/```json\n([\s\S]*?)\n```/)
  if (jsonMatch?.[1]) {
    try {
      const parsed = JSON.parse(jsonMatch[1]) as unknown
      if (Array.isArray(parsed) && parsed.every((row) => row && typeof row === "object" && !Array.isArray(row))) {
        return formatRecordsTable(parsed as Record<string, unknown>[])
      }
    } catch {
      // fall through to ASCII table
    }
  }

  const lines = text.split("\n")
  const headerIdx = lines.findIndex((line, i) => i + 1 < lines.length && /-\+-/.test(lines[i + 1] ?? ""))
  if (headerIdx < 0) return undefined
  const header = lines[headerIdx] ?? ""
  const data: string[] = []
  for (let i = headerIdx + 2; i < lines.length && data.length < SQL_PREVIEW_ROWS; i++) {
    const line = lines[i] ?? ""
    if (!line.trim() || /^\(\d+\s+rows?\)/.test(line.trim()) || line.startsWith("```")) break
    data.push(line)
  }
  if (data.length === 0) return "_(0 rows)_"
  const columns = header.split(" | ").map((c) => c.trim())
  const mdHeader = `| ${columns.join(" | ")} |`
  const mdSep = `| ${columns.map(() => "---").join(" | ")} |`
  const mdRows = data.map((line) => {
    const cells = line.split(" | ")
    return `| ${columns.map((_, i) => escapeMdCell(cells[i] ?? "")).join(" | ")} |`
  })
  let out = [mdHeader, mdSep, ...mdRows].join("\n")
  const countMatch = text.match(/\((\d+)\s+rows?\)/)
  const total = countMatch ? Number(countMatch[1]) : undefined
  if (total !== undefined && total > data.length) {
    out += `\n\n_(showing first ${data.length} of ${total} rows)_`
  }
  return out
}

// The recap is streamed as ordinary assistant text rather than pushed by the
// Open WebUI filter: clients persist the message from the accumulated stream
// deltas, so anything injected out-of-band is dropped when the turn is saved.
function renderSqlRecap(steps: SqlStep[]) {
  if (steps.length === 0) return ""

  const blocks = steps.map((step, index) => {
    const summary = escapeHtml(
      (step.reason || oneLine(step.query) || `Query ${index + 1}`) + (step.failed ? " (failed)" : ""),
    )
    let body = `\`\`\`sql\n${step.query}\n\`\`\``
    if (step.warehouse) body += `\n\n**Warehouse:** \`${step.warehouse}\``
    if (step.failed) {
      body += "\n\n_Query failed — no result rows._"
    } else if (step.preview) {
      body += `\n\n${step.preview}`
    }
    return `<details>\n<summary>${summary}</summary>\n\n${body}\n</details>`
  })

  return `\n\n<details>\n<summary>Executed Queries</summary>\n\n${blocks.join("\n\n")}\n</details>\n`
}
// altimate_change end

// Subscribe to the session event stream and translate it into OWUI-shaped
// events via `emit`. Returns a promise that resolves when the turn goes idle
// (or errors), plus an `unsubscribe` handle for client disconnects.
function consumeSession(input: {
  sessionID: SessionID
  sessionKey: string
  emit: (
    kind: EmitKind,
    payload: {
      content?: string
      name?: string
      args?: unknown
      duration?: number
      status?: "completed" | "error"
      error?: string
    },
  ) => void
  onError: (message: string) => void
}) {
  const { sessionID, sessionKey, emit, onError } = input
  const textParts = new Set<string>()
  const reasoningParts = new Set<string>()
  const deltaStreamedParts = new Set<string>()
  const finalizedTextParts = new Set<string>()
  const emittedToolCall = new Set<string>()
  const emittedToolDone = new Set<string>()
  // Executed SQL, in execution order, for the end-of-turn recap.
  const sqlSteps: SqlStep[] = []
  const sqlStepByCall = new Map<string, SqlStep>()
  // Deltas can race ahead of the part.updated that classifies a part as
  // text vs reasoning. Buffer until we know which emit kind to use.
  const pendingDeltas = new Map<string, string[]>()
  // Buffer assistant text until end-of-turn so an access denial can replace
  // fabricated analysis with the denial message alone.
  const bufferedText: string[] = []
  let accessDeniedMsg: string | undefined
  let sawActivity = false

  let resolveDone: () => void
  const done = new Promise<void>((resolve) => {
    resolveDone = resolve
  })

  const permissionMode = (process.env["ALTIMATE_OWUI_PERMISSION"] || "approve").toLowerCase()

  const queueText = (content: string) => {
    if (!content || accessDeniedMsg) return
    bufferedText.push(content)
  }

  const flushPending = (partID: string, kind: "text" | "reasoning") => {
    const buffered = pendingDeltas.get(partID)
    if (!buffered?.length) {
      pendingDeltas.delete(partID)
      return
    }
    pendingDeltas.delete(partID)
    for (const delta of buffered) {
      if (kind === "text") queueText(delta)
      else emit(kind, { content: delta })
    }
  }

  const flushText = () => {
    if (accessDeniedMsg) {
      emit("text", { content: accessDeniedMsg })
      return
    }
    for (const content of bufferedText) emit("text", { content })
  }

  const wasAccessDenied = () => Boolean(accessDeniedMsg)

  const unsubscribe = Bus.subscribeAll((event: { type: string; properties: any }) => {
    const props = event.properties ?? {}

    if (event.type === "message.part.delta") {
      if (props.sessionID !== sessionID || props.field !== "text") return
      sawActivity = true
      deltaStreamedParts.add(props.partID)
      if (!props.delta) return
      // Reasoning parts share field "text" deltas; map them to OWUI's native
      // reasoning_content so the Thought collapsible can render them.
      if (reasoningParts.has(props.partID)) {
        if (!accessDeniedMsg) emit("reasoning", { content: props.delta })
        return
      }
      if (textParts.has(props.partID)) {
        queueText(props.delta)
        return
      }
      const queue = pendingDeltas.get(props.partID) ?? []
      queue.push(props.delta)
      pendingDeltas.set(props.partID, queue)
      return
    }

    if (event.type === "message.part.updated") {
      const part = props.part
      if (!part || part.sessionID !== sessionID) return
      sawActivity = true

      if (part.type === "text") {
        textParts.add(part.id)
        flushPending(part.id, "text")
        if (part.time?.end && !deltaStreamedParts.has(part.id) && !finalizedTextParts.has(part.id)) {
          finalizedTextParts.add(part.id)
          const text = (part.text ?? "").trim()
          if (text) queueText(text)
        }
        return
      }

      if (part.type === "reasoning") {
        reasoningParts.add(part.id)
        flushPending(part.id, "reasoning")
        // Fallback when deltas were missed (e.g. subscriber attached mid-turn).
        if (part.time?.end && !deltaStreamedParts.has(part.id) && !finalizedTextParts.has(part.id)) {
          finalizedTextParts.add(part.id)
          const text = (part.text ?? "").trim()
          if (text && !accessDeniedMsg) emit("reasoning", { content: text })
        }
        return
      }

      if (part.type === "tool") {
        if (accessDeniedMsg) return
        const state = part.state ?? {}
        const trackSql = () => {
          if (accessDeniedMsg || !SQL_TOOLS.has(part.tool)) return
          const step = sqlStepFromInput(state.input)
          if (!step) return
          const existing = sqlStepByCall.get(part.callID)
          if (existing) {
            // The running state can carry a partially streamed input; the
            // completed state is authoritative.
            Object.assign(existing, step, { failed: existing.failed })
            return
          }
          sqlStepByCall.set(part.callID, step)
          sqlSteps.push(step)
        }
        if (state.status === "running" && !emittedToolCall.has(part.callID)) {
          emittedToolCall.add(part.callID)
          trackSql()
          emit("tool_call", { name: part.tool, args: argsForOwui(part.tool, state.input) })
          return
        }
        if ((state.status === "completed" || state.status === "error") && !emittedToolDone.has(part.callID)) {
          // Make sure a call chunk was emitted even if we missed the running state.
          if (!emittedToolCall.has(part.callID)) {
            emittedToolCall.add(part.callID)
            emit("tool_call", { name: part.tool, args: argsForOwui(part.tool, state.input) })
          }
          emittedToolDone.add(part.callID)
          trackSql()
          const start = state.time?.start
          const end = state.time?.end
          const duration = typeof start === "number" && typeof end === "number" ? (end - start) / 1000 : undefined
          // Tools like sql_execute report failures in their metadata rather than
          // by throwing, so a "completed" state can still be a failed call.
          const metadataError = state.metadata?.error
          const error =
            typeof state.error === "string" ? state.error : typeof metadataError === "string" ? metadataError : undefined
          // altimate_change start — domain access denial: stop turn, hide SQL recap
          const accessDenied =
            state.metadata?.accessDenied === true ||
            (typeof state.output === "string" && state.output.startsWith("Access denied:")) ||
            (typeof error === "string" && error.startsWith("Access denied:"))
          if (accessDenied) {
            accessDeniedMsg =
              (typeof state.output === "string" && state.output.startsWith("Access denied:")
                ? state.output
                : undefined) ||
              (typeof error === "string" ? error : undefined) ||
              "Access denied."
            sqlSteps.length = 0
            sqlStepByCall.clear()
            bufferedText.length = 0
            emit("tool_done", {
              name: part.tool,
              duration,
              status: "error",
              error: accessDeniedMsg,
            })
            SessionPrompt.cancel(sessionID).catch(() => {})
            resolveDone()
            return
          }
          // altimate_change end
          const step = sqlStepByCall.get(part.callID)
          if (step) {
            if (error) step.failed = true
            else if (state.status === "completed") {
              const preview = rowsPreviewFromOutput(state.output)
              if (preview) step.preview = preview
            }
          }
          emit("tool_done", {
            name: part.tool,
            duration,
            status: state.status === "error" || error ? "error" : "completed",
            error,
          })
          // Charts: plot_dataframe (and any tool) can put HTML in metadata.embeds.
          // Emit one silent "Rich UI Embed" tool-call per chart so each SSE line
          // stays under Open WebUI's aiohttp 128KiB limit (filter accumulates).
          if (state.status === "completed" && !error) {
            for (const html of extractEmbeds(state.metadata)) {
              emit("tool_call", { name: "Rich UI Embed", args: { embeds: [html] } })
            }
          }
          return
        }
      }
      return
    }

    if (event.type === "permission.asked") {
      if (props.sessionID !== sessionID) return
      const reply = permissionMode === "approve" ? "once" : "reject"
      PermissionNext.reply({ requestID: props.id, reply }).catch((err) =>
        log.error("permission reply failed", { error: err instanceof Error ? err.message : String(err) }),
      )
      return
    }

    // altimate_change start — surface follow-up questions to Open WebUI.
    // The agent blocks waiting for a reply; end the current SSE turn with the
    // question rendered as text so the user sees it, then route their next
    // message as the answer (handled at the top of /v1/chat/completions).
    if (event.type === "question.asked") {
      if (props.sessionID !== sessionID) return
      const req = props as Question.Request
      pendingOwuiQuestions.set(sessionKey, req.id)
      emit("text", { content: formatQuestion(req) })
      resolveDone()
      return
    }
    // altimate_change end

    if (event.type === "session.error") {
      if (props.sessionID && props.sessionID !== sessionID) return
      const err = props.error
      let message = "unknown error"
      if (err) {
        message = String(err.name ?? "error")
        if (err.data && typeof err.data === "object" && "message" in err.data) message = String(err.data.message)
      }
      onError(message)
      resolveDone()
      return
    }

    if (event.type === "session.status" && props.sessionID === sessionID) {
      const type = props.status?.type
      if (type === "busy") sawActivity = true
      if (type === "idle" && sawActivity) resolveDone()
      return
    }
  })

  // finish() force-resolves the turn. Used when the (blocking) prompt promise
  // settles, so a prompt that never reaches an "idle" status (e.g. it throws
  // before the run starts) cannot hang the SSE stream open forever.
  return { done, unsubscribe, finish: () => resolveDone(), sqlSteps, flushText, wasAccessDenied }
}

export const OpenAIRoutes = lazy(() =>
  new Hono()
    // Establish the altimate-code instance context (project directory + workspace)
    // before any handler runs. OWUI clients don't send x-opencode-directory, so the
    // directory comes from env. Mirrors the global directory middleware in server.ts.
    .use("/v1/*", async (c, next) => {
      const directory = resolveDirectory(c, c.req.header("x-opencode-directory"))
      return WorkspaceContext.provide({
        workspaceID: undefined,
        async fn() {
          return Instance.provide({
            directory,
            init: InstanceBootstrap,
            async fn() {
              return next()
            },
          })
        },
      })
    })
    .get("/v1/models", (c) => {
      const id = modelID()
      return c.json({
        object: "list",
        data: [{ id, object: "model", created: 1, owned_by: "altimate" }],
      })
    })
    .post("/v1/chat/completions", async (c) => {
      const body = await c.req.json().catch(() => ({}) as any)
      const messages: Array<{ role?: string; content?: unknown }> = Array.isArray(body?.messages) ? body.messages : []
      // Always advertise the portable's configured model id (builder vs analyst).
      const model = modelID()
      const wantStream = body?.stream !== false
      const agent = process.env["ALTIMATE_OWUI_AGENT"] || undefined

      const chatId = (c.req.header("x-openwebui-chat-id") || c.req.header("x-chat-id") || "").trim()
      const userId = owuiUserId(c)
      const userMessage = lastUserMessage(messages)

      const directory = Instance.directory
      // Include user (like data-agent session keying) so chats don't collide across users.
      const chatKey = `${directory}::${userId}::${chatId || crypto.randomUUID()}`

      if (!userMessage) {
        return c.json({
          id: "chatcmpl-altimate",
          object: "chat.completion",
          created: Math.floor(Date.now() / 1000),
          model,
          choices: [{ index: 0, message: { role: "assistant", content: "" }, finish_reason: "stop" }],
        })
      }

      const sessionID = await resolveSession(chatKey, userMessage)
      // Stash before firePrompt so TraceConsumer can attach user/model on first events.
      // altimate_change start — group access control: read group names injected by filter.py
      const userGroups: string[] = Array.isArray(body?.user_groups) ? body.user_groups : []
      // altimate_change end
      setOwuiTraceContext(sessionID, {
        userId,
        modelId: model,
        agent: agent || undefined,
        groups: userGroups,
      })
      const completionID = `chatcmpl-${sessionID}-${Date.now().toString(36)}`

      // altimate_change start — route user message as question answer when pending.
      const pendingQuestionID = pendingOwuiQuestions.get(chatKey)
      if (pendingQuestionID) {
        pendingOwuiQuestions.delete(chatKey)
        // Wait for the agent to finish processing the answer and produce output.
        const completionIDQ = `chatcmpl-${sessionID}-q-${Date.now().toString(36)}`
        if (!wantStream) {
          let text = ""
          let errored: string | undefined
          const { done, unsubscribe, finish, sqlSteps, flushText, wasAccessDenied } = consumeSession({
            sessionID,
            sessionKey: chatKey,
            emit: (kind, payload) => {
              if (kind === "text" && payload.content) text += payload.content
            },
            onError: (message) => { errored = message },
          })
          // Reply fires the agent; .finally(finish) ensures done resolves even if
          // session.status → idle races ahead of our subscription.
          Question.reply({ requestID: pendingQuestionID, answers: [[userMessage]] })
            .finally(finish)
            .catch((err) => log.error("question reply failed", { error: err instanceof Error ? err.message : String(err) }))
          try {
            await done
          } finally {
            unsubscribe()
          }
          flushText()
          const body = wasAccessDenied()
            ? text
            : (errored ? `${text}\n\n**Error:** ${errored}` : text) + renderSqlRecap(sqlSteps)
          return c.json({
            id: completionIDQ,
            object: "chat.completion",
            created: Math.floor(Date.now() / 1000),
            model,
            choices: [{ index: 0, message: { role: "assistant", content: body }, finish_reason: "stop" }],
          })
        }
        c.header("Cache-Control", "no-cache")
        c.header("Connection", "keep-alive")
        c.header("X-Accel-Buffering", "no")
        const startedAtQ = Date.now()
        return streamSSE(c, async (stream) => {
          const { write, flush } = makeOwuiWriter(stream, {
            warn: (msg, data) => log.warn(msg, data),
          })
          await write(chunk({ id: completionIDQ, model, author: "assistant", messageType: "text", delta: { role: "assistant" } }))
          const { done, unsubscribe, finish, sqlSteps, flushText, wasAccessDenied } = consumeSession({
            sessionID,
            sessionKey: chatKey,
            emit: (kind, payload) => {
              if (kind === "text" && payload.content) void write(chunk({ id: completionIDQ, model, author: "assistant", messageType: "text", delta: { content: payload.content } }))
              else if (kind === "reasoning" && payload.content) void write(chunk({ id: completionIDQ, model, author: "assistant", messageType: "reasoning", delta: { reasoning_content: payload.content } }))
              else if (kind === "tool_call") void write(chunk({ id: completionIDQ, model, author: "tool call", messageType: "tool call", delta: { content: JSON.stringify({ name: payload.name, args: payload.args ?? {} }) } }))
              else if (kind === "tool_done") void write(chunk({ id: completionIDQ, model, author: "tool done", messageType: "tool response", delta: { content: JSON.stringify({ name: payload.name, duration: payload.duration, status: payload.status, error: payload.error }) } }))
            },
            onError: (message) => { void write(chunk({ id: completionIDQ, model, author: "assistant", messageType: "text", delta: { content: `\n\n**Error:** ${message}` } })) },
          })
          stream.onAbort(() => { unsubscribe(); SessionPrompt.cancel(sessionID).catch(() => { }) })
          // Reply fires the agent; .finally(finish) mirrors firePrompt().finally(finish)
          // in the normal path — guards against session.status → idle racing ahead of
          // the Bus subscription so done always resolves and the sentinel is emitted.
          Question.reply({ requestID: pendingQuestionID, answers: [[userMessage]] })
            .finally(finish)
            .catch((err) => log.error("question reply failed", { error: err instanceof Error ? err.message : String(err) }))
          try {
            await done
          } finally {
            unsubscribe()
          }
          await flush()
          flushText()
          if (!wasAccessDenied()) {
            const recap = renderSqlRecap(sqlSteps)
            if (recap) await write(chunk({ id: completionIDQ, model, author: "assistant", messageType: "text", delta: { content: recap } }))
          }
          const durationQ = (Date.now() - startedAtQ) / 1000
          // Content-based completion signal — survives OWUI stripping custom choice fields.
          await write(executionCompleteChunk({ id: completionIDQ, model, durationSec: durationQ }))
          await write(chunk({ id: completionIDQ, model, author: "assistant", messageType: "text", delta: {}, finishReason: "stop", overallDuration: durationQ, streamComplete: true }))
          await flush()
          await stream.writeSSE({ data: "[DONE]" })
        })
      }
      // altimate_change end

      // altimate_change start — builder/analyst /model and /think (no LLM turn)
      const slash = parseOwuiSlashCommand(userMessage)
      if (slash) {
        let text: string
        try {
          if (!allowsModelThinkSlash(agent)) {
            text =
              `${MODEL_THINK_SLASH_DENIAL}\n\n` +
              `This serve process has \`ALTIMATE_OWUI_AGENT=${agent || "(unset)"}\`. ` +
              `Set it to \`builder\` or \`analyst\` and restart.`
          } else {
            const headerNames: string[] = []
            try {
              // hono RawRequest may expose headers via entries
              const raw = (c.req.raw as Request | undefined)?.headers
              if (raw) for (const [k] of raw.entries()) headerNames.push(k)
            } catch {
              // ignore
            }
            const groups = collectOwuiGroupIds({
              body: body && typeof body === "object" ? (body as Record<string, unknown>) : undefined,
              header: (name) => c.req.header(name),
              headerNames,
            })
            log.info("owui slash gate", {
              command: slash.command,
              agent,
              groups,
              allowlistSet: Boolean(process.env["ALTIMATE_OWUI_SLASH_GROUP_IDS"]?.trim()),
              bodyKeys: body && typeof body === "object" ? Object.keys(body) : [],
              groupHeaders: headerNames.filter((n) => /group/i.test(n)),
            })
            if (!isSlashGroupAllowed(groups)) {
              text = formatGroupSlashDenial({ received: groups })
            } else {
              const result = await SessionPrompt.command({
                sessionID,
                agent: agent!,
                command: slash.command,
                arguments: slash.arguments,
              })
              text = assistantTextFromCommand(result) || "Done."
            }
          }
        } catch (err) {
          text = `**Error:** ${err instanceof Error ? err.message : String(err)}`
          log.error("slash command failed", { sessionID, command: slash.command, error: text })
        }

        if (!wantStream) {
          return c.json({
            id: completionID,
            object: "chat.completion",
            created: Math.floor(Date.now() / 1000),
            model,
            choices: [
              {
                index: 0,
                message: { role: "assistant", content: text },
                finish_reason: "stop",
              },
            ],
          })
        }

        c.header("Cache-Control", "no-cache")
        c.header("Connection", "keep-alive")
        c.header("X-Accel-Buffering", "no")
        const startedAtSlash = Date.now()
        return streamSSE(c, async (stream) => {
          const { write, flush } = makeOwuiWriter(stream, {
            warn: (msg, data) => log.warn(msg, data),
          })
          await write(
            chunk({
              id: completionID,
              model,
              author: "assistant",
              messageType: "text",
              delta: { role: "assistant" },
            }),
          )
          if (text) {
            await write(
              chunk({
                id: completionID,
                model,
                author: "assistant",
                messageType: "text",
                delta: { content: text },
              }),
            )
          }
          const durationSlash = (Date.now() - startedAtSlash) / 1000
          await write(executionCompleteChunk({ id: completionID, model, durationSec: durationSlash }))
          await write(
            chunk({
              id: completionID,
              model,
              author: "assistant",
              messageType: "text",
              delta: {},
              finishReason: "stop",
              overallDuration: durationSlash,
              streamComplete: true,
            }),
          )
          await flush()
          await stream.writeSSE({ data: "[DONE]" })
        })
      }
      // altimate_change end

      // altimate_change start — analyst explicit /plan → plan@flash, /execute → analyst@flite
      let promptAgent = agent
      let promptText = userMessage
      let phaseStatus: string | undefined
      const planTurn = resolveAnalystPlanTurn({
        agent,
        userMessage,
        phase: getSessionOverride(sessionID)?.phase,
      })
      if (planTurn.kind === "help") {
        const help = planTurn.text
        if (!wantStream) {
          return c.json({
            id: completionID,
            object: "chat.completion",
            created: Math.floor(Date.now() / 1000),
            model,
            choices: [{ index: 0, message: { role: "assistant", content: help }, finish_reason: "stop" }],
          })
        }
        c.header("Cache-Control", "no-cache")
        c.header("Connection", "keep-alive")
        c.header("X-Accel-Buffering", "no")
        const startedHelp = Date.now()
        return streamSSE(c, async (stream) => {
          const { write, flush } = makeOwuiWriter(stream, {
            warn: (msg, data) => log.warn(msg, data),
          })
          await write(chunk({ id: completionID, model, author: "assistant", messageType: "text", delta: { role: "assistant" } }))
          await write(chunk({ id: completionID, model, author: "assistant", messageType: "text", delta: { content: help } }))
          const dur = (Date.now() - startedHelp) / 1000
          await write(executionCompleteChunk({ id: completionID, model, durationSec: dur }))
          await write(
            chunk({
              id: completionID,
              model,
              author: "assistant",
              messageType: "text",
              delta: {},
              finishReason: "stop",
              overallDuration: dur,
              streamComplete: true,
            }),
          )
          await flush()
          await stream.writeSSE({ data: "[DONE]" })
        })
      }
      if (planTurn.kind === "prompt") {
        const ov = getSessionOverride(sessionID)
        // Sticky /model during plan follow-ups: keep existing model if set.
        const modelPatch =
          planTurn.phase === "plan" && ov?.model && !planTurn.statusLine ? undefined : planTurn.model
        setSessionOverride(sessionID, {
          phase: planTurn.phase,
          ...(modelPatch ? { model: modelPatch } : {}),
        })
        promptAgent = planTurn.agent
        promptText = planTurn.promptText
        phaseStatus = planTurn.statusLine
        log.info("owui analyst plan turn", {
          sessionID,
          agent: promptAgent,
          phase: planTurn.phase,
          transition: Boolean(planTurn.statusLine),
        })
      }
      // altimate_change end

      const firePrompt = () => {
        const ov = getSessionOverride(sessionID)
        return SessionPrompt.prompt({
          sessionID,
          agent: promptAgent,
          model: ov?.model
            ? {
                providerID: ProviderID.make(ov.model.providerID),
                modelID: ModelID.make(ov.model.modelID),
              }
            : undefined,
          variant: ov?.variant,
          parts: [{ type: "text", text: promptText }],
        }).catch((err) => {
          log.error("prompt failed", { sessionID, error: err instanceof Error ? err.message : String(err) })
          Bus.publish(Session.Event.Error, {
            sessionID,
            error: new NamedError.Unknown({ message: err instanceof Error ? err.message : String(err) }).toObject(),
          }).catch(() => { })
        })
      }

      if (!wantStream) {
        // Non-streaming: buffer assistant text and return a single completion.
        let text = phaseStatus ? `${phaseStatus}\n\n` : ""
        let errored: string | undefined
        const { done, unsubscribe, finish, sqlSteps, flushText, wasAccessDenied } = consumeSession({
          sessionID,
          sessionKey: chatKey,
          emit: (kind, payload) => {
            if (kind === "text" && payload.content) text += payload.content
          },
          onError: (message) => {
            errored = message
          },
        })
        try {
          firePrompt().finally(finish)
          await done
        } finally {
          unsubscribe()
        }
        flushText()
        const body = wasAccessDenied()
          ? text
          : (errored ? `${text}\n\n**Error:** ${errored}` : text) + renderSqlRecap(sqlSteps)
        return c.json({
          id: completionID,
          object: "chat.completion",
          created: Math.floor(Date.now() / 1000),
          model,
          choices: [
            {
              index: 0,
              message: {
                role: "assistant",
                content: body,
              },
              finish_reason: "stop",
            },
          ],
        })
      }

      c.header("Cache-Control", "no-cache")
      c.header("Connection", "keep-alive")
      c.header("X-Accel-Buffering", "no")
      const startedAt = Date.now()
      return streamSSE(c, async (stream) => {
        const { write, flush } = makeOwuiWriter(stream, {
          warn: (msg, data) => log.warn(msg, data),
        })

        // Initial assistant role delta.
        await write(
          chunk({
            id: completionID,
            model,
            author: "assistant",
            messageType: "text",
            delta: { role: "assistant" },
          }),
        )
        if (phaseStatus) {
          await write(
            chunk({
              id: completionID,
              model,
              author: "assistant",
              messageType: "text",
              delta: { content: `${phaseStatus}\n\n` },
            }),
          )
        }

        const { done, unsubscribe, finish, sqlSteps, flushText, wasAccessDenied } = consumeSession({
          sessionID,
          sessionKey: chatKey,
          emit: (kind, payload) => {
            if (kind === "text" && payload.content) {
              void write(
                chunk({
                  id: completionID,
                  model,
                  author: "assistant",
                  messageType: "text",
                  delta: { content: payload.content },
                }),
              )
              return
            }
            if (kind === "reasoning" && payload.content) {
              void write(
                chunk({
                  id: completionID,
                  model,
                  author: "assistant",
                  messageType: "reasoning",
                  delta: { reasoning_content: payload.content },
                }),
              )
              return
            }
            if (kind === "tool_call") {
              void write(
                chunk({
                  id: completionID,
                  model,
                  author: "tool call",
                  messageType: "tool call",
                  delta: { content: JSON.stringify({ name: payload.name, args: payload.args ?? {} }) },
                }),
              )
              return
            }
            if (kind === "tool_done") {
              void write(
                chunk({
                  id: completionID,
                  model,
                  author: "tool done",
                  messageType: "tool response",
                  delta: {
                    content: JSON.stringify({
                      name: payload.name,
                      duration: payload.duration,
                      status: payload.status,
                      error: payload.error,
                    }),
                  },
                }),
              )
              return
            }
          },
          onError: (message) => {
            void write(
              chunk({
                id: completionID,
                model,
                author: "assistant",
                messageType: "text",
                delta: { content: `\n\n**Error:** ${message}` },
              }),
            )
          },
        })

        stream.onAbort(() => {
          unsubscribe()
          SessionPrompt.cancel(sessionID).catch(() => { })
        })

        try {
          firePrompt().finally(finish)
          await done
        } finally {
          unsubscribe()
        }
        await flush()

        // Flush buffered assistant text (or the access-denial message alone).
        // Executed Queries is skipped entirely on domain access denial.
        flushText()
        if (!wasAccessDenied()) {
          // Stream the Executed Queries recap as ordinary assistant text BEFORE the
          // completion sentinel. Open WebUI rebuilds the saved message from
          // accumulated stream deltas / output items, so anything pushed only via
          // the filter's event emitter is wiped when the turn finishes.
          const recap = renderSqlRecap(sqlSteps)
          if (recap) {
            await write(
              chunk({
                id: completionID,
                model,
                author: "assistant",
                messageType: "text",
                delta: { content: recap },
              }),
            )
          }
        }

        // Completion pill: emit a silent tool-call first. Open WebUI often strips
        // custom choice fields (stream_complete / overall_duration) before the
        // filter's stream() hook sees them, so content-based detection is reliable
        // (same pattern as data-agent "Plan Execution Complete").
        const durationSec = (Date.now() - startedAt) / 1000
        await write(executionCompleteChunk({ id: completionID, model, durationSec }))

        // Final finish chunk + OpenAI stream terminator (backup sentinel).
        await write(
          chunk({
            id: completionID,
            model,
            author: "assistant",
            messageType: "text",
            delta: {},
            finishReason: "stop",
            overallDuration: durationSec,
            streamComplete: true,
          }),
        )
        await flush()
        await stream.writeSSE({ data: "[DONE]" })
      })
    }),
)
// altimate_change end
