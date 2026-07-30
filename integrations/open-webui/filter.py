"""Open WebUI Filter Function for the Altimate / sage OpenAI-compatible bridge.

Paste this into Open WebUI (Admin Panel -> Functions -> new Filter) and enable it
for the `altimate-code` model. It turns the raw streaming chunks emitted by
`altimate serve`'s `/v1/chat/completions` bridge into a clean chat experience:

  * `message_type: "tool call"`   -> a compact status pill (spinner) with a
                                      friendly label + argument preview, and the
                                      raw JSON chunk is dropped from the message.
                                      For SQL tools the preview is the agent's
                                      `reason` — why that query is being run.
  * `message_type: "tool response"` -> dropped (kept out of the message body).
  * `message_type: "text"`        -> forwarded to the message body; if a chunk
                                      starts with a markdown block marker (#, -,
                                      *, >, `, |, …) and the previous chunk ended
                                      with a full stop (.), a newline is prefixed
                                      so headings/lists don't glue mid-line.
  * reasoning deltas              -> forwarded as `delta.reasoning_content` for
                                      Open WebUI's native Thought collapsible.
  * Rich UI Embed tool call       -> chart HTML emitted as Open WebUI `embeds`,
                                      re-sent cumulatively per turn so multiple
                                      charts all stay visible (see
                                      _emit_rich_ui_embeds).
  * Execution Complete tool call  -> "✅ Complete in Xs" done status pill
                                      (preferred; survives OWUI stripping custom
                                      choice fields). Backup: stream_complete /
                                      finish_reason stop / outlet fallback.
                                      Final SQL is streamed by the bridge as
                                      ordinary text before this signal.
  * `message_type: "error"`       -> an error status pill.

The bridge chunk contract (see packages/opencode/src/server/routes/openai.ts):
  - tool call:     delta.content = JSON {"name": <tool>, "args": {...}}
  - tool response: delta.content = JSON {"name": <tool>, "duration": <seconds>,
                                         "status": "completed" | "error",
                                         "error": <message>}
                   `status` / `error` are absent on older binaries.
  - chart embed:   tool call name "Rich UI Embed", args.embeds = [html, ...]
  - turn done:     tool call name "Execution Complete", args.duration = <seconds>
  - reasoning:     delta.reasoning_content = <thought text>
  - final chunk:   choices[0].finish_reason = "stop",
                   choices[0].stream_complete = true,
                   choices[0].overall_duration = <seconds>

Per-turn state is keyed by `__metadata__["message_id"]` because Open WebUI shares
one Filter instance across every request — see MAX_TRACKED_TURNS below.

This mirrors the Data-Agent-ADK OWUI filter, adapted to sage's tool set.
"""

import json
import logging
import time
from collections import OrderedDict
from typing import Optional

logger = logging.getLogger("altimate_owui_filter")
logging.basicConfig(level=logging.INFO)


# Friendly, human-readable labels per sage tool name.
TOOL_LABELS = {
    "sql_execute": "🧮 Executing SQL",
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
    "plot_dataframe": "📊 Plotting chart",
}


def _basename(value: object) -> str:
    text = str(value or "").strip()
    if not text:
        return ""
    return text.rstrip("/").split("/")[-1]


def _one_line(value: object, limit: int = 70) -> str:
    """Collapse a multi-line statement into a short single-line preview."""
    text = " ".join(str(value or "").split())
    if len(text) > limit:
        text = text[:limit].rstrip() + "..."
    return text


# Which arg to preview after the label, keyed by tool name.
ARG_PREVIEW = {
    # `reason` is the agent's own explanation of why this query is being run;
    # fall back to the statement itself when the binary predates that arg.
    "sql_execute": lambda a: a.get("reason") or _one_line(a.get("query") or a.get("sql")),
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
    "question": lambda a: a.get("question") or next(
        (q.get("question") for q in (a.get("questions") or []) if isinstance(q, dict) and q.get("question")),
        None,
    ),
    "plot_dataframe": lambda a: a.get("title")
    or (
        f"{a.get('kind', 'bar')}: {a.get('y')} by {a.get('x')}"
        if a.get("x") and a.get("y")
        else a.get("sql") or a.get("kind")
    ),
}

