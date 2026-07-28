/**
 * Persist Open WebUI chat-id → altimate session-id mappings across process restarts.
 *
 * Default file: <$XDG_DATA_HOME>/altimate-code/owui-chat-sessions.json
 * Override: ALTIMATE_OWUI_SESSION_MAP
 */
import fs from "fs"
import path from "path"
import { Global } from "../../global"
import { Log } from "../../util/log"
import { SessionID } from "@/session/schema"

const log = Log.create({ service: "owui-session-map" })

type FileShape = {
  version: 1
  sessions: Record<string, string>
}

const memory = new Map<string, SessionID>()
let loaded = false

export function mapFilePath(): string {
  const override = process.env["ALTIMATE_OWUI_SESSION_MAP"]?.trim()
  if (override) return path.resolve(override)
  return path.join(Global.Path.data, "owui-chat-sessions.json")
}

/** Test seam: clear in-memory state (does not delete the file). */
export function resetForTests() {
  memory.clear()
  loaded = false
}

function ensureLoaded() {
  if (loaded) return
  loaded = true
  const file = mapFilePath()
  try {
    if (!fs.existsSync(file)) return
    const raw = fs.readFileSync(file, "utf8")
    const parsed = JSON.parse(raw) as Partial<FileShape>
    if (parsed?.version !== 1 || !parsed.sessions || typeof parsed.sessions !== "object") {
      log.warn("ignoring invalid owui session map", { file })
      return
    }
    for (const [key, id] of Object.entries(parsed.sessions)) {
      if (typeof key === "string" && typeof id === "string" && key && id) {
        memory.set(key, SessionID.make(id))
      }
    }
    log.info("loaded owui session map", { file, count: memory.size })
  } catch (error) {
    log.warn("failed to load owui session map", {
      file,
      error: error instanceof Error ? error.message : String(error),
    })
  }
}

function persist() {
  const file = mapFilePath()
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    const body: FileShape = {
      version: 1,
      sessions: Object.fromEntries([...memory.entries()].map(([k, v]) => [k, String(v)])),
    }
    const tmp = `${file}.${process.pid}.tmp`
    fs.writeFileSync(tmp, JSON.stringify(body, null, 2) + "\n", "utf8")
    fs.renameSync(tmp, file)
  } catch (error) {
    log.warn("failed to persist owui session map", {
      file,
      error: error instanceof Error ? error.message : String(error),
    })
  }
}

export function getMappedSession(chatKey: string): SessionID | undefined {
  ensureLoaded()
  return memory.get(chatKey)
}

export function setMappedSession(chatKey: string, sessionID: SessionID): void {
  ensureLoaded()
  memory.set(chatKey, sessionID)
  persist()
}

export function deleteMappedSession(chatKey: string): void {
  ensureLoaded()
  if (!memory.delete(chatKey)) return
  persist()
}
