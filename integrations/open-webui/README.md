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

| Bridge chunk (`message_type`) | Filter behavior |
| --- | --- |
| `tool call` | Emits a status pill (friendly label + arg preview); drops the raw JSON. |
| `tool response` | Dropped (kept out of the message body). |
| `text` | Forwarded to the message body unchanged. |
| completion sentinel (`stream_complete` / `finish_reason: stop`) | Emits a "✅ Complete in Xs" done pill. |
| `error` | Emits a "❌ Error occurred." pill. |

Tool labels and argument previews live in `TOOL_LABELS` / `ARG_PREVIEW` at the top
of `filter.py` — edit those to taste.