# OWUI wraps each Rich UI embed in a sandboxed iframe. The document must
# postMessage its height to that parent. Split "</scr" + "ipt>" so pasting into
# OWUI's HTML editor does not break the script tag.
_IFRAME_HEIGHT_SCRIPT = (
    "<script>\n"
    "(function () {\n"
    "  function reportHeight() {\n"
    "    var h = Math.max(\n"
    "      document.documentElement ? document.documentElement.scrollHeight : 0,\n"
    "      document.body ? document.body.scrollHeight : 0\n"
    "    );\n"
    "    if (h > 0) {\n"
    "      parent.postMessage({ type: 'iframe:height', height: h }, '*');\n"
    "    }\n"
    "  }\n"
    "  window.addEventListener('load', reportHeight);\n"
    "  [50, 250, 1000, 2000].forEach(function (ms) {\n"
    "    setTimeout(reportHeight, ms);\n"
    "  });\n"
    "  if (window.ResizeObserver) {\n"
    "    var target = document.body || document.documentElement;\n"
    "    if (target) {\n"
    "      new ResizeObserver(reportHeight).observe(target);\n"
    "    }\n"
    "  }\n"
    "})();\n"
    "</"
    "script>\n"
)


def _ensure_iframe_height_script(html: str) -> str:
    """Inject height-reporting script into HTML that OWUI will embed as an iframe."""
    prepared = (html or "").strip()
    if not prepared:
        return prepared
    if "iframe:height" not in prepared and not prepared.lstrip().lower().startswith(
        "<iframe"
    ):
        lower = prepared.lower()
        if "</body>" in lower:
            idx = lower.rfind("</body>")
            prepared = prepared[:idx] + _IFRAME_HEIGHT_SCRIPT + prepared[idx:]
        else:
            prepared = prepared + _IFRAME_HEIGHT_SCRIPT
    return prepared


