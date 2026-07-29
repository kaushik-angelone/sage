import type { Hooks, PluginInput } from "@opencode-ai/plugin"
import { Auth, OAUTH_DUMMY_KEY } from "@/auth"

/**
 * Databricks workspace host regex.
 * Matches patterns like: myworkspace.cloud.databricks.com, adb-1234567890.12.azuredatabricks.net
 */
export const VALID_HOST_RE = /^[a-zA-Z0-9._-]+\.(cloud\.databricks\.com|azuredatabricks\.net|gcp\.databricks\.com)$/

/**
 * Validate a Databricks workspace host. Returns true only when the host
 * matches the whitelist regex AND contains no control/whitespace characters
 * (CR/LF/tab/space) — JS regex `$` matches before a trailing `\n`, so the
 * explicit check prevents CRLF-style injection if the value is ever spliced
 * into a URL or header.
 */
export function isValidDatabricksHost(host: string): boolean {
  if (!host) return false
  if (/[\r\n\t\s]/.test(host)) return false
  return VALID_HOST_RE.test(host)
}

/** Parse a `host::token` credential string for Databricks PAT auth. */
export function parseDatabricksPAT(code: string): { host: string; token: string } | null {
  const sep = code.indexOf("::")
  if (sep === -1) return null
  const host = code.substring(0, sep).trim()
  const token = code.substring(sep + 2).trim()
  if (!host || !token) return null
  if (!isValidDatabricksHost(host)) return null
  return { host, token }
}

/**
 * OpenAI-compatible API path under the workspace host.
 * - `/serving-endpoints` — Foundation Model / pay-per-token endpoints (default)
 * - `/ai-gateway/mlflow/v1` — AI Gateway MLflow OpenAI API (catalog models like system.ai.*)
 *
 * Override with env `DATABRICKS_API_BASE` (must be an absolute path, no host).
 */
export const DEFAULT_DATABRICKS_API_BASE = "/serving-endpoints"

export function normalizeDatabricksApiBase(raw: string | undefined): string {
  const fallback = DEFAULT_DATABRICKS_API_BASE
  if (raw == null || !raw.trim()) return fallback
  let path = raw.trim().replace(/\/+$/, "")
  if (!path.startsWith("/")) path = `/${path}`
  // Reject protocol/host injection and traversal — path only.
  if (/[\r\n\t\s]/.test(path) || path.includes("://") || path.includes("..")) return fallback
  if (!/^\/[A-Za-z0-9._/-]+$/.test(path)) return fallback
  return path
}

/** Build OpenAI-compatible base URL: `https://{host}{apiBase}` (no `/chat/completions`). */
export function databricksBaseURL(host: string, apiBase?: string): string {
  const base = normalizeDatabricksApiBase(apiBase)
  return `https://${host}${base}`
}

/**
 * Validate a Databricks model id (e.g. `system.ai.gemini-3-5-flash`
 * or `databricks-claude-sonnet-4-6`). Rejects path/host injection.
 */
export function normalizeDatabricksModelId(raw: string | undefined): string | undefined {
  if (raw == null) return undefined
  const id = raw.trim()
  if (!id) return undefined
  if (/[\r\n\t\s]/.test(id) || id.includes("://") || id.includes("..")) return undefined
  if (!/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(id)) return undefined
  return id
}

/**
 * Extract a Databricks model id from `ALTIMATE_MODEL=databricks/<id>`.
 * Returns undefined for other providers or malformed values.
 */
export function databricksModelIdFromAltimateModel(raw: string | undefined): string | undefined {
  if (raw == null) return undefined
  const full = raw.trim()
  if (!full) return undefined
  const slash = full.indexOf("/")
  if (slash <= 0) return undefined
  const provider = full.slice(0, slash).trim().toLowerCase()
  if (provider !== "databricks") return undefined
  return normalizeDatabricksModelId(full.slice(slash + 1))
}

/**
 * JSON Schema keywords Gemini FunctionDeclaration.parameters rejects.
 * Applied as a last-mile strip on Databricks → AI Gateway → Gemini requests.
 * Property *names* under `properties` / `$defs` / `definitions` are preserved.
 */
