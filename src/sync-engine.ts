import { createHash, randomUUID } from "node:crypto"
import { mkdir, rm } from "node:fs/promises"
import { join } from "node:path"
import { ConfigSyncError } from "./errors.ts"
import {
  applyMaterializedTree,
  diffPaths,
  hashMap,
  materializeMerge,
  pathInside,
  planMerge,
  readJsonIfExists,
  snapshot,
  snapshotFromHashes,
  writeJsonAtomic,
  type Snapshot,
} from "./files.ts"
import { GitRepository } from "./git.ts"
import { scanForSecrets, type SecretFinding } from "./secrets.ts"
import type { SyncOptions } from "./options.ts"

interface SyncState {
  version: 1
  fingerprint: string
  repository: string
  branch: string
  remoteDirectory: string
  include: string[]
  lastRemoteCommit: string | null
  lastManifest: Record<string, string>
  updatedAt: string
}

export type SyncAction = "status" | "sync" | "pull" | "push"

export interface StatusResult {
  action: "status"
  configured: boolean
  repository?: string
  branch: string
  configDir: string
  remoteDirectory: string
  machineId: string
  initialized: boolean
  remoteCommit: string | null
  localFileCount: number
  remoteFileCount: number
  localChanged: string[]
  remoteChanged: string[]
  conflicts: string[]
  state: "unconfigured" | "synced" | "local-ahead" | "remote-ahead" | "diverged" | "conflict"
}

export interface SyncResult {
  action: Exclude<SyncAction, "status">
  repository: string
  branch: string
  configDir: string
  machineId: string
  remoteCommit: string | null
  pushed: boolean
  localChanged: string[]
  remoteChanged: string[]
  conflictsResolved: string[]
  appliedFileCount: number
  warnings: string[]
}

export interface RunOptions {
  force?: boolean
  signal?: AbortSignal
}

function stableFingerprint(options: SyncOptions): string {
  const value = JSON.stringify({
    repository: options.repository,
    branch: options.branch,
    configDir: options.configDir,
    remoteDirectory: options.remoteDirectory,
    include: [...options.include].sort(),
  })
  return createHash("sha256").update(value).digest("hex")
}

function checkoutKey(options: SyncOptions): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        repository: options.repository,
        branch: options.branch,
        remoteDirectory: options.remoteDirectory,
        configDir: options.configDir,
      }),
    )
    .digest("hex")
    .slice(0, 24)
}

function classifyStatus(localChanged: string[], remoteChanged: string[], conflicts: string[]): StatusResult["state"] {
  if (conflicts.length > 0) return "conflict"
  if (localChanged.length === 0 && remoteChanged.length === 0) return "synced"
  if (localChanged.length > 0 && remoteChanged.length === 0) return "local-ahead"
  if (localChanged.length === 0 && remoteChanged.length > 0) return "remote-ahead"
  return "diverged"
}

function secretWarnings(findings: SecretFinding[]): string[] {
  if (findings.length === 0) return []
  return [
    `Potential secrets detected in synchronized content: ${findings
      .slice(0, 10)
      .map((finding) => `${finding.path}${finding.key ? `:${finding.key}` : ""}`)
      .join(", ")}${findings.length > 10 ? ` (+${findings.length - 10} more)` : ""}`,
  ]
}

export class SyncEngine {
  readonly options: SyncOptions
  private readonly fingerprint: string
  private readonly checkoutDir: string
  private readonly statePath: string
  private queue: Promise<void> = Promise.resolve()

  constructor(options: SyncOptions) {
    this.options = options
    this.fingerprint = stableFingerprint(options)
    const key = checkoutKey(options)
    this.checkoutDir = join(options.stateDir, "repos", key)
    this.statePath = join(options.stateDir, "state", `${key}.json`)
  }

  private limits() {
    return {
      maxFileSizeBytes: this.options.maxFileSizeBytes,
      maxTotalBytes: this.options.maxTotalBytes,
      maxFiles: this.options.maxFiles,
    }
  }

  private ensureConfigured(): string {
    if (!this.options.repository) {
      throw new ConfigSyncError(
        "NOT_CONFIGURED",
        "No sync repository is configured. Set plugin option 'repository' or OPENCODE_CONFIG_SYNC_REPOSITORY.",
      )
    }
    return this.options.repository
  }