# Fallback preview keys for unknown / project-specific tools (checked in order).
GENERIC_PREVIEW_KEYS = (
    "status_description",
    "reason",
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

# Block-level markdown starters that look broken when glued onto the previous
# streamed token (e.g. "done.# Heading" → "done.\n# Heading").
_MD_LINE_STARTERS = ("#", "-", "*", "+", ">", "|", "`", "=", "~")

# Status pill previews are truncated to keep the pill on one line. SQL steps get
# more room because their preview is a full sentence of rationale.
PREVIEW_LIMIT_DEFAULT = 50
PREVIEW_LIMITS = {"sql_execute": 90}

# Open WebUI builds ONE Filter instance per function and reuses it for every
# request (utils/plugin.py: get_function_module_from_cache), while inlet, stream
# and outlet arrive as separate HTTP requests that interleave freely across
# turns, chats and users. Anything kept on `self` is therefore shared: a late
# outlet from the previous turn, a second chat, or a side-by-side model
# comparison would clobber the live turn's timer and completion flag. Turn state
# is keyed by the message id instead, and only a bounded number is retained.
MAX_TRACKED_TURNS = 32


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
        self._turns = OrderedDict()

    @staticmethod
    def _turn_key(metadata: Optional[dict], event: Optional[dict] = None) -> str:
        """Identify the turn a hook call belongs to.

        `message_id` is unique per assistant message, which is exactly one turn.
        The chunk `id` is the fallback for deployments that do not forward
        metadata to filters; it is stable per chat rather than per turn, so the
        role-only opening delta is what starts a fresh turn under that key.
        """
        if isinstance(metadata, dict):
            for key in ("message_id", "chat_id", "session_id"):
                value = metadata.get(key)
                if value:
                    return str(value)
        if isinstance(event, dict) and event.get("id"):
            return str(event["id"])
        return "_default"

    def _new_turn(self) -> dict:
        return {
            "started_at": time.monotonic(),
            "complete_emitted": False,
            "prev_ends_with_full_stop": False,
            "embeds": [],
        }

    def _turn(self, key: str) -> dict:
        turn = self._turns.get(key)
        if turn is None:
            turn = self._new_turn()
            self._turns[key] = turn
            while len(self._turns) > MAX_TRACKED_TURNS:
                self._turns.popitem(last=False)
        else:
            self._turns.move_to_end(key)
        return turn

    @staticmethod
    def _starts_markdown_line(text: str) -> bool:
        if not text or text.startswith("\n"):
            return False
        return text[0] in _MD_LINE_STARTERS

    def _ensure_markdown_newline(self, turn: dict, text: str) -> str:
        """Prefix a newline when markdown follows a sentence-ending full stop."""
        if not isinstance(text, str) or not text:
            return text
        out = text
        if self._starts_markdown_line(text) and turn["prev_ends_with_full_stop"]:
            out = "\n" + text
        # Ignore trailing whitespace/newlines when detecting a sentence end.
        turn["prev_ends_with_full_stop"] = text.rstrip().endswith(".")
        return out

    def _rewrite_delta_content(self, event: dict, original: str, updated: str) -> dict:
        if original == updated:
            return event
        choices = event.get("choices") or []
        for choice in choices:
            if not isinstance(choice, dict):
                continue
            delta = choice.get("delta")
            if not isinstance(delta, dict):
                continue
            if delta.get("content") == original:
                delta = dict(delta)
                delta["content"] = updated
                choice["delta"] = delta
                break
        return event

    def _resolve_duration(self, turn: dict, provided: object) -> float:
        try:
            d = float(provided) if provided is not None else 0.0
        except (TypeError, ValueError):
            d = 0.0
        # Fallback for binaries that predate the overall_duration bridge change:
        # time this turn ourselves, from its own first chunk.
        if d <= 0:
            d = max(0.0, time.monotonic() - turn["started_at"])
        return d

    async def _emit_status(self, description: str, done: bool, __event_emitter__) -> None:
        if __event_emitter__ is None:
            return
        await __event_emitter__(
            {
                "type": "status",
                "data": {"description": description, "done": done},
            }
        )

    async def _emit_rich_ui_embeds(self, turn: dict, args: dict, __event_emitter__) -> bool:
        """Emit chart HTML via Rich UI embeds. Return True if handled (drop chunk).

        Open WebUI's two halves disagree about `data.replace`: the frontend does
        an unconditional `message.embeds = data.embeds`, while the backend
        appends unless `replace` is true. Sending one chart per event therefore
        rendered only the newest chart live, but persisted all of them, so the
        rest appeared on reload. Re-sending every chart for the turn with
        `replace: True` matches both halves — the frontend's replace shows the
        whole set, and the backend's replace keeps the DB from stacking copies.
        """
        embeds = args.get("embeds") or []
        if not isinstance(embeds, list) or not embeds or __event_emitter__ is None:
            return True
        for item in embeds:
            if item is None:
                continue
            html = str(item).strip()
            if not html:
                continue
            html = _ensure_iframe_height_script(html)
            if html not in turn["embeds"]:
                turn["embeds"].append(html)
        if turn["embeds"]:
            await __event_emitter__(
                {
                    "type": "embeds",
                    "data": {
                        "embeds": list(turn["embeds"]),
                        "replace": True,
                    },
                }
            )
        return True

    async def _emit_complete(self, turn: dict, duration: object, __event_emitter__) -> None:
        if turn["complete_emitted"] or __event_emitter__ is None:
            return
        resolved = self._resolve_duration(turn, duration)
        await self._emit_status(
            f"✅ Complete in {_fmt_duration(resolved)}. ", True, __event_emitter__
        )
        turn["complete_emitted"] = True

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
            limit = PREVIEW_LIMITS.get(tool_name, PREVIEW_LIMIT_DEFAULT)
            label += f" | {_one_line(preview, limit)}"
        return label

    def _parse_tool_payload(self, text: str):
        """Return (kind, name, args) for a tool chunk, else None.

        kind is "call" (has args) or "response" (has duration / status). For a
        response the whole payload is returned so the outcome is available.
        Detection is content-based so it works even when Open WebUI drops the
        custom top-level ``message_type`` field.
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
        if "duration" in parsed or "status" in parsed:
            return ("response", parsed["name"], parsed)
        return None

    async def inlet(
        self,
        body: dict,
        __user__: Optional[dict] = None,
        __metadata__: Optional[dict] = None,
    ) -> dict:
        # Start this turn's state fresh; a retried or regenerated message reuses
        # its message id, so drop any earlier record under the same key.
        key = self._turn_key(__metadata__)
        self._turns.pop(key, None)
        self._turn(key)
        return body

    @staticmethod
    def _reasoning_delta(delta: dict) -> Optional[str]:
        for key in ("reasoning_content", "reasoning", "thinking"):
            value = delta.get(key)
            if isinstance(value, str) and value:
                return value
        return None

    async def stream(
        self,
        event: dict,
        __event_emitter__=None,
        __metadata__: Optional[dict] = None,
    ) -> Optional[dict]:
        if not isinstance(event, dict):
            return event
        key = self._turn_key(__metadata__, event)
        turn = self._turn(key)
        choices = [c for c in (event.get("choices") or []) if isinstance(c, dict)]

        # Collect any text content in this chunk.
        contents = []
        has_reasoning = False
        opens_turn = False
        for choice in choices:
            delta = choice.get("delta", {}) or {}
            if not isinstance(delta, dict):
                continue
            if "content" in delta and delta.get("content") is not None:
                contents.append(delta["content"])
            if self._reasoning_delta(delta):
                has_reasoning = True
            if delta.get("role") and "content" not in delta:
                opens_turn = True
        text = contents[0] if contents else ""

        # The bridge opens every turn with a role-only delta. Under the chunk-id
        # fallback key (stable per chat, not per turn) this marker is what keeps
        # one turn's completion flag from suppressing the next turn's pill.
        if opens_turn:
            turn = self._new_turn()
            self._turns[key] = turn
            return None

        message_type = event.get("message_type")

        # Completion sentinel: no content, but the bridge flagged the turn done.
        # Do not treat reasoning-only chunks as completion.
        first_choice = choices[0] if choices else {}
        is_complete_sentinel = bool(first_choice.get("stream_complete")) or (
            not str(text).strip()
            and not has_reasoning
            and (
                "overall_duration" in first_choice
                or first_choice.get("finish_reason") == "stop"
            )
        )
        if is_complete_sentinel:
            await self._emit_complete(
                turn, first_choice.get("overall_duration", 0), __event_emitter__
            )
            return None

        # Native Thought UI: forward reasoning_content / reasoning / thinking.
        if has_reasoning:
            return event

        # Tool call / response: detect from the JSON content directly so it works
        # regardless of whether Open WebUI forwarded the `message_type` hint.
        payload = self._parse_tool_payload(text)
        if payload is None and message_type in ("tool call", "tool response"):
            # message_type says tool but content wasn't parseable -> still drop it.
            return None
        if payload is not None:
            kind, tool_name, args = payload
            if kind == "call":
                # Silent chart delivery (mirrors data-agent Rich UI Embed path).
                if tool_name == "Rich UI Embed":
                    await self._emit_rich_ui_embeds(
                        turn, args if isinstance(args, dict) else {}, __event_emitter__
                    )
                    return None
                # Preferred completion signal — content-based so it works even
                # when OWUI drops stream_complete / overall_duration from choices.
                if tool_name in ("Execution Complete", "Plan Execution Complete"):
                    duration = args.get("duration") if isinstance(args, dict) else None
                    await self._emit_complete(turn, duration, __event_emitter__)
                    return None
                # The `question` tool ends the turn immediately after emitting
                # the question text into the message body; mark it done so OWUI
                # closes the spinner and the text below is visible right away.
                is_blocking = tool_name == "question"
                await self._emit_status(
                    self._status_for_tool(tool_name, args), is_blocking, __event_emitter__
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

        # Keep markdown block markers (# headings, lists, fences, …) on their
        # own line when the model streams them stuck to the previous token.
        fixed = self._ensure_markdown_newline(turn, str(text))
        return self._rewrite_delta_content(event, str(text), fixed)

    async def outlet(
        self,
        body: dict,
        __event_emitter__=None,
        __metadata__: Optional[dict] = None,
    ) -> Optional[dict]:
        # Fallback for a stream that ended without a sentinel (client disconnect,
        # aborted turn, a bridge that never wrote the final chunk). Scoped to this
        # turn only: outlet arrives as its own request and can land after the next
        # turn has already started.
        key = self._turn_key(__metadata__, body if isinstance(body, dict) else None)
        turn = self._turns.get(key)
        if turn is None or turn["complete_emitted"]:
            return body

        duration = None
        if isinstance(body, dict):
            for choice in body.get("choices", []) or []:
                if isinstance(choice, dict) and "overall_duration" in choice:
                    duration = choice.get("overall_duration")
                    break
        logger.info("no completion sentinel for turn %s; completing from outlet", key)
        await self._emit_complete(turn, duration, __event_emitter__)
        return body
