import { createHash, randomUUID } from "node:crypto"
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises"
import { dirname, join, resolve, sep } from "node:path"
import { ConfigSyncError } from "./errors.ts"

export interface FileRecord {
  hash: string
  size: number
  mode: number
}

export type Snapshot = Record<string, FileRecord>

export interface SnapshotLimits {
  maxFileSizeBytes: number
  maxTotalBytes: number
  maxFiles: number
}

const IGNORED_DIRECTORY_NAMES = new Set([".git", "node_modules", ".cache"])

function toPosix(path: string): string {
  return path.split(sep).join("/")
}

function fromPosix(path: string): string[] {
  return path.split("/").filter(Boolean)
}

export function pathInside(root: string, relativePath: string): string {
  const base = resolve(root)
  const target = resolve(base, ...fromPosix(relativePath))
  if (target !== base && !target.startsWith(`${base}${sep}`)) {
    throw new ConfigSyncError("INVALID_STATE", `Path escapes sync root: ${relativePath}`)
  }
  return target
}

async function hashFile(file: string): Promise<string> {
  const data = await readFile(file)
  return createHash("sha256").update(data).digest("hex")
}

async function visit(
  absolutePath: string,
  relativePath: string,
  out: Snapshot,
  totals: { files: number; bytes: number },
  limits: SnapshotLimits,
): Promise<void> {
  let info
  try {
    info = await lstat(absolutePath)
  } catch (error: any) {
    if (error?.code === "ENOENT") return
    throw error
  }

  if (info.isSymbolicLink()) {
    throw new ConfigSyncError(
      "UNSAFE_SYMLINK",
      `Refusing to synchronize symlink: ${relativePath}. Replace it with real files or remove it from include.`,
      { path: relativePath },
    )
  }

  if (info.isDirectory()) {
    if (relativePath && IGNORED_DIRECTORY_NAMES.has(relativePath.split("/").at(-1) ?? "")) return
    const entries = await readdir(absolutePath, { withFileTypes: true })
    entries.sort((a, b) => a.name.localeCompare(b.name))
    for (const entry of entries) {
      const childRelative = relativePath ? `${relativePath}/${entry.name}` : entry.name
      await visit(join(absolutePath, entry.name), childRelative, out, totals, limits)
    }
    return
  }

  if (!info.isFile()) return
  if (info.size > limits.maxFileSizeBytes) {
    throw new ConfigSyncError("LIMIT_EXCEEDED", `File exceeds maxFileSizeBytes: ${relativePath}`, {
      path: relativePath,
      size: info.size,
      limit: limits.maxFileSizeBytes,
    })
  }

  totals.files += 1
  totals.bytes += info.size
  if (totals.files > limits.maxFiles) {
    throw new ConfigSyncError("LIMIT_EXCEEDED", "Synchronized file count exceeds maxFiles", {
      files: totals.files,
      limit: limits.maxFiles,
    })
  }
  if (totals.bytes > limits.maxTotalBytes) {
    throw new ConfigSyncError("LIMIT_EXCEEDED", "Synchronized content exceeds maxTotalBytes", {
      bytes: totals.bytes,
      limit: limits.maxTotalBytes,
    })
  }

  out[toPosix(relativePath)] = {
    hash: await hashFile(absolutePath),
    size: info.size,
    mode: info.mode & 0o777,
  }
}

export async function snapshot(root: string, include: readonly string[], limits: SnapshotLimits): Promise<Snapshot> {
  const out: Snapshot = {}
  const totals = { files: 0, bytes: 0 }
  for (const item of include) {
    await visit(pathInside(root, item), item, out, totals, limits)
  }
  return out
}

export function hashMap(snapshotValue: Snapshot): Record<string, string> {
  return Object.fromEntries(Object.entries(snapshotValue).map(([path, info]) => [path, info.hash]))
}

export function snapshotFromHashes(hashes: Record<string, string>): Snapshot {
  return Object.fromEntries(Object.entries(hashes).map(([path, hash]) => [path, { hash, size: 0, mode: 0 }]))
}

export function equalHash(a: FileRecord | undefined, b: FileRecord | undefined): boolean {
  return a?.hash === b?.hash
}

export function diffPaths(base: Snapshot, next: Snapshot): string[] {
  const paths = new Set([...Object.keys(base), ...Object.keys(next)])
  return [...paths].filter((path) => !equalHash(base[path], next[path])).sort()
}

export interface MergePlan {
  files: Record<string, "local" | "remote">
  conflicts: string[]
  localChanged: string[]
  remoteChanged: string[]
}

