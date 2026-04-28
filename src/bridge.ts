import type { Config } from "./config.js"
import type { MessageContext } from "./qq/types.js"
import { getAccessToken } from "./qq/token.js"
import { replyToQQ } from "./qq/sender.js"
import type { ClientRef, OpencodeClient } from "./opencode/client.js"
import { promptAsync } from "./opencode/adapter.js"
import { EventRouter } from "./opencode/events.js"
import { SessionManager } from "./opencode/sessions.js"
import type { Event } from "@opencode-ai/sdk"
import {
  handleCommand,
  handlePendingSelection,
  isCommand,
  type CommandContext,
  type PendingSelection,
  type ReconnectFn,
  type SetProjectDirectoryFn,
} from "./commands/index.js"

const RESPONSE_TIMEOUT_MS = 60 * 60 * 1000   // 60 分钟

interface StreamCallbacks {
  onFirstChunk: () => Promise<void>
  onProgress: (text: string) => Promise<void>
  onDone: (text: string) => Promise<void>
}

interface Bridge {
  handleMessage: (ctx: MessageContext) => Promise<void>
}

export function createBridge(
  config: Config,
  client: OpencodeClient,
  clientRef: ClientRef,
  router: EventRouter,
  sessions: SessionManager,
  reconnect: ReconnectFn,
  setProjectDirectory: SetProjectDirectoryFn,
): Bridge {
  // 消息队列：userId → [未发送的消息内容列表]
  const messageQueue = new Map<string, string[]>()
  // 持久化的 greeted 状态（每个 user 是否已打过招呼）
  const greeted = new Set<string>()
  // 本次启动前有未完成 prompt 的用户，需在第一条消息时通知
  const pendingOnStartup = new Set(sessions.getPendingPromptsOnStartup())
  console.log(`[bridge] ${pendingOnStartup.size} users had pending prompts on startup`)
  const pendingSelections = new Map<string, PendingSelection>()
  const lastReplies = new Map<string, string>()
  const commandContext: CommandContext = {
    config,
    client,
    clientRef,
    router,
    sessions,
    getAccessToken: () => getAccessToken(config.qq.appId, config.qq.clientSecret),
    pendingSelections,
    reconnect,
    setProjectDirectory,
    lastReplies,
  }

  // 核心：处理一条 prompt（包括队列排空）
  async function processPrompt(userId: string, content: string, ctx: MessageContext): Promise<void> {
    const session = await sessions.getOrCreate(userId)
    const model = sessions.getModel(userId)
    const agent = sessions.getAgent(userId)
    let repliedProcessing = false

    await waitForSessionReply(
      router,
      session.sessionId,
      () => {
        void promptAsync(client, {
          sessionId: session.sessionId,
          text: content,
          model: model.providerId && model.modelId
            ? { providerID: model.providerId, modelID: model.modelId }
            : { providerID: "deepseek", modelID: "deepseek-v4-flash" },
          agent,
          baseUrl: clientRef.baseUrl,
          directory: sessions.getProjectDirectory(),
        })
      },
      {
        onFirstChunk: async () => {
          if (!repliedProcessing) {
            repliedProcessing = true
            await sendReply(ctx, "AI 正在处理中...")
          }
        },
        onProgress: async (text) => {
          await sendReply(ctx, text)
          const prefix = "[AI 输出中] "
          const preview = text.length > 500 ? text.slice(0, 500) + "..." : text
          await sendReply(ctx, prefix + preview)
        },
        onDone: async (text) => {
          if (text.trim()) {
            lastReplies.set(session.sessionId, text)
            await sendReply(ctx, text)
          }
        },
      },
    )
  }

  const handleMessage = async (ctx: MessageContext): Promise<void> => {
    try {
      if (!isAllowedUser(ctx.userId, config.allowedUsers)) {
        await sendReply(ctx, "你不在允许使用的名单里")
        return
      }

      const content = ctx.content.trim()
      if (!content) return

      if (!greeted.has(ctx.userId)) {
        greeted.add(ctx.userId)
        // 不发使用说明了，用户自己发 hp 查看
      }

      if (isCommand(content)) {
        const reply = await handleCommand(ctx, commandContext)
        await sendReply(ctx, reply)
        return
      }

      const pendingReply = await maybeHandlePendingSelection(ctx, commandContext)
      if (pendingReply !== null) {
        await sendReply(ctx, pendingReply)
        return
      }

      // 消息队列：如果该用户有正在处理的消息，入队等待
      if (messageQueue.has(ctx.userId)) {
        messageQueue.get(ctx.userId)!.push(content)
        console.log(`[bridge] queued message for userId=${ctx.userId.slice(0, 8)}... queue length=${messageQueue.get(ctx.userId)!.length}`)
        return
      }

      // 新消息：标记为处理中
      messageQueue.set(ctx.userId, [])

      try {
        sessions.savePendingPrompt(ctx.userId)
        await processPrompt(ctx.userId, content, ctx)
      } catch (error) {
        await sendReply(ctx, `处理失败：${toErrorMessage(error)}`)
      } finally {
        // 排空队列：合并所有等待的消息为一条 prompt
        const queue = messageQueue.get(ctx.userId) ?? []
        messageQueue.delete(ctx.userId)
        sessions.clearPendingPrompt(ctx.userId)
        if (queue.length > 0) {
          const combined = queue.join("\n---\n")
          console.log(`[bridge] draining queue for userId=${ctx.userId.slice(0, 8)}... combined ${queue.length} messages`)
          try {
            sessions.savePendingPrompt(ctx.userId)
            await processPrompt(ctx.userId, combined, ctx)
          } catch (error) {
            await sendReply(ctx, `处理失败：${toErrorMessage(error)}`)
          }
        }
      }
    } catch (error) {
      console.error("[bridge] handleMessage failed:", error)
      try {
        await sendReply(ctx, `处理消息失败：${toErrorMessage(error)}`)
      } catch (replyError) {
        console.error("[bridge] failed to send error reply:", replyError)
      }
    }
  }

  async function sendReply(ctx: MessageContext, text: string): Promise<void> {
    const accessToken = await getAccessToken(config.qq.appId, config.qq.clientSecret)
    await replyToQQ(accessToken, ctx, text, config.maxReplyLength)
  }

  return { handleMessage }
}

