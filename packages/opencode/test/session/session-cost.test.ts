import { describe, test, expect } from "bun:test"
import { Session } from "../../src/session"
import { Instance } from "../../src/project/instance"
import { Log } from "../../src/util/log"
import { MessageID, PartID } from "../../src/session/schema"
import { ModelID, ProviderID } from "../../src/provider/schema"
import { tmpdir } from "../fixture/fixture"

Log.init({ print: false })

describe("Session cost aggregation", () => {
  test("step-finish parts roll cost/tokens into Session.Info", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await Session.create({})
        expect(session.cost).toBe(0)
        expect(session.tokens?.input).toBe(0)

        const messageID = MessageID.ascending()
        await Session.updateMessage({
          id: messageID,
          sessionID: session.id,
          role: "assistant",
          parentID: MessageID.ascending(),
          mode: "build",
          agent: "build",
          path: { cwd: tmp.path, root: tmp.path },
          cost: 0,
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
          modelID: ModelID.make("test"),
          providerID: ProviderID.make("test"),
          time: { created: Date.now() },
        } as any)

        await Session.updatePart({
          id: PartID.ascending(),
          messageID,
          sessionID: session.id,
          type: "step-finish",
          reason: "stop",
          cost: 0.0123,
          tokens: {
            input: 1000,
            output: 200,
            reasoning: 50,
            cache: { read: 100, write: 25 },
          },
        })

        const after = await Session.get(session.id)
        expect(after.cost).toBeCloseTo(0.0123, 6)
        expect(after.tokens).toEqual({
          input: 1000,
          output: 200,
          reasoning: 50,
          cache: { read: 100, write: 25 },
        })

        await Session.updatePart({
          id: PartID.ascending(),
          messageID,
          sessionID: session.id,
          type: "step-finish",
          reason: "stop",
          cost: 0.004,
          tokens: {
            input: 100,
            output: 40,
            reasoning: 0,
            cache: { read: 0, write: 0 },
          },
        })

        const total = await Session.get(session.id)
        expect(total.cost).toBeCloseTo(0.0163, 6)
        expect(total.tokens?.input).toBe(1100)
        expect(total.tokens?.output).toBe(240)
      },
    })
  })

  test("removing a step-finish part subtracts session usage", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await Session.create({})
        const messageID = MessageID.ascending()
        await Session.updateMessage({
          id: messageID,
          sessionID: session.id,
          role: "assistant",
          parentID: MessageID.ascending(),
          mode: "build",
          agent: "build",
          path: { cwd: tmp.path, root: tmp.path },
          cost: 0,
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
          modelID: ModelID.make("test"),
          providerID: ProviderID.make("test"),
          time: { created: Date.now() },
        } as any)

        const partID = PartID.ascending()
        await Session.updatePart({
          id: partID,
          messageID,
          sessionID: session.id,
          type: "step-finish",
          reason: "stop",
          cost: 0.5,
          tokens: {
            input: 10,
            output: 5,
            reasoning: 0,
            cache: { read: 0, write: 0 },
          },
        })

        expect((await Session.get(session.id)).cost).toBeCloseTo(0.5, 6)

        await Session.removePart({ sessionID: session.id, messageID, partID })
        const cleared = await Session.get(session.id)
        expect(cleared.cost).toBeCloseTo(0, 6)
        expect(cleared.tokens?.input).toBe(0)
        expect(cleared.tokens?.output).toBe(0)
      },
    })
  })
})
