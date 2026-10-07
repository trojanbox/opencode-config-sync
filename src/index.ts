import { errorSummary } from "./errors.ts"
import { parseOptions } from "./options.ts"
import { SyncEngine, type SyncAction } from "./sync-engine.ts"

interface ToolExecutionContext {
  signal?: AbortSignal
  progress?: (update: { status: string }) => Promise<void>
}

interface ToolEditor {
  add(tool: {
    name: string
    description: string
    input: Record<string, unknown>
    options?: { codemode?: boolean; namespace?: string }
    execute: (input: unknown, context: ToolExecutionContext) => Promise<{ content: string }>
  }): void
}

interface OpenCodePluginContext {
  options: Readonly<Record<string, unknown>>
  tool: {
    transform(callback: (editor: ToolEditor) => void): Promise<unknown>
  }
}

interface ToolInput {
  action: SyncAction
  force?: boolean
}

function parseToolInput(value: unknown): ToolInput {
  if (!value || typeof value !== "object") throw new Error("config_sync input must be an object")
  const action = (value as Record<string, unknown>).action
  if (action !== "status" && action !== "sync" && action !== "pull" && action !== "push") {
    throw new Error("config_sync.action must be one of: status, sync, pull, push")
  }
  const forceValue = (value as Record<string, unknown>).force
  if (forceValue !== undefined && typeof forceValue !== "boolean") {
    throw new Error("config_sync.force must be a boolean")
  }
  return { action, force: forceValue as boolean | undefined }
}

function formatOutput(result: unknown): string {
  return JSON.stringify(result, null, 2)
}

export default {
  id: "trojanbox.opencode-config-sync",

  async setup(ctx: OpenCodePluginContext) {
    const options = parseOptions(ctx.options)
    const engine = new SyncEngine(options)
    const controller = new AbortController()
    const backgroundTasks = new Set<Promise<unknown>>()

    const track = (task: Promise<unknown>) => {
      backgroundTasks.add(task)
      void task.finally(() => backgroundTasks.delete(task))
    }

    const background = async (action: "pull" | "sync") => {
      try {
        const result =
          action === "pull"
            ? await engine.pull({ signal: controller.signal })
            : await engine.sync({ signal: controller.signal })
        console.info(`[opencode-config-sync] background ${action} complete`, {
          pushed: result.pushed,
          localChanged: result.localChanged.length,
          remoteChanged: result.remoteChanged.length,
        })
      } catch (error) {
        if (controller.signal.aborted) return
        console.warn(`[opencode-config-sync] background ${action} skipped/failed: ${errorSummary(error)}`)
      }
    }

    await ctx.tool.transform((editor) => {
      editor.add({
        name: "config_sync",
        description:
          "Synchronize the user's global OpenCode configuration through the configured Git repository. Use status first. sync performs a safe three-way file merge; pull(force=true) resolves file conflicts with remote content; push(force=true) resolves them with local content. Never use force without explicit user intent.",
        input: {
          type: "object",
          properties: {
            action: {
              type: "string",
              enum: ["status", "sync", "pull", "push"],
              description: "status inspects changes; sync safely reconciles; pull/push support explicit directional conflict resolution.",
            },
            force: {
              type: "boolean",
              description:
                "Only for pull/push conflicts. pull=true chooses remote; push=true chooses local. sync rejects force.",
            },
          },
          required: ["action"],
          additionalProperties: false,
        },
        options: { codemode: false },
        execute: async (rawInput, toolContext) => {
          const input = parseToolInput(rawInput)
          if (toolContext.progress) {
            await toolContext.progress({ status: `config-sync:${input.action}` }).catch(() => undefined)
          }

          if (input.action === "status") {
            return { content: formatOutput(await engine.status({ signal: toolContext.signal })) }
          }
          if (input.action === "pull") {
            return {
              content: formatOutput(
                await engine.pull({ force: input.force === true, signal: toolContext.signal }),
              ),
            }
          }
          if (input.action === "push") {
            return {
              content: formatOutput(
                await engine.push({ force: input.force === true, signal: toolContext.signal }),
              ),
            }
          }
          return {
            content: formatOutput(await engine.sync({ force: input.force === true, signal: toolContext.signal })),
          }
        },
      })
    })

    if (options.repository && options.startupMode !== "off") {
      track(background(options.startupMode))
    }

    let timer: ReturnType<typeof setInterval> | undefined
    if (options.repository && options.intervalSeconds > 0) {
      timer = setInterval(() => track(background("sync")), options.intervalSeconds * 1000)
      if (typeof timer.unref === "function") timer.unref()
    }

    return async () => {
      controller.abort()
      if (timer) clearInterval(timer)
      await Promise.allSettled([...backgroundTasks])
    }
  },
}