  private async exclusive<T>(signal: AbortSignal | undefined, work: () => Promise<T>): Promise<T> {
    let release!: () => void
    const current = new Promise<void>((resolve) => {
      release = resolve
    })
    const previous = this.queue
    this.queue = previous.then(() => current, () => current)
    await previous.catch(() => undefined)
    if (signal?.aborted) {
      release()
      throw new ConfigSyncError("ABORTED", "Synchronization was aborted before it started")
    }
    try {
      return await work()
    } finally {
      release()
    }
  }

  private gitRepository(): GitRepository {
    return new GitRepository({
      repository: this.ensureConfigured(),
      branch: this.options.branch,
      checkoutDir: this.checkoutDir,
      timeoutMs: this.options.gitTimeoutMs,
    })
  }

  private remoteRoot(): string {
    return pathInside(this.checkoutDir, this.options.remoteDirectory)
  }

  private async readState(): Promise<SyncState | undefined> {
    const state = await readJsonIfExists<SyncState>(this.statePath)
    if (!state) return undefined
    if (state.version !== 1 || state.fingerprint !== this.fingerprint) return undefined
    if (!state.lastManifest || typeof state.lastManifest !== "object") {
      throw new ConfigSyncError("INVALID_STATE", `Invalid state manifest: ${this.statePath}`)
    }
    return state
  }

  private async writeState(lastManifest: Snapshot, remoteCommit: string | null): Promise<void> {
    const repository = this.ensureConfigured()
    const state: SyncState = {
      version: 1,
      fingerprint: this.fingerprint,
      repository,
      branch: this.options.branch,
      remoteDirectory: this.options.remoteDirectory,
      include: [...this.options.include],
      lastRemoteCommit: remoteCommit,
      lastManifest: hashMap(lastManifest),
      updatedAt: new Date().toISOString(),
    }
    await writeJsonAtomic(this.statePath, state)
  }

  private async snapshots(): Promise<{ local: Snapshot; remote: Snapshot; base: Snapshot; state?: SyncState }> {
    const state = await this.readState()
    const [local, remote] = await Promise.all([
      snapshot(this.options.configDir, this.options.include, this.limits()),
      snapshot(this.remoteRoot(), this.options.include, this.limits()),
    ])
    const base = state ? snapshotFromHashes(state.lastManifest) : {}
    return { local, remote, base, state }
  }

  async status(run: RunOptions = {}): Promise<StatusResult> {
    return await this.exclusive(run.signal, async () => {
      const configured = Boolean(this.options.repository)
      if (!configured) {
        const local = await snapshot(this.options.configDir, this.options.include, this.limits())
        return {
          action: "status",
          configured: false,
          branch: this.options.branch,
          configDir: this.options.configDir,
          remoteDirectory: this.options.remoteDirectory,
          machineId: this.options.machineId,
          initialized: false,
          remoteCommit: null,
          localFileCount: Object.keys(local).length,
          remoteFileCount: 0,
          localChanged: Object.keys(local).sort(),
          remoteChanged: [],
          conflicts: [],
          state: "unconfigured",
        }
      }

      const git = this.gitRepository()
      await git.prepare(run.signal)
      const remoteCommit = await git.head(run.signal)
      const { local, remote, base, state } = await this.snapshots()
      const plan = planMerge(base, local, remote, "abort")

      return {
        action: "status",
        configured: true,
        repository: this.options.repository,
        branch: this.options.branch,
        configDir: this.options.configDir,
        remoteDirectory: this.options.remoteDirectory,
        machineId: this.options.machineId,
        initialized: Boolean(state),
        remoteCommit,
        localFileCount: Object.keys(local).length,
        remoteFileCount: Object.keys(remote).length,
        localChanged: plan.localChanged,
        remoteChanged: plan.remoteChanged,
        conflicts: plan.conflicts,
        state: classifyStatus(plan.localChanged, plan.remoteChanged, plan.conflicts),
      }
    })
  }

  async pull(run: RunOptions = {}): Promise<SyncResult> {
    return await this.reconcile("pull", run)
  }

