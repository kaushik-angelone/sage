import { describe, expect, test, beforeEach } from "bun:test"
import {
  ANALYST_EXECUTE_MODEL,
  ANALYST_PLAN_MODEL,
  analystExecuteModelOverride,
  analystPlanModelOverride,
  emptyPlanHelp,
  executePlanPrompt,
  isPlanApprovalPhrase,
  parseAnalystPhaseSlash,
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

  test("ignores non phase slash and mid-message", () => {
    expect(parseAnalystPhaseSlash("/model flash")).toBeUndefined()
    expect(parseAnalystPhaseSlash("please /plan this")).toBeUndefined()
    expect(parseAnalystPhaseSlash("hello")).toBeUndefined()
  })

  test("approval phrases are whole-message only", () => {
    expect(isPlanApprovalPhrase("approved")).toBe(true)
    expect(isPlanApprovalPhrase("Looks good!")).toBe(true)
    expect(isPlanApprovalPhrase("LGTM")).toBe(true)
    expect(isPlanApprovalPhrase("execute")).toBe(true)
    expect(isPlanApprovalPhrase("go ahead")).toBe(true)
    expect(isPlanApprovalPhrase("ship it")).toBe(true)
    expect(isPlanApprovalPhrase("let's go")).toBe(true)
    expect(isPlanApprovalPhrase("sounds good")).toBe(true)
    expect(isPlanApprovalPhrase("approved with changes")).toBe(false)
    expect(isPlanApprovalPhrase("please go ahead")).toBe(false)
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

  test("empty /plan help mentions both models", () => {
    const help = emptyPlanHelp()
    expect(help).toContain("/plan <question>")
    expect(help).toContain(ANALYST_PLAN_MODEL)
    expect(help).toContain(ANALYST_EXECUTE_MODEL)
  })

  test("executePlanPrompt normalizes bare execute/approval", () => {
    expect(executePlanPrompt("/execute")).toBe("Execute the plan")
    expect(executePlanPrompt("approved")).toBe("Execute the plan")
    expect(executePlanPrompt("run the SQL checks")).toBe("run the SQL checks")
  })

  test("resolveAnalystPlanTurn: builder noop; /plan enter; stay; execute; approval", () => {
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
    expect(enter.kind === "prompt" && enter.statusLine).toContain("gemini-3.6-flash")

    expect(
      resolveAnalystPlanTurn({ agent: "analyst", userMessage: "/plan", phase: undefined }),
    ).toMatchObject({ kind: "help" })

    const stay = resolveAnalystPlanTurn({
      agent: "analyst",
      userMessage: "change step 2",
      phase: "plan",
    })
    expect(stay).toMatchObject({
      kind: "prompt",
      agent: "plan",
      promptText: "change step 2",
      phase: "plan",
    })
    expect(stay.kind === "prompt" && stay.statusLine).toBeUndefined()

    const exec = resolveAnalystPlanTurn({
      agent: "analyst",
      userMessage: "/execute",
      phase: "plan",
    })
    expect(exec).toMatchObject({
      kind: "prompt",
      agent: "analyst",
      promptText: "Execute the plan",
      phase: "execute",
      model: { providerID: "google", modelID: "gemini-3.5-flash-lite" },
    })

    expect(
      resolveAnalystPlanTurn({ agent: "analyst", userMessage: "approved", phase: "plan" }),
    ).toMatchObject({ kind: "prompt", agent: "analyst", phase: "execute" })

    // Approval ignored outside plan phase
    expect(
      resolveAnalystPlanTurn({ agent: "analyst", userMessage: "approved", phase: "execute" }),
    ).toEqual({ kind: "noop" })

    // Normal analyst message: no auto plan
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
