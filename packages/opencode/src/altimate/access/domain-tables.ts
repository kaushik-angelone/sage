import * as fs from "fs"
import * as path from "path"

const DISALLOW_SUFFIX = "_disallow"

/** "loans_disallow" → "loans", "analysts" → null */
export function deniedSlugFromGroup(name: string): string | null {
  return name.endsWith(DISALLOW_SUFFIX) ? name.slice(0, -DISALLOW_SUFFIX.length) : null
}

export function deniedSlugsForGroups(groups: string[]): string[] {
  return [...new Set(groups.map(deniedSlugFromGroup).filter((s): s is string => s !== null))]
}

interface CacheEntry {
  fqns: Set<string>
  mtime: number
}

// ponytail: module-level cache, no TTL — mtime invalidation is sufficient
const slugCache = new Map<string, CacheEntry>()

function projectDir(): string {
  return process.env["ALTIMATE_OWUI_PROJECT_DIR"] || process.env["OPENCODE_PROJECT_DIR"] || process.cwd()
}

function loadSlug(slug: string): Set<string> {
  const tablesPath = path.join(projectDir(), "genie_spaces", slug, "tables.json")
  let mtime = 0
  try {
    mtime = fs.statSync(tablesPath).mtimeMs
  } catch {
    return new Set()
  }
  const cached = slugCache.get(slug)
  if (cached && cached.mtime === mtime) return cached.fqns
  try {
    const entries: { identifier: string }[] = JSON.parse(fs.readFileSync(tablesPath, "utf8"))
    const fqns = new Set(entries.map((e) => e.identifier.toLowerCase()))
    slugCache.set(slug, { fqns, mtime })
    return fqns
  } catch {
    return new Set()
  }
}

export function deniedFqnSet(slugs: string[]): Set<string> {
  if (slugs.length === 0) return new Set()
  const combined = new Set<string>()
  for (const slug of slugs) {
    for (const fqn of loadSlug(slug)) combined.add(fqn)
  }
  return combined
}
