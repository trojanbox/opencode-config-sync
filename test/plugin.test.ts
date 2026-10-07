import assert from "node:assert/strict"
import { mkdtemp, mkdir, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import plugin from "../src/index.ts"

test("V2 plugin registers config_sync and reports unconfigured status", async () => {
  const root = await mkdtemp(join(tmpdir(), "opencode-config-sync-plugin-test-"))
  const configDir = join(root, "config")
  const stateDir = join(root, "state")
  await mkdir(configDir, { recursive: true })

  let registeredTool: any
  const ctx = {
    options: {
      configDir,
      stateDir,
      include: ["AGENTS.md"],
    },
    tool: {
      async transform(callback: (editor: { add(tool: any): void }) => void) {
        callback({
          add(tool) {
            registeredTool = tool
          },
        })
        return { async dispose() {} }
      },
    },
  }

  try {
    assert.equal(plugin.id, "trojanbox.opencode-config-sync")

    const cleanup = await plugin.setup(ctx)
    assert.equal(registeredTool?.name, "config_sync")

    const result = await registeredTool.execute({ action: "status" }, {})
    const status = JSON.parse(result.content)

    assert.equal(status.action, "status")
    assert.equal(status.configured, false)
    assert.equal(status.state, "unconfigured")

    await cleanup()
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