const GEMINI_UNSUPPORTED_SCHEMA_KEYS = new Set([
  "$schema",
  "$id",
  "$comment",
  "additionalProperties",
  "patternProperties",
  "propertyNames",
  "exclusiveMinimum",
  "exclusiveMaximum",
  "unevaluatedProperties",
  "unevaluatedItems",
  "dependencies",
  "dependentRequired",
  "dependentSchemas",
  "if",
  "then",
  "else",
  "not",
  "examples",
  "contentEncoding",
  "contentMediaType",
  "contentSchema",
  "uniqueItems",
])

const GEMINI_SCHEMA_PROPERTY_MAPS = new Set(["properties", "$defs", "definitions"])

/** Recursively strip Gemini-unsupported JSON Schema keywords from a tool parameters object. */
export function sanitizeGeminiToolParameters(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sanitizeGeminiToolParameters)
  if (value === null || typeof value !== "object") return value

  const obj = value as Record<string, unknown>
  const result: Record<string, unknown> = {}
  for (const [key, item] of Object.entries(obj)) {
    if (GEMINI_UNSUPPORTED_SCHEMA_KEYS.has(key)) continue
    if (key === "const") {
      if (!("enum" in result)) result.enum = [typeof item === "string" ? item : String(item)]
      continue
    }
    if (GEMINI_SCHEMA_PROPERTY_MAPS.has(key) && item !== null && typeof item === "object" && !Array.isArray(item)) {
      result[key] = Object.fromEntries(
        Object.entries(item as Record<string, unknown>).map(([name, nested]) => [
          name,
          sanitizeGeminiToolParameters(nested),
        ]),
      )
      continue
    }
    result[key] = sanitizeGeminiToolParameters(item)
  }
  return result
}

/**
 * Dummy signature accepted by Gemini 3 when history was built without real
 * thought signatures (OpenAI-compatible SDKs often drop / mis-key them).
 * See https://ai.google.dev/gemini-api/docs/thought-signatures
 */
export const SKIP_THOUGHT_SIGNATURE = "skip_thought_signature_validator"

/**
 * Databricks AI Gateway (MLflow OpenAI) returns thought signatures as a
 * top-level camelCase field on each tool_call:
 *   tool_calls[].thoughtSignature
 * while @ai-sdk/openai-compatible only reads:
 *   tool_calls[].extra_content.google.thought_signature
 * and Google's docs show the latter for OpenAI compat. We bridge both.
 */
export function extractToolCallThoughtSignature(call: Record<string, unknown>): string | undefined {
  if (typeof call.thoughtSignature === "string" && call.thoughtSignature.length > 0) {
    return call.thoughtSignature
  }
  if (typeof call.thought_signature === "string" && call.thought_signature.length > 0) {
    return call.thought_signature
  }
  const extra =
    call.extra_content && typeof call.extra_content === "object" && !Array.isArray(call.extra_content)
      ? (call.extra_content as Record<string, unknown>)
      : undefined
  const google =
    extra?.google && typeof extra.google === "object" && !Array.isArray(extra.google)
      ? (extra.google as Record<string, unknown>)
      : undefined
  if (typeof google?.thought_signature === "string" && google.thought_signature.length > 0) {
    return google.thought_signature
  }
  if (typeof google?.thoughtSignature === "string" && google.thoughtSignature.length > 0) {
    return google.thoughtSignature
  }
  return undefined
}

/** Write signature in both Databricks (`thoughtSignature`) and Google OpenAI-compat shapes. */
export function applyThoughtSignatureToToolCall(call: Record<string, unknown>, signature: string): void {
  call.thoughtSignature = signature
  const extra =
    call.extra_content && typeof call.extra_content === "object" && !Array.isArray(call.extra_content)
      ? (call.extra_content as Record<string, unknown>)
      : {}
  const google =
    extra.google && typeof extra.google === "object" && !Array.isArray(extra.google)
      ? (extra.google as Record<string, unknown>)
      : {}
  call.extra_content = {
    ...extra,
    google: {
      ...google,
      thought_signature: signature,
    },
  }
}

/**
 * Normalize a parsed chat.completion / chunk object so AI SDK can see
 * Databricks `thoughtSignature` via `extra_content.google.thought_signature`.
 */
