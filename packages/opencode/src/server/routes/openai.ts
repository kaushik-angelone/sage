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
// function renders tool activity identically.
//
// Configuration (env):
//   ALTIMATE_OWUI_PROJECT_DIR  Absolute path of the repo the agent operates on.
//                              Falls back to OPENCODE_PROJECT_DIR, the
//                              x-opencode-directory header, then process.cwd().
//   ALTIMATE_OWUI_MODEL        Model id advertised on /v1/models (default "altimate-code").
//   ALTIMATE_OWUI_AGENT        Agent to run (optional; uses the session default otherwise).
//   ALTIMATE_OWUI_PERMISSION   "approve" (default) auto-approves tool permission
//                              requests with reply "once"; anything else rejects.
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

const log = Log.create({ service: "openai-bridge" })

function modelID() {
  return process.env["ALTIMATE_OWUI_MODEL"] || "altimate-code"
}

function decode(value: string) {
  try {
    return decodeURIComponent(value)
  } catch {
    return value
  }
}

function resolveDirectory(headerDir: string | undefined) {
  const raw =
    process.env["ALTIMATE_OWUI_PROJECT_DIR"] || process.env["OPENCODE_PROJECT_DIR"] || headerDir || process.cwd()
  return Filesystem.resolve(decode(raw))
}

// chatKey -> sessionID. Keeps an Open WebUI conversation pinned to one
// altimate-code session so multi-turn context is preserved. Sessions are
// persisted by altimate-code itself; this map only survives the server process,
// which is enough since OWUI sends the same chat id on every turn.
const chatSessions = new Map<string, SessionID>()

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
  const existing = chatSessions.get(chatKey)
  if (existing) {
    const still = await Session.get(existing).catch(() => undefined)
    if (still) return existing
    chatSessions.delete(chatKey)
  }
  const title = firstMessage ? firstMessage.slice(0, 80) : "Open WebUI chat"
  const session = await Session.create({ title })
  chatSessions.set(chatKey, session.id)
  return session.id
}

type EmitKind = "text" | "tool_call" | "tool_done"

