/**
 * Langfuse exporter for Altimate session traces.
 *
 * Mirrors data-agent-repo env semantics:
 *   LANGFUSE_PUBLIC_KEY / LANGFUSE_SECRET_KEY / LANGFUSE_HOST
 *   DISABLE_LANGFUSE = 1|true|yes|on → off (unset → enabled when keys present)
 *
 * Exports finalized TraceFile payloads via Langfuse's public ingestion API:
 *   POST {LANGFUSE_HOST}/api/public/ingestion
 *   Basic auth: publicKey:secretKey
 *
 * One Langfuse *trace row* per user message (turn). All turns share
 * `sessionId = altimate session id` so the Langfuse Sessions tab aggregates them.
 */
import { randomUUIDv7 } from "bun"
import { Log } from "@/altimate/util/log"
import type { TraceExporter, TraceFile, TraceSpan } from "./tracing"

const log = Log.create({ service: "langfuse" })

function envTruthyDisable(raw: string | undefined): boolean {
  if (raw == null) return false
  return ["1", "true", "yes", "on"].includes(raw.trim().toLowerCase())
}

function envTrim(name: string): string | undefined {
  const raw = process.env[name]?.trim()
  if (!raw) return undefined
  // dotenv / shell exports often quote values: LANGFUSE_HOST="http://..."
  return raw.replace(/^["']|["']$/g, "")
}

/** Same gate as data-agent `DISABLE_LANGFUSE` + require keys/host. */
export function isLangfuseEnabled(): boolean {
  if (envTruthyDisable(process.env["DISABLE_LANGFUSE"])) return false
  return Boolean(envTrim("LANGFUSE_PUBLIC_KEY") && envTrim("LANGFUSE_SECRET_KEY") && envTrim("LANGFUSE_HOST"))
}

function toIso(ms: number | undefined, fallback: string): string {
  if (typeof ms === "number" && Number.isFinite(ms)) return new Date(ms).toISOString()
  return fallback
}

function eventEnvelope(type: string, body: Record<string, unknown>, timestamp: string) {
  return {
    id: randomUUIDv7(),
    type,
    timestamp,
    body,
  }
}

function userText(span: TraceSpan): string {
  if (typeof span.input === "string") return span.input
  if (typeof span.output === "string") return span.output
  return ""
}

type Turn = {
  /** Stable Langfuse trace id for this user message. */
  turnTraceId: string
  userSpan: TraceSpan | null
  input: string
  spans: TraceSpan[]
  startedAt: string
  endedAt: string
}

/** Split a session TraceFile into one Langfuse turn per user-message span. */
export function splitTraceIntoTurns(trace: TraceFile): Turn[] {
  const startedAt = trace.startedAt
  const endedAt = trace.endedAt ?? startedAt
  const spans = [...trace.spans].sort((a, b) => a.startTime - b.startTime)
  const userMsgs = spans.filter((s) => s.kind === "user-message")

  if (userMsgs.length === 0) {
    // Single-turn / legacy traces without user-message spans.
    const bodySpans = spans.filter((s) => s.kind !== "session")
    return [
      {
        turnTraceId: `turn-${trace.sessionId}-${trace.traceId}`,
        userSpan: null,
        input: trace.metadata.prompt ?? "",
        spans: bodySpans,
        startedAt,
        endedAt,
      },
    ]
  }

  return userMsgs.map((um, i) => {
    const nextStart = userMsgs[i + 1]?.startTime
    const turnSpans = spans.filter(
      (s) =>
        s.kind !== "session" &&
        s.kind !== "user-message" &&
        s.startTime >= um.startTime &&
        (nextStart == null || s.startTime < nextStart),
    )
    const turnEndMs = Math.max(
      um.endTime ?? um.startTime,
      ...turnSpans.map((s) => s.endTime ?? s.startTime),
      um.startTime,
    )
    return {
      turnTraceId: `turn-${trace.sessionId}-${um.spanId}`,
      userSpan: um,
      input: userText(um) || trace.metadata.prompt || "",
      spans: turnSpans,
      startedAt: toIso(um.startTime, startedAt),
      endedAt: toIso(turnEndMs, endedAt),
    }
  })
}

function turnOutput(turn: Turn): unknown {
  const lastText = [...turn.spans].reverse().find((s) => s.kind === "text" && s.output != null)
  if (lastText?.output != null) return lastText.output
  const lastGen = [...turn.spans].reverse().find((s) => s.kind === "generation" && s.output != null)
  return lastGen?.output
}

function turnName(turn: Turn, fallbackTitle?: string): string {
  const text = turn.input.trim()
  if (text) return text.length > 80 ? `${text.slice(0, 80)}…` : text
  return fallbackTitle || "altimate_turn"
}

/** Map Altimate TraceFile → Langfuse ingestion batch (one trace per user turn). */
export function traceFileToLangfuseBatch(trace: TraceFile): Record<string, unknown>[] {
  const batch: Record<string, unknown>[] = []
  const turns = splitTraceIntoTurns(trace)
  const spanIdsInTurn = (turn: Turn) => new Set(turn.spans.map((s) => s.spanId))

  for (const turn of turns) {
    const ids = spanIdsInTurn(turn)
    batch.push(
      eventEnvelope(
        "trace-create",
        {
          id: turn.turnTraceId,
          name: turnName(turn, trace.metadata.title),
          // Shared across turns → Langfuse Sessions tab aggregates the conversation.
          sessionId: trace.sessionId,
          userId: trace.metadata.userId,
          input: turn.input || undefined,
          output: turnOutput(turn) ?? undefined,
          metadata: {
            runner_app: "altimate",
            agent: trace.metadata.agent,
            model: trace.metadata.owuiModel || trace.metadata.model,
            llmModel: trace.metadata.owuiModel ? trace.metadata.model : undefined,
            owuiModel: trace.metadata.owuiModel,
            providerId: trace.metadata.providerId,
            environment: trace.metadata.environment,
            version: trace.metadata.version,
            altimateTraceId: trace.traceId,
            turnSpanId: turn.userSpan?.spanId,
          },
          tags: trace.metadata.tags,
          timestamp: turn.startedAt,
        },
        turn.startedAt,
      ),
    )

    for (const span of turn.spans) {
      // Drop parent link if parent isn't in this turn (e.g. session root).
      const parent =
        span.parentSpanId && ids.has(span.parentSpanId) ? span.parentSpanId : undefined
      batch.push(...spanToEvents(turn.turnTraceId, span, turn.startedAt, turn.endedAt, parent))
    }
  }

  return batch
}

function spanToEvents(
  traceId: string,
  span: TraceSpan,
  traceStart: string,
  traceEnd: string,
  parentObservationId?: string,
): Record<string, unknown>[] {
  const startTime = toIso(span.startTime, traceStart)
  const endTime = toIso(span.endTime ?? span.startTime, span.endTime ? traceEnd : startTime)
  const level = span.status === "error" ? "ERROR" : "DEFAULT"
  const statusMessage = span.statusMessage

  if (span.kind === "generation") {
    const usage =
      span.tokens != null
        ? {
            input: span.tokens.input,
            output: span.tokens.output,
            total: span.tokens.total,
            unit: "TOKENS",
          }
        : undefined
    return [
      eventEnvelope(
        "generation-create",
        {
          id: span.spanId,
          traceId,
          parentObservationId,
          name: span.name,
          startTime,
          endTime,
          input: span.input,
          output: span.output,
          model: span.model?.modelId,
          modelParameters: span.model?.variant ? { variant: span.model.variant } : undefined,
          usage,
          metadata: {
            providerId: span.model?.providerId,
            finishReason: span.finishReason,
            cost: span.cost,
            interrupted: span.interrupted,
            ...(span.attributes ?? {}),
          },
          level,
          statusMessage,
        },
        startTime,
      ),
    ]
  }

  const name = span.kind === "tool" && span.tool?.callId ? span.name : span.name

  return [
    eventEnvelope(
      "span-create",
      {
        id: span.spanId,
        traceId,
        parentObservationId,
        name,
        startTime,
        endTime,
        input: span.input,
        output: span.output,
        metadata: {
          kind: span.kind,
          tool: span.tool,
          interrupted: span.interrupted,
          ...(span.attributes ?? {}),
        },
        level,
        statusMessage,
      },
      startTime,
    ),
  ]
}

export class LangfuseExporter implements TraceExporter {
  readonly name = "langfuse"
  /** Push mid-session on idle — serve/OWUI never finalizes until shutdown. */
  readonly live = true
  private readonly endpoint: string
  private readonly authHeader: string

  constructor(input: { publicKey: string; secretKey: string; host: string }) {
    const host = input.host.replace(/\/+$/, "")
    this.endpoint = `${host}/api/public/ingestion`
    this.authHeader = `Basic ${Buffer.from(`${input.publicKey}:${input.secretKey}`).toString("base64")}`
  }

  async export(trace: TraceFile): Promise<string | undefined> {
    const batch = traceFileToLangfuseBatch(trace)
    const turnCount = batch.filter((e) => e.type === "trace-create").length
    try {
      const res = await fetch(this.endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: this.authHeader,
        },
        body: JSON.stringify({ batch, metadata: { sdk: "altimate-langfuse-exporter" } }),
        signal: AbortSignal.timeout(10_000),
      })
      if (!res.ok) {
        const body = await res.text().catch(() => "")
        log.warn("langfuse export failed", { status: res.status, body: body.slice(0, 300) })
        return undefined
      }
      log.info("langfuse export ok", {
        events: batch.length,
        turns: turnCount,
        sessionId: trace.sessionId,
      })
      return `langfuse: exported ${turnCount} turn(s), ${batch.length} events`
    } catch (error) {
      log.warn("langfuse export error", {
        error: error instanceof Error ? error.message : String(error),
      })
      return undefined
    }
  }
}

/** Build exporter from env, or undefined when disabled / incomplete. */
export function createLangfuseExporterFromEnv(): LangfuseExporter | undefined {
  if (!isLangfuseEnabled()) return undefined
  return new LangfuseExporter({
    publicKey: envTrim("LANGFUSE_PUBLIC_KEY")!,
    secretKey: envTrim("LANGFUSE_SECRET_KEY")!,
    host: envTrim("LANGFUSE_HOST")!,
  })
}

/** Append Langfuse exporter once when env is configured. */
export function appendLangfuseExporter(exporters: TraceExporter[]): TraceExporter[] {
  const lf = createLangfuseExporterFromEnv()
  if (!lf) return exporters
  if (exporters.some((e) => e.name === "langfuse")) return exporters
  log.info("langfuse exporter enabled", { host: envTrim("LANGFUSE_HOST") })
  return [...exporters, lf]
}
