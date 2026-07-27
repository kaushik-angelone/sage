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

export function resolveEmbeddedAsset(
  ui: EmbeddedWebUI,
  requestPath: string,
  options?: { spaFallback?: boolean },
): { key: string; asset: EmbeddedAsset } | null {
  const key = requestPath.replace(/^\//, "")
  const exact = ui[key]
  if (exact) return { key, asset: exact }
  // SPA fallback serves index.html for unknown paths (client-side routes). Callers that
  // handle API traffic must pass spaFallback:false so missing API routes 404 as JSON
  // instead of poisoning SDK clients with HTML.
  if (options?.spaFallback === false) return null
  const asset = ui["index.html"]
  if (!asset) return null
  return { key: "index.html", asset }
}

/** True when the client is navigating for HTML rather than fetching JSON. */
export function prefersHtmlNavigation(accept: string | undefined, method: string): boolean {
  if (method !== "GET" && method !== "HEAD") return false
  if (!accept || accept === "*/*") return true
  const htmlIdx = accept.indexOf("text/html")
  const jsonIdx = accept.indexOf("application/json")
  if (jsonIdx !== -1 && (htmlIdx === -1 || jsonIdx < htmlIdx)) return false
  return htmlIdx !== -1 || !accept.includes("application/")
}

export function embeddedAssetBytes(asset: EmbeddedAsset): Uint8Array {
  if (asset.encoding === "base64") {
    return Uint8Array.from(Buffer.from(asset.body, "base64"))
  }
  return new TextEncoder().encode(asset.body)
}