export function normalizeDatabricksGeminiPayload(payload: unknown): unknown {
  if (!payload || typeof payload !== "object") return payload
  const obj = payload as Record<string, unknown>

  const normalizeToolCalls = (toolCalls: unknown) => {
    if (!Array.isArray(toolCalls)) return
    for (const call of toolCalls) {
      if (!call || typeof call !== "object") continue
      const c = call as Record<string, unknown>
      const sig = extractToolCallThoughtSignature(c)
      if (sig) applyThoughtSignatureToToolCall(c, sig)
    }
  }

  if (Array.isArray(obj.choices)) {
    for (const choice of obj.choices) {
      if (!choice || typeof choice !== "object") continue
      const ch = choice as Record<string, unknown>
      if (ch.message && typeof ch.message === "object") {
        normalizeToolCalls((ch.message as Record<string, unknown>).tool_calls)
      }
      if (ch.delta && typeof ch.delta === "object") {
        normalizeToolCalls((ch.delta as Record<string, unknown>).tool_calls)
      }
    }
  }

  return obj
}

/** Rewrite SSE or JSON response text so thought signatures are AI-SDK-visible. */
export function normalizeDatabricksGeminiResponseText(raw: string): string {
  const trimmed = raw.trim()
  if (!trimmed) return raw

  // Non-streaming JSON body
  if (trimmed.startsWith("{")) {
    try {
      return JSON.stringify(normalizeDatabricksGeminiPayload(JSON.parse(trimmed)))
    } catch {
      return raw
    }
  }

  // SSE stream: rewrite each data: JSON line
  if (!trimmed.includes("data:")) return raw
  return raw
    .split("\n")
    .map((line) => {
      if (!line.startsWith("data:")) return line
      const data = line.slice(5).trim()
      if (!data || data === "[DONE]") return line
      try {
        const parsed = JSON.parse(data)
        return `data: ${JSON.stringify(normalizeDatabricksGeminiPayload(parsed))}`
      } catch {
        return line
      }
    })
    .join("\n")
}

/**
 * Ensure assistant tool_calls carry thought signatures for Gemini 3.
 * Databricks requires top-level `thoughtSignature`; Google OpenAI-compat uses
 * `extra_content.google.thought_signature`. We set both.
 */
export function ensureGeminiThoughtSignatures(messages: unknown): void {
  if (!Array.isArray(messages)) return
  for (const msg of messages) {
    if (!msg || typeof msg !== "object") continue
    const role = (msg as { role?: unknown }).role
    if (role !== "assistant" && role !== "model") continue
    const toolCalls = (msg as { tool_calls?: unknown }).tool_calls
    if (!Array.isArray(toolCalls)) continue

    for (const call of toolCalls) {
      if (!call || typeof call !== "object") continue
      const c = call as Record<string, unknown>
      const existing = extractToolCallThoughtSignature(c)
      applyThoughtSignatureToToolCall(c, existing ?? SKIP_THOUGHT_SIGNATURE)
    }
  }
}

/**
 * Transform a Databricks request body string.
 * Databricks Foundation Model APIs use max_tokens (OpenAI-compatible),
 * but some endpoints may prefer max_completion_tokens.
 *
 * Gemini models via AI Gateway are strict: strip OpenAI-only fields that the
 * gateway maps into Gemini `generation_config` / `function_declarations`, and
 * ensure thought signatures are present on tool-call history.
 */
export function transformDatabricksBody(bodyText: string): { body: string } {
  const parsed = JSON.parse(bodyText)

  // Databricks uses max_tokens for most endpoints, but some newer ones
  // expect max_completion_tokens. Normalize to max_tokens for compatibility.
  if ("max_completion_tokens" in parsed && !("max_tokens" in parsed)) {
    parsed.max_tokens = parsed.max_completion_tokens
    delete parsed.max_completion_tokens
  }

  const model = typeof parsed.model === "string" ? parsed.model.toLowerCase() : ""
  if (model.includes("gemini")) {
    // OpenAI SDK sends stream_options; Gemini generation_config rejects it.
    delete parsed.stream_options

    if (Array.isArray(parsed.tools)) {
      parsed.tools = parsed.tools.map((tool: unknown) => {
        if (!tool || typeof tool !== "object") return tool
        const t = tool as Record<string, unknown>
        const fn = t.function
        if (!fn || typeof fn !== "object") return tool
        const f = fn as Record<string, unknown>
        if (f.parameters == null) return tool
        return {
          ...t,
          function: {
            ...f,
            parameters: sanitizeGeminiToolParameters(f.parameters),
          },
        }
      })
    }

    ensureGeminiThoughtSignatures(parsed.messages)
  }

  return { body: JSON.stringify(parsed) }
}

