import type { Config } from "../config.js"
import type { ClientRef, OpencodeClient } from "../opencode/client.js"
import type { EventRouter } from "../opencode/events.js"
import { SessionManager } from "../opencode/sessions.js"

export const SELECTION_TTL_MS = 60_000

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
  /** sessionId → 最后一次 AI 回复（用于 /replay） */
  lastReplies: Map<string, string>
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
