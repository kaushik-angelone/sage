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
