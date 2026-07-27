"""Open WebUI Filter Function for the Altimate / sage OpenAI-compatible bridge.

Paste this into Open WebUI (Admin Panel -> Functions -> new Filter) and enable it
for the `altimate-code` model. It turns the raw streaming chunks emitted by
`altimate serve`'s `/v1/chat/completions` bridge into a clean chat experience:

  * `message_type: "tool call"`   -> a compact status pill (spinner) with a
                                      friendly label + argument preview, and the
                                      raw JSON chunk is dropped from the message.
  * `message_type: "tool response"` -> dropped (kept out of the message body).
  * `message_type: "text"`        -> forwarded to the message body unchanged.
  * completion sentinel           -> a "Complete in Xs" done status pill.
  * `message_type: "error"`       -> an error status pill.

The bridge chunk contract (see packages/opencode/src/server/routes/openai.ts):
  - tool call:     delta.content = JSON {"name": <tool>, "args": {...}}
  - tool response: delta.content = JSON {"name": <tool>, "duration": <seconds>}
  - final chunk:   choices[0].finish_reason = "stop",
                   choices[0].stream_complete = true,
                   choices[0].overall_duration = <seconds>

This mirrors the Data-Agent-ADK OWUI filter, adapted to sage's tool set.
"""

import json
import logging
from typing import Optional

logger = logging.getLogger("altimate_owui_filter")
logging.basicConfig(level=logging.INFO)


# Friendly, human-readable labels per sage tool name.
TOOL_LABELS = {
    "bash": "⚙️ Running command",
    "shell": "⚙️ Running shell",
    "edit": "✏️ Editing file",
    "multiedit": "✏️ Editing file",
    "apply_patch": "🩹 Applying patch",
    "patch": "🩹 Applying patch",
    "write": "📝 Writing file",
    "read": "📖 Reading file",
    "grep": "🔎 Searching code",
    "glob": "🔍 Finding files",
    "list": "📂 Listing directory",
    "webfetch": "🌐 Fetching page",
    "websearch": "🌐 Searching the web",
    "codesearch": "🔎 Searching code knowledge",
    "task": "🤖 Delegating to subagent",
    "todowrite": "🗒️ Updating task list",
    "todoread": "🗒️ Reading task list",
    "lsp": "🧭 Inspecting with LSP",
    "skill": "🧠 Running skill",
    "question": "❓ Asking a question",
    "plan_enter": "🧠 Entering plan mode",
    "plan_exit": "🧠 Exiting plan mode",
}


def _basename(value: object) -> str:
    text = str(value or "").strip()
    if not text:
        return ""
    return text.rstrip("/").split("/")[-1]


# Which arg to preview after the label, keyed by tool name.
ARG_PREVIEW = {
    "bash": lambda a: a.get("description") or a.get("command"),
    "shell": lambda a: a.get("description") or a.get("command"),
    "edit": lambda a: _basename(a.get("filePath")),
    "multiedit": lambda a: _basename(a.get("filePath")),
    "write": lambda a: _basename(a.get("filePath")),
    "read": lambda a: _basename(a.get("filePath")),
    "grep": lambda a: a.get("pattern"),
    "glob": lambda a: a.get("pattern"),
    "list": lambda a: _basename(a.get("path")),
    "webfetch": lambda a: a.get("url"),
    "websearch": lambda a: a.get("query"),
    "codesearch": lambda a: a.get("query"),
    "task": lambda a: a.get("description"),
    "skill": lambda a: a.get("name"),
    "question": lambda a: a.get("question"),
}

# Fallback preview keys for unknown / project-specific tools (checked in order).
GENERIC_PREVIEW_KEYS = (
    "status_description",
    "description",
    "title",
    "query",
    "prompt",
    "command",
    "pattern",
    "filePath",
    "path",
    "url",
    "name",
)


def _fmt_duration(duration: object) -> str:
    if duration is None:
        return "0s"
    try:
        d = float(duration)
    except (TypeError, ValueError):
        logger.warning("Invalid execution duration: %r", duration)
        return "0s"
    if d > 60:
        return f"{int(d // 60)}m {int(d % 60)}s"
    return f"{int(d)}s"


