import assert from "node:assert/strict"
import { execFile } from "node:child_process"
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { promisify } from "node:util"
import test from "node:test"
import { ConfigSyncError } from "../src/errors.ts"
import { parseOptions } from "../src/options.ts"
import { SyncEngine } from "../src/sync-engine.ts"

const exec = promisify(execFile)

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "opencode-config-sync-test-"))
  const remote = join(root, "remote.git")
  await exec("git", ["init", "--bare", remote])
  return {
    root,
    remote,
    async cleanup() {
      await rm(root, { recursive: true, force: true })
    },
  }
}

function engine(
  remote: string,
  configDir: string,
  stateDir: string,
  machineId: string,
  include = ["opencode.jsonc", "AGENTS.md", "skills", "tools"],
) {
  return new SyncEngine(
    parseOptions({
      repository: remote,
      configDir,
      stateDir,
      machineId,
      include,
      gitTimeoutMs: 10_000,
    }),
  )
}

test("initial sync publishes one machine and pull restores another", async () => {
  const f = await fixture()
  try {
    const aConfig = join(f.root, "a-config")
    const bConfig = join(f.root, "b-config")
    await mkdir(aConfig, { recursive: true })
    await mkdir(bConfig, { recursive: true })
    await writeFile(join(aConfig, "AGENTS.md"), "shared instructions\n")

    const a = engine(f.remote, aConfig, join(f.root, "a-state"), "machine-a")
    const first = await a.sync()
    assert.equal(first.pushed, true)

    const b = engine(f.remote, bConfig, join(f.root, "b-state"), "machine-b")
    const pulled = await b.pull()
    assert.equal(pulled.pushed, false)
    assert.equal(await readFile(join(bConfig, "AGENTS.md"), "utf8"), "shared instructions\n")

    const status = await b.status()
    assert.equal(status.state, "synced")
    assert.equal(status.conflicts.length, 0)
  } finally {
    await f.cleanup()
  }
})

test("same file edited on two machines is reported as a conflict", async () => {
  const f = await fixture()
  try {
    const aConfig = join(f.root, "a-config")
    const bConfig = join(f.root, "b-config")
    await mkdir(aConfig, { recursive: true })
    await mkdir(bConfig, { recursive: true })
    await writeFile(join(aConfig, "AGENTS.md"), "base\n")

    const a = engine(f.remote, aConfig, join(f.root, "a-state"), "machine-a")
    const b = engine(f.remote, bConfig, join(f.root, "b-state"), "machine-b")
    await a.sync()
    await b.pull()

    await writeFile(join(aConfig, "AGENTS.md"), "from-a\n")
    await a.sync()

    await writeFile(join(bConfig, "AGENTS.md"), "from-b\n")
    await assert.rejects(
      () => b.sync(),
      (error: unknown) => {
        assert.ok(error instanceof ConfigSyncError)
        assert.equal(error.code, "CONFLICT")
        assert.deepEqual((error.details as { conflicts: string[] }).conflicts, ["AGENTS.md"])
        return true
      },
    )

    await b.pull({ force: true })
    assert.equal(await readFile(join(bConfig, "AGENTS.md"), "utf8"), "from-a\n")
  } finally {
    await f.cleanup()
  }
})

test("non-conflicting changes from two machines are merged", async () => {
  const f = await fixture()
  try {
    const aConfig = join(f.root, "a-config")
    const bConfig = join(f.root, "b-config")
    await mkdir(aConfig, { recursive: true })
    await mkdir(bConfig, { recursive: true })
    await writeFile(join(aConfig, "AGENTS.md"), "base\n")

    const a = engine(f.remote, aConfig, join(f.root, "a-state"), "machine-a")
    const b = engine(f.remote, bConfig, join(f.root, "b-state"), "machine-b")
    await a.sync()
    await b.pull()

    await mkdir(join(aConfig, "skills"), { recursive: true })
    await writeFile(join(aConfig, "skills", "a.md"), "skill-a\n")
    await a.sync()

    await mkdir(join(bConfig, "tools"), { recursive: true })
    await writeFile(join(bConfig, "tools", "b.ts"), "export const b = true\n")
    await b.sync()

    assert.equal(await readFile(join(bConfig, "skills", "a.md"), "utf8"), "skill-a\n")

    await a.pull()
    assert.equal(await readFile(join(aConfig, "tools", "b.ts"), "utf8"), "export const b = true\n")
  } finally {
    await f.cleanup()
  }
})

test("literal API keys are blocked before the first push", async () => {
  const f = await fixture()
  try {
    const config = join(f.root, "config")
    await mkdir(config, { recursive: true })
    await writeFile(
      join(config, "opencode.jsonc"),
      '{\n  "provider": { "openai": { "apiKey": "sk-example-secret-value" } }\n}\n',
      "utf8",
    )

    const sync = engine(f.remote, config, join(f.root, "state"), "machine-a")
    await assert.rejects(
      () => sync.sync(),
      (error: unknown) => {
        assert.ok(error instanceof ConfigSyncError)
        assert.equal(error.code, "SECRET_DETECTED")
        return true
      },
    )
  } finally {
    await f.cleanup()
  }
})


test("paths removed from include are deleted from the managed remote directory", async () => {
  const f = await fixture()
  try {
    const config = join(f.root, "config")
    const state = join(f.root, "state")
    await mkdir(join(config, "skills"), { recursive: true })
    await writeFile(join(config, "AGENTS.md"), "base\n")
    await writeFile(join(config, "skills", "old.md"), "old skill\n")

    await engine(f.remote, config, state, "machine-a", ["AGENTS.md", "skills"]).sync()

    const narrowed = engine(f.remote, config, state, "machine-a", ["AGENTS.md"])
    const result = await narrowed.sync()
    assert.equal(result.pushed, true)

    const verify = join(f.root, "verify")
    await exec("git", ["clone", "--branch", "main", f.remote, verify])
    await assert.rejects(() => readFile(join(verify, ".opencode-config-sync", "config", "skills", "old.md"), "utf8"))
    assert.equal(
      await readFile(join(verify, ".opencode-config-sync", "config", "AGENTS.md"), "utf8"),
      "base\n",
    )
  } finally {
    await f.cleanup()
  }
})
