import type { Config } from "../config.js"
import type { ClientRef, OpencodeClient } from "../opencode/client.js"
import type { EventRouter } from "../opencode/events.js"
import { SessionManager } from "../opencode/sessions.js"

export const SELECTION_TTL_MS = 60_000

/**
 * 切换 opencode 连接地址的回调。实现位于 index.ts / bridge.ts：
 * - 校验 + 调用 reconnectClientRef
 * - 重启 EventRouter
 * - 清空 SessionManager 缓存
 * - 持久化到 ~/.openqq/.env
 * 成功返回新地址，失败 throw Error（由 handler 捕获生成回复）。
 */
export type ReconnectFn = (newBaseUrl: string) => Promise<void>

export type SetProjectDirectoryFn = (directory: string | undefined) => void

export interface CommandContext {
  config: Config
  /** 注意：该 client 实为 ClientRef 上的 Proxy，运行时替换 ref.current 后所有方法自动走新实例 */
  client: OpencodeClient
  clientRef: ClientRef
  router: EventRouter
  sessions: SessionManager
  getAccessToken: () => Promise<string>
  pendingSelections: Map<string, PendingSelection>
  reconnect: ReconnectFn
  setProjectDirectory: SetProjectDirectoryFn
}

export interface PendingSelection {
  type: "session" | "model" | "project"
  items: Array<{ id: string; label: string; directory?: string }>
  expiresAt: number
}

export interface ParsedCommand {
  name: string
  args: string
}
