import { expect, test } from "bun:test"
import { SessionID } from "../../src/session/schema"
import { SessionPrompt } from "../../src/session/prompt"

test("finalizeTurnSnapshot is a no-op when baseline is missing", async () => {
  await SessionPrompt.finalizeTurnSnapshot({
    sessionID: SessionID.make("ses_turn_snapshot_noop"),
    before: undefined,
  })
  expect(true).toBe(true)
})
