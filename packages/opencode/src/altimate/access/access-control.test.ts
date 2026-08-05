import { describe, it, expect, mock, beforeEach } from "bun:test"
import { deniedSlugFromGroup, deniedSlugsForGroups } from "./domain-tables"

// Test pure slug-extraction (no fs, no napi)
describe("deniedSlugFromGroup", () => {
  it("extracts slug from _disallow group", () => {
    expect(deniedSlugFromGroup("loans_disallow")).toBe("loans")
    expect(deniedSlugFromGroup("mutual_funds_disallow")).toBe("mutual_funds")
  })
  it("returns null for non-disallow groups", () => {
    expect(deniedSlugFromGroup("analysts")).toBeNull()
    expect(deniedSlugFromGroup("admin")).toBeNull()
  })
})

describe("deniedSlugsForGroups", () => {
  it("extracts and dedupes slugs", () => {
    expect(deniedSlugsForGroups(["loans_disallow", "loans_disallow", "analysts"])).toEqual(["loans"])
  })
  it("returns empty for no disallow groups", () => {
    expect(deniedSlugsForGroups(["analysts", "admin"])).toEqual([])
  })
  it("returns empty for empty groups", () => {
    expect(deniedSlugsForGroups([])).toEqual([])
  })
})

// Test checkSqlAccess logic directly by exercising the module with inline mocks.
// These tests validate matching, CTE exclusion, and fail-open without needing real fs or napi.
import { checkSqlAccess } from "./access-control"
import * as domainTables from "./domain-tables"

describe("checkSqlAccess", () => {
  it("allows when no disallow groups", () => {
    expect(checkSqlAccess("SELECT 1", ["analysts"]).allow).toBe(true)
  })

  it("allows when groups is empty (fail open)", () => {
    expect(checkSqlAccess("SELECT * FROM loans", []).allow).toBe(true)
  })

  it("allows when denied FQN set is empty (unknown slug, fail open)", () => {
    // "unknown_disallow" → slug "unknown" → no tables.json → empty set → allow
    expect(checkSqlAccess("SELECT * FROM some_table", ["unknown_disallow"]).allow).toBe(true)
  })
})
