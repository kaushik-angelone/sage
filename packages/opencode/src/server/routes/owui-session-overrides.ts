/**
 * Per-session model / thinking-variant overrides for the Open WebUI bridge.
 *
 * OWUI never passes model/variant on each turn, and createUserMessage resolves
 * `input.model ?? agent.model ?? lastModel`, so agent.model would otherwise
 * shadow any prior user-message model. These overrides are applied on every
 * subsequent `SessionPrompt.prompt` for the session.
 */
import type { SessionID } from "@/session/schema"

export type SessionModelOverride = {
  providerID: string
  modelID: string
}

export type SessionOverride = {
  model?: SessionModelOverride
  /** Thinking / reasoning variant key for the active model (e.g. "high"). */
  variant?: string
}

const memory = new Map<string, SessionOverride>()

function key(sessionID: SessionID | string): string {
  return String(sessionID)
}

export function getSessionOverride(sessionID: SessionID | string): SessionOverride | undefined {
  const cur = memory.get(key(sessionID))
  if (!cur) return undefined
  return { ...cur, model: cur.model ? { ...cur.model } : undefined }
}

export function setSessionOverride(
  sessionID: SessionID | string,
  patch: Partial<SessionOverride> & { clearVariant?: boolean; clearModel?: boolean },
): SessionOverride {
  const id = key(sessionID)
  const prev = memory.get(id) ?? {}
  const next: SessionOverride = { ...prev }
  if (patch.clearModel) delete next.model
  else if (patch.model) next.model = { ...patch.model }
  if (patch.clearVariant) delete next.variant
  else if (patch.variant !== undefined) next.variant = patch.variant
  memory.set(id, next)
  return getSessionOverride(id)!
}

export function clearSessionOverride(sessionID: SessionID | string): void {
  memory.delete(key(sessionID))
}

/** Test seam. */
export function resetSessionOverridesForTests(): void {
  memory.clear()
}
