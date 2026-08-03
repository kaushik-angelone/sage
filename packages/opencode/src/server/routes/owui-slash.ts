/**
 * Parse Open WebUI slash commands for builder model / thinking overrides.
 */

export const BUILDER_SLASH_DENIAL =
  "`/model` and `/think` are only available in builder mode."

export const GROUP_SLASH_DENIAL =
  "`/model` and `/think` are not enabled for your Open WebUI group."

/** Comma-separated OWUI group ids allowed to use /model and /think. */
export const SLASH_GROUP_IDS_ENV = "ALTIMATE_OWUI_SLASH_GROUP_IDS"

export type OwuiSlashCommand = {
  command: "model" | "think"
  arguments: string
}

function stripEnvQuotes(s: string): string {
  const t = s.trim()
  if (
    (t.startsWith('"') && t.endsWith('"')) ||
    (t.startsWith("'") && t.endsWith("'"))
  ) {
    return t.slice(1, -1).trim()
  }
  return t
}

/** Parse `ALTIMATE_OWUI_SLASH_GROUP_IDS` (comma-separated). Empty = unrestricted. */
export function parseSlashGroupAllowlist(raw: string | undefined | null): string[] {
  if (!raw?.trim()) return []
  const unquoted = stripEnvQuotes(raw)
  // JSON array form: ["uuid-a","uuid-b"]
  if (unquoted.startsWith("[")) {
    try {
      return coerceOwuiGroupIds(JSON.parse(unquoted))
    } catch {
      // fall through to CSV
    }
  }
  return unquoted
    .split(",")
    .map((s) => stripEnvQuotes(s))
    .filter(Boolean)
}

/**
 * When the allowlist env is unset/empty, all builder users may use the commands.
 * When set, the caller must present at least one matching OWUI group id or name.
 */
export function isSlashGroupAllowed(
  userGroupIds: Iterable<string> | undefined | null,
  allowlist: string[] | string | undefined | null = process.env[SLASH_GROUP_IDS_ENV],
): boolean {
  const allowed = Array.isArray(allowlist) ? allowlist : parseSlashGroupAllowlist(allowlist)
  if (allowed.length === 0) return true
  const allowedSet = new Set(allowed.map((id) => id.toLowerCase()))
  for (const id of userGroupIds ?? []) {
    if (allowedSet.has(String(id).trim().toLowerCase())) return true
  }
  return false
}

/** Normalize group ids/names from a body field or header (string[] / csv / JSON / objects). */
export function coerceOwuiGroupIds(raw: unknown): string[] {
  if (raw == null) return []
  if (Array.isArray(raw)) {
    const out: string[] = []
    for (const x of raw) {
      if (typeof x === "string" || typeof x === "number" || typeof x === "boolean") {
        const s = stripEnvQuotes(String(x))
        if (s) out.push(s)
        continue
      }
      if (x && typeof x === "object") {
        const o = x as Record<string, unknown>
        for (const key of ["id", "group_id", "groupId", "name"] as const) {
          const v = o[key]
          if (typeof v === "string" || typeof v === "number") {
            const s = stripEnvQuotes(String(v))
            if (s) out.push(s)
          }
        }
      }
    }
    return out
  }
  if (typeof raw === "string" && raw.trim()) {
    const t = stripEnvQuotes(raw)
    if (t.startsWith("[")) {
      try {
        return coerceOwuiGroupIds(JSON.parse(t))
      } catch {
        // CSV below
      }
    }
    return parseSlashGroupAllowlist(t)
  }
  return []
}

/**
 * Collect OWUI group ids/names already present on the chat request.
 * Reads body.user_groups / user_group_ids (and nested metadata), plus any
 * request header whose name contains "group".
 */
export function collectOwuiGroupIds(input: {
  body?: Record<string, unknown> | null
  header?: (name: string) => string | undefined
  /** Optional: all header names present on the request (for wildcard scan). */
  headerNames?: string[]
}): string[] {
  const out = new Set<string>()
  const add = (raw: unknown) => {
    for (const id of coerceOwuiGroupIds(raw)) out.add(id)
  }
  const body = input.body
  if (body) {
    add(body["user_group_ids"])
    add(body["user_groups"])
    add(body["group_ids"])
    add(body["groups"])
    const meta = body["metadata"]
    if (meta && typeof meta === "object") {
      const m = meta as Record<string, unknown>
      add(m["user_group_ids"])
      add(m["user_groups"])
      add(m["group_ids"])
      add(m["groups"])
    }
    // Any top-level key containing "group"
    for (const [k, v] of Object.entries(body)) {
      if (/group/i.test(k)) add(v)
    }
  }
  const header = input.header
  if (header) {
    const known = [
      "x-openwebui-user-group-ids",
      "x-openwebui-user-groups",
      "x-user-group-ids",
      "x-user-groups",
      "x-openwebui-groups",
    ]
    const names = new Set<string>([
      ...known,
      ...(input.headerNames ?? []).filter((n) => /group/i.test(n)),
    ])
    for (const name of names) add(header(name))
  }
  return [...out]
}

