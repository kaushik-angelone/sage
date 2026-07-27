import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import type { OpencodeClient } from "@opencode-ai/sdk/v2/client"
import { createClient, loadAuth, probeAuth, saveAuth, type AuthCredentials } from "./client"
import { renderMarkdown } from "./markdown"
import type { MessageRow, Part, SessionInfo } from "./types"

type AuthState = "checking" | "needed" | "ready"

function sessionLabel(session: SessionInfo) {
  const title = session.title?.trim()
  if (title) return title
  return session.id.slice(0, 12)
}

function formatTime(ts?: number) {
  if (!ts) return ""
  try {
    return new Date(ts).toLocaleString()
  } catch {
    return ""
  }
}

function textFromParts(parts: Part[]) {
  return parts
    .filter((p) => p.type === "text" && typeof p.text === "string")
    .map((p) => p.text as string)
    .join("\n\n")
    .trim()
}

function AuthGate(props: {
  error: string | null
  onSubmit: (auth: AuthCredentials) => void
}) {
  const [username, setUsername] = useState("opencode")
  const [password, setPassword] = useState("")

  return (
    <div className="auth-screen">
      <form
        className="auth-card"
        onSubmit={(e) => {
          e.preventDefault()
          props.onSubmit({ username, password })
        }}
      >
        <div className="brand-name">ALTIMATE CODE</div>
        <h1>Sign in to server</h1>
        <p>This server requires HTTP basic auth. Default username is usually <code>opencode</code>.</p>
        <label>
          Username
          <input value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="username" />
        </label>
        <label>
          Password
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="current-password"
          />
        </label>
        {props.error ? <div className="error-banner">{props.error}</div> : null}
        <button className="btn btn-primary" type="submit">
          Connect
        </button>
      </form>
    </div>
  )
}

