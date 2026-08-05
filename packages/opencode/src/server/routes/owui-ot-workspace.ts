import fs from "fs"
import path from "path"
import { createHash } from "crypto"
import { spawnSync } from "child_process"

/**
 * Per-user Open Terminal workspace under ALTIMATE_OWUI_OT_ROOT.
 * Username sanitization MUST match open-terminal's user_isolation.sanitize_username
 * so sage and the OT file browser open the same `/home/<user>/altimate_context`.
 */

const CONTEXT_DIR = "altimate_context"
const SKIP_HOMES = new Set(["_skel", "altimate-agent"])

/**
 * Match open-webui/open-terminal `sanitize_username` (user_isolation.py):
 * alphanumeric only, first 8 chars, `u` prefix if leading digit, hash fallback.
 */
export function sanitizeOtUsername(raw: string, userPrefix = ""): string {
  const cleaned = raw.trim().toLowerCase().replace(/[^a-z0-9]/g, "")
  let name =
    cleaned.length >= 4
      ? cleaned.slice(0, 8)
      : createHash("sha256").update(raw.trim()).digest("hex").slice(0, 8)
  name = `${userPrefix}${name}`
  if (!name || !/^[a-z_]/.test(name)) name = `u${name || "anon"}`
  return name
}

function hasContextMarker(dir: string): boolean {
  return (
    fs.existsSync(path.join(dir, "agents.md")) ||
    fs.existsSync(path.join(dir, "AGENTS.md")) ||
    fs.existsSync(path.join(dir, "descriptions.json"))
  )
}

function chmodOpen(dir: string) {
  // Match open-terminal multi-user: home/dirs 2770 (setgid + group rwx) so
  // `sudo -u <user> mkdir` and server-group writes work. Do not use 750 —
  // that blocks OT saves when host cp left deploy ownership. Chown is fixed
  // in the OT container via run-open-terminal.sh --fix-perms.
  const home = path.dirname(dir)
  spawnSync("chmod", ["2770", home], { stdio: "ignore" })
  spawnSync("chmod", ["-R", "ug+rwX,o-rwx", dir], { stdio: "ignore" })
  spawnSync("find", [dir, "-type", "d", "-exec", "chmod", "2770", "{}", "+"], { stdio: "ignore" })
  const uid = String(process.getuid?.() ?? "")
  if (uid) {
    const acl = spawnSync("setfacl", ["-m", `u:${uid}:--x`, home], { stdio: "ignore" })
    if (acl.status === 0) {
      spawnSync("setfacl", ["-R", "-m", `u:${uid}:rwx`, dir], { stdio: "ignore" })
      spawnSync("setfacl", ["-R", "-d", "-m", `u:${uid}:rwx`, dir], { stdio: "ignore" })
      return
    }
  }
  // ponytail: no ACL — fall back so host sage can still write.
  spawnSync("chmod", ["2770", home], { stdio: "ignore" })
  spawnSync("chmod", ["-R", "a+rwX", dir], { stdio: "ignore" })
}

/** Copy seed → dest (replace contents). */
export function seedOtContext(dest: string, seed: string) {
  if (!fs.existsSync(seed) || !fs.statSync(seed).isDirectory()) {
    throw new Error(`OT seed missing or not a directory: ${seed}`)
  }
  fs.mkdirSync(dest, { recursive: true })
  for (const ent of fs.readdirSync(dest)) {
    fs.rmSync(path.join(dest, ent), { recursive: true, force: true })
  }
  fs.cpSync(seed, dest, { recursive: true })
  chmodOpen(dest)
}

/**
 * Resolve the per-user project directory, seeding from `seed` when empty.
 * Path: `$OT_ROOT/<sanitizeOtUsername(id)>/altimate_context` (= OT `/home/<user>/…`).
 */
export function ensureOtUserProject(otRoot: string, userRaw: string, seed: string): string {
  const prefix = (process.env["OPEN_TERMINAL_USER_PREFIX"] || "").trim()
  const user = sanitizeOtUsername(userRaw, prefix)
  const home = path.join(otRoot, user)
  const dest = path.join(home, CONTEXT_DIR)
  fs.mkdirSync(home, { recursive: true })
  if (!hasContextMarker(dest)) {
    seedOtContext(dest, seed)
  } else {
    chmodOpen(dest)
  }
  return dest
}

export function resolveOtSeed(otRoot: string, explicit?: string): string {
  if (explicit && fs.existsSync(explicit)) return explicit
  const skel = path.join(otRoot, "_skel")
  if (hasContextMarker(skel)) return skel
  return explicit || skel
}

export function isOtHomeName(name: string): boolean {
  return !SKIP_HOMES.has(name) && !name.startsWith(".")
}