export function planMerge(
  base: Snapshot,
  local: Snapshot,
  remote: Snapshot,
  conflictPolicy: "abort" | "local" | "remote" = "abort",
): MergePlan {
  const files: Record<string, "local" | "remote"> = {}
  const conflicts: string[] = []
  const localChanged = diffPaths(base, local)
  const remoteChanged = diffPaths(base, remote)
  const all = new Set([...Object.keys(base), ...Object.keys(local), ...Object.keys(remote)])

  for (const path of [...all].sort()) {
    const baseFile = base[path]
    const localFile = local[path]
    const remoteFile = remote[path]
    const localDidChange = !equalHash(baseFile, localFile)
    const remoteDidChange = !equalHash(baseFile, remoteFile)

    if (equalHash(localFile, remoteFile)) {
      if (localFile) files[path] = "local"
      continue
    }

    if (localDidChange && remoteDidChange) {
      conflicts.push(path)
      if (conflictPolicy === "local" && localFile) files[path] = "local"
      if (conflictPolicy === "remote" && remoteFile) files[path] = "remote"
      continue
    }

    if (localDidChange) {
      if (localFile) files[path] = "local"
      continue
    }

    if (remoteDidChange) {
      if (remoteFile) files[path] = "remote"
      continue
    }

    if (localFile) files[path] = "local"
    else if (remoteFile) files[path] = "remote"
  }

  return { files, conflicts, localChanged, remoteChanged }
}

export async function materializeMerge(
  destinationRoot: string,
  plan: MergePlan,
  localRoot: string,
  remoteRoot: string,
): Promise<void> {
  await rm(destinationRoot, { recursive: true, force: true })
  await mkdir(destinationRoot, { recursive: true })

  for (const [relativePath, side] of Object.entries(plan.files)) {
    const sourceRoot = side === "local" ? localRoot : remoteRoot
    const source = pathInside(sourceRoot, relativePath)
    const destination = pathInside(destinationRoot, relativePath)
    const sourceInfo = await stat(source)
    await mkdir(dirname(destination), { recursive: true })
    await copyFile(source, destination)
    try {
      await chmod(destination, sourceInfo.mode & 0o777)
    } catch {
      // Permission modes are best-effort on platforms such as Windows.
    }
  }
}

function topLevelApplyOrder(include: readonly string[]): string[] {
  const configFiles = new Set(["opencode.json", "opencode.jsonc"])
  return [...include].sort((a, b) => {
    const aConfig = configFiles.has(a) ? 1 : 0
    const bConfig = configFiles.has(b) ? 1 : 0
    if (aConfig !== bConfig) return aConfig - bConfig
    return a.localeCompare(b)
  })
}

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path)
    return true
  } catch (error: any) {
    if (error?.code === "ENOENT") return false
    throw error
  }
}

export async function applyMaterializedTree(
  materializedRoot: string,
  targetRoot: string,
  include: readonly string[],
): Promise<void> {
  await mkdir(targetRoot, { recursive: true })

  for (const item of topLevelApplyOrder(include)) {
    const source = pathInside(materializedRoot, item)
    const target = pathInside(targetRoot, item)
    const sourceExists = await exists(source)

    if (!sourceExists) {
      await rm(target, { recursive: true, force: true })
      continue
    }

    const sourceInfo = await lstat(source)
    const temp = `${target}.opencode-config-sync-${randomUUID()}`
    await rm(temp, { recursive: true, force: true })
    await mkdir(dirname(temp), { recursive: true })

    if (sourceInfo.isDirectory()) {
      const { cp } = await import("node:fs/promises")
      await cp(source, temp, { recursive: true, force: true, errorOnExist: false })
    } else {
      await copyFile(source, temp)
      try {
        await chmod(temp, sourceInfo.mode & 0o777)
      } catch {
        // Permission modes are best-effort on platforms such as Windows.
      }
    }

    await rm(target, { recursive: true, force: true })
    await rename(temp, target)
  }
}

export async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  const temp = `${path}.${randomUUID()}.tmp`
  await writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, "utf8")
  await rename(temp, path)
}

export async function readJsonIfExists<T>(path: string): Promise<T | undefined> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as T
  } catch (error: any) {
    if (error?.code === "ENOENT") return undefined
    if (error instanceof SyntaxError) {
      throw new ConfigSyncError("INVALID_STATE", `Invalid JSON state file: ${path}`, { cause: error.message })
    }
    throw error
  }
}
