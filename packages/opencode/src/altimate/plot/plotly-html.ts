/**
 * Build self-contained Plotly chart HTML for Open WebUI Rich UI embeds
 * (and local .html files). No Python / plotly npm dependency — traces are
 * constructed as plain JSON and rendered via the Plotly CDN.
 */

export type PlotKind =
  | "bar"
  | "line"
  | "scatter"
  | "hist"
  | "pie"
  | "donut"
  | "box"
  | "violin"
  | "area"
  | "stacked_area"
  | "hbar"
  | "stacked_bar"
  | "funnel"
  | "treemap"
  | "heatmap"
  | "sankey"

export const PLOT_KINDS: readonly PlotKind[] = [
  "bar",
  "line",
  "scatter",
  "hist",
  "pie",
  "donut",
  "box",
  "violin",
  "area",
  "stacked_area",
  "hbar",
  "stacked_bar",
  "funnel",
  "treemap",
  "heatmap",
  "sankey",
] as const

export interface PlotSpec {
  rows: Record<string, unknown>[]
  x: string
  y: string
  kind?: PlotKind | string
  title?: string
  hue?: string
  /**
   * Optional value column for heatmap color / sankey link weight.
   * Heatmap: uses `hue` if z omitted, else a 2D histogram of x vs y.
   * Sankey: uses `hue` if z omitted, else each link weighs 1.
   */
  z?: string
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
  if (kind === "donut") return `Donut chart of ${x}`
  if (kind === "box") return `Box plot of ${y} by ${x}`
  if (kind === "violin") return `Violin plot of ${y} by ${x}`
  if (kind === "area" || kind === "stacked_area") return `Area chart of ${y} by ${x}`
  if (kind === "hbar") return `${y} by ${x} (horizontal)`
  if (kind === "stacked_bar") return `Stacked bar of ${y} by ${x}`
  if (kind === "funnel") return `Funnel of ${y} by ${x}`
  if (kind === "treemap") return `Treemap of ${y} by ${x}`
  if (kind === "heatmap") return `Heatmap of ${y} vs ${x}`
  if (kind === "sankey") return `Sankey: ${x} → ${y}`
  return `${y} by ${x}`
}