/** Human-readable reason when group ACL rejects a slash command. */
export function formatGroupSlashDenial(input: {
  received: string[]
  allowlist?: string[] | string | null
}): string {
  const allowed = Array.isArray(input.allowlist)
    ? input.allowlist
    : parseSlashGroupAllowlist(input.allowlist ?? process.env[SLASH_GROUP_IDS_ENV])
  const received = input.received
  if (received.length === 0) {
    return (
      `${GROUP_SLASH_DENIAL}\n\n` +
      `No group ids/names were present on this request (checked body.user_groups / ` +
      `user_group_ids and *group* headers). ` +
      `Allowlist has ${allowed.length} entr${allowed.length === 1 ? "y" : "ies"} from \`${SLASH_GROUP_IDS_ENV}\`.`
    )
  }
  return (
    `${GROUP_SLASH_DENIAL}\n\n` +
    `Your groups: ${received.map((g) => `\`${g}\``).join(", ")}\n` +
    `Allowlist (${SLASH_GROUP_IDS_ENV}): ${allowed.map((g) => `\`${g}\``).join(", ") || "(empty)"}`
  )
}

/** Match `/model`, `/think`, `/thinking` as a whole user message. */
export function parseOwuiSlashCommand(text: string): OwuiSlashCommand | undefined {
  const trimmed = (text || "").trim()
  const match = trimmed.match(/^\/(model|think|thinking)(?:\s+([\s\S]*))?$/i)
  if (!match) return undefined
  const raw = match[1]!.toLowerCase()
  const command = raw === "thinking" ? "think" : (raw as "model" | "think")
  return { command, arguments: (match[2] ?? "").trim() }
}

/** Short `/model` aliases → full `provider/model-id` (OWUI + TUI). */
export const OWUI_MODEL_ALIASES: Readonly<Record<string, string>> = {
  pro: "google/gemini-3.1-pro-preview",
  lite: "google/gemini-3.5-flash-lite",
}

/** Expand `pro` / `lite` (case-insensitive); leave other args unchanged. */
export function resolveOwuiModelArg(arg: string): string {
  const trimmed = (arg || "").trim()
  if (!trimmed) return trimmed
  return OWUI_MODEL_ALIASES[trimmed.toLowerCase()] ?? trimmed
}

export function isBuilderAgent(agent: string | undefined | null): boolean {
  return (agent || "").trim().toLowerCase() === "builder"
}

export function formatRegisteredModels(
  models: Array<{ providerID: string; modelID: string }>,
  current?: { providerID: string; modelID: string } | string,
): string {
  const currentKey =
    typeof current === "string"
      ? current
      : current
        ? `${current.providerID}/${current.modelID}`
        : undefined
  if (models.length === 0) {
    return "No models registered. Check provider config in `altimate-code.json`."
  }
  const lines = models
    .map((m) => {
      const id = `${m.providerID}/${m.modelID}`
      return id === currentKey ? `- \`${id}\` ← current` : `- \`${id}\``
    })
    .join("\n")
  const aliases = Object.entries(OWUI_MODEL_ALIASES)
    .map(([k, v]) => `\`${k}\` → \`${v}\``)
    .join(", ")
  return (
    `Registered models:\n\n${lines}\n\n` +
    `Set with \`/model provider/model-id\`.\n` +
    `Aliases: ${aliases}.`
  )
}

export function formatThinkStatus(input: {
  modelLabel: string
  current?: string
  available: string[]
}): string {
  const { modelLabel, current, available } = input
  if (available.length === 0) {
    return `Model \`${modelLabel}\` has no thinking/reasoning variants.`
  }
  const cur = current ? `\`${current}\`` : "(default / off)"
  const list = available.map((v) => (v === current ? `- \`${v}\` ← current` : `- \`${v}\``)).join("\n")
  return (
    `Thinking for \`${modelLabel}\`: ${cur}\n\n` +
    `Available:\n${list}\n\n` +
    `Set with \`/think <level>\` or \`/think off\`.`
  )
}