export function App() {
  const [authState, setAuthState] = useState<AuthState>("checking")
  const [authError, setAuthError] = useState<string | null>(null)
  const [auth, setAuth] = useState<AuthCredentials | null>(() => loadAuth())
  const [client, setClient] = useState<OpencodeClient | null>(null)

  const [sessions, setSessions] = useState<SessionInfo[]>([])
  const [sessionID, setSessionID] = useState<string | null>(null)
  const [messages, setMessages] = useState<MessageRow[]>([])
  const [draft, setDraft] = useState("")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [status, setStatus] = useState("Connecting…")

  const transcriptRef = useRef<HTMLDivElement>(null)
  const sseAbort = useRef<AbortController | null>(null)
  const partsRef = useRef<Map<string, Part>>(new Map())

  const activeSession = useMemo(
    () => sessions.find((s) => s.id === sessionID) ?? null,
    [sessions, sessionID],
  )

  const bootstrap = useCallback(async (nextAuth: AuthCredentials | null) => {
    setAuthState("checking")
    setAuthError(null)
    const result = await probeAuth(nextAuth)
    if (result === "unauthorized") {
      saveAuth(null)
      setAuth(null)
      setClient(null)
      setAuthState("needed")
      setAuthError("Unauthorized — check username/password")
      return
    }
    if (result === "error") {
      setAuthState("needed")
      setAuthError("Could not reach Altimate server")
      return
    }
    saveAuth(nextAuth)
    setAuth(nextAuth)
    setClient(createClient(nextAuth))
    setAuthState("ready")
    setStatus("Connected")
  }, [])

  useEffect(() => {
    void bootstrap(loadAuth())
  }, [bootstrap])

  const refreshSessions = useCallback(async (sdk: OpencodeClient) => {
    const res = await sdk.session.list({ limit: 100 })
    if (res.error) throw new Error("Failed to list sessions")
    const list = (res.data ?? []) as SessionInfo[]
    list.sort((a, b) => (b.time?.updated ?? 0) - (a.time?.updated ?? 0))
    setSessions(list)
    return list
  }, [])

  const loadMessages = useCallback(async (sdk: OpencodeClient, id: string) => {
    const res = await sdk.session.messages({ sessionID: id, limit: 200 })
    if (res.error) throw new Error("Failed to load messages")
    const rows = (res.data ?? []) as MessageRow[]
    partsRef.current = new Map()
    for (const row of rows) {
      for (const part of row.parts ?? []) {
        partsRef.current.set(part.id, part)
      }
    }
    setMessages(rows)
  }, [])

  const applyPart = useCallback((part: Part) => {
    if (!part?.id || !part.messageID) return
    partsRef.current.set(part.id, part)
    setMessages((prev) => {
      const idx = prev.findIndex((m) => m.info.id === part.messageID)
      if (idx === -1) {
        return [
          ...prev,
          {
            info: {
              id: part.messageID!,
              sessionID: part.sessionID ?? sessionID ?? "",
              role: "assistant",
            },
            parts: [part],
          },
        ]
      }
      const row = prev[idx]
      const partIdx = row.parts.findIndex((p) => p.id === part.id)
      const nextParts = [...row.parts]
      if (partIdx === -1) nextParts.push(part)
      else nextParts[partIdx] = part
      const next = [...prev]
      next[idx] = { ...row, parts: nextParts }
      return next
    })
  }, [sessionID])

  const applyDelta = useCallback((props: { messageID: string; partID: string; field: string; delta: string; sessionID?: string }) => {
    if (props.field !== "text") return
    const existing = partsRef.current.get(props.partID)
    const next: Part = {
      id: props.partID,
      type: "text",
      messageID: props.messageID,
      sessionID: props.sessionID ?? existing?.sessionID,
      text: `${typeof existing?.text === "string" ? existing.text : ""}${props.delta}`,
    }
    applyPart(next)
  }, [applyPart])

  const applyMessage = useCallback((info: MessageRow["info"]) => {
    setMessages((prev) => {
      const idx = prev.findIndex((m) => m.info.id === info.id)
      if (idx === -1) {
        return [...prev, { info, parts: [] }]
      }
      const next = [...prev]
      next[idx] = { ...next[idx], info }
      return next
    })
  }, [])

  useEffect(() => {
    if (!client || authState !== "ready") return
    let cancelled = false

    ;(async () => {
      try {
        setError(null)
        const list = await refreshSessions(client)
        if (cancelled) return
        if (!sessionID && list[0]) {
          setSessionID(list[0].id)
        }
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : "Failed to load sessions")
      }
    })()

    return () => {
      cancelled = true
    }
  }, [client, authState, refreshSessions])

  useEffect(() => {
    if (!client || !sessionID || authState !== "ready") return
    let cancelled = false
    ;(async () => {
      try {
        setError(null)
        await loadMessages(client, sessionID)
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : "Failed to load messages")
      }
    })()
    return () => {
      cancelled = true
    }
  }, [client, sessionID, authState, loadMessages])

  useEffect(() => {
    if (!client || authState !== "ready") return

    const abort = new AbortController()
    sseAbort.current?.abort()
    sseAbort.current = abort

    ;(async () => {
      let delay = 1000
      while (!abort.signal.aborted) {
        try {
          setStatus("Listening")
          const events = await client.global.event({
            signal: abort.signal,
            sseMaxRetryAttempts: 0,
          })
          delay = 1000
          for await (const event of events.stream) {
            if (abort.signal.aborted) break
            const payload = (event as { payload?: { type?: string; properties?: Record<string, unknown> } }).payload
              ?? (event as { type?: string; properties?: Record<string, unknown> })
            const type = payload.type
            const properties = payload.properties ?? {}

            if (type === "session.updated" || type === "session.created") {
              void refreshSessions(client).catch(() => {})
              continue
            }

            if (type === "message.updated") {
              const info = properties.info as MessageRow["info"] | undefined
              if (info?.sessionID && info.sessionID === sessionID) applyMessage(info)
              continue
            }

            if (type === "message.part.updated") {
              const part = (properties.part ?? properties) as Part
              if (part.sessionID && part.sessionID !== sessionID) continue
              if (!part.sessionID && sessionID) part.sessionID = sessionID
              applyPart(part)
              continue
            }

            if (type === "message.part.delta") {
              const deltaProps = properties as {
                messageID: string
                partID: string
                field: string
                delta: string
                sessionID?: string
              }
              if (deltaProps.sessionID && deltaProps.sessionID !== sessionID) continue
              applyDelta(deltaProps)
            }
          }
        } catch {
          if (abort.signal.aborted) break
          setStatus("Reconnecting…")
          await new Promise((r) => setTimeout(r, delay))
          delay = Math.min(delay * 2, 15000)
        }
      }
    })().catch(() => {})

    return () => {
      abort.abort()
    }
  }, [client, authState, sessionID, refreshSessions, applyMessage, applyPart, applyDelta])

  useEffect(() => {
    const el = transcriptRef.current
    if (!el) return
    el.scrollTop = el.scrollHeight
  }, [messages, busy])

  async function createSession() {
    if (!client) return
    setBusy(true)
    setError(null)
    try {
      const res = await client.session.create({})
      if (res.error || !res.data) throw new Error("Failed to create session")
      const created = res.data as SessionInfo
      await refreshSessions(client)
      setSessionID(created.id)
      setMessages([])
      partsRef.current = new Map()
    } catch (e) {
      setError(e instanceof Error ? e.message : "Create session failed")
    } finally {
      setBusy(false)
    }
  }

  async function sendPrompt() {
    if (!client || !sessionID) return
    const text = draft.trim()
    if (!text || busy) return
    setBusy(true)
    setError(null)
    setDraft("")
    try {
      await client.session.prompt(
        {
          sessionID,
          parts: [{ type: "text", text }],
        },
        { throwOnError: true },
      )
    } catch (e) {
      setError(e instanceof Error ? e.message : "Prompt failed")
      setDraft(text)
    } finally {
      setBusy(false)
    }
  }

  if (authState === "checking") {
    return (
      <div className="auth-screen">
        <div className="auth-card">
          <div className="brand-name">ALTIMATE CODE</div>
          <p>Checking server…</p>
        </div>
      </div>
    )
  }

  if (authState === "needed") {
    return (
      <AuthGate
        error={authError}
        onSubmit={(next) => {
          void bootstrap(next)
        }}
      />
    )
  }

  return (
    <div className="app">
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-name">ALTIMATE CODE</div>
          <div className="brand-sub">Web MVP</div>
        </div>
        <div className="sidebar-actions">
          <button className="btn btn-primary" type="button" disabled={busy} onClick={() => void createSession()}>
            New session
          </button>
          <button
            className="btn"
            type="button"
            onClick={() => {
              saveAuth(null)
              setAuth(null)
              setAuthState("needed")
            }}
          >
            Sign out
          </button>
        </div>
        <div className="session-list">
          {sessions.map((session) => (
            <button
              key={session.id}
              type="button"
              className={`session-item${session.id === sessionID ? " active" : ""}`}
              onClick={() => setSessionID(session.id)}
            >
              <span className="session-title">{sessionLabel(session)}</span>
              <span className="session-meta">{formatTime(session.time?.updated ?? session.time?.created)}</span>
            </button>
          ))}
          {sessions.length === 0 ? <div className="session-meta" style={{ padding: "0.5rem" }}>No sessions yet</div> : null}
        </div>
      </aside>

      <main className="main">
        <header className="main-header">
          <h1 className="main-title">{activeSession ? sessionLabel(activeSession) : "Altimate Code"}</h1>
          <div className="main-status">{status}{auth?.username ? ` · ${auth.username}` : ""}</div>
        </header>

        {error ? <div className="error-banner">{error}</div> : null}

        <div className="transcript" ref={transcriptRef}>
          {!sessionID ? (
            <div className="empty">
              <h2>Start a conversation</h2>
              <p>Create a session from the sidebar, then send a prompt. Streaming replies use the same API as the TUI.</p>
            </div>
          ) : messages.length === 0 ? (
            <div className="empty">
              <h2>Empty session</h2>
              <p>Ask about warehouses, dbt models, SQL, or anything in your project.</p>
            </div>
          ) : (
            messages.map((row) => {
              const text = textFromParts(row.parts)
              if (!text && row.info.role !== "user") return null
              const role = row.info.role === "user" ? "user" : "assistant"
              return (
                <article key={row.info.id} className={`message ${role}`}>
                  <div className="message-role">{role}</div>
                  {role === "assistant" ? (
                    <div className="message-body" dangerouslySetInnerHTML={{ __html: renderMarkdown(text || "…") }} />
                  ) : (
                    <div className="message-body">{text || "(empty)"}</div>
                  )}
                </article>
              )
            })
          )}
        </div>

        <form
          className="composer"
          onSubmit={(e) => {
            e.preventDefault()
            void sendPrompt()
          }}
        >
          <textarea
            value={draft}
            placeholder={sessionID ? "Message Altimate Code…" : "Create a session to start chatting"}
            disabled={!sessionID || busy}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                e.preventDefault()
                void sendPrompt()
              }
            }}
          />
          <div className="composer-row">
            <span className="composer-hint">⌘/Ctrl + Enter to send</span>
            <button className="btn btn-primary" type="submit" disabled={!sessionID || busy || !draft.trim()}>
              {busy ? "Sending…" : "Send"}
            </button>
          </div>
        </form>
      </main>
    </div>
  )
}
