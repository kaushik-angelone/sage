/**
 * Build self-contained Plotly chart HTML for Open WebUI Rich UI embeds
 * (and local .html files). No Python / plotly npm dependency — traces are
 * constructed as plain JSON and rendered via the Plotly CDN.
 */

export type PlotKind = "bar" | "line" | "scatter" | "hist" | "pie" | "box" | "violin" | "area"

export const PLOT_KINDS: readonly PlotKind[] = [
  "bar",
  "line",
  "scatter",
  "hist",
  "pie",
  "box",
  "violin",
  "area",
] as const

export interface PlotSpec {
  rows: Record<string, unknown>[]
  x: string
  y: string
  kind?: PlotKind | string
  title?: string
  hue?: string
  /** Unique DOM id prefix; defaults to a short random slug. */
  chartId?: string
}

const MAX_ROWS = 5000

/** Injected so OWUI's outer iframe can resize to the chart. */
export const IFRAME_HEIGHT_SCRIPT = `<script>
(function () {
  function reportHeight() {
    var h = Math.max(
      document.documentElement ? document.documentElement.scrollHeight : 0,
      document.body ? document.body.scrollHeight : 0
    );
    if (h > 0) {
      parent.postMessage({ type: 'iframe:height', height: h }, '*');
    }
  }
  window.addEventListener('load', reportHeight);
  [50, 250, 1000, 2000].forEach(function (ms) {
    setTimeout(reportHeight, ms);
  });
  if (window.ResizeObserver) {
    var target = document.body || document.documentElement;
    if (target) {
      new ResizeObserver(reportHeight).observe(target);
    }
  }
})();
</script>`

export function ensureIframeHeightScript(html: string): string {
  const prepared = (html || "").trim()
  if (!prepared || prepared.includes("iframe:height")) return prepared
  const lower = prepared.toLowerCase()
  const idx = lower.lastIndexOf("</body>")
  if (idx >= 0) return prepared.slice(0, idx) + IFRAME_HEIGHT_SCRIPT + prepared.slice(idx)
  return prepared + IFRAME_HEIGHT_SCRIPT
}

export function prepareEmbedHtml(html: string): string {
  return ensureIframeHeightScript((html || "").trim())
}

export function defaultPlotTitle(kind: string, x: string, y: string): string {
  if (kind === "scatter") return `${y} vs ${x}`
  if (kind === "hist") return `Histogram of ${x}`
  if (kind === "pie") return `Pie chart of ${x}`
  if (kind === "box") return `Box plot of ${y} by ${x}`
  if (kind === "violin") return `Violin plot of ${y} by ${x}`
  if (kind === "area") return `Area chart of ${y} by ${x}`
  return `${y} by ${x}`
}

function normalizeKind(kind: string | undefined): PlotKind {
  const k = (kind || "bar").toLowerCase()
  return (PLOT_KINDS as readonly string[]).includes(k) ? (k as PlotKind) : "bar"
}

function colValues(rows: Record<string, unknown>[], col: string): unknown[] {
  return rows.map((r) => r[col])
}

function groupByHue(
  rows: Record<string, unknown>[],
  hue: string,
): Map<string, Record<string, unknown>[]> {
  const groups = new Map<string, Record<string, unknown>[]>()
  for (const row of rows) {
    const key = String(row[hue] ?? "")
    const list = groups.get(key) ?? []
    list.push(row)
    groups.set(key, list)
  }
  return groups
}

function buildTraces(spec: {
  rows: Record<string, unknown>[]
  x: string
  y: string
  kind: PlotKind
  hue?: string
}): Record<string, unknown>[] {
  const { rows, x, y, kind, hue } = spec

  const series = hue ? [...groupByHue(rows, hue).entries()] : [["", rows] as const]

  if (kind === "hist") {
    return series.map(([name, group]) => ({
      type: "histogram",
      x: colValues(group, x),
      name: name || undefined,
      opacity: series.length > 1 ? 0.75 : 1,
    }))
  }

  if (kind === "pie") {
    // Single pie: x = labels, y = values. Hue ignored.
    return [
      {
        type: "pie",
        labels: colValues(rows, x),
        values: colValues(rows, y),
        hole: 0,
      },
    ]
  }

  const typeMap: Record<Exclude<PlotKind, "hist" | "pie">, string> = {
    bar: "bar",
    line: "scatter",
    scatter: "scatter",
    box: "box",
    violin: "violin",
    area: "scatter",
  }

  return series.map(([name, group]) => {
    const trace: Record<string, unknown> = {
      type: typeMap[kind as Exclude<PlotKind, "hist" | "pie">] ?? "bar",
      x: colValues(group, x),
      y: colValues(group, y),
      name: name || undefined,
    }
    if (kind === "line") {
      trace.mode = "lines+markers"
    } else if (kind === "scatter") {
      trace.mode = "markers"
    } else if (kind === "area") {
      trace.mode = "lines"
      trace.fill = "tozeroy"
    }
    return trace
  })
}

function sanitizeChartId(raw: string | undefined): string {
  const base = (raw || `chart-${Math.random().toString(36).slice(2, 10)}`)
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
  return base || "chart"
}

export function buildPlotlyHtml(input: PlotSpec): { html: string; title: string; kind: PlotKind } {
  if (!Array.isArray(input.rows) || input.rows.length === 0) {
    throw new Error("rows must be a non-empty array of objects")
  }
  const rows = input.rows.slice(0, MAX_ROWS)
  const x = input.x?.trim()
  const y = input.y?.trim()
  if (!x || !y) throw new Error("x and y column names are required")

  const sample = rows[0] ?? {}
  const cols = Object.keys(sample)
  if (!(x in sample)) throw new Error(`Column "${x}" not found. Available: ${cols.join(", ")}`)
  if (!(y in sample) && normalizeKind(input.kind) !== "hist") {
    throw new Error(`Column "${y}" not found. Available: ${cols.join(", ")}`)
  }
  if (input.hue && !(input.hue in sample)) {
    throw new Error(`Hue column "${input.hue}" not found. Available: ${cols.join(", ")}`)
  }

  const kind = normalizeKind(input.kind)
  const title = (input.title || defaultPlotTitle(kind, x, y)).trim()
  const chartId = sanitizeChartId(input.chartId || title)
  const traces = buildTraces({ rows, x, y, kind, hue: input.hue })

  const layout = {
    title: { text: title, font: { color: "#c0caf5" } },
    paper_bgcolor: "#1a1b26",
    plot_bgcolor: "#1a1b26",
    font: { color: "#c0caf5" },
    margin: { t: 48, b: 48, l: 56, r: 24 },
    xaxis: { title: x, color: "#c0caf5", gridcolor: "#414868" },
    yaxis: { title: y, color: "#c0caf5", gridcolor: "#414868" },
    legend: { font: { color: "#c0caf5" } },
  }

  const config = { responsive: true, displayModeBar: false }

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1"/>
  <script src="https://cdn.plot.ly/plotly-2.35.2.min.js"></script>
</head>
<body style="margin:0;background:#1a1b26;">
  <div id="${chartId}" style="width:100%;height:420px;"></div>
  <script>
    Plotly.newPlot(
      ${JSON.stringify(chartId)},
      ${JSON.stringify(traces)},
      ${JSON.stringify(layout)},
      ${JSON.stringify(config)}
    );
  </script>
</body>
</html>`

  return { html: ensureIframeHeightScript(html), title, kind }
}