function normalizeKind(kind: string | undefined): PlotKind {
  const raw = (kind || "bar").toLowerCase()
  const aliases: Record<string, PlotKind> = {
    histogram: "hist",
    doughnut: "donut",
    barh: "hbar",
    horizontal_bar: "hbar",
    stackedbar: "stacked_bar",
    stackedarea: "stacked_area",
    density: "heatmap",
    hist2d: "heatmap",
    sankey_diagram: "sankey",
  }
  const k = aliases[raw] ?? raw
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

/** Pivot long-form rows into a dense z matrix for heatmap(x, y, z). */
function pivotHeatmap(
  rows: Record<string, unknown>[],
  x: string,
  y: string,
  z: string,
): { x: string[]; y: string[]; z: (number | null)[][] } {
  const xs: string[] = []
  const ys: string[] = []
  const xIndex = new Map<string, number>()
  const yIndex = new Map<string, number>()
  for (const row of rows) {
    const xv = String(row[x] ?? "")
    const yv = String(row[y] ?? "")
    if (!xIndex.has(xv)) {
      xIndex.set(xv, xs.length)
      xs.push(xv)
    }
    if (!yIndex.has(yv)) {
      yIndex.set(yv, ys.length)
      ys.push(yv)
    }
  }
  const matrix: (number | null)[][] = ys.map(() => xs.map(() => null))
  for (const row of rows) {
    const xi = xIndex.get(String(row[x] ?? ""))!
    const yi = yIndex.get(String(row[y] ?? ""))!
    const raw = row[z]
    const num = typeof raw === "number" ? raw : Number(raw)
    matrix[yi]![xi] = Number.isFinite(num) ? num : null
  }
  return { x: xs, y: ys, z: matrix }
}

function buildTraces(spec: {
  rows: Record<string, unknown>[]
  x: string
  y: string
  kind: PlotKind
  hue?: string
  z?: string
}): { traces: Record<string, unknown>[]; layoutExtras: Record<string, unknown> } {
  const { rows, x, y, kind, hue, z } = spec
  const layoutExtras: Record<string, unknown> = {}
  const series =
    hue && kind !== "heatmap" && kind !== "sankey"
      ? [...groupByHue(rows, hue).entries()]
      : [["", rows] as const]

  if (kind === "hist") {
    return {
      traces: series.map(([name, group]) => ({
        type: "histogram",
        x: colValues(group, x),
        name: name || undefined,
        opacity: series.length > 1 ? 0.75 : 1,
      })),
      layoutExtras,
    }
  }

  if (kind === "pie" || kind === "donut") {
    return {
      traces: [
        {
          type: "pie",
          labels: colValues(rows, x),
          values: colValues(rows, y),
          hole: kind === "donut" ? 0.45 : 0,
        },
      ],
      layoutExtras: { showlegend: true },
    }
  }

  if (kind === "funnel") {
    return {
      traces: [
        {
          type: "funnel",
          y: colValues(rows, x),
          x: colValues(rows, y),
          textinfo: "value+percent initial",
        },
      ],
      layoutExtras,
    }
  }

  if (kind === "treemap") {
    return {
      traces: [
        {
          type: "treemap",
          labels: colValues(rows, x),
          values: colValues(rows, y),
          parents: colValues(rows, x).map(() => ""),
          textinfo: "label+value+percent root",
        },
      ],
      layoutExtras,
    }
  }

  if (kind === "heatmap") {
    const valueCol = z || hue
    if (valueCol) {
      const pivoted = pivotHeatmap(rows, x, y, valueCol)
      return {
        traces: [
          {
            type: "heatmap",
            x: pivoted.x,
            y: pivoted.y,
            z: pivoted.z,
            colorscale: "Viridis",
            hoverongaps: false,
          },
        ],
        layoutExtras,
      }
    }
    return {
      traces: [
        {
          type: "histogram2d",
          x: colValues(rows, x),
          y: colValues(rows, y),
          colorscale: "Viridis",
        },
      ],
      layoutExtras,
    }
  }

  if (kind === "sankey") {
    // x = source node, y = target node, z|hue = link value (default 1).
    const valueCol = z || hue
    const labels: string[] = []
    const index = new Map<string, number>()
    const ensure = (label: string) => {
      let i = index.get(label)
      if (i === undefined) {
        i = labels.length
        index.set(label, i)
        labels.push(label)
      }
      return i
    }
    // Aggregate duplicate source→target pairs.
    const linkMap = new Map<string, { source: number; target: number; value: number }>()
    for (const row of rows) {
      const src = String(row[x] ?? "")
      const tgt = String(row[y] ?? "")
      if (!src || !tgt || src === tgt) continue
      const raw = valueCol ? row[valueCol] : 1
      const num = typeof raw === "number" ? raw : Number(raw)
      const value = Number.isFinite(num) ? num : 0
      if (value <= 0) continue
      const source = ensure(src)
      const target = ensure(tgt)
      const key = `${source}->${target}`
      const prev = linkMap.get(key)
      if (prev) prev.value += value
      else linkMap.set(key, { source, target, value })
    }
    const links = [...linkMap.values()]
    if (links.length === 0) {
      throw new Error(
        "sankey needs rows with distinct source (x) and target (y); optional z/hue for link weight",
      )
    }
    return {
      traces: [
        {
          type: "sankey",
          orientation: "h",
          node: {
            pad: 16,
            thickness: 16,
            label: labels,
            color: "#7aa2f7",
          },
          link: {
            source: links.map((l) => l.source),
            target: links.map((l) => l.target),
            value: links.map((l) => l.value),
            color: "rgba(122, 162, 247, 0.35)",
          },
        },
      ],
      layoutExtras: {
        xaxis: { visible: false },
        yaxis: { visible: false },
      },
    }
  }

  if (kind === "stacked_bar") layoutExtras.barmode = "stack"

  const typeMap: Record<string, string> = {
    bar: "bar",
    stacked_bar: "bar",
    hbar: "bar",
    line: "scatter",
    scatter: "scatter",
    box: "box",
    violin: "violin",
    area: "scatter",
    stacked_area: "scatter",
  }

  const traces = series.map(([name, group]) => {
    const trace: Record<string, unknown> = {
      type: typeMap[kind] ?? "bar",
      name: name || undefined,
    }

    if (kind === "hbar") {
      trace.x = colValues(group, y)
      trace.y = colValues(group, x)
      trace.orientation = "h"
    } else {
      trace.x = colValues(group, x)
      trace.y = colValues(group, y)
    }

    if (kind === "line") {
      trace.mode = "lines+markers"
    } else if (kind === "scatter") {
      trace.mode = "markers"
    } else if (kind === "area") {
      Object.assign(trace, { mode: "lines", fill: "tozeroy" })
    } else if (kind === "stacked_area") {
      Object.assign(trace, { mode: "lines", fill: "tonexty", stackgroup: "one" })
    }

    return trace
  })

  return { traces, layoutExtras }
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

  const kind = normalizeKind(input.kind)
  const sample = rows[0] ?? {}
  const cols = Object.keys(sample)
  if (!(x in sample)) throw new Error(`Column "${x}" not found. Available: ${cols.join(", ")}`)
  if (!(y in sample) && kind !== "hist") {
    throw new Error(`Column "${y}" not found. Available: ${cols.join(", ")}`)
  }
  if (input.hue && !(input.hue in sample)) {
    throw new Error(`Hue column "${input.hue}" not found. Available: ${cols.join(", ")}`)
  }
  if (input.z && !(input.z in sample)) {
    throw new Error(`Z column "${input.z}" not found. Available: ${cols.join(", ")}`)
  }

  const title = (input.title || defaultPlotTitle(kind, x, y)).trim()
  const chartId = sanitizeChartId(input.chartId || title)
  const { traces, layoutExtras } = buildTraces({
    rows,
    x,
    y,
    kind,
    hue: input.hue,
    z: input.z,
  })

  const layout: Record<string, unknown> = {
    title: { text: title, font: { color: "#c0caf5" } },
    paper_bgcolor: "#1a1b26",
    plot_bgcolor: "#1a1b26",
    font: { color: "#c0caf5" },
    margin: { t: 48, b: 48, l: 56, r: 24 },
    xaxis: {
      title: kind === "hbar" ? y : x,
      color: "#c0caf5",
      gridcolor: "#414868",
    },
    yaxis: {
      title: kind === "hbar" ? x : y,
      color: "#c0caf5",
      gridcolor: "#414868",
    },
    legend: { font: { color: "#c0caf5" } },
    ...layoutExtras,
  }

  const config = { responsive: true, displayModeBar: "hover" }

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
