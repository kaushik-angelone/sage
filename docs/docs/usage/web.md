# Web UI

Altimate Web is a local browser UI for chat sessions, served by the same process as `altimate serve`. When the CLI is built with the embedded SPA, `altimate web` opens that UI instead of proxying to a remote host.

## Quick start

```bash
altimate web
```

This starts the local server and opens the UI in your browser (default `http://localhost:<port>`). You can also point a browser at a running server:

```bash
altimate serve
# then open http://localhost:<port>
```

## Authentication

If `OPENCODE_SERVER_PASSWORD` is set, the server requires HTTP basic auth. The web UI shows a login form on 401.

| Variable | Default | Description |
| --- | --- | --- |
| `OPENCODE_SERVER_PASSWORD` | _(unset)_ | When set, enables basic auth. Without it the server is unsecured (a warning is printed). |
| `OPENCODE_SERVER_USERNAME` | `opencode` | Basic auth username. |

Example:

```bash
export OPENCODE_SERVER_PASSWORD=secret
altimate web
```

## What works in this MVP

- Session list, create, and select
- Chat composer and message transcript
- Streaming assistant text (SSE)
- Basic markdown in assistant replies
- Same-origin API calls to the local server

## Not in this MVP

- Tool-call UI, permissions, and questions
- Agent switcher, costs, and file attach
- Config screens and hosted multi-tenant web

For full agent tooling, use the [TUI](tui.md) or [CLI](cli.md).

## Build notes

Release / `build:local` builds `packages/web` and inlines assets into the CLI. Set `OPENCODE_SKIP_WEB_UI=1` to skip that step (the server then falls back to proxying `https://app.altimate.ai` when no embed is present).