function copyHeaders(init?: RequestInit): Headers {
  const headers = new Headers()
  if (!init?.headers) return headers
  if (init.headers instanceof Headers) {
    init.headers.forEach((value, key) => headers.set(key, value))
  } else if (Array.isArray(init.headers)) {
    for (const [key, value] of init.headers) {
      if (value !== undefined) headers.set(key, String(value))
    }
  } else {
    for (const [key, value] of Object.entries(init.headers)) {
      if (value !== undefined) headers.set(key, String(value))
    }
  }
  return headers
}

/** Read a fetch body as text when possible (sync path for string/bytes). */
export function readFetchBodyTextSync(body: BodyInit | null | undefined): string | undefined {
  if (body == null) return undefined
  if (typeof body === "string") return body
  if (body instanceof Uint8Array) return new TextDecoder().decode(body)
  if (body instanceof ArrayBuffer) return new TextDecoder().decode(body)
  return undefined
}

/** Apply Databricks body transforms to a fetch RequestInit (best-effort, sync). */
export function applyDatabricksBodyTransform(
  init?: RequestInit,
): { headers?: Headers; body?: BodyInit | null } {
  const text = readFetchBodyTextSync(init?.body ?? undefined)
  if (text == null || text === "") return {}

  try {
    const result = transformDatabricksBody(text)
    const headers = copyHeaders(init)
    headers.delete("content-length")
    return { headers, body: result.body }
  } catch (err) {
    // JSON parse error — pass original body through untransformed.
    if (process.env["DEBUG"]) {
      // eslint-disable-next-line no-console
      console.debug("databricks: body transform skipped", err)
    }
    return {}
  }
}

/** Line-buffered transform of an SSE body to normalize Gemini thought signatures. */
export function mapSseThoughtSignatures(source: ReadableStream<Uint8Array>): ReadableStream<Uint8Array> {
  const decoder = new TextDecoder()
  const encoder = new TextEncoder()
  let buffer = ""
  const reader = source.getReader()
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      const { done, value } = await reader.read()
      if (done) {
        if (buffer.length > 0) {
          controller.enqueue(encoder.encode(normalizeDatabricksGeminiResponseText(buffer)))
        }
        controller.close()
        return
      }
      buffer += decoder.decode(value, { stream: true })
      const lines = buffer.split("\n")
      buffer = lines.pop() ?? ""
      if (lines.length === 0) return
      const chunk = lines.join("\n") + "\n"
      controller.enqueue(encoder.encode(normalizeDatabricksGeminiResponseText(chunk)))
    },
    cancel(reason) {
      return reader.cancel(reason)
    },
  })
}

function responseLooksLikeGemini(requestBody: string, response: Response): boolean {
  try {
    const model = String(JSON.parse(requestBody)?.model ?? "").toLowerCase()
    if (model.includes("gemini")) return true
  } catch {
    /* ignore */
  }
  // Fallback: some gateways omit model on error bodies.
  const url = String(response.url ?? "")
  return url.toLowerCase().includes("gemini")
}

/**
 * Wrap any fetch implementation so Databricks/Gemini request rewrites always run.
 * Used by the auth plugin and by Provider.getSDK (so config-only apiKey paths
 * still get thought_signature / schema sanitization).
 */
