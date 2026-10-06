import { spawn } from "node:child_process"
import { mkdir, rm } from "node:fs/promises"
import { dirname } from "node:path"
import { ConfigSyncError } from "./errors.ts"

export interface GitRunOptions {
  cwd?: string
  allowFailure?: boolean
  signal?: AbortSignal
  timeoutMs: number
}

export interface GitResult {
  code: number
  stdout: string
  stderr: string
}

export async function runGit(args: string[], options: GitRunOptions): Promise<GitResult> {
  return await new Promise<GitResult>((resolve, reject) => {
    let settled = false
    let stdout = ""
    let stderr = ""

    const child = spawn("git", args, {
      cwd: options.cwd,
      env: {
        ...process.env,
        GIT_TERMINAL_PROMPT: "0",
      },
      stdio: ["ignore", "pipe", "pipe"],
    })

    const timeout = setTimeout(() => {
      if (!settled) child.kill("SIGTERM")
    }, options.timeoutMs)

    const abort = () => {
      if (!settled) child.kill("SIGTERM")
    }
    options.signal?.addEventListener("abort", abort, { once: true })

    child.stdout.setEncoding("utf8")
    child.stderr.setEncoding("utf8")
    child.stdout.on("data", (chunk) => {
      stdout += chunk
    })
    child.stderr.on("data", (chunk) => {
      stderr += chunk
    })

    child.on("error", (error) => {
      settled = true
      clearTimeout(timeout)
      options.signal?.removeEventListener("abort", abort)
      reject(new ConfigSyncError("GIT_ERROR", `Unable to start git: ${error.message}`))
    })

    child.on("close", (code) => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      options.signal?.removeEventListener("abort", abort)

      if (options.signal?.aborted) {
        reject(new ConfigSyncError("ABORTED", "Git operation was aborted"))
        return
      }

      const exitCode = code ?? 1
      if (exitCode !== 0 && !options.allowFailure) {
        reject(
          new ConfigSyncError("GIT_ERROR", `git ${args.join(" ")} failed`, {
            code: exitCode,
            stderr: stderr.trim(),
            stdout: stdout.trim(),
          }),
        )
        return
      }
      resolve({ code: exitCode, stdout: stdout.trim(), stderr: stderr.trim() })
    })
  })
}

export interface GitRepositoryOptions {
  repository: string
  branch: string
  checkoutDir: string
  timeoutMs: number
}

export class GitRepository {
  readonly repository: string
  readonly branch: string
  readonly checkoutDir: string
  readonly timeoutMs: number

  constructor(options: GitRepositoryOptions) {
    this.repository = options.repository
    this.branch = options.branch
    this.checkoutDir = options.checkoutDir
    this.timeoutMs = options.timeoutMs
  }

  private async git(args: string[], signal?: AbortSignal, allowFailure = false): Promise<GitResult> {
    return await runGit(args, {
      cwd: this.checkoutDir,
      signal,
      timeoutMs: this.timeoutMs,
      allowFailure,
    })
  }

  private async cloneFresh(signal?: AbortSignal): Promise<void> {
    await rm(this.checkoutDir, { recursive: true, force: true })
    await mkdir(dirname(this.checkoutDir), { recursive: true })
    await runGit(["clone", "--no-checkout", this.repository, this.checkoutDir], {
      signal,
      timeoutMs: this.timeoutMs,
    })
  }

  private async remoteBranchExists(signal?: AbortSignal): Promise<boolean> {
    const result = await this.git(
      ["show-ref", "--verify", "--quiet", `refs/remotes/origin/${this.branch}`],
      signal,
      true,
    )
    return result.code === 0
  }

  async prepare(signal?: AbortSignal): Promise<void> {
    const probe = await runGit(["-C", this.checkoutDir, "rev-parse", "--git-dir"], {
      signal,
      timeoutMs: this.timeoutMs,
      allowFailure: true,
    }).catch(() => ({ code: 1, stdout: "", stderr: "" }))

    if (probe.code !== 0) await this.cloneFresh(signal)

    await this.git(["remote", "set-url", "origin", this.repository], signal)
    await this.git(["reset", "--hard"], signal, true)
    await this.git(["clean", "-fd"], signal, true)
    await this.git(["fetch", "origin", "--prune"], signal)

    if (await this.remoteBranchExists(signal)) {
      await this.git(["checkout", "-B", this.branch, `refs/remotes/origin/${this.branch}`], signal)
      await this.git(["reset", "--hard", `refs/remotes/origin/${this.branch}`], signal)
      await this.git(["clean", "-fd"], signal)
      return
    }

    // Discard any local-only internal commit left by a previously failed push.
    await this.cloneFresh(signal)
    await this.git(["checkout", "--orphan", this.branch], signal)
    await this.git(["rm", "-rf", "--ignore-unmatch", "."], signal, true)
    await this.git(["clean", "-fd"], signal, true)
  }

  async head(signal?: AbortSignal): Promise<string | null> {
    const result = await this.git(["rev-parse", "HEAD"], signal, true)
    return result.code === 0 ? result.stdout : null
  }

  async hasStagedChanges(pathspec: string, signal?: AbortSignal): Promise<boolean> {
    const result = await this.git(["diff", "--cached", "--quiet", "--", pathspec], signal, true)
    if (result.code === 0) return false
    if (result.code === 1) return true
    throw new ConfigSyncError("GIT_ERROR", "Unable to inspect staged Git changes", result)
  }

  async stage(pathspec: string, signal?: AbortSignal): Promise<void> {
    await this.git(["add", "-A", "-f", "--", pathspec], signal)
  }

  async commit(message: string, signal?: AbortSignal): Promise<string> {
    const name = await this.git(["config", "user.name"], signal, true)
    const email = await this.git(["config", "user.email"], signal, true)
    const args = [
      "-c",
      `user.name=${name.code === 0 && name.stdout ? name.stdout : "OpenCode Config Sync"}`,
      "-c",
      `user.email=${email.code === 0 && email.stdout ? email.stdout : "opencode-config-sync@localhost"}`,
      "-c",
      "commit.gpgSign=false",
      "commit",
      "-m",
      message,
    ]
    await this.git(args, signal)
    const head = await this.head(signal)
    if (!head) throw new ConfigSyncError("GIT_ERROR", "Git commit succeeded but HEAD is unavailable")
    return head
  }

  async push(signal?: AbortSignal): Promise<void> {
    // Never force. A non-fast-forward rejection is intentional conflict/race protection.
    await this.git(["push", "-u", "origin", this.branch], signal)
  }
}
