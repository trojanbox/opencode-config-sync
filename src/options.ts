import { homedir, hostname, platform } from "node:os"
import { isAbsolute, join, normalize, resolve, sep } from "node:path"

export type StartupMode = "off" | "pull" | "sync"

export interface SyncOptions {
  repository?: string
  branch: string
  configDir: string
  stateDir: string
  remoteDirectory: string
  include: string[]
  machineId: string
  startupMode: StartupMode
  intervalSeconds: number
  maxFileSizeBytes: number
  maxTotalBytes: number
  maxFiles: number
  allowUnsafeSecrets: boolean
  gitTimeoutMs: number
}

export const DEFAULT_INCLUDE = [
  "opencode.json",
  "opencode.jsonc",
  "cli.json",
  "AGENTS.md",
  "agents",
  "commands",
  "skills",
  "tools",
  "themes",
  "package.json",
  "bun.lock",
  "bun.lockb",
]

function nonEmptyString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : undefined
}

function numberOption(value: unknown, fallback: number, minimum: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback
  return Math.max(minimum, Math.floor(value))
}

function booleanOption(value: unknown, fallback = false): boolean {
  return typeof value === "boolean" ? value : fallback
}

function expandHome(input: string): string {
  if (input === "~") return homedir()
  if (input.startsWith(`~${sep}`) || input.startsWith("~/") || input.startsWith("~\\")) {
    return join(homedir(), input.slice(2))
  }
  return input
}

function defaultConfigDir(): string {
  const explicit = nonEmptyString(process.env.OPENCODE_CONFIG_DIR)
  if (explicit) return resolve(expandHome(explicit))

  const xdg = nonEmptyString(process.env.XDG_CONFIG_HOME)
  if (xdg) return resolve(expandHome(xdg), "opencode")

  return resolve(homedir(), ".config", "opencode")
}

function defaultStateDir(): string {
  const explicit = nonEmptyString(process.env.OPENCODE_CONFIG_SYNC_STATE_DIR)
  if (explicit) return resolve(expandHome(explicit))

  const xdg = nonEmptyString(process.env.XDG_STATE_HOME)
  if (xdg) return resolve(expandHome(xdg), "opencode-config-sync")

  if (platform() === "win32") {
    const local = nonEmptyString(process.env.LOCALAPPDATA)
    if (local) return resolve(local, "opencode-config-sync")
  }

  return resolve(homedir(), ".local", "state", "opencode-config-sync")
}

function validateRelativePath(value: string, label: string): string {
  const normalized = normalize(value).replaceAll("\\", "/").replace(/^\.\//, "")
  if (!normalized || normalized === ".") throw new Error(`${label} cannot be empty`)
  if (isAbsolute(value) || normalized === ".." || normalized.startsWith("../") || normalized.includes("/../")) {
    throw new Error(`${label} must stay inside the sync root: ${value}`)
  }
  if (normalized.includes("\0")) throw new Error(`${label} contains an invalid null byte`)
  return normalized
}

function validateBranch(value: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(value)) {
    throw new Error(`Invalid Git branch: ${value}`)
  }
  if (value.includes("..") || value.includes("//") || value.endsWith("/") || value.endsWith(".")) {
    throw new Error(`Invalid Git branch: ${value}`)
  }
  return value
}

function validateRepository(value: string | undefined): string | undefined {
  if (!value) return undefined
  if (value.startsWith("-")) throw new Error("repository cannot start with '-' ")

  if (/^https?:\/\//i.test(value)) {
    const parsed = new URL(value)
    if (parsed.username || parsed.password) {
      throw new Error("repository URL must not embed credentials; use Git credential storage or SSH")
    }
    for (const key of parsed.searchParams.keys()) {
      if (/token|key|secret|password/i.test(key)) {
        throw new Error("repository URL must not contain credential-like query parameters")
      }
  }

  return value
}

function parseInclude(value: unknown): string[] {
  const raw = Array.isArray(value) ? value : DEFAULT_INCLUDE
  const result: string[] = []
  const seen = new Set<string>()
  for (const item of raw) {
    if (typeof item !== "string") throw new Error("include must contain only relative string paths")
    const normalized = validateRelativePath(item, "include path")
    if (!seen.has(normalized)) {
      result.push(normalized)
      seen.add(normalized)
    }
  }
  if (result.length === 0) throw new Error("include must contain at least one path")

  const ordered = [...result].sort((a, b) => a.length - b.length || a.localeCompare(b))
  for (let i = 0; i < ordered.length; i += 1) {
    for (let j = i + 1; j < ordered.length; j += 1) {
      if (ordered[j].startsWith(`${ordered[i]}/`)) {
        throw new Error(`include paths must not overlap: ${ordered[i]} and ${ordered[j]}`)
      }
    }
  }

  return result
}

function parseStartupMode(value: unknown): StartupMode {
  if (value === "pull" || value === "sync" || value === "off") return value
  return "off"
}

export function parseOptions(raw: Readonly<Record<string, unknown>> = {}): SyncOptions {
  const repository = validateRepository(
    nonEmptyString(raw.repository) ?? nonEmptyString(process.env.OPENCODE_CONFIG_SYNC_REPOSITORY),
  )
  const branch = validateBranch(
    nonEmptyString(raw.branch) ?? nonEmptyString(process.env.OPENCODE_CONFIG_SYNC_BRANCH) ?? "main",
  )
  const configDir = resolve(
    expandHome(nonEmptyString(raw.configDir) ?? nonEmptyString(process.env.OPENCODE_CONFIG_DIR) ?? defaultConfigDir()),
  )
  const stateDir = resolve(expandHome(nonEmptyString(raw.stateDir) ?? defaultStateDir()))
  const remoteDirectory = validateRelativePath(
    nonEmptyString(raw.remoteDirectory) ?? ".opencode-config-sync/config",
    "remoteDirectory",
  )
  const machineId =
    nonEmptyString(raw.machineId) ??
    nonEmptyString(process.env.OPENCODE_CONFIG_SYNC_MACHINE_ID) ??
    hostname() ??
    "unknown-machine"

  const intervalSeconds = numberOption(raw.intervalSeconds, 0, 0)
  if (intervalSeconds > 0 && intervalSeconds < 60) {
    throw new Error("intervalSeconds must be 0 (disabled) or at least 60 seconds")
  }

  return {
    repository,
    branch,
    configDir,
    stateDir,
    remoteDirectory,
    include: parseInclude(raw.include),
    machineId,
    startupMode: parseStartupMode(raw.startupMode),
    intervalSeconds,
    maxFileSizeBytes: numberOption(raw.maxFileSizeBytes, 5 * 1024 * 1024, 1024),
    maxTotalBytes: numberOption(raw.maxTotalBytes, 50 * 1024 * 1024, 1024),
    maxFiles: numberOption(raw.maxFiles, 5000, 1),
    allowUnsafeSecrets: booleanOption(raw.allowUnsafeSecrets, false),
    gitTimeoutMs: numberOption(raw.gitTimeoutMs, 60_000, 1_000),
  }
}
