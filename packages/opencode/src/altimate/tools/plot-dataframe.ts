import path from "path"
import { mkdir, writeFile } from "fs/promises"
import z from "zod"
import { Tool } from "../../tool/tool"
import { Global } from "../../global"
import { Dispatcher } from "../native"
import { classifyAndCheck } from "./sql-classify"
import { buildPlotlyHtml, prepareEmbedHtml } from "../plot/plotly-html"

function slugTitle(title: string): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
  return slug || "plot"
}

function asRecords(data: unknown): Record<string, unknown>[] {
  if (!Array.isArray(data)) {
    throw new Error("data must be an array of row objects (e.g. sql_execute result rows)")
  }
  if (data.length === 0) {
    throw new Error("data is empty — nothing to plot")
  }
  return data.map((row, i) => {
    if (!row || typeof row !== "object" || Array.isArray(row)) {
      throw new Error(`data[${i}] must be an object with column keys`)
    }
    return row as Record<string, unknown>
  })
}

async function rowsFromSql(sql: string, warehouse: string | undefined, limit: number): Promise<Record<string, unknown>[]> {
  const result = await Dispatcher.call("sql.execute", {
    sql,
    warehouse,
    limit,
  })
  if (!result.rows?.length) {
    throw new Error("SQL returned 0 rows — nothing to plot")
  }
  return result.rows.map((r) => {
    const obj: Record<string, unknown> = {}
    for (let i = 0; i < result.columns.length; i++) {
      obj[result.columns[i]!] = r[i] ?? null
    }
    return obj
  })
}

export const PlotDataframeTool = Tool.define("plot_dataframe", {
  description:
    "Create an interactive Plotly chart from SQL results or row objects. " +
    "Prefer passing `sql` (reuses the warehouse) so you don't copy large JSON. " +
    "In Open WebUI the chart is embedded inline; a local HTML copy is cached under the app data dir " +
    "(not the project tree, so analyst/read-only mode can use it). " +
    "Use when the user asks for a chart, trend, breakdown, or visualization.",
  parameters: z.object({
    sql: z
      .string()
      .optional()
      .describe("SQL that returns the chart data (preferred). Must include the x/y columns."),
    warehouse: z.string().optional().describe("Warehouse connection name (with sql)"),
    limit: z.number().optional().default(500).describe("Max rows when using sql (default 500)"),
    data: z
      .array(z.record(z.string(), z.unknown()))
      .optional()
      .describe("Row objects to plot when not using sql (e.g. JSON from sql_execute)"),
    x: z.string().describe("Column name for the x-axis (or pie labels / histogram values)"),
    y: z.string().describe("Column name for the y-axis (or pie values). For hist, may match x"),
    kind: z
      .enum(["bar", "line", "scatter", "hist", "pie", "box", "violin", "area"])
      .optional()
      .default("bar")
      .describe('Chart type: "bar" | "line" | "scatter" | "hist" | "pie" | "box" | "violin" | "area"'),
    title: z.string().optional().describe("Chart title"),
    hue: z.string().optional().describe("Optional column for color grouping / multi-series"),
  }),
  async execute(args, ctx) {
    try {
      const sql = args.sql?.trim()
      let rows: Record<string, unknown>[]
      if (sql) {
        // Same write/safety gates as sql_execute — plot must not be a bypass.
        const { queryType, blocked } = classifyAndCheck(sql)
        if (blocked) {
          throw new Error(
            "DROP DATABASE, DROP SCHEMA, and TRUNCATE are blocked for safety. This cannot be overridden.",
          )
        }
        if (queryType === "write") {
          await ctx.ask({
            permission: "sql_execute_write",
            patterns: [sql.slice(0, 200)],
            always: ["*"],
            metadata: { queryType, via: "plot_dataframe" },
          })
        }
        rows = await rowsFromSql(sql, args.warehouse, args.limit ?? 500)
      } else if (args.data) {
        rows = asRecords(args.data)
      } else {
        throw new Error("Provide either `sql` or `data`")
      }

      const { html, title, kind } = buildPlotlyHtml({
        rows,
        x: args.x,
        y: args.y,
        kind: args.kind,
        title: args.title,
        hue: args.hue,
      })
      const embed = prepareEmbedHtml(html)

      // Cache outside the project so analyst (no project writes) can still plot.
      // Embeds in metadata are what OWUI needs; the file is a convenience for TUI.
      let filePath: string | undefined
      try {
        const plotsDir = path.join(Global.Path.cache, "plots")
        await mkdir(plotsDir, { recursive: true })
        filePath = path.join(plotsDir, `${slugTitle(title)}_${Date.now()}.html`)
        await writeFile(filePath, embed, "utf8")
      } catch {
        // Embed path still works if cache write fails.
      }

      return {
        title: `Plot: ${title}`,
        metadata: {
          success: true,
          kind,
          title,
          ...(filePath ? { path: filePath } : {}),
          rowCount: rows.length,
          // Consumed by the Open WebUI bridge → filter as Rich UI embeds.
          embeds: [embed],
        },
        output: [
          `Plotting was successful (${kind}): ${title} (${rows.length} rows)`,
          ...(filePath ? [`Cached HTML: ${filePath}`] : []),
          "The chart is embedded in Open WebUI automatically. Do not re-plot the same columns unless the data changed.",
        ].join("\n"),
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      return {
        title: "Plot: FAILED",
        metadata: { success: false, error: msg },
        output: `Failed to plot: ${msg}`,
      }
    }
  },
})
