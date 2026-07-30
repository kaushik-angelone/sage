import { describe, expect, test } from "bun:test"
import {
  buildPlotlyHtml,
  defaultPlotTitle,
  ensureIframeHeightScript,
  prepareEmbedHtml,
} from "../../src/altimate/plot/plotly-html"

const rows = [
  { month: "Jan", revenue: 10, segment: "A" },
  { month: "Feb", revenue: 14, segment: "A" },
  { month: "Jan", revenue: 8, segment: "B" },
  { month: "Feb", revenue: 11, segment: "B" },
]

describe("plotly-html", () => {
  test("builds bar chart HTML with plotly CDN and height script", () => {
    const { html, title, kind } = buildPlotlyHtml({
      rows,
      x: "month",
      y: "revenue",
      kind: "bar",
      title: "Revenue by month",
    })
    expect(kind).toBe("bar")
    expect(title).toBe("Revenue by month")
    expect(html).toContain("cdn.plot.ly/plotly")
    expect(html).toContain("Plotly.newPlot")
    expect(html).toContain("iframe:height")
    expect(html).toContain("Revenue by month")
  })

  test("supports hue series and pie", () => {
    const line = buildPlotlyHtml({
      rows,
      x: "month",
      y: "revenue",
      kind: "line",
      hue: "segment",
    })
    expect(line.html).toContain("lines+markers")
    expect(defaultPlotTitle("line", "month", "revenue")).toBe("revenue by month")

    const pie = buildPlotlyHtml({
      rows: [
        { name: "A", value: 60 },
        { name: "B", value: 40 },
      ],
      x: "name",
      y: "value",
      kind: "pie",
    })
    expect(pie.html).toContain('"type":"pie"')
  })

  test("supports new chart kinds", () => {
    const donut = buildPlotlyHtml({
      rows: [
        { name: "A", value: 60 },
        { name: "B", value: 40 },
      ],
      x: "name",
      y: "value",
      kind: "donut",
    })
    expect(donut.html).toContain('"hole":0.45')

    const hbar = buildPlotlyHtml({ rows, x: "month", y: "revenue", kind: "hbar" })
    expect(hbar.html).toContain('"orientation":"h"')

    const stacked = buildPlotlyHtml({
      rows,
      x: "month",
      y: "revenue",
      kind: "stacked_bar",
      hue: "segment",
    })
    expect(stacked.html).toContain('"barmode":"stack"')

    const area = buildPlotlyHtml({ rows, x: "month", y: "revenue", kind: "area" })
    expect(area.html).toContain('"fill":"tozeroy"')

    const funnel = buildPlotlyHtml({
      rows: [
        { stage: "Visit", count: 1000 },
        { stage: "Signup", count: 400 },
        { stage: "Paid", count: 120 },
      ],
      x: "stage",
      y: "count",
      kind: "funnel",
    })
    expect(funnel.html).toContain('"type":"funnel"')

    const treemap = buildPlotlyHtml({
      rows: [
        { name: "A", value: 60 },
        { name: "B", value: 40 },
      ],
      x: "name",
      y: "value",
      kind: "treemap",
    })
    expect(treemap.html).toContain('"type":"treemap"')

    const heatmap = buildPlotlyHtml({
      rows: [
        { day: "Mon", hour: "9", value: 3 },
        { day: "Mon", hour: "10", value: 5 },
        { day: "Tue", hour: "9", value: 2 },
      ],
      x: "day",
      y: "hour",
      z: "value",
      kind: "heatmap",
    })
    expect(heatmap.html).toContain('"type":"heatmap"')

    // Alias
    const aliased = buildPlotlyHtml({ rows, x: "month", y: "revenue", kind: "barh" })
    expect(aliased.kind).toBe("hbar")

    const sankey = buildPlotlyHtml({
      rows: [
        { source: "Ads", target: "Visit", value: 100 },
        { source: "Visit", target: "Signup", value: 40 },
        { source: "Signup", target: "Paid", value: 12 },
        { source: "Ads", target: "Visit", value: 20 }, // aggregated with first link
      ],
      x: "source",
      y: "target",
      z: "value",
      kind: "sankey",
    })
    expect(sankey.kind).toBe("sankey")
    expect(sankey.html).toContain('"type":"sankey"')
    expect(sankey.html).toContain('"source":[')
    expect(sankey.html).toContain("120") // 100+20 aggregated Ads→Visit
  })

  test("rejects missing columns", () => {
    expect(() =>
      buildPlotlyHtml({
        rows,
        x: "missing",
        y: "revenue",
      }),
    ).toThrow(/Column "missing"/)
  })

  test("prepareEmbedHtml is idempotent for height script", () => {
    const once = prepareEmbedHtml("<html><body>hi</body></html>")
    expect(once).toContain("iframe:height")
    const twice = ensureIframeHeightScript(once)
    expect(twice).toBe(once)
  })
})