function chunk(input: {
  id: string
  model: string
  author: string
  messageType: "text" | "tool call" | "tool response"
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

// Subscribe to the session event stream and translate it into OWUI-shaped
// events via `emit`. Returns a promise that resolves when the turn goes idle
// (or errors), plus an `unsubscribe` handle for client disconnects.
function consumeSession(input: {
  sessionID: SessionID
  emit: (kind: EmitKind, payload: { content?: string; name?: string; args?: unknown; duration?: number }) => void
  onError: (message: string) => void
}) {
  const { sessionID, emit, onError } = input
  const textParts = new Set<string>()
  const reasoningParts = new Set<string>()
  const deltaStreamedParts = new Set<string>()
  const finalizedTextParts = new Set<string>()
  const emittedToolCall = new Set<string>()
  const emittedToolDone = new Set<string>()
  let sawActivity = false

  let resolveDone: () => void
  const done = new Promise<void>((resolve) => {
    resolveDone = resolve
  })

  const permissionMode = (process.env["ALTIMATE_OWUI_PERMISSION"] || "approve").toLowerCase()

  const unsubscribe = Bus.subscribeAll((event: { type: string; properties: any }) => {
    const props = event.properties ?? {}

    if (event.type === "message.part.delta") {
      if (props.sessionID !== sessionID || props.field !== "text") return
      if (reasoningParts.has(props.partID)) return // don't stream chain-of-thought
      sawActivity = true
      deltaStreamedParts.add(props.partID)
      if (props.delta) emit("text", { content: props.delta })
      return
    }

    if (event.type === "message.part.updated") {
      const part = props.part
      if (!part || part.sessionID !== sessionID) return
      sawActivity = true

      if (part.type === "text") {
        textParts.add(part.id)
        if (part.time?.end && !deltaStreamedParts.has(part.id) && !finalizedTextParts.has(part.id)) {
          finalizedTextParts.add(part.id)
          const text = (part.text ?? "").trim()
          if (text) emit("text", { content: text })
        }
        return
      }

      if (part.type === "reasoning") {
        reasoningParts.add(part.id)
        return
      }

      if (part.type === "tool") {
        const state = part.state ?? {}
        if (state.status === "running" && !emittedToolCall.has(part.callID)) {
          emittedToolCall.add(part.callID)
          emit("tool_call", { name: part.tool, args: state.input ?? {} })
          return
        }
        if ((state.status === "completed" || state.status === "error") && !emittedToolDone.has(part.callID)) {
          // Make sure a call chunk was emitted even if we missed the running state.
          if (!emittedToolCall.has(part.callID)) {
            emittedToolCall.add(part.callID)
            emit("tool_call", { name: part.tool, args: state.input ?? {} })
          }
          emittedToolDone.add(part.callID)
          const start = state.time?.start
          const end = state.time?.end
          const duration = typeof start === "number" && typeof end === "number" ? (end - start) / 1000 : undefined
          emit("tool_done", { name: part.tool, duration })
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

    if (event.type === "session.error") {
      if (props.sessionID && props.sessionID !== sessionID) return
      const err = props.error
      let message = "unknown error"
      if (err) {
        message = String(err.name ?? "error")
        if (err.data && typeof err.data === "object" && "message" in err.data) message = String(err.data.message)
      }
      onError(message)
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
  return { done, unsubscribe, finish: () => resolveDone() }
}

export const OpenAIRoutes = lazy(() =>
  new Hono()
    // Establish the altimate-code instance context (project directory + workspace)
    // before any handler runs. OWUI clients don't send x-opencode-directory, so the
    // directory comes from env. Mirrors the global directory middleware in server.ts.
    .use("/v1/*", async (c, next) => {
      const directory = resolveDirectory(c.req.header("x-opencode-directory"))
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
      const model = typeof body?.model === "string" && body.model ? body.model : modelID()
      const wantStream = body?.stream !== false
      const agent = process.env["ALTIMATE_OWUI_AGENT"] || undefined

      const chatId = (c.req.header("x-openwebui-chat-id") || c.req.header("x-chat-id") || "").trim()
      const userMessage = lastUserMessage(messages)

      const directory = Instance.directory
      const chatKey = `${directory}::${chatId || crypto.randomUUID()}`

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
      const completionID = `chatcmpl-${sessionID}`

      const firePrompt = () =>
        SessionPrompt.prompt({
          sessionID,
          agent,
          parts: [{ type: "text", text: userMessage }],
        }).catch((err) => {
          log.error("prompt failed", { sessionID, error: err instanceof Error ? err.message : String(err) })
          Bus.publish(Session.Event.Error, {
            sessionID,
            error: new NamedError.Unknown({ message: err instanceof Error ? err.message : String(err) }).toObject(),
          }).catch(() => {})
        })

      if (!wantStream) {
        // Non-streaming: buffer assistant text and return a single completion.
        let text = ""
        let errored: string | undefined
        const { done, unsubscribe, finish } = consumeSession({
          sessionID,
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
        return c.json({
          id: completionID,
          object: "chat.completion",
          created: Math.floor(Date.now() / 1000),
          model,
          choices: [
            {
              index: 0,
              message: { role: "assistant", content: errored ? `${text}\n\n**Error:** ${errored}` : text },
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
        const write = (obj: unknown) => stream.writeSSE({ data: JSON.stringify(obj) })

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

        const { done, unsubscribe, finish } = consumeSession({
          sessionID,
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
                  delta: { content: JSON.stringify({ name: payload.name, duration: payload.duration }) },
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
          SessionPrompt.cancel(sessionID).catch(() => {})
        })

        try {
          firePrompt().finally(finish)
          await done
        } finally {
          unsubscribe()
        }

        // Final finish chunk + OpenAI stream terminator. Carries the total turn
        // duration + stream_complete so the OWUI filter can show a completion pill.
        await write(
          chunk({
            id: completionID,
            model,
            author: "assistant",
            messageType: "text",
            delta: {},
            finishReason: "stop",
            overallDuration: (Date.now() - startedAt) / 1000,
            streamComplete: true,
          }),
        )
        await stream.writeSSE({ data: "[DONE]" })
      })
    }),
)
// altimate_change end
