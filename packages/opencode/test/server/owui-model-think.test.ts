import { describe, expect, test, beforeEach } from "bun:test"
import {
  clearSessionOverride,
  getSessionOverride,
  resetSessionOverridesForTests,
  setSessionOverride,
} from "../../src/server/routes/owui-session-overrides"
import {
  BUILDER_SLASH_DENIAL,
  coerceOwuiGroupIds,
  collectOwuiGroupIds,
  formatGroupSlashDenial,
  formatRegisteredModels,
  formatThinkStatus,
  isBuilderAgent,
  isSlashGroupAllowed,
  parseOwuiSlashCommand,
  parseSlashGroupAllowlist,
  resolveOwuiModelArg,
  OWUI_MODEL_ALIASES,
} from "../../src/server/routes/owui-slash"

describe("OWUI /model and /think slash helpers", () => {
  test("parses /model with and without args", () => {
    expect(parseOwuiSlashCommand("/model")).toEqual({ command: "model", arguments: "" })
    expect(parseOwuiSlashCommand("/model  databricks/system.ai.gemini-3-5-flash ")).toEqual({
      command: "model",
      arguments: "databricks/system.ai.gemini-3-5-flash",
    })
  })

  test("resolves /model pro and lite aliases", () => {
    expect(resolveOwuiModelArg("pro")).toBe("google/gemini-3.1-pro-preview")
    expect(resolveOwuiModelArg("PRO")).toBe("google/gemini-3.1-pro-preview")
    expect(resolveOwuiModelArg("lite")).toBe("google/gemini-3.5-flash-lite")
    expect(resolveOwuiModelArg("Lite")).toBe("google/gemini-3.5-flash-lite")
    expect(resolveOwuiModelArg("google/gemini-3.1-pro-preview")).toBe("google/gemini-3.1-pro-preview")
    expect(resolveOwuiModelArg("")).toBe("")
    expect(OWUI_MODEL_ALIASES.pro).toBe("google/gemini-3.1-pro-preview")
    expect(OWUI_MODEL_ALIASES.lite).toBe("google/gemini-3.5-flash-lite")
  })

  test("parses /think and /thinking alias", () => {
    expect(parseOwuiSlashCommand("/think")).toEqual({ command: "think", arguments: "" })
    expect(parseOwuiSlashCommand("/thinking high")).toEqual({ command: "think", arguments: "high" })
    expect(parseOwuiSlashCommand("/think off")).toEqual({ command: "think", arguments: "off" })
  })

  test("ignores non-slash and mid-message slash", () => {
    expect(parseOwuiSlashCommand("hello")).toBeUndefined()
    expect(parseOwuiSlashCommand("please /model foo")).toBeUndefined()
    expect(parseOwuiSlashCommand("/models")).toBeUndefined()
  })

  test("builder gate", () => {
    expect(isBuilderAgent("builder")).toBe(true)
    expect(isBuilderAgent("Builder")).toBe(true)
    expect(isBuilderAgent("analyst")).toBe(false)
    expect(isBuilderAgent(undefined)).toBe(false)
    expect(BUILDER_SLASH_DENIAL).toContain("builder mode")
  })

  test("slash group allowlist: empty env allows all", () => {
    expect(parseSlashGroupAllowlist(undefined)).toEqual([])
    expect(parseSlashGroupAllowlist(" a , b ")).toEqual(["a", "b"])
    expect(isSlashGroupAllowed(["x"], [])).toBe(true)
    expect(isSlashGroupAllowed([], "")).toBe(true)
  })

  test("slash group allowlist: requires matching OWUI group id", () => {
    expect(isSlashGroupAllowed(["grp-1", "grp-2"], "grp-2,grp-9")).toBe(true)
    expect(isSlashGroupAllowed(["grp-1"], "grp-2")).toBe(false)
    expect(isSlashGroupAllowed(undefined, "grp-2")).toBe(false)
    expect(isSlashGroupAllowed(["GRP-2"], "grp-2")).toBe(true)
    expect(isSlashGroupAllowed(["grp-1"], '"grp-1"')).toBe(true)
  })

  test("coerceOwuiGroupIds accepts array, csv, json, objects", () => {
    expect(coerceOwuiGroupIds(["a", " b "])).toEqual(["a", "b"])
    expect(coerceOwuiGroupIds("a,b")).toEqual(["a", "b"])
    expect(coerceOwuiGroupIds(null)).toEqual([])
    expect(coerceOwuiGroupIds('["uuid-1","uuid-2"]')).toEqual(["uuid-1", "uuid-2"])
    expect(coerceOwuiGroupIds([{ id: "i1", name: "n1" }])).toEqual(["i1", "n1"])
  })

  test("collectOwuiGroupIds reads body.user_groups and headers (no filter)", () => {
    const headers: Record<string, string> = {
      "x-openwebui-user-group-ids": "hdr-1,hdr-2",
    }
    expect(
      collectOwuiGroupIds({
        body: { user_groups: ["body-a", "body-b"] },
        header: (name) => headers[name],
      }).sort(),
    ).toEqual(["body-a", "body-b", "hdr-1", "hdr-2"])
    expect(
      collectOwuiGroupIds({
        body: { user_group_ids: ["id-1"] },
      }),
    ).toEqual(["id-1"])
  })

  test("formatGroupSlashDenial explains empty vs mismatch", () => {
    expect(formatGroupSlashDenial({ received: [], allowlist: ["a"] })).toContain("No group ids")
    expect(formatGroupSlashDenial({ received: ["x"], allowlist: ["a"] })).toContain("`x`")
  })

  test("formatRegisteredModels marks current", () => {
    const text = formatRegisteredModels(
      [
        { providerID: "databricks", modelID: "a" },
        { providerID: "databricks", modelID: "b" },
      ],
      { providerID: "databricks", modelID: "b" },
    )
    expect(text).toContain("`databricks/a`")
    expect(text).toContain("`databricks/b` ← current")
    expect(text).toContain("`pro` → `google/gemini-3.1-pro-preview`")
    expect(text).toContain("`lite` → `google/gemini-3.5-flash-lite`")
  })

  test("formatThinkStatus lists levels", () => {
    const text = formatThinkStatus({
      modelLabel: "databricks/m",
      current: "high",
      available: ["low", "high"],
    })
    expect(text).toContain("`high` ← current")
    expect(text).toContain("`/think off`")
  })

  test("formatThinkStatus when model has no variants", () => {
    expect(
      formatThinkStatus({ modelLabel: "x/y", available: [] }),
    ).toContain("no thinking/reasoning variants")
  })
})

