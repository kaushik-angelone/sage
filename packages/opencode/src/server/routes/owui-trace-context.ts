/**
 * Per-session OWUI context for Langfuse / Trace metadata.
 *
 * Populated by the OpenAI bridge from Open WebUI headers + env, then applied
 * by TraceConsumer onto the live Trace (sessions are created by the bus path,
 * not inside the bridge).
 *
 * Mirrors data-agent owui_client_v5.py:
 *   user_id = X-OpenWebUI-User-Email (fallback anonymous uuid)
 */
export type OwuiTraceContext = {
  userId: string
  /** Advertised /v1 model id (distinguishes builder vs analyst portables). */
  modelId: string
  agent?: string
  /** OWUI group names injected by filter.py inlet(). Used for domain access control. */
  groups: string[]
}

const bySession = new Map<string, OwuiTraceContext>()

export function setOwuiTraceContext(sessionID: string, ctx: OwuiTraceContext): void {
  if (!sessionID) return
  bySession.set(sessionID, ctx)
}

export function getOwuiTraceContext(sessionID: string): OwuiTraceContext | undefined {
  return bySession.get(sessionID)
}

export function clearOwuiTraceContext(sessionID: string): void {
  bySession.delete(sessionID)
}
