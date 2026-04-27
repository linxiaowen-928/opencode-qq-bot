// @input:  @opencode-ai/sdk (Event, SSE stream), ./client (OpencodeClient)
// @output: EventRouter, EventCallback
// @pos:    opencode层 - 全局 SSE 事件订阅 + 按 sessionId 分发 + 支持 /connect 热重启
import type { OpencodeClient } from "./client.js"
import type { Event } from "@opencode-ai/sdk"

export type EventCallback = (event: Event) => void

export class EventRouter {
  private listeners = new Map<string, EventCallback>()
  private running = false
  // generation 用于区分 consume 循环的"代"；reconnect 时自增，旧循环下次检查到
  // 代号不匹配会主动退出，避免多个 consume 同时向同一个 listeners 表分发事件
  private generation = 0
  private client: OpencodeClient

  constructor(client: OpencodeClient) {
    this.client = client
  }

  async start(): Promise<void> {
    if (this.running) return
    this.running = true
    this.generation += 1
    const myGen = this.generation
    void this.consume(myGen)
  }

  stop(): void {
    this.running = false
    this.generation += 1
  }

  /**
   * 强制重启 consume 循环：旧循环在下一次事件或 SSE 报错时退出。
   * 注意：旧 SSE 连接若长期无事件且不报错，可能残留直到底层 HTTP 超时——
   * 这是无 AbortSignal 支持下的可接受折衷。
   */
  async restart(): Promise<void> {
    this.generation += 1
    this.running = true
    const myGen = this.generation
    void this.consume(myGen)
  }

  register(sessionId: string, callback: EventCallback): void {
    this.listeners.set(sessionId, callback)
  }

  unregister(sessionId: string): void {
    this.listeners.delete(sessionId)
  }

  private async consume(myGen: number): Promise<void> {
    while (this.running && myGen === this.generation) {
      try {
        const result = await this.client.event.subscribe()

        for await (const event of result.stream) {
          if (!this.running || myGen !== this.generation) break
          const sessionId = this.extractSessionId(event)
          if (sessionId) {
            const cb = this.listeners.get(sessionId)
            if (cb) cb(event)
          }
        }
        // 成功消费流后重置重连延迟
        this.resetBackoff()
      } catch (err) {
        if (!this.running || myGen !== this.generation) break
        const msg = err instanceof Error ? err.message : String(err)
        console.error(`[events] SSE connection error (gen=${myGen}): ${msg}`)
        await this.backoff()
      }
    }
    console.log(`[events] consume loop exited (gen=${myGen})`)
  }

  private extractSessionId(event: Event): string | undefined {
    switch (event.type) {
      case "message.part.updated":
        return event.properties.part.sessionID
      case "message.updated":
        return event.properties.info.sessionID
      case "session.idle":
      case "session.compacted":
        return event.properties.sessionID
      case "session.status":
        return event.properties.sessionID
      case "session.error":
        return event.properties.sessionID ?? undefined
      case "message.removed":
        return event.properties.sessionID
      default:
        return undefined
    }
  }

  private reconnectDelay = 1000
  private async backoff(): Promise<void> {
    await new Promise((r) => setTimeout(r, this.reconnectDelay))
    this.reconnectDelay = Math.min(this.reconnectDelay * 2, 30_000)
  }

  resetBackoff(): void {
    this.reconnectDelay = 1000
  }
}
