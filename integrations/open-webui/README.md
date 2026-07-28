# Open WebUI integration

Use [Open WebUI](https://github.com/open-webui/open-webui) as a chat front-end for
`altimate` (sage). Two pieces are involved:

1. **The bridge** — `altimate serve` exposes an OpenAI-compatible API at
   `/v1/models` and `/v1/chat/completions`
   (`packages/opencode/src/server/routes/openai.ts`). Point Open WebUI at it as an
   OpenAI connection.
2. **The filter** — [`filter.py`](./filter.py), an Open WebUI *Filter Function*
   that turns the bridge's raw streaming chunks into a clean chat experience
   (tool-call status pills, dropped raw tool JSON, a completion pill).

## 1. Run the bridge

```bash
# Point the bridge at the project directory it should operate in.
export ALTIMATE_OWUI_PROJECT_DIR="/absolute/path/to/your/project"

# Optional overrides:
export ALTIMATE_OWUI_MODEL="altimate-code"   # model id shown to Open WebUI
export ALTIMATE_OWUI_AGENT="build"           # agent to run (defaults to bridge default)
export ALTIMATE_OWUI_PERMISSION="approve"    # "approve" (default) or "reject" tool permissions

altimate serve --port 4096
```

Verify it:

```bash
curl http://localhost:4096/v1/models
```

## 2. Add the connection in Open WebUI

Admin Panel -> Settings -> Connections -> add an **OpenAI API** connection:

- **Base URL:** `http://<host>:4096/v1`
- **API Key:** any non-empty string (the bridge does not check it)

The `altimate-code` model should now appear in the model picker.

> Session continuity relies on Open WebUI forwarding the `X-OpenWebUI-Chat-Id`
> header. Enable "Forward User Info Headers" in Open WebUI so each chat maps to a
> stable sage session.

## 3. Install the filter

Admin Panel -> Functions -> **+** -> paste the contents of [`filter.py`](./filter.py),
save, enable it, and attach it to the `altimate-code` model (or make it global).

### What the filter does

| Bridge chunk | Filter behavior |
| --- | --- |
| tool call (`{"name","args"}`) | Emits a status pill (friendly label + arg preview); drops the raw JSON. |
| tool response (`{"name","duration"}`) | Dropped (kept out of the message body). |
| reasoning (`delta.reasoning_content`) | Forwarded for Open WebUI’s native Thought collapsible. |
| plain text | Forwarded; if a chunk starts with a markdown block marker (`#`, `-`, `*`, …) and the previous chunk ended with a full stop (`.`), a newline is prefixed. |
| completion sentinel (`stream_complete` / `finish_reason: stop`) | Emits a "✅ Complete in Xs" done pill. |
| error | Emits a "❌ Error occurred." pill. |

Detection is content-based (it parses the `{"name", ...}` payload), so it does not
depend on Open WebUI forwarding the custom `message_type` field.

Tool labels and argument previews live in `TOOL_LABELS` / `ARG_PREVIEW` at the top
of `filter.py` — edit those to taste.

### Surfacing SQL (and other tool args) into the chat

`REVEAL_TOOLS` maps a tool name to a function that renders its arguments into the
message body. By default `sql_execute` renders the executed statement as a
```sql``` code block above the answer, so the underlying SQL shows alongside the
response. Add more entries to reveal other tools.

### Execution time

The "Complete in Xs" pill uses `overall_duration` from the bridge's final chunk
when present, and otherwise falls back to the time the filter measured for the
turn — so it stays correct even if the running `altimate` binary predates the
`overall_duration` bridge change. Rebuild the binary to get the exact
server-measured duration.