export function wrapDatabricksFetch(
  upstream: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response> = fetch,
): (input: RequestInfo | URL, init?: RequestInit) => Promise<Response> {
  return async (requestInput: RequestInfo | URL, init?: RequestInit) => {
    let text = readFetchBodyTextSync(init?.body ?? undefined)
    // AI SDK may pass a Blob; read it asynchronously.
    if (text == null && init?.body && typeof Blob !== "undefined" && init.body instanceof Blob) {
      try {
        text = await init.body.text()
      } catch {
        text = undefined
      }
    }
    if (text == null || text === "") return upstream(requestInput, init)

    try {
      const result = transformDatabricksBody(text)
      const headers = copyHeaders(init)
      headers.delete("content-length")
      const response = await upstream(requestInput, { ...init, headers, body: result.body })

      if (!responseLooksLikeGemini(result.body, response) || !response.body) return response

      const contentType = response.headers.get("content-type") ?? ""
      if (contentType.includes("text/event-stream") || contentType.includes("event-stream")) {
        return new Response(mapSseThoughtSignatures(response.body), {
          status: response.status,
          statusText: response.statusText,
          headers: response.headers,
        })
      }

      // Non-streaming JSON
      const raw = await response.text()
      const normalized = normalizeDatabricksGeminiResponseText(raw)
      return new Response(normalized, {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
      })
    } catch (err) {
      if (process.env["DEBUG"]) {
        // eslint-disable-next-line no-console
        console.debug("databricks: body transform skipped", err)
      }
      return upstream(requestInput, init)
    }
  }
}

/** Fetch wrapper that rewrites Databricks/Gemini-incompatible request fields. */
export function databricksFetch(requestInput: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  return wrapDatabricksFetch(fetch)(requestInput, init)
}

export async function DatabricksAuthPlugin(_input: PluginInput): Promise<Hooks> {
  return {
    auth: {
      provider: "databricks",
      async loader(getAuth, provider) {
        const auth = await getAuth()
        if (auth.type !== "oauth") return {}

        // Host validation lives in the provider loader (see provider.ts) —
        // the plugin auth type doesn't expose accountId. The provider loader
        // re-validates with `isValidDatabricksHost` on every config load, so
        // a tampered auth.json can't redirect `baseURL` to an unknown host.

        for (const model of Object.values(provider.models)) {
          model.cost = { input: 0, output: 0, cache: { read: 0, write: 0 } }
        }

        return {
          apiKey: OAUTH_DUMMY_KEY,
          // Gemini via AI Gateway rejects stream_options; disable usage streaming.
          includeUsage: false,
          async fetch(requestInput: RequestInfo | URL, init?: RequestInit) {
            const currentAuth = await getAuth()
            if (currentAuth.type !== "oauth") return databricksFetch(requestInput, init)

            const headers = new Headers()
            if (init?.headers) {
              if (init.headers instanceof Headers) {
                init.headers.forEach((value, key) => headers.set(key, value))
              } else if (Array.isArray(init.headers)) {
                for (const [key, value] of init.headers) {
                  if (value !== undefined) headers.set(key, String(value))
                }
              } else {
                for (const [key, value] of Object.entries(init.headers)) {
                  if (value !== undefined) headers.set(key, String(value))
                }
              }
            }

            headers.set("authorization", `Bearer ${currentAuth.access}`)

            const transformed = applyDatabricksBodyTransform({ ...init, headers })
            const body = transformed.body ?? init?.body
            const outHeaders = transformed.headers ?? headers

            return fetch(requestInput, { ...init, headers: outHeaders, body })
          },
        }
      },
      methods: [
        {
          label: "Databricks PAT",
          type: "oauth",
          authorize: async () => ({
            url: "https://accounts.cloud.databricks.com",
            instructions:
              "Enter your credentials as: <workspace-host>::<PAT-token>\n  e.g. myworkspace.cloud.databricks.com::dapi1234567890abcdef\n  Create a PAT in Databricks: Settings → Developer → Access Tokens → Generate New Token",
            method: "code" as const,
            callback: async (code: string) => {
              const parsed = parseDatabricksPAT(code)
              if (!parsed) return { type: "failed" as const }
              return {
                type: "success" as const,
                access: parsed.token,
                refresh: "",
                // Databricks PATs can be configured with custom TTLs; use 90-day default
                expires: Date.now() + 90 * 24 * 60 * 60 * 1000,
                accountId: parsed.host,
              }
            },
          }),
        },
      ],
    },
  }
}
