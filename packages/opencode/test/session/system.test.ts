import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import type { Agent } from "../../src/agent/agent"
import { NamedError } from "@opencode-ai/core/util/error"
import { Permission } from "../../src/permission"
import { SystemPrompt } from "../../src/session/system"
import { testEffect } from "../lib/effect"
import { withLegacyInstanceRunner } from "./legacy-instance"
import fs from "node:fs/promises"
import path from "node:path"

const skills = [
  {
    name: "zeta-skill",
    description: "Zeta skill.",
  },
  {
    name: "alpha-skill",
    description: "Alpha skill.",
  },
  {
    name: "middle-skill",
    description: "Middle skill.",
  },
  {
    name: "manual-skill",
  },
]

const writeSkillFixtures = (directory: string) =>
  Effect.promise(async () => {
    for (const skill of skills) {
      const dir = path.join(directory, ".opencode", "skill", skill.name)
      await fs.mkdir(dir, { recursive: true })
      await Bun.write(
        path.join(dir, "SKILL.md"),
        [
          "---",
          `name: ${skill.name}`,
          skill.description ? `description: ${skill.description}` : undefined,
          "---",
          "",
          `# ${skill.name}`,
          "",
        ]
          .filter((line) => line !== undefined)
          .join("\n"),
      )
    }
  })

const build: Agent.Info = {
  name: "build",
  mode: "primary",
  permission: Permission.fromConfig({ "*": "allow" }),
  options: {},
}

const it = withLegacyInstanceRunner(testEffect(SystemPrompt.layer))

describe("session.system", () => {
  it.instance(
    "skills output is sorted by name and stable across calls",
    () =>
      Effect.gen(function* () {
        const prompt = yield* SystemPrompt.Service
        const first = yield* prompt.skills(build)
        const second = yield* prompt.skills(build)
        const output = first ?? (yield* Effect.fail(new NamedError.Unknown({ message: "missing skills output" })))

        expect(first).toBe(second)

        const alpha = output.indexOf("<name>alpha-skill</name>")
        const middle = output.indexOf("<name>middle-skill</name>")
        const zeta = output.indexOf("<name>zeta-skill</name>")

        expect(alpha).toBeGreaterThan(-1)
        expect(middle).toBeGreaterThan(alpha)
        expect(zeta).toBeGreaterThan(middle)
        expect(output).not.toContain("manual-skill")
      }),
    { init: writeSkillFixtures },
  )

  // Non-git projects set worktree to "/". applyPaths must not scan from "/".
  test("skillAutoLoadRoot falls back to directory when worktree is filesystem root", () => {
    expect(SystemPrompt.skillAutoLoadRoot("/", "/tmp/project")).toBe("/tmp/project")
    expect(SystemPrompt.skillAutoLoadRoot("/repo", "/tmp/project")).toBe("/repo")
    expect(SystemPrompt.skillAutoLoadRoot("/", "/")).toBeUndefined()
  })

  it.instance(
    "applyPaths auto-load stays fast when worktree is / (non-git project)",
    () =>
      Effect.gen(function* () {
        const started = Date.now()
        const prompt = yield* SystemPrompt.Service
        const output = yield* prompt.skills(build)
        const elapsed = Date.now() - started
        // Regression: scanning applyPaths from "/" previously took 60s+.
        expect(elapsed).toBeLessThan(5_000)
        expect(output).toContain("<name>apply-path-skill</name>")
        // File lives under the session directory; auto-load should still find it.
        expect(output).toContain('<auto_loaded_skill name="apply-path-skill">')
      }),
    {
      // default git:false → Instance.worktree === "/"
      init: (directory: string) =>
        Effect.promise(async () => {
          for (const skill of skills) {
            const dir = path.join(directory, ".opencode", "skill", skill.name)
            await fs.mkdir(dir, { recursive: true })
            await Bun.write(
              path.join(dir, "SKILL.md"),
              [
                "---",
                `name: ${skill.name}`,
                skill.description ? `description: ${skill.description}` : undefined,
                "---",
                "",
                `# ${skill.name}`,
                "",
              ]
                .filter((line) => line !== undefined)
                .join("\n"),
            )
          }
          const dir = path.join(directory, ".opencode", "skill", "apply-path-skill")
          await fs.mkdir(dir, { recursive: true })
          await Bun.write(
            path.join(dir, "SKILL.md"),
            [
              "---",
              "name: apply-path-skill",
              "description: Auto-load probe skill.",
              "applyPaths:",
              "  - dbt_project.yml",
              "---",
              "",
              "# apply-path-skill",
              "",
            ].join("\n"),
          )
          await Bun.write(path.join(directory, "dbt_project.yml"), "name: probe\n")
        }),
    },
  )
})
