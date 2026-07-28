import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import {
  appendLangfuseExporter,
  createLangfuseExporterFromEnv,
  isLangfuseEnabled,
  LangfuseExporter,
  traceFileToLangfuseBatch,
} from "../../src/altimate/observability/langfuse"
import type { TraceFile } from "../../src/altimate/observability/tracing"
import { FileExporter } from "../../src/altimate/observability/tracing"

const KEYS = ["LANGFUSE_PUBLIC_KEY", "LANGFUSE_SECRET_KEY", "LANGFUSE_HOST", "DISABLE_LANGFUSE"] as const
const saved: Partial<Record<(typeof KEYS)[number], string | undefined>> = {}

function stashEnv() {
  for (const k of KEYS) saved[k] = process.env[k]
}

function restoreEnv() {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k]
    else process.env[k] = saved[k]
  }
}

function clearLangfuseEnv() {
  for (const k of KEYS) delete process.env[k]
}

beforeEach(() => {
  stashEnv()
  clearLangfuseEnv()
})

afterEach(() => {
  restoreEnv()
})

function sampleTrace(): TraceFile {
  return {
    version: 2,
    traceId: "trace-1",
    sessionId: "sess-1",
    startedAt: "2026-07-28T10:00:00.000Z",
    endedAt: "2026-07-28T10:00:05.000Z",
    metadata: {
      title: "hello",
      prompt: "what is 2+2?",
      agent: "builder",
      model: "gemini-flash",
      providerId: "google",
      tags: ["owui"],
    },
    spans: [
      {
        spanId: "span-root",
        parentSpanId: null,
        name: "session",
        kind: "session",
        startTime: Date.parse("2026-07-28T10:00:00.000Z"),
        endTime: Date.parse("2026-07-28T10:00:05.000Z"),
        status: "ok",
      },
      {
        spanId: "span-gen",
        parentSpanId: "span-root",
        name: "llm",
        kind: "generation",
        startTime: Date.parse("2026-07-28T10:00:01.000Z"),
        endTime: Date.parse("2026-07-28T10:00:03.000Z"),
        status: "ok",
        input: { messages: [{ role: "user", content: "what is 2+2?" }] },
        output: "4",
        model: { modelId: "gemini-flash", providerId: "google" },
        tokens: {
          input: 10,
          output: 2,
          reasoning: 0,
          cacheRead: 0,
          cacheWrite: 0,
          total: 12,
        },
        cost: 0.001,
      },
      {
        spanId: "span-tool",
        parentSpanId: "span-root",
        name: "bash",
        kind: "tool",
        startTime: Date.parse("2026-07-28T10:00:03.000Z"),
        endTime: Date.parse("2026-07-28T10:00:04.000Z"),
        status: "ok",
        input: { command: "echo 4" },
        output: "4",
        tool: { callId: "call-1", durationMs: 1000 },
      },
    ],
    summary: {
      totalTokens: 12,
      totalCost: 0.001,
      totalToolCalls: 1,
      totalGenerations: 1,
      duration: 5000,
      status: "completed",
      tokens: { input: 10, output: 2, reasoning: 0, cacheRead: 0, cacheWrite: 0 },
      narrative: "answered arithmetic",
    },
  }
}

describe("isLangfuseEnabled", () => {
  test("off when keys missing", () => {
    expect(isLangfuseEnabled()).toBe(false)
  })

  test("on when keys+host set", () => {
    process.env["LANGFUSE_PUBLIC_KEY"] = "pk-test"
    process.env["LANGFUSE_SECRET_KEY"] = "sk-test"
    process.env["LANGFUSE_HOST"] = '"http://10.3.16.178:3000"'
    expect(isLangfuseEnabled()).toBe(true)
  })

  test("DISABLE_LANGFUSE truthy disables", () => {
    process.env["LANGFUSE_PUBLIC_KEY"] = "pk-test"
    process.env["LANGFUSE_SECRET_KEY"] = "sk-test"
    process.env["LANGFUSE_HOST"] = "http://localhost:3000"
    process.env["DISABLE_LANGFUSE"] = "true"
    expect(isLangfuseEnabled()).toBe(false)
    expect(createLangfuseExporterFromEnv()).toBeUndefined()
  })
})