async function maybeHandlePendingSelection(
  ctx: MessageContext,
  commandContext: CommandContext,
): Promise<string | null> {
  const pending = commandContext.pendingSelections.get(ctx.userId)
  if (!pending) return null
  if (pending.expiresAt <= Date.now()) {
    commandContext.pendingSelections.delete(ctx.userId)
    return null
  }
  if (!/^\d+$/.test(ctx.content.trim())) {
    commandContext.pendingSelections.delete(ctx.userId)
    return null
  }
  return handlePendingSelection(ctx.userId, Number(ctx.content.trim()), commandContext)
}

function isAllowedUser(userId: string, allowedUsers: string[]): boolean {
  return allowedUsers.length === 0 || allowedUsers.includes(userId)
}

function waitForSessionReply(
  router: EventRouter,
  sessionId: string,
  startPrompt: () => void,
  callbacks: StreamCallbacks,
): Promise<void> {
  let settled = false
  let latestText = ""
  let lastSentLength = 0
  let lastSendTime = 0
  let hasReceivedChunk = false

  // 增量推送：有足够新内容且距上次发送超过 30 秒时推送
  const MIN_DELTA = 200
  const MIN_INTERVAL = 30_000

  return new Promise<void>((resolve, reject) => {
    const timeoutId = setTimeout(() => {
      finish(() => reject(new Error("AI 响应超时（60 分钟）")))
    }, RESPONSE_TIMEOUT_MS)

    const finish = (done: () => void): void => {
      if (settled) return
      settled = true
      clearTimeout(timeoutId)
      router.unregister(sessionId)
      done()
    }

    router.unregister(sessionId)
    router.register(sessionId, (event: Event) => {
      if (event.type === "message.part.updated") {
        const part = event.properties.part
        if (part.type === "text" || part.type === "reasoning") {
          latestText = part.text
          if (!hasReceivedChunk) {
            hasReceivedChunk = true
            void callbacks.onFirstChunk()
            lastSendTime = Date.now()
            // 首次推送头部内容
            const head = latestText.slice(0, MIN_DELTA)
            if (head) {
              lastSentLength = head.length
              void callbacks.onProgress(head)
            }
            return
          }

          // 后续：增量推送
          const now = Date.now()
          const newDelta = latestText.length - lastSentLength
          if (newDelta >= MIN_DELTA && now - lastSendTime >= MIN_INTERVAL) {
            const delta = latestText.slice(lastSentLength)
            lastSentLength = latestText.length
            lastSendTime = now
            void callbacks.onProgress(delta)
          }
        }
        return
      }

      if (event.type === "session.idle") {
        finish(() => {
          const remaining = latestText.slice(lastSentLength)
          const finalText = remaining || latestText || "(AI 未返回内容)"
          void callbacks.onDone(finalText).then(() => resolve())
        })
        return
      }

      if (event.type === "session.error") {
        finish(() => reject(new Error(toErrorMessage(event.properties.error) || "未知错误")))
      }
    })

    try {
      startPrompt()
    } catch (error) {
      finish(() => reject(error instanceof Error ? error : new Error(String(error))))
    }
  })
}

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
