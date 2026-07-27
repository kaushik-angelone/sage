import type { EmbeddedAsset } from "../../generated/opencode-web-ui.gen"
import assets from "../../generated/opencode-web-ui.gen"

export type { EmbeddedAsset }

export type EmbeddedWebUI = Record<string, EmbeddedAsset>

export function loadEmbeddedWebUI(disableEmbeddedWebUi: boolean): EmbeddedWebUI | null {
  if (disableEmbeddedWebUi) return null
  if (!assets || typeof assets !== "object") return null
  if (!("index.html" in assets)) return null
  return assets as EmbeddedWebUI
}

export function resolveEmbeddedAsset(ui: EmbeddedWebUI, requestPath: string): { key: string; asset: EmbeddedAsset } | null {
  const key = requestPath.replace(/^\//, "")
  const asset = ui[key] ?? ui["index.html"]
  if (!asset) return null
  return { key: ui[key] ? key : "index.html", asset }
}

export function embeddedAssetBytes(asset: EmbeddedAsset): Uint8Array {
  if (asset.encoding === "base64") {
    return Uint8Array.from(Buffer.from(asset.body, "base64"))
  }
  return new TextEncoder().encode(asset.body)
}
