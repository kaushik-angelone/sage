import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import fs from "fs"
import os from "os"
import path from "path"
import {
  deleteMappedSession,
  getMappedSession,
  mapFilePath,
  resetForTests,
  setMappedSession,
} from "../../src/server/routes/owui-session-map"
import { SessionID } from "../../src/session/schema"

let tmpDir: string
let prevMap: string | undefined

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "owui-map-"))
  prevMap = process.env["ALTIMATE_OWUI_SESSION_MAP"]
  process.env["ALTIMATE_OWUI_SESSION_MAP"] = path.join(tmpDir, "map.json")
  resetForTests()
})

afterEach(() => {
  resetForTests()
  if (prevMap === undefined) delete process.env["ALTIMATE_OWUI_SESSION_MAP"]
  else process.env["ALTIMATE_OWUI_SESSION_MAP"] = prevMap
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

describe("owui-session-map", () => {
  test("persists and reloads chat→session mapping", () => {
    const id = SessionID.make("ses_test123")
    setMappedSession("dir::chat-a", id)
    expect(fs.existsSync(mapFilePath())).toBe(true)

    resetForTests()
    expect(getMappedSession("dir::chat-a")).toBe(id)
  })

  test("delete removes mapping from disk", () => {
    setMappedSession("dir::chat-b", SessionID.make("ses_b"))
    deleteMappedSession("dir::chat-b")
    resetForTests()
    expect(getMappedSession("dir::chat-b")).toBeUndefined()
  })

  test("ignores corrupt file", () => {
    fs.writeFileSync(mapFilePath(), "{not json", "utf8")
    expect(getMappedSession("x")).toBeUndefined()
  })
})
