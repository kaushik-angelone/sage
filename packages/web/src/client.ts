import { createOpencodeClient, type OpencodeClient } from "@opencode-ai/sdk/v2/client"

export type AuthCredentials = {
  username: string
  password: string
}

const AUTH_KEY = "altimate.web.auth"

export function loadAuth(): AuthCredentials | null {
  try {
    const raw = sessionStorage.getItem(AUTH_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as AuthCredentials
    if (!parsed?.username) return null
    return parsed
  } catch {
    return null
  }
}

export function saveAuth(auth: AuthCredentials | null) {
  if (!auth) {
    sessionStorage.removeItem(AUTH_KEY)
    return
  }
  sessionStorage.setItem(AUTH_KEY, JSON.stringify(auth))
}

export function basicAuthHeader(auth: AuthCredentials | null): Record<string, string> {
  if (!auth?.password && !auth?.username) return {}
  const token = btoa(`${auth?.username || "opencode"}:${auth?.password || ""}`)
  return { Authorization: `Basic ${token}` }
}

export function createClient(auth: AuthCredentials | null = loadAuth()): OpencodeClient {
  const baseUrl = window.location.origin
  return createOpencodeClient({
    baseUrl,
    headers: basicAuthHeader(auth),
  })
}

export async function probeAuth(auth: AuthCredentials | null): Promise<"ok" | "unauthorized" | "error"> {
  try {
    const headers = {
      ...basicAuthHeader(auth),
      Accept: "application/json",
    }
    const res = await fetch(`${window.location.origin}/session`, { headers })
    if (res.status === 401 || res.status === 403) return "unauthorized"
    if (!res.ok) return "error"
    return "ok"
  } catch {
    return "error"
  }
}
