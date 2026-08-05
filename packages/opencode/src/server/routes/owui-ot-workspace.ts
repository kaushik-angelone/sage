import fs from "fs"
import path from "path"
import { spawnSync } from "child_process"

/**
 * Per-user Open Terminal workspace under ALTIMATE_OWUI_OT_ROOT.
 * Each OWUI user gets `$OT_ROOT/<sanitized-id>/altimate_context` (a copy of the
 * seed). Host altimate_context is never written. Matches Open Terminal
 * multi-user homes at `/home/<username>/altimate_context`.
 */

const CONTEXT_DIR = "altimate_context"
const SKIP_HOMES = new Set(["_skel", "altimate-agent"])

/** Best-effort Linux username sanitize (Open Terminal multi-user / useradd). */
export function sanitizeOtUsername(raw: string): string {
  let name = raw.trim().toLowerCase()
  if (name.includes("@")) name = name.slice(0, name.indexOf("@"))
  name = name.replace(/[^a-z0-9_-]/g, "_").replace(/_+/g, "_").replace(/^_|_$/g, "")
  if (!name) name = "anon"
  if (!/^[a-z_]/.test(name)) name = `u_${name}`
  return name.slice(0, 32)
}

function hasContextMarker(dir: string): boolean {
  return (
    fs.existsSync(path.join(dir, "agents.md")) ||
    fs.existsSync(path.join(dir, "AGENTS.md")) ||
    fs.existsSync(path.join(dir, "descriptions.json"))
  )
}

function chmodOpen(dir: string) {
  // ponytail: a+rwX so host sage + container OT user can both edit; upgrade = match OT uid/gid.
  spawnSync("chmod", ["-R", "a+rwX", dir], { stdio: "ignore" })
  const home = path.dirname(dir)
  try {
    fs.chmodSync(home, 0o755)
  } catch {
    // ignore
  }
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
 * If a home already exists under otRoot that matches the sanitized id, use it.
 */
export function ensureOtUserProject(otRoot: string, userRaw: string, seed: string): string {
  const user = sanitizeOtUsername(userRaw)
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