  async push(run: RunOptions = {}): Promise<SyncResult> {
    return await this.reconcile("push", run)
  }

  async sync(run: RunOptions = {}): Promise<SyncResult> {
    if (run.force) {
      throw new ConfigSyncError(
        "CONFLICT",
        "force is intentionally unsupported for sync because it has no safe direction. Use pull(force=true) or push(force=true).",
      )
    }
    return await this.reconcile("sync", run)
  }

  private async reconcile(action: "pull" | "push" | "sync", run: RunOptions): Promise<SyncResult> {
    return await this.exclusive(run.signal, async () => {
      const repository = this.ensureConfigured()
      const git = this.gitRepository()
      await git.prepare(run.signal)

      const initialRemoteCommit = await git.head(run.signal)
      const { local, remote, base } = await this.snapshots()
      const conflictPolicy = run.force ? (action === "pull" ? "remote" : "local") : "abort"
      const plan = planMerge(base, local, remote, conflictPolicy)

      if (plan.conflicts.length > 0 && !run.force) {
        throw new ConfigSyncError(
          "CONFLICT",
          `Synchronization found ${plan.conflicts.length} file conflict(s). Resolve them manually or choose an explicit directional force.`,
          {
            conflicts: plan.conflicts,
            hint: "Use pull with force=true for remote-wins, or push with force=true for local-wins.",
          },
        )
      }

      const mergeRoot = join(this.options.stateDir, "tmp", `${checkoutKey(this.options)}-${randomUUID()}`)
      await mkdir(mergeRoot, { recursive: true })

      try {
        await materializeMerge(mergeRoot, plan, this.options.configDir, this.remoteRoot())
        const merged = await snapshot(mergeRoot, this.options.include, this.limits())
        const remoteDelta = diffPaths(remote, merged)
        const findings = await scanForSecrets(mergeRoot, merged)
        const warnings = secretWarnings(findings)

        if ((action === "push" || action === "sync") && remoteDelta.length > 0 && findings.length > 0) {
          if (!this.options.allowUnsafeSecrets) {
            throw new ConfigSyncError(
              "SECRET_DETECTED",
              "Refusing to publish content that looks like a literal credential. Replace secrets with {env:...}/{file:...} references or explicitly set allowUnsafeSecrets=true.",
              { findings },
            )
          }
        }

        let pushed = false
        let remoteCommit = initialRemoteCommit

        if (action === "push" || action === "sync") {
          // The remoteDirectory is exclusively managed by this plugin. Rebuild it from
          // the current allowlist so paths removed from `include` do not linger forever
          // in the configuration repository. This never touches files outside
          // remoteDirectory and Git push remains fast-forward only.
          await rm(this.remoteRoot(), { recursive: true, force: true })
          await mkdir(this.remoteRoot(), { recursive: true })
          await applyMaterializedTree(mergeRoot, this.remoteRoot(), this.options.include)
          await git.stage(this.options.remoteDirectory, run.signal)
          if (await git.hasStagedChanges(this.options.remoteDirectory, run.signal)) {
            await git.commit(
              `sync: ${this.options.machineId} ${new Date().toISOString().replace(/\.\d{3}Z$/, "Z")}`,
              run.signal,
            )
            await git.push(run.signal)
            pushed = true
            remoteCommit = await git.head(run.signal)
          }

          // A push also consumes non-conflicting remote-only changes so both sides converge.
          await applyMaterializedTree(mergeRoot, this.options.configDir, this.options.include)
          await this.writeState(merged, remoteCommit)
        } else {
          // Pull keeps local-only changes unpublished. The remote snapshot remains the merge base.
          await applyMaterializedTree(mergeRoot, this.options.configDir, this.options.include)
          await this.writeState(remote, remoteCommit)
        }

        return {
          action,
          repository,
          branch: this.options.branch,
          configDir: this.options.configDir,
          machineId: this.options.machineId,
          remoteCommit,
          pushed,
          localChanged: plan.localChanged,
          remoteChanged: plan.remoteChanged,
          conflictsResolved: run.force ? plan.conflicts : [],
          appliedFileCount: Object.keys(merged).length,
          warnings,
        }
      } finally {
        await rm(mergeRoot, { recursive: true, force: true })
      }
    })
  }
}
