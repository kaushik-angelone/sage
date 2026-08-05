import { describe, expect, test } from "bun:test"
import {
  clearOwuiTraceContext,
  getOwuiTraceContext,
  setOwuiTraceContext,
} from "../../src/server/routes/owui-trace-context"
import { FileExporter, Trace } from "../../src/altimate/observability/tracing"
import fs from "fs"
import os from "os"
import path from "path"

describe("owui-trace-context", () => {
  test("stores and clears per session", () => {
    setOwuiTraceContext("ses_a", { userId: "a@x.com", modelId: "altimate-builder", agent: "builder", groups: [] })
    expect(getOwuiTraceContext("ses_a")?.userId).toBe("a@x.com")
    clearOwuiTraceContext("ses_a")
    expect(getOwuiTraceContext("ses_a")).toBeUndefined()
  })

  test("applyOwuiContext sets userId, owuiModel, tags", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "owui-ctx-"))
    try {
      const trace = Trace.withExporters([new FileExporter(dir)])
      trace.startTrace("ses_b", {})
      trace.applyOwuiContext({
        userId: "user@example.com",
        modelId: "altimate-analyst",
        agent: "analyst",
      })
      await trace.flush()
      const file = path.join(dir, "ses_b.json")
      const body = JSON.parse(fs.readFileSync(file, "utf8"))
      expect(body.metadata.userId).toBe("user@example.com")
      expect(body.metadata.owuiModel).toBe("altimate-analyst")
      expect(body.metadata.agent).toBe("analyst")
      expect(body.metadata.tags).toContain("altimate-analyst")
      expect(body.metadata.tags).toContain("analyst")
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})