class Filter:
    def __init__(self):
        self._complete_emitted = False

    def _reset_stream_state(self) -> None:
        self._complete_emitted = False

    async def _emit_status(self, description: str, done: bool, __event_emitter__) -> None:
        if __event_emitter__ is None:
            return
        await __event_emitter__(
            {
                "type": "status",
                "data": {"description": description, "done": done},
            }
        )

    async def _emit_complete(self, duration: object, __event_emitter__) -> None:
        if self._complete_emitted or __event_emitter__ is None:
            return
        await self._emit_status(
            f"✅ Complete in {_fmt_duration(duration)}. ", True, __event_emitter__
        )
        self._complete_emitted = True

    def _status_for_tool(self, tool_name: str, args: dict) -> str:
        # Backend-provided status_description always wins.
        if isinstance(args, dict):
            sd = args.get("status_description")
            if sd is not None and str(sd).strip():
                return str(sd).strip()

        label = TOOL_LABELS.get(tool_name, f"🔧 {tool_name}")

        preview = None
        if isinstance(args, dict):
            preview_fn = ARG_PREVIEW.get(tool_name)
            try:
                if preview_fn is not None:
                    preview = preview_fn(args)
                else:
                    # Unknown / project-specific tool: pick the first meaningful arg.
                    for key in GENERIC_PREVIEW_KEYS:
                        if key in args and str(args.get(key) or "").strip():
                            preview = args.get(key)
                            break
            except Exception:  # noqa: BLE001 - never let preview break the stream
                preview = None
        if preview is not None and str(preview).strip():
            preview = str(preview).strip().replace("\n", " ")
            if len(preview) > 50:
                preview = preview[:50] + "..."
            label += f" | {preview}"
        return label

    def _parse_tool_payload(self, text: str):
        """Return (kind, name, args) for a tool chunk, else None.

        kind is "call" (has args) or "response" (has duration). Detection is
        content-based so it works even when Open WebUI drops the custom
        top-level ``message_type`` field.
        """
        if not text or not str(text).lstrip().startswith("{"):
            return None
        try:
            parsed = json.loads(text)
        except (json.JSONDecodeError, TypeError):
            return None
        if not isinstance(parsed, dict) or not isinstance(parsed.get("name"), str):
            return None
        if "args" in parsed:
            return ("call", parsed["name"], parsed.get("args") or {})
        if "duration" in parsed:
            return ("response", parsed["name"], {})
        return None

    async def inlet(self, body: dict, __user__: Optional[dict] = None) -> dict:
        self._reset_stream_state()
        return body

    async def stream(self, event: dict, __event_emitter__=None) -> Optional[dict]:
        choices = event.get("choices", []) or []

        # Collect any text content in this chunk.
        contents = []
        for choice in choices:
            delta = choice.get("delta", {}) or {}
            if "content" in delta and delta.get("content") is not None:
                contents.append(delta["content"])
        text = contents[0] if contents else ""

        message_type = event.get("message_type")

        # Completion sentinel: no content, but the bridge flagged the turn done.
        first_choice = choices[0] if choices else {}
        is_complete_sentinel = bool(first_choice.get("stream_complete")) or (
            not str(text).strip()
            and (
                "overall_duration" in first_choice
                or first_choice.get("finish_reason") == "stop"
            )
        )
        if is_complete_sentinel:
            await self._emit_complete(
                first_choice.get("overall_duration", 0), __event_emitter__
            )
            return None

        # Tool call / response: detect from the JSON content directly so it works
        # regardless of whether Open WebUI forwarded the `message_type` hint.
        payload = self._parse_tool_payload(text)
        if payload is None and message_type in ("tool call", "tool response"):
            # message_type says tool but content wasn't parseable -> still drop it.
            return None
        if payload is not None:
            kind, tool_name, args = payload
            if kind == "call":
                await self._emit_status(
                    self._status_for_tool(tool_name, args), False, __event_emitter__
                )
            # Both tool call and tool response chunks are dropped from the body.
            return None

        # Error: surface as an error status pill; text still flows through below.
        if message_type == "error":
            await self._emit_status("❌ Error occurred.", True, __event_emitter__)
            return event

        # Role-only / empty deltas carry no content to show.
        if not str(text).strip():
            return None

        # Plain assistant text (and everything else) is forwarded unchanged.
        return event

    async def outlet(self, body: dict, __event_emitter__=None) -> Optional[dict]:
        # Emit a completion status in case the stream ended without a sentinel.
        duration = None
        if isinstance(body, dict):
            for choice in body.get("choices", []) or []:
                if isinstance(choice, dict) and "overall_duration" in choice:
                    duration = choice.get("overall_duration")
                    break
        await self._emit_complete(duration, __event_emitter__)
        return body
