/**
 * Analyst-only OWUI plan→execute: explicit /plan and /execute (no auto-detect yet).
 * Plan runs on gemini-3.6-flash; execute returns to analyst on gemini-3.5-flash-lite.
 */
import { OWUI_MODEL_ALIASES } from "./owui-slash"
import type { SessionModelOverride } from "./owui-session-overrides"

export const ANALYST_PLAN_MODEL = OWUI_MODEL_ALIASES.flash
export const ANALYST_EXECUTE_MODEL = OWUI_MODEL_ALIASES.lite

export type AnalystPhaseSlash = {
  command: "plan" | "execute"
  arguments: string
}

export type AnalystPhase = "plan" | "execute"

/** Match `/plan` or `/execute` as a whole user message. */
export function parseAnalystPhaseSlash(text: string): AnalystPhaseSlash | undefined {
  const trimmed = (text || "").trim()
  const match = trimmed.match(/^\/(plan|execute)(?:\s+([\s\S]*))?$/i)
  if (!match) return undefined
  return {
    command: match[1]!.toLowerCase() as "plan" | "execute",
    arguments: (match[2] ?? "").trim(),
  }
}

const APPROVAL =
  /^(approved|looks good|lgtm|execute|go ahead|ship it|let'?s go|sounds good)[.!]?$/i

/** Whole-message approval while in plan phase → switch to execute. */
export function isPlanApprovalPhrase(text: string): boolean {
  return APPROVAL.test((text || "").trim())
}

export function splitProviderModel(id: string): SessionModelOverride {
  const i = id.indexOf("/")
  if (i <= 0) return { providerID: "google", modelID: id }
  return { providerID: id.slice(0, i), modelID: id.slice(i + 1) }
}

export function analystPlanModelOverride(): SessionModelOverride {
  return splitProviderModel(ANALYST_PLAN_MODEL)
}

export function analystExecuteModelOverride(): SessionModelOverride {
  return splitProviderModel(ANALYST_EXECUTE_MODEL)
}

export function emptyPlanHelp(): string {
  return (
    "Usage: `/plan <question>` — plans with `" +
    ANALYST_PLAN_MODEL +
    "`.\n" +
    "When ready: `/execute` or reply `approved` / `looks good` / `lgtm` / `go ahead` / `ship it` " +
    "to continue as analyst on `" +
    ANALYST_EXECUTE_MODEL +
    "`."
  )
}

export function planStatusLine(): string {
  return `Planning with \`${ANALYST_PLAN_MODEL}\`…`
}

export function executeStatusLine(): string {
  return `Executing with \`${ANALYST_EXECUTE_MODEL}\` (analyst)…`
}

/** Prompt text for bare `/execute` or bare approval. */
export function executePlanPrompt(userText: string): string {
  const t = (userText || "").trim()
  if (!t || parseAnalystPhaseSlash(t)?.command === "execute" || isPlanApprovalPhrase(t)) {
    return "Execute the plan"
  }
  return t
}

export type AnalystPlanTurn =
  | { kind: "noop" }
  | { kind: "help"; text: string }
  | {
      kind: "prompt"
      agent: "plan" | "analyst"
      promptText: string
      statusLine?: string
      phase: AnalystPhase
      model: SessionModelOverride
    }

/**
 * Pure routing for analyst OWUI plan→execute (explicit /plan only).
 * Builder / non-analyst → noop. No auto complexity detection.
 */
export function resolveAnalystPlanTurn(input: {
  agent: string | undefined | null
  userMessage: string
  phase: AnalystPhase | undefined
}): AnalystPlanTurn {
  if ((input.agent || "").trim().toLowerCase() !== "analyst") return { kind: "noop" }

  const msg = input.userMessage
  const slash = parseAnalystPhaseSlash(msg)

  if (slash?.command === "plan") {
    if (!slash.arguments) return { kind: "help", text: emptyPlanHelp() }
    return {
      kind: "prompt",
      agent: "plan",
      promptText: slash.arguments,
      statusLine: planStatusLine(),
      phase: "plan",
      model: analystPlanModelOverride(),
    }
  }

  if (slash?.command === "execute" || (input.phase === "plan" && isPlanApprovalPhrase(msg))) {
    return {
      kind: "prompt",
      agent: "analyst",
      promptText: executePlanPrompt(msg),
      statusLine: executeStatusLine(),
      phase: "execute",
      model: analystExecuteModelOverride(),
    }
  }

  if (input.phase === "plan") {
    return {
      kind: "prompt",
      agent: "plan",
      promptText: msg,
      phase: "plan",
      model: analystPlanModelOverride(),
    }
  }

  return { kind: "noop" }
}
