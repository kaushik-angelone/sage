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

> Enable **Forward User Info Headers** in Open WebUI. The bridge uses:
>
> - `X-OpenWebUI-Chat-Id` — session continuity (persisted to
>   `$XDG_DATA_HOME/altimate-code/owui-chat-sessions.json`)
> - `X-OpenWebUI-User-Email` — Langfuse / trace `userId` (same as data-agent
>   `owui_client_v5.py`)
>
> Set `ALTIMATE_OWUI_MODEL` / `ALTIMATE_OWUI_AGENT` per portable instance so
> `/v1/models` and Langfuse tags distinguish builder vs analyst (e.g.
> `altimate-builder` + `builder`).

## 3. Install the filter

Admin Panel -> Functions -> **+** -> paste the contents of [`filter.py`](./filter.py),
save, enable it, and attach it to the `altimate-code` model (or make it global).

### What the filter does

| Bridge chunk | Filter behavior |
| --- | --- |
| tool call (`{"name","args"}`) | Emits a status pill (friendly label + arg preview); drops the raw JSON. For SQL tools the preview is the agent's `reason`. |
| tool response (`{"name","duration","status","error"}`) | Dropped from the message body. |
| Rich UI Embed (`args.embeds`) | Emits Open WebUI `embeds` (Plotly charts from `plot_dataframe`). |
| reasoning (`delta.reasoning_content`) | Forwarded for Open WebUI’s native Thought collapsible. |
| plain text | Forwarded; if a chunk starts with a markdown block marker (`#`, `-`, `*`, …) and the previous chunk ended with a full stop (`.`), a newline is prefixed. |
| completion sentinel (`stream_complete` / `finish_reason: stop`) | Emits a "✅ Complete in Xs" done pill. Final SQL is streamed by the bridge as ordinary text just before this sentinel. |
| error | Emits a "❌ Error occurred." pill. |

### Plotting in chat

Ask the agent to chart query results (e.g. “plot revenue by month”). It should
call `plot_dataframe` with `sql`, `x`, `y`, and `kind`. The bridge ships chart
HTML as a silent `Rich UI Embed` tool call; this filter turns that into an
inline iframe.

Re-paste `filter.py` into Open WebUI after pulling this change, and rebuild /
restart `altimate serve` so the new tool and bridge emit path are live.

Detection is content-based (it parses the `{"name", ...}` payload), so it does not
depend on Open WebUI forwarding the custom `message_type` field.

Tool labels and argument previews live in `TOOL_LABELS` / `ARG_PREVIEW` at the top
of `filter.py` — edit those to taste.

### SQL rationale and the final SQL

`sql_execute` takes an optional `reason` — one sentence from the agent explaining
why that query is being run. The builder and analyst prompts instruct the agent
to always pass it. The filter uses it in two places:

- **Per step** — the status pill reads `🧮 Executing SQL | Find the latest month
  with complete F&O data` instead of a truncated statement, so the step list
  reads as the agent's plan rather than a wall of SQL.
- **End of turn** — the bridge streams a `Final SQL` section as ordinary
  assistant text just before the completion sentinel. That puts it in the same
  stream Open WebUI uses to build the saved message body (filter-side message
  events get wiped when the body is rebuilt). The section shows the last query
  that succeeded, the warehouse it ran against, its rationale, and a one-line
  recap of the earlier queries (failed ones marked).

Queries that failed are excluded from `Final SQL`; if every query failed, the last
attempt is shown and the heading says so. Failure detection uses the tool's
result metadata on the bridge. A missing `reason` degrades to a statement
preview in the pill and no `Why:` line.

### Turn state and the completion pill

Open WebUI builds one `Filter` instance per function and reuses it for every
request, while `inlet`, `stream` and `outlet` arrive as three independent HTTP
requests — `outlet` is a separate `/api/chat/completed` call fired by the browser
after streaming ends. Those can interleave: turn N's `outlet` may land after turn
N+1 has already started, and two chats, two tabs, or a side-by-side model
comparison run through the same instance concurrently.

The filter therefore keys all per-turn state (timer, completion flag, collected
SQL) by `__metadata__["message_id"]` rather than storing it on `self`. When
metadata isn't forwarded it falls back to the chunk `id`, and the role-only
opening delta of each turn starts a fresh record under that key.

This is what caused the completion pill to intermittently go missing, or to show
a nonsensical duration such as "Complete in 0s": a stale `outlet` consumed the
shared "already completed" flag, so the next turn's real completion was
suppressed, and the shared start timestamp had been reset by the newer turn.

### Execution time

The "Complete in Xs" pill uses `overall_duration` from the bridge's final chunk
when present, and otherwise falls back to the time the filter measured for that
turn — so it stays correct even if the running `altimate` binary predates the
`overall_duration` bridge change. Rebuild the binary to get the exact
server-measured duration.
