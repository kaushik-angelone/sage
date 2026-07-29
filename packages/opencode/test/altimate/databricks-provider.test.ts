/**
 * Databricks AI Gateway Provider Tests
 *
 * Unit tests for PAT parsing, host validation, and request body transforms.
 * E2E tests for the serving endpoints API (skipped without credentials).
 *
 * For E2E tests, set:
 *   export DATABRICKS_HOST="myworkspace.cloud.databricks.com"
 *   export DATABRICKS_TOKEN="dapi1234567890abcdef"
 *
 * Run:
 *   bun test test/altimate/databricks-provider.test.ts
 */

import { describe, expect, test } from "bun:test"
import {
  databricksBaseURL,
  ensureGeminiThoughtSignatures,
  databricksModelIdFromAltimateModel,
  normalizeDatabricksApiBase,
  normalizeDatabricksGeminiResponseText,
  normalizeDatabricksModelId,
  parseDatabricksPAT,
  sanitizeGeminiToolParameters,
  SKIP_THOUGHT_SIGNATURE,
  transformDatabricksBody,
  VALID_HOST_RE,
} from "../../src/altimate/plugin/databricks"

// ---------------------------------------------------------------------------
// Host validation regex
// ---------------------------------------------------------------------------

describe("VALID_HOST_RE", () => {
  test("accepts standard AWS workspace host", () => {
    expect(VALID_HOST_RE.test("myworkspace.cloud.databricks.com")).toBe(true)
  })

  test("accepts Azure workspace host", () => {
    expect(VALID_HOST_RE.test("adb-1234567890.12.azuredatabricks.net")).toBe(true)
  })

  test("accepts GCP workspace host", () => {
    expect(VALID_HOST_RE.test("myworkspace.gcp.databricks.com")).toBe(true)
  })

  test("accepts hyphenated workspace names", () => {
    expect(VALID_HOST_RE.test("my-workspace-123.cloud.databricks.com")).toBe(true)
  })

  test("rejects bare hostname without domain", () => {
    expect(VALID_HOST_RE.test("myworkspace")).toBe(false)
  })

  test("rejects non-databricks domain", () => {
    expect(VALID_HOST_RE.test("myworkspace.cloud.example.com")).toBe(false)
  })

  test("rejects empty string", () => {
    expect(VALID_HOST_RE.test("")).toBe(false)
  })

  test("rejects URL with protocol", () => {
    expect(VALID_HOST_RE.test("https://myworkspace.cloud.databricks.com")).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// PAT parsing
// ---------------------------------------------------------------------------

describe("parseDatabricksPAT", () => {
  test("parses valid AWS host::token", () => {
    const result = parseDatabricksPAT("myworkspace.cloud.databricks.com::dapi1234567890abcdef")
    expect(result).toEqual({
      host: "myworkspace.cloud.databricks.com",
      token: "dapi1234567890abcdef",
    })
  })

  test("parses valid Azure host::token", () => {
    const result = parseDatabricksPAT("adb-123.45.azuredatabricks.net::dapi-token-here")
    expect(result).toEqual({
      host: "adb-123.45.azuredatabricks.net",
      token: "dapi-token-here",
    })
  })

  test("parses valid GCP host::token", () => {
    const result = parseDatabricksPAT("my-ws.gcp.databricks.com::dapiABCDEF123")
    expect(result).toEqual({
      host: "my-ws.gcp.databricks.com",
      token: "dapiABCDEF123",
    })
  })

  test("trims whitespace from host and token", () => {
    const result = parseDatabricksPAT("  myworkspace.cloud.databricks.com  ::  dapi123  ")
    expect(result).toEqual({
      host: "myworkspace.cloud.databricks.com",
      token: "dapi123",
    })
  })

  test("returns null for missing separator", () => {
    expect(parseDatabricksPAT("myworkspace.cloud.databricks.com:dapi123")).toBeNull()
  })

  test("returns null for empty host", () => {
    expect(parseDatabricksPAT("::dapi123")).toBeNull()
  })

  test("returns null for empty token", () => {
    expect(parseDatabricksPAT("myworkspace.cloud.databricks.com::")).toBeNull()
  })

  test("returns null for invalid host domain", () => {
    expect(parseDatabricksPAT("example.com::dapi123")).toBeNull()
  })

  test("returns null for empty string", () => {
    expect(parseDatabricksPAT("")).toBeNull()
  })

  test("returns null for single colon separator", () => {
    expect(parseDatabricksPAT("host.cloud.databricks.com:token")).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// API base URL
// ---------------------------------------------------------------------------

describe("normalizeDatabricksApiBase / databricksBaseURL", () => {
  test("defaults to serving-endpoints", () => {
    expect(normalizeDatabricksApiBase(undefined)).toBe("/serving-endpoints")
    expect(normalizeDatabricksApiBase("")).toBe("/serving-endpoints")
  })

  test("accepts AI Gateway MLflow path", () => {
    expect(normalizeDatabricksApiBase("/ai-gateway/mlflow/v1")).toBe("/ai-gateway/mlflow/v1")
    expect(normalizeDatabricksApiBase("ai-gateway/mlflow/v1/")).toBe("/ai-gateway/mlflow/v1")
  })

  test("rejects host injection and traversal", () => {
    expect(normalizeDatabricksApiBase("https://evil.example/x")).toBe("/serving-endpoints")
    expect(normalizeDatabricksApiBase("/ai-gateway/../admin")).toBe("/serving-endpoints")
  })

  test("builds OpenAI-compatible base URL without chat/completions", () => {
    expect(databricksBaseURL("angel-ds-dev.cloud.databricks.com", "/ai-gateway/mlflow/v1")).toBe(
      "https://angel-ds-dev.cloud.databricks.com/ai-gateway/mlflow/v1",
    )
  })
})

describe("normalizeDatabricksModelId", () => {
  test("accepts AI Gateway catalog ids", () => {
    expect(normalizeDatabricksModelId("system.ai.gemini-3-5-flash")).toBe("system.ai.gemini-3-5-flash")
    expect(normalizeDatabricksModelId("databricks-claude-sonnet-4-6")).toBe("databricks-claude-sonnet-4-6")
  })

  test("rejects empty and unsafe values", () => {
    expect(normalizeDatabricksModelId("")).toBeUndefined()
    expect(normalizeDatabricksModelId("https://evil")).toBeUndefined()
    expect(normalizeDatabricksModelId("../x")).toBeUndefined()
  })
})

describe("databricksModelIdFromAltimateModel", () => {
  test("extracts id from ALTIMATE_MODEL=databricks/...", () => {
    expect(databricksModelIdFromAltimateModel("databricks/system.ai.gemini-3-5-flash-lite")).toBe(
      "system.ai.gemini-3-5-flash-lite",
    )
  })

  test("ignores non-databricks providers", () => {
    expect(databricksModelIdFromAltimateModel("google/gemini-2.5-flash")).toBeUndefined()
    expect(databricksModelIdFromAltimateModel("google-vertex/gemini-2.5-pro")).toBeUndefined()
  })

  test("rejects malformed values", () => {
    expect(databricksModelIdFromAltimateModel("")).toBeUndefined()
    expect(databricksModelIdFromAltimateModel("databricks")).toBeUndefined()
    expect(databricksModelIdFromAltimateModel("databricks/")).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// Request body transforms
// ---------------------------------------------------------------------------

describe("transformDatabricksBody", () => {
  test("converts max_completion_tokens to max_tokens", () => {
    const input = JSON.stringify({
      model: "databricks-meta-llama-3-1-70b-instruct",
      messages: [{ role: "user", content: "hello" }],
      max_completion_tokens: 4096,
    })
    const result = JSON.parse(transformDatabricksBody(input).body)
    expect(result.max_tokens).toBe(4096)
    expect(result.max_completion_tokens).toBeUndefined()
  })

  test("preserves max_tokens if already present", () => {
    const input = JSON.stringify({
      model: "databricks-meta-llama-3-1-70b-instruct",
      messages: [{ role: "user", content: "hello" }],
      max_tokens: 2048,
    })
    const result = JSON.parse(transformDatabricksBody(input).body)
    expect(result.max_tokens).toBe(2048)
  })

  test("does not convert when both max_tokens and max_completion_tokens exist", () => {
    const input = JSON.stringify({
      model: "databricks-meta-llama-3-1-70b-instruct",
      messages: [{ role: "user", content: "hello" }],
      max_tokens: 2048,
      max_completion_tokens: 4096,
    })
    const result = JSON.parse(transformDatabricksBody(input).body)
    expect(result.max_tokens).toBe(2048)
    expect(result.max_completion_tokens).toBe(4096)
  })

  test("passes through body without max token fields unchanged", () => {
    const input = JSON.stringify({
      model: "databricks-dbrx-instruct",
      messages: [{ role: "user", content: "hello" }],
      stream: true,
    })
    const result = JSON.parse(transformDatabricksBody(input).body)
    expect(result.model).toBe("databricks-dbrx-instruct")
    expect(result.stream).toBe(true)
    expect(result.max_tokens).toBeUndefined()
  })

  test("strips stream_options and Gemini-unsupported tool schema keys for gemini models", () => {
    const input = JSON.stringify({
      model: "system.ai.gemini-3-5-flash",
      stream: true,
      stream_options: { include_usage: true },
      tools: [
        {
          type: "function",
          function: {
            name: "demo",
            parameters: {
              $schema: "https://json-schema.org/draft/2020-12/schema",
              type: "object",
              properties: {
                n: { type: "number", exclusiveMinimum: 0 },
                tags: { type: "object", propertyNames: { type: "string" } },
                const: { type: "string" },
              },
              additionalProperties: false,
            },
          },
        },
      ],
    })
    const result = JSON.parse(transformDatabricksBody(input).body)
    expect(result.stream_options).toBeUndefined()
    const params = result.tools[0].function.parameters
    expect(params.$schema).toBeUndefined()
    expect(params.additionalProperties).toBeUndefined()
    expect(params.properties.n.exclusiveMinimum).toBeUndefined()
    expect(params.properties.tags.propertyNames).toBeUndefined()
    // Parameter named `const` must be preserved
    expect(params.properties.const).toEqual({ type: "string" })
  })

  test("keeps stream_options for non-gemini Databricks models", () => {
    const input = JSON.stringify({
      model: "databricks-meta-llama-3-1-70b-instruct",
      stream_options: { include_usage: true },
    })
    const result = JSON.parse(transformDatabricksBody(input).body)
    expect(result.stream_options).toEqual({ include_usage: true })
  })
})

describe("sanitizeGeminiToolParameters", () => {
  test("converts const keyword to enum", () => {
    const result = sanitizeGeminiToolParameters({
      type: "object",
      properties: { mode: { const: "fast" } },
    }) as any
    expect(result.properties.mode.const).toBeUndefined()
    expect(result.properties.mode.enum).toEqual(["fast"])
  })
})

describe("ensureGeminiThoughtSignatures", () => {
  test("injects skip token when tool_calls lack thought_signature", () => {
    const messages: any[] = [
      { role: "user", content: "hi" },
      {
        role: "assistant",
        tool_calls: [{ id: "1", type: "function", function: { name: "read", arguments: "{}" } }],
      },
    ]
    ensureGeminiThoughtSignatures(messages)
    expect(messages[1].tool_calls[0].thoughtSignature).toBe(SKIP_THOUGHT_SIGNATURE)
    expect(messages[1].tool_calls[0].extra_content.google.thought_signature).toBe(SKIP_THOUGHT_SIGNATURE)
  })

  test("preserves Databricks top-level thoughtSignature and mirrors to extra_content", () => {
    const messages: any[] = [
      {
        role: "assistant",
        tool_calls: [
          {
            id: "1",
            type: "function",
            function: { name: "read", arguments: "{}" },
            thoughtSignature: "real-sig-from-gateway",
          },
        ],
      },
    ]
    ensureGeminiThoughtSignatures(messages)
    expect(messages[0].tool_calls[0].thoughtSignature).toBe("real-sig-from-gateway")
    expect(messages[0].tool_calls[0].extra_content.google.thought_signature).toBe("real-sig-from-gateway")
  })
})

describe("normalizeDatabricksGeminiResponseText", () => {
  test("maps Databricks thoughtSignature onto extra_content for AI SDK", () => {
    const sse = [
      `data: ${JSON.stringify({
        choices: [
          {
            delta: {
              tool_calls: [
                {
                  id: "read",
                  type: "function",
                  function: { name: "read", arguments: "{}" },
                  thoughtSignature: "sig-abc",
                },
              ],
            },
          },
        ],
      })}`,
      "",
      "data: [DONE]",
      "",
    ].join("\n")

    const out = normalizeDatabricksGeminiResponseText(sse)
    const line = out.split("\n").find((l) => l.startsWith("data: {"))!
    const payload = JSON.parse(line.slice(5).trim())
    const call = payload.choices[0].delta.tool_calls[0]
    expect(call.thoughtSignature).toBe("sig-abc")
    expect(call.extra_content.google.thought_signature).toBe("sig-abc")
  })
})

describe("transformDatabricksBody thought signatures", () => {
  test("injects thoughtSignature on gemini tool-call history", () => {
    const input = JSON.stringify({
      model: "system.ai.gemini-3-5-flash",
      messages: [
        { role: "user", content: "read foo" },
        {
          role: "assistant",
          tool_calls: [{ id: "c1", type: "function", function: { name: "read", arguments: "{}" } }],
        },
        { role: "tool", tool_call_id: "c1", content: "ok" },
      ],
    })
    const result = JSON.parse(transformDatabricksBody(input).body)
    expect(result.messages[1].tool_calls[0].thoughtSignature).toBe(SKIP_THOUGHT_SIGNATURE)
    expect(result.messages[1].tool_calls[0].extra_content.google.thought_signature).toBe(SKIP_THOUGHT_SIGNATURE)
  })
})

// ---------------------------------------------------------------------------
// E2E tests (skipped without credentials)
// ---------------------------------------------------------------------------

const DATABRICKS_HOST = process.env.DATABRICKS_HOST
const DATABRICKS_TOKEN = process.env.DATABRICKS_TOKEN
const HAS_DATABRICKS = !!(DATABRICKS_HOST && DATABRICKS_TOKEN)

describe("Databricks Serving Endpoints E2E", () => {
  const skipReason = HAS_DATABRICKS ? undefined : "DATABRICKS_HOST and DATABRICKS_TOKEN not set"

  test.skipIf(!HAS_DATABRICKS)("chat completion with foundation model", async () => {
    const baseURL = `https://${DATABRICKS_HOST}/serving-endpoints`
    const res = await fetch(`${baseURL}/databricks-meta-llama-3-1-8b-instruct/invocations`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${DATABRICKS_TOKEN}`,
      },
      body: JSON.stringify({
        messages: [{ role: "user", content: "Say hello in one word." }],
        max_tokens: 32,
      }),
    })

    expect(res.ok).toBe(true)
    const data = await res.json()
    expect(data.choices).toBeDefined()
    expect(data.choices.length).toBeGreaterThan(0)
    expect(data.choices[0].message.content).toBeTruthy()
  })

  test.skipIf(!HAS_DATABRICKS)("streaming chat completion", async () => {
    const baseURL = `https://${DATABRICKS_HOST}/serving-endpoints`
    const res = await fetch(`${baseURL}/databricks-meta-llama-3-1-8b-instruct/invocations`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${DATABRICKS_TOKEN}`,
      },
      body: JSON.stringify({
        messages: [{ role: "user", content: "Say hello." }],
        max_tokens: 32,
        stream: true,
      }),
    })

    expect(res.ok).toBe(true)
    expect(res.headers.get("content-type")).toContain("text/event-stream")

    const text = await res.text()
    expect(text).toContain("data:")
    expect(text).toContain("[DONE]")
  })
})
