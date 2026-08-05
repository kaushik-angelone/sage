// Keep Open WebUI SSE lines under aiohttp's StreamReader limit (~131072 bytes).
// Oversized single `data:` lines surface as:
//   400: Got more than 131072 bytes when reading ...

export const OWUI_SSE_MAX_BYTES = 100_000

export function utf8Bytes(value: string): number {
  return Buffer.byteLength(value, "utf8")
}

/** Split `value` into chunks each ≤ maxBytes of UTF-8 (keeps code points intact). */
export function splitUtf8ByBytes(value: string, maxBytes: number): string[] {
  if (maxBytes < 1 || utf8Bytes(value) <= maxBytes) return [value]
  const out: string[] = []
  let start = 0
  while (start < value.length) {
    let end = start
    let size = 0
    while (end < value.length) {
      const cp = value.codePointAt(end)
      if (cp === undefined) break
      const char = String.fromCodePoint(cp)
      const n = utf8Bytes(char)
      if (size + n > maxBytes) break
      size += n
      end += char.length
    }
    if (end === start) {
      const cp = value.codePointAt(start)
      if (cp === undefined) break
      end = start + String.fromCodePoint(cp).length
    }
    out.push(value.slice(start, end))
    start = end
  }
  return out.length > 0 ? out : [value]
}

function truncateStrings(value: unknown, maxBytes: number): unknown {
  if (typeof value === "string") {
    if (utf8Bytes(value) <= maxBytes) return value
    const parts = splitUtf8ByBytes(value, Math.max(1, maxBytes - 1))
    return (parts[0] ?? "") + "…"
  }
  if (Array.isArray(value)) return value.map((item) => truncateStrings(item, maxBytes))
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = truncateStrings(v, maxBytes)
    }
    return out
  }
  return value
}

type SseStream = { writeSSE: (msg: { data: string }) => Promise<void> }

/**
 * Write one OpenAI-style chunk as SSE, splitting/truncating so each event stays
 * under OWUI_SSE_MAX_BYTES. Text/reasoning deltas are split; Rich UI Embed tool
 * calls are emitted one embed at a time; other oversized tool JSON is truncated.
 */
export async function writeOwuiSse(
  stream: SseStream,
  obj: unknown,
  opts?: { maxBytes?: number; warn?: (msg: string, data: Record<string, unknown>) => void },
): Promise<void> {
  const maxBytes = opts?.maxBytes ?? OWUI_SSE_MAX_BYTES
  const warn = opts?.warn
  const data = JSON.stringify(obj)
  if (utf8Bytes(data) <= maxBytes) {
    await stream.writeSSE({ data })
    return
  }

  if (!obj || typeof obj !== "object") {
    warn?.("owui sse drop: oversized non-object", { bytes: utf8Bytes(data) })
    return
  }

  const root = obj as Record<string, unknown>
  const choices = root["choices"]
  if (!Array.isArray(choices) || !choices[0] || typeof choices[0] !== "object") {
    warn?.("owui sse drop: oversized chunk without choices", { bytes: utf8Bytes(data) })
    return
  }
  const choice0 = { ...(choices[0] as Record<string, unknown>) }
  delete choice0["stream_complete"]
  delete choice0["overall_duration"]
  choice0["finish_reason"] = null
  const delta = choice0["delta"]
  if (!delta || typeof delta !== "object") {
    warn?.("owui sse drop: oversized chunk without delta", { bytes: utf8Bytes(data) })
    return
  }
  const d = { ...(delta as Record<string, unknown>) }

  for (const key of ["content", "reasoning_content"] as const) {
    if (typeof d[key] !== "string" || !(d[key] as string).length) continue
    const text = d[key] as string

    if (key === "content" && root["message_type"] === "tool call") {
      try {
        const payload = JSON.parse(text) as { name?: string; args?: Record<string, unknown> }
        if (payload.name === "Rich UI Embed" && Array.isArray(payload.args?.["embeds"])) {
          const embeds = payload.args["embeds"].filter((x): x is string => typeof x === "string" && x.length > 0)
          // Multiple charts → one SSE event each (avoids stacking past the limit).
          if (embeds.length > 1) {
            for (const html of embeds) {
              await writeOwuiSse(
                stream,
                {
                  ...root,
                  choices: [
                    {
                      ...choice0,
                      delta: {
                        content: JSON.stringify({ name: "Rich UI Embed", args: { embeds: [html] } }),
                      },
                    },
                  ],
                },
                opts,
              )
            }
            return
          }
          // Single chart still too large → truncate HTML (do not recurse).
          if (embeds.length === 1) {
            const probe = {
              ...root,
              choices: [
                {
                  ...choice0,
                  delta: { content: JSON.stringify({ name: "Rich UI Embed", args: { embeds: [""] } }) },
                },
              ],
            }
            const budget = Math.max(512, maxBytes - utf8Bytes(JSON.stringify(probe)) - 8)
            const truncated = `${splitUtf8ByBytes(embeds[0], budget)[0] ?? ""}…`
            await stream.writeSSE({
              data: JSON.stringify({
                ...root,
                choices: [
                  {
                    ...choice0,
                    delta: {
                      content: JSON.stringify({ name: "Rich UI Embed", args: { embeds: [truncated] } }),
                    },
                  },
                ],
              }),
            })
            warn?.("owui sse truncated oversized rich ui embed", { bytes: utf8Bytes(data) })
            return
          }
        }
        if (payload.args && typeof payload.args === "object") {
          const probe = {
            ...root,
            choices: [{ ...choice0, delta: { content: JSON.stringify({ name: payload.name, args: {} }) } }],
          }
          const budget = Math.max(512, maxBytes - utf8Bytes(JSON.stringify(probe)) - 64)
          const next = JSON.stringify({
            name: payload.name,
            args: truncateStrings(payload.args, budget),
          })
          await stream.writeSSE({
            data: JSON.stringify({
              ...root,
              choices: [{ ...choice0, delta: { content: next } }],
            }),
          })
          return
        }
      } catch {
        // fall through to plain text split
      }
    }

    const probe = {
      ...root,
      choices: [{ ...choice0, delta: { ...d, [key]: "" } }],
    }
    const overhead = utf8Bytes(JSON.stringify(probe))
    const maxContent = Math.max(1024, maxBytes - overhead - 32)
    for (const piece of splitUtf8ByBytes(text, maxContent)) {
      await stream.writeSSE({
        data: JSON.stringify({
          ...root,
          choices: [{ ...choice0, delta: { ...d, [key]: piece } }],
        }),
      })
    }
    return
  }

  warn?.("owui sse drop: oversized unsplittable chunk", { bytes: utf8Bytes(data) })
}

/** Serialize writes so split chunks stay in order when callers fire-and-forget. */
export function makeOwuiWriter(
  stream: SseStream,
  opts?: { maxBytes?: number; warn?: (msg: string, data: Record<string, unknown>) => void },
) {
  let chain: Promise<void> = Promise.resolve()
  const write = (obj: unknown) => {
    chain = chain.then(() => writeOwuiSse(stream, obj, opts))
    return chain
  }
  const flush = () => chain
  return { write, flush }
}
