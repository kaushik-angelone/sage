// bun packages/opencode/src/server/routes/owui-ot-workspace.check.ts
import fs from "fs"
import os from "os"
import path from "path"
import { ensureOtUserProject, sanitizeOtUsername, seedOtContext } from "./owui-ot-workspace"

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg)
}

assert(sanitizeOtUsername("Alice@Corp.com") === "alice", "email local-part")
assert(sanitizeOtUsername("c0b31e80-aaaa-bbbb") === "c0b31e80-aaaa-bbbb".slice(0, 32), "uuid kept")
assert(sanitizeOtUsername("9bad") === "u_9bad", "leading digit")

const root = fs.mkdtempSync(path.join(os.tmpdir(), "ot-ws-"))
const seed = path.join(root, "seed")
fs.mkdirSync(seed)
fs.writeFileSync(path.join(seed, "agents.md"), "# hi\n")
fs.writeFileSync(path.join(seed, "note.txt"), "seed\n")

const a = ensureOtUserProject(root, "user-a@x.com", seed)
const b = ensureOtUserProject(root, "user-b@x.com", seed)
assert(a !== b, "per-user paths differ")
assert(fs.readFileSync(path.join(a, "note.txt"), "utf8") === "seed\n", "user a seeded")
fs.writeFileSync(path.join(a, "note.txt"), "only-a\n")
assert(fs.readFileSync(path.join(b, "note.txt"), "utf8") === "seed\n", "user b isolated")

seedOtContext(a, seed)
assert(fs.readFileSync(path.join(a, "note.txt"), "utf8") === "seed\n", "reseed restores")

fs.rmSync(root, { recursive: true, force: true })
console.log("owui-ot-workspace.check: ok")
