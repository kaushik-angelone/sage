import { Server } from "@/server/server"
const app = Server.Default()
const res = await app.request("/v1/chat/completions", {
  method: "POST",
  headers: { "content-type": "application/json", "x-openwebui-chat-id": "smoke-1" },
  body: JSON.stringify({ model: "altimate-code", stream: true, messages: [{ role: "user", content: "say hi in one word" }] }),
})
console.log("STREAM_STATUS", res.status, res.headers.get("content-type"))
const reader = res.body!.getReader()
const dec = new TextDecoder()
let buf = ""
let frames = 0
let sawDone = false
const started = Date.now()
while (true) {
  const { done, value } = await reader.read()
  if (done) break
  buf += dec.decode(value, { stream: true })
  let idx
  while ((idx = buf.indexOf("\n\n")) >= 0) {
    const frame = buf.slice(0, idx); buf = buf.slice(idx + 2)
    if (!frame.startsWith("data:")) continue
    frames++
    const data = frame.slice(5).trim()
    if (data === "[DONE]") { sawDone = true; continue }
    if (frames <= 12) console.log("FRAME", data.slice(0, 160))
  }
  if (Date.now() - started > 45000) { console.log("TIMEOUT_GUARD"); break }
}
console.log("TOTAL_FRAMES", frames, "SAW_DONE", sawDone)
process.exit(0)
