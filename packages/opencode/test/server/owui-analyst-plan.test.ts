import { describe, expect, test, beforeEach } from "bun:test"
import {
  ANALYST_EXECUTE_MODEL,
  ANALYST_PLAN_MODEL,
  analystExecuteModelOverride,
  analystPlanModelOverride,
  emptyPlanHelp,
  executePlanPrompt,
  isPlanPrefixed,
  parseAnalystPhaseSlash,
  planExitDisclaimer,
  resolveAnalystPlanTurn,
} from "../../src/server/routes/owui-analyst-plan"
import {
  getSessionOverride,
  resetSessionOverridesForTests,
  setSessionOverride,
} from "../../src/server/routes/owui-session-overrides"

describe("OWUI analyst /plan and /execute", () => {
  test("parses /plan and /execute", () => {
    expect(parseAnalystPhaseSlash("/plan")).toEqual({ command: "plan", arguments: "" })
    expect(parseAnalystPhaseSlash("/plan  migrate orders ")).toEqual({
      command: "plan",
      arguments: "migrate orders",
    })
    expect(parseAnalystPhaseSlash("/execute")).toEqual({ command: "execute", arguments: "" })
    expect(parseAnalystPhaseSlash("/EXECUTE now")).toEqual({ command: "execute", arguments: "now" })
  })

  test("isPlanPrefixed", () => {
    expect(isPlanPrefixed("/plan foo")).toBe(true)
    expect(isPlanPrefixed("  /PLAN refine")).toBe(true)
    expect(isPlanPrefixed("/plan")).toBe(true)
    expect(isPlanPrefixed("go ahead with the plan")).toBe(false)
    expect(isPlanPrefixed("/execute")).toBe(false)
    expect(isPlanPrefixed("please /plan this")).toBe(false)
  })

  test("ignores non phase slash and mid-message", () => {
    expect(parseAnalystPhaseSlash("/model flash")).toBeUndefined()
    expect(parseAnalystPhaseSlash("please /plan this")).toBeUndefined()
    expect(parseAnalystPhaseSlash("hello")).toBeUndefined()
  })

  test("model refs match flash / lite aliases", () => {
    expect(ANALYST_PLAN_MODEL).toBe("google/gemini-3.6-flash")
    expect(ANALYST_EXECUTE_MODEL).toBe("google/gemini-3.5-flash-lite")
    expect(analystPlanModelOverride()).toEqual({
      providerID: "google",
      modelID: "gemini-3.6-flash",
    })
    expect(analystExecuteModelOverride()).toEqual({
      providerID: "google",
      modelID: "gemini-3.5-flash-lite",
    })
  })

  test("empty /plan help and disclaimer mention exit rule", () => {
    const help = emptyPlanHelp()
    expect(help).toContain("/plan <question>")
    expect(help).toContain(ANALYST_PLAN_MODEL)
    expect(help).toContain("not prefixed with `/plan`")
    expect(planExitDisclaimer()).toContain("exit plan mode")
  })

  test("executePlanPrompt normalizes bare /execute only", () => {
    expect(executePlanPrompt("/execute")).toBe("Execute the plan")
    expect(executePlanPrompt("go ahead with the plan")).toBe("go ahead with the plan")
    expect(executePlanPrompt("run the SQL checks")).toBe("run the SQL checks")
  })

  test("resolveAnalystPlanTurn: /plan enter; /plan stay; non-/plan exits", () => {
    expect(
      resolveAnalystPlanTurn({ agent: "builder", userMessage: "/plan foo", phase: undefined }),
    ).toEqual({ kind: "noop" })

    const enter = resolveAnalystPlanTurn({
      agent: "analyst",
      userMessage: "/plan migrate orders",
      phase: undefined,
    })
    expect(enter).toMatchObject({
      kind: "prompt",
      agent: "plan",
      promptText: "migrate orders",
      phase: "plan",
      model: { providerID: "google", modelID: "gemini-3.6-flash" },
    })
    expect(enter.kind === "prompt" && enter.statusLine).toContain("not prefixed with `/plan`")

    expect(
      resolveAnalystPlanTurn({ agent: "analyst", userMessage: "/plan", phase: undefined }),
    ).toMatchObject({ kind: "help" })

    const stay = resolveAnalystPlanTurn({
      agent: "analyst",
      userMessage: "/plan change step 2",
      phase: "plan",
    })
    expect(stay).toMatchObject({
      kind: "prompt",
      agent: "plan",
      promptText: "change step 2",
      phase: "plan",
    })

    const exit = resolveAnalystPlanTurn({
      agent: "analyst",
      userMessage: "go ahead with the plan",
      phase: "plan",
    })
    expect(exit).toMatchObject({
      kind: "prompt",
      agent: "analyst",
      promptText: "go ahead with the plan",
      phase: "execute",
      model: { providerID: "google", modelID: "gemini-3.5-flash-lite" },
    })
    expect(exit.kind === "prompt" && exit.statusLine).toContain("gemini-3.5-flash-lite")

    expect(
      resolveAnalystPlanTurn({ agent: "analyst", userMessage: "/execute", phase: "plan" }),
    ).toMatchObject({
      kind: "prompt",
      agent: "analyst",
      promptText: "Execute the plan",
      phase: "execute",
    })

    // Outside plan: normal message does not auto-plan
    expect(
      resolveAnalystPlanTurn({
        agent: "analyst",
        userMessage: "investigate and migrate the entire pipeline end-to-end",
        phase: undefined,
      }),
    ).toEqual({ kind: "noop" })
  })
})

describe("OWUI session phase override", () => {
  beforeEach(() => {
    resetSessionOverridesForTests()
  })

  test("set/get phase with model", () => {
    setSessionOverride("s1", {
      phase: "plan",
      model: analystPlanModelOverride(),
    })
    expect(getSessionOverride("s1")).toEqual({
      phase: "plan",
      model: { providerID: "google", modelID: "gemini-3.6-flash" },
    })
    setSessionOverride("s1", {
      phase: "execute",
      model: analystExecuteModelOverride(),
    })
    expect(getSessionOverride("s1")?.phase).toBe("execute")
  })

  test("clearPhase keeps model", () => {
    setSessionOverride("s1", { phase: "plan", model: analystPlanModelOverride() })
    setSessionOverride("s1", { clearPhase: true })
    expect(getSessionOverride("s1")).toEqual({
      model: { providerID: "google", modelID: "gemini-3.6-flash" },
    })
  })
})