describe("OWUI session overrides store", () => {
  beforeEach(() => {
    resetSessionOverridesForTests()
  })

  test("set/get model and variant", () => {
    setSessionOverride("s1", {
      model: { providerID: "databricks", modelID: "flash" },
      variant: "high",
    })
    expect(getSessionOverride("s1")).toEqual({
      model: { providerID: "databricks", modelID: "flash" },
      variant: "high",
    })
  })

  test("clearVariant and clearModel", () => {
    setSessionOverride("s1", {
      model: { providerID: "p", modelID: "m" },
      variant: "low",
    })
    setSessionOverride("s1", { clearVariant: true })
    expect(getSessionOverride("s1")).toEqual({
      model: { providerID: "p", modelID: "m" },
    })
    setSessionOverride("s1", { clearModel: true, variant: "medium" })
    expect(getSessionOverride("s1")).toEqual({ variant: "medium" })
  })

  test("clear removes session entry", () => {
    setSessionOverride("s1", { variant: "high" })
    clearSessionOverride("s1")
    expect(getSessionOverride("s1")).toBeUndefined()
  })

  test("prompt override shape matches SessionPrompt.prompt model field", () => {
    setSessionOverride("s1", {
      model: { providerID: "databricks", modelID: "system.ai.gemini-3-5-flash" },
      variant: "high",
    })
    const ov = getSessionOverride("s1")!
    const promptArgs = {
      model: ov.model
        ? { providerID: ov.model.providerID, modelID: ov.model.modelID }
        : undefined,
      variant: ov.variant,
    }
    expect(promptArgs).toEqual({
      model: { providerID: "databricks", modelID: "system.ai.gemini-3-5-flash" },
      variant: "high",
    })
  })
})
