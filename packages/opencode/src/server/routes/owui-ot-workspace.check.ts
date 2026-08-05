// bun packages/opencode/src/server/routes/owui-ot-workspace.check.ts
import fs from "fs"
import os from "os"
import path from "path"
import { ensureOtUserProject, sanitizeOtUsername, seedOtContext } from "./owui-ot-workspace"

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg)
}

// Match open-terminal user_isolation.sanitize_username
assert(sanitizeOtUsername("Alice@Corp.com") === "alicecor", "email alnum first 8")
assert(sanitizeOtUsername("c0b31e80-aaaa-bbbb-cccc-ddddeeeeffff") === "c0b31e80", "uuid → 8 alnum")
assert(sanitizeOtUsername("550e8400-e29b-41d4-a716-446655440000") === "u550e8400", "leading digit → u prefix")
assert(sanitizeOtUsername("ab") !== "ab", "short id uses hash")
assert(sanitizeOtUsername("user-a@x.com") !== sanitizeOtUsername("user-b@x.com"), "different users")

const root = fs.mkdtempSync(path.join(os.tmpdir(), "ot-ws-"))
const seed = path.join(root, "seed")
fs.mkdirSync(seed)
fs.writeFileSync(path.join(seed, "agents.md"), "# hi\n")
fs.writeFileSync(path.join(seed, "note.txt"), "seed\n")

const a = ensureOtUserProject(root, "user-a@x.com", seed)
const b = ensureOtUserProject(root, "user-b@x.com", seed)
assert(a !== b, "per-user paths differ")
assert(a.includes("/useraxco/"), `path uses OT sanitize, got ${a}`)
assert(fs.readFileSync(path.join(a, "note.txt"), "utf8") === "seed\n", "user a seeded")
fs.writeFileSync(path.join(a, "note.txt"), "only-a\n")
assert(fs.readFileSync(path.join(b, "note.txt"), "utf8") === "seed\n", "user b isolated")

seedOtContext(a, seed)
assert(fs.readFileSync(path.join(a, "note.txt"), "utf8") === "seed\n", "reseed restores")

fs.rmSync(root, { recursive: true, force: true })
console.log("owui-ot-workspace.check: ok")
