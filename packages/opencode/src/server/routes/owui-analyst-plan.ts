/**
 * Analyst-only OWUI plan→execute: explicit /plan only.
 * Plan runs on gemini-3.6-flash; any non-/plan follow-up exits to analyst on flash-lite.
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

/** Message starts with `/plan` (keep planning). */
export function isPlanPrefixed(text: string): boolean {
  return /^\s*\/plan(?:\s|$)/i.test(text || "")
}

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

/** Shown on first /plan response — next message without /plan exits planning. */
export function planExitDisclaimer(): string {
  return (
    `**Note:** Reply with \`/plan …\` to keep planning. ` +
    `If your next message is not prefixed with \`/plan\`, I will exit plan mode and run as analyst on \`${ANALYST_EXECUTE_MODEL}\`.`
  )
}

export function emptyPlanHelp(): string {
  return (
    "Usage: `/plan <question>` — plans with `" +
    ANALYST_PLAN_MODEL +
    "`.\n\n" +
    planExitDisclaimer() +
    "\n\nOptional: `/execute` runs the plan as analyst on `" +
    ANALYST_EXECUTE_MODEL +
    "`."
  )
}

export function planStatusLine(): string {
  return `Planning with \`${ANALYST_PLAN_MODEL}\`…\n\n${planExitDisclaimer()}`
}

export function executeStatusLine(): string {
  return `Executing with \`${ANALYST_EXECUTE_MODEL}\` (analyst)…`
}

/** Prompt text for bare `/execute`. */
export function executePlanPrompt(userText: string): string {
  const t = (userText || "").trim()
  if (!t || parseAnalystPhaseSlash(t)?.command === "execute") {
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
 * Pure routing for analyst OWUI plan→execute.
 * Stay in plan only while messages are prefixed with /plan; otherwise exit.
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

  // Explicit /execute, or any non-/plan message while in plan → analyst execute.
  if (slash?.command === "execute" || (input.phase === "plan" && !isPlanPrefixed(msg))) {
    return {
      kind: "prompt",
      agent: "analyst",
      promptText: executePlanPrompt(msg),
      statusLine: executeStatusLine(),
      phase: "execute",
      model: analystExecuteModelOverride(),
    }
  }

  return { kind: "noop" }
}
