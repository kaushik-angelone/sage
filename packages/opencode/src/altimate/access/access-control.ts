import { deniedSlugsForGroups, deniedFqnSet } from "./domain-tables"

// Safe import: napi binary may not be available on all platforms (same pattern as sql-classify.ts)
let extractMetadata: ((sql: string) => any) | null = null
try {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const core = require("@altimateai/altimate-core")
  if (typeof core?.extractMetadata === "function") extractMetadata = core.extractMetadata
} catch {
  // napi binary unavailable — fail open
}

export type AccessDecision = { allow: boolean; deniedTables?: string[] }

/** Normalize a table reference: lowercase, strip quotes/backticks/brackets */
function normalize(ref: string): string {
  return ref.toLowerCase().replace(/[`"[\]]/g, "")
}

/** True if ref matches fqn exactly or as a trailing suffix (schema.table or table) */
function matches(ref: string, denied: Set<string>): boolean {
  if (denied.has(ref)) return true
  // suffix match: denied "a.b.c" matches ref "b.c" or "c"
  for (const fqn of denied) {
    if (fqn.endsWith("." + ref)) return true
  }
  return false
}

export function checkSqlAccess(sql: string, groups: string[]): AccessDecision {
  const slugs = deniedSlugsForGroups(groups)
  if (slugs.length === 0) return { allow: true }

  const denied = deniedFqnSet(slugs)
  if (denied.size === 0) return { allow: true }

  if (!extractMetadata) return { allow: true } // fail open: extractor unavailable

  let meta: any
  try {
    meta = extractMetadata(sql)
  } catch {
    return { allow: true } // fail open: parse error
  }

  const tables: string[] = Array.isArray(meta?.tables) ? meta.tables : []
  const ctes: string[] = Array.isArray(meta?.ctes) ? meta.ctes : []
  const cteSet = new Set(ctes.map(normalize))

  if (tables.length === 0) return { allow: true } // fail open: no tables extracted

  const deniedTables: string[] = []
  for (const t of tables) {
    const ref = normalize(t)
    if (cteSet.has(ref)) continue // skip CTE names
    if (matches(ref, denied)) deniedTables.push(t)
  }

  if (deniedTables.length === 0) return { allow: true }
  return { allow: false, deniedTables }
}
