// Runnable check: bun packages/opencode/src/server/routes/owui-sse.check.ts
import { makeOwuiWriter, splitUtf8ByBytes, utf8Bytes, writeOwuiSse } from "./owui-sse"

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg)
}

{
  const parts = splitUtf8ByBytes("aé🙂x", 4)
  assert(parts.every((p) => utf8Bytes(p) <= 4), "split keeps utf8 budget")
  assert(parts.join("") === "aé🙂x", "split rejoins")
  // Single codepoint larger than budget is emitted whole (cannot split further).
  const forced = splitUtf8ByBytes("🙂", 1)
  assert(forced.length === 1 && forced[0] === "🙂", "oversized codepoint forced")
}

{
  const lines: string[] = []
  const stream = {
    writeSSE: async ({ data }: { data: string }) => {
      lines.push(data)
    },
  }
  const big = "x".repeat(50_000)
  await writeOwuiSse(
    stream,
    {
      id: "t",
      object: "chat.completion.chunk",
      message_type: "text",
      choices: [{ index: 0, delta: { content: big }, finish_reason: null }],
    },
    { maxBytes: 20_000 },
  )
  assert(lines.length > 1, "large text splits into multiple SSE events")
  assert(
    lines.every((line) => utf8Bytes(line) <= 20_000),
    "each SSE line under budget",
  )
  assert(
    lines.map((line) => JSON.parse(line).choices[0].delta.content).join("") === big,
    "split text reconstitutes",
  )
}

{
  const lines: string[] = []
  const stream = {
    writeSSE: async ({ data }: { data: string }) => {
      lines.push(data)
    },
  }
  const e1 = "a".repeat(8_000)
  const e2 = "b".repeat(8_000)
  await writeOwuiSse(
    stream,
    {
      id: "t",
      object: "chat.completion.chunk",
      message_type: "tool call",
      choices: [
        {
          index: 0,
          delta: { content: JSON.stringify({ name: "Rich UI Embed", args: { embeds: [e1, e2] } }) },
          finish_reason: null,
        },
      ],
    },
    { maxBytes: 12_000 },
  )
  assert(lines.length === 2, "rich ui embeds emit one SSE event each")
  assert(
    lines.every((line) => utf8Bytes(line) <= 12_000),
    "embed events under budget",
  )
}

{
  const lines: string[] = []
  const { write, flush } = makeOwuiWriter(
    {
      writeSSE: async ({ data }: { data: string }) => {
        lines.push(data)
      },
    },
    { maxBytes: 10_000 },
  )
  void write({
    message_type: "text",
    choices: [{ delta: { content: "y".repeat(25_000) }, finish_reason: null }],
  })
  await flush()
  assert(lines.length > 1, "writer chain flushes split chunks")
}

console.log("owui-sse.check: ok")
