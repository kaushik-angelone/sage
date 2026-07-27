import { describe, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { buildAssetMap, renderGenModule } from "./generate-ui-gen"

describe("generate-ui-gen", () => {
  test("maps index.html and hashed assets", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "altimate-web-gen-"))
    fs.writeFileSync(path.join(root, "index.html"), "<!doctype html><html></html>")
    fs.mkdirSync(path.join(root, "assets"))
    fs.writeFileSync(path.join(root, "assets", "index-abc.js"), "console.log(1)")
    fs.writeFileSync(path.join(root, "assets", "index-abc.css"), "body{}")

    const map = buildAssetMap(root)
    expect(map["index.html"]?.encoding).toBe("utf8")
    expect(map["index.html"]?.body).toContain("<!doctype html>")
    expect(map["assets/index-abc.js"]?.mime).toContain("javascript")
    expect(map["assets/index-abc.css"]?.mime).toContain("css")

    const source = renderGenModule(map)
    expect(source).toContain("export default assets")
    expect(source).toContain("index.html")
  })
})
