import type { Event } from "@opencode-ai/sdk"

export type EventCallback = (event: Event) => void

export class EventRouter {
  private listeners = new Map<string, EventCallback>()
  private running = false
  private generation = 0
  private directory: string | undefined
  private baseUrl: string

  constructor(baseUrl: string, directory?: string) {
    this.baseUrl = baseUrl.replace(/\/+$/, "")
    this.directory = directory
  }

  setDirectory(directory: string | undefined): void {
    if (this.directory === directory) return
    this.directory = directory
    this.generation += 1
    if (this.running) {
      void this.consume(this.generation)
    }
  }

  async start(): Promise<void> {
    if (this.running) return
    this.running = true
    this.generation += 1
    void this.consume(this.generation)
  }

  stop(): void {
    this.running = false
    this.generation += 1
  }

  async restart(): Promise<void> {
    this.generation += 1
    this.running = true
    void this.consume(this.generation)
  }

  register(sessionId: string, callback: EventCallback): void {
    this.listeners.set(sessionId, callback)
  }

  unregister(sessionId: string): void {
    this.listeners.delete(sessionId)
  }

  private processLine(line: string): void {
    if (!line.startsWith("data:")) return
    const json = line.slice(5).trim()
    if (!json) return
    try {
      const ev = JSON.parse(json)
      if (ev.type === "server.connected" || ev.type === "server.heartbeat") return
      console.log(`[moss-events] GOT: ${ev.type}`)
      const sid = this.extractSessionId(ev)
      if (sid) this.listeners.get(sid)?.(ev)
    } catch {}
  }

  private async consume(myGen: number): Promise<void> {
    console.log(`[moss-events] started gen=${myGen}`)
    while (this.running && myGen === this.generation) {
      try {
        const url = this.directory
          ? `${this.baseUrl}/event?directory=${encodeURIComponent(this.directory)}`
          : `${this.baseUrl}/event`

        const cp = await import("child_process")
        const { createInterface } = await import("readline")

        const child = cp.spawn("curl", ["-sN", url], { stdio: ["ignore", "pipe", "pipe"] })
        console.log(`[moss-events] curl pid=${child.pid}`)

        const rl = createInterface({ input: child.stdout! })
        let settled = false
        const kill = () => { if (!settled) { settled = true; try { child.kill() } catch {} } }

        rl.on("line", (line) => {
          if (!this.running || myGen !== this.generation) { kill(); return }
          this.processLine(line)
        })

        child.on("exit", (code) => { if (!settled) { console.log(`[moss-events] curl exit ${code}`); settled = true } })
        child.stderr!.resume()

        // Wait while curl is alive
        while (this.running && myGen === this.generation && !settled) {
          await new Promise(r => setTimeout(r, 500))
        }
        kill()
        this.resetBackoff()
      } catch (err) {
        if (!this.running || myGen !== this.generation) break
        await this.backoff()
      }
    }
    console.log(`[moss-events] exit gen=${myGen}`)
  }

  private extractSessionId(event: Event): string | undefined {
    switch (event.type) {
      case "message.part.updated": return event.properties.part.sessionID
      case "message.updated":     return event.properties.info.sessionID
      case "session.idle":        return event.properties.sessionID
      case "session.error":       return event.properties.sessionID ?? undefined
      default:                    return undefined
    }
  }

  private reconnectDelay = 1000
  private backoff(): Promise<void> { return new Promise((r) => setTimeout(r, this.reconnectDelay)) }
  resetBackoff(): void { this.reconnectDelay = 1000 }
}
