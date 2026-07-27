export type SessionInfo = {
  id: string
  title?: string
  time?: {
    created?: number
    updated?: number
  }
}

export type MessageInfo = {
  id: string
  sessionID: string
  role: "user" | "assistant" | "system"
  time?: {
    created?: number
  }
}

export type TextPart = {
  id: string
  type: "text"
  text: string
}

export type Part = {
  id: string
  type: string
  sessionID?: string
  messageID?: string
  text?: string
  [key: string]: unknown
}

export type MessageRow = {
  info: MessageInfo
  parts: Part[]
}