describe("traceFileToLangfuseBatch", () => {
  test("legacy single-turn (no user-message spans) emits one trace", () => {
    const batch = traceFileToLangfuseBatch(sampleTrace())
    const traces = batch.filter((e) => e.type === "trace-create")
    expect(traces).toHaveLength(1)
    const body = traces[0].body as Record<string, unknown>
    expect(body.sessionId).toBe("sess-1")
    expect(body.input).toBe("what is 2+2?")
    expect(body.output).toBe("4")
    expect(String(body.id)).toContain("sess-1")

    const gen = batch.find((e) => e.type === "generation-create")!
    const genBody = gen.body as Record<string, unknown>
    expect(genBody.traceId).toBe(body.id)
    expect(genBody.model).toBe("gemini-flash")
    expect((genBody.usage as { total: number }).total).toBe(12)
  })

  test("one Langfuse trace per user-message; shared sessionId", () => {
    const t0 = Date.parse("2026-07-28T10:00:00.000Z")
    const multi: TraceFile = {
      ...sampleTrace(),
      spans: [
        {
          spanId: "span-root",
          parentSpanId: null,
          name: "session",
          kind: "session",
          startTime: t0,
          endTime: t0 + 20_000,
          status: "ok",
        },
        {
          spanId: "um-1",
          parentSpanId: "span-root",
          name: "user-message",
          kind: "user-message",
          startTime: t0 + 1000,
          endTime: t0 + 1000,
          status: "ok",
          input: "first question",
        },
        {
          spanId: "gen-1",
          parentSpanId: "span-root",
          name: "llm",
          kind: "generation",
          startTime: t0 + 1500,
          endTime: t0 + 3000,
          status: "ok",
          output: "first answer",
          model: { modelId: "gemini-flash", providerId: "google" },
        },
        {
          spanId: "um-2",
          parentSpanId: "span-root",
          name: "user-message",
          kind: "user-message",
          startTime: t0 + 10_000,
          endTime: t0 + 10_000,
          status: "ok",
          input: "follow up",
        },
        {
          spanId: "gen-2",
          parentSpanId: "span-root",
          name: "llm",
          kind: "generation",
          startTime: t0 + 11_000,
          endTime: t0 + 12_000,
          status: "ok",
          output: "second answer",
          model: { modelId: "gemini-flash", providerId: "google" },
        },
      ],
    }

    const batch = traceFileToLangfuseBatch(multi)
    const traces = batch.filter((e) => e.type === "trace-create")
    expect(traces).toHaveLength(2)

    const bodies = traces.map((e) => e.body as Record<string, unknown>)
    expect(bodies[0].sessionId).toBe("sess-1")
    expect(bodies[1].sessionId).toBe("sess-1")
    expect(bodies[0].id).not.toBe(bodies[1].id)
    expect(bodies[0].input).toBe("first question")
    expect(bodies[0].output).toBe("first answer")
    expect(bodies[1].input).toBe("follow up")
    expect(bodies[1].output).toBe("second answer")

    const gens = batch.filter((e) => e.type === "generation-create")
    expect(gens).toHaveLength(2)
    expect((gens[0].body as Record<string, unknown>).traceId).toBe(bodies[0].id)
    expect((gens[1].body as Record<string, unknown>).traceId).toBe(bodies[1].id)
  })
})

describe("appendLangfuseExporter", () => {
  test("appends once when enabled", () => {
    process.env["LANGFUSE_PUBLIC_KEY"] = "pk"
    process.env["LANGFUSE_SECRET_KEY"] = "sk"
    process.env["LANGFUSE_HOST"] = "http://localhost:3000"

    const base = [new FileExporter()]
    const once = appendLangfuseExporter(base)
    expect(once.some((e) => e instanceof LangfuseExporter)).toBe(true)
    const twice = appendLangfuseExporter(once)
    expect(twice.filter((e) => e.name === "langfuse")).toHaveLength(1)
  })
})
