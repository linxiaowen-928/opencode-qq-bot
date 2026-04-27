import type { OpencodeClient } from "./client.js"
import type { Event } from "@opencode-ai/sdk"

export type EventCallback = (event: Event) => void

export class EventRouter {
  private listeners = new Map<string, EventCallback>()
  private running = false
  private generation = 0
  private directory: string | undefined
  private client: OpencodeClient

  constructor(client: OpencodeClient, directory?: string) {
    this.client = client
    this.directory = directory
  }

  setDirectory(directory: string | undefined): void {
    this.directory = directory
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
    console.log(`[events] consume started, gen=${myGen} dir=${this.directory || "(global)"}`)
    while (this.running && myGen === this.generation) {
      try {
        const opts: Record<string, unknown> = {}
        if (this.directory) opts.query = { directory: this.directory }
        console.log(`[events] subscribing with opts=${JSON.stringify(opts)}`)
        const result = await this.client.event.subscribe(opts)
        console.log(`[events] SSE connected, gen=${myGen}`)

        for await (const event of result.stream) {
          console.log(`[events] GOT: type=${event.type}`)
          if (!this.running || myGen !== this.generation) break
          const sessionId = this.extractSessionId(event)
          if (sessionId) {
            const cb = this.listeners.get(sessionId)
            if (cb) cb(event)
          }
        }
        this.resetBackoff()
      } catch (err) {
        if (!this.running || myGen !== this.generation) break
        const msg = err instanceof Error ? err.message : String(err)
        console.error(`[events] SSE error (gen=${myGen}): ${msg}`)
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
        return event.properties.sessionID
      case "session.error":
        return event.properties.sessionID ?? undefined
      default:
        return undefined
    }
  }

  private reconnectDelay = 1000
  private backoff(): Promise<void> {
    return new Promise((r) => setTimeout(r, this.reconnectDelay))
  }
  resetBackoff(): void { this.reconnectDelay = 1000 }
}
