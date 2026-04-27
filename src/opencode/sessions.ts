import type { OpencodeClient } from "./client.js"
import { createSession } from "./adapter.js"
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs"
import { join } from "path"
import { homedir } from "os"

interface UserSession {
  sessionId: string
  title?: string
  modelId?: string
  providerId?: string
  agentId?: string
}

export interface BookmarkEntry {
  sessionId: string
  title?: string
  projectDirectory?: string
}

interface PersistedState {
  sessions: Array<{ userId: string; sessionId: string; title?: string }>
  projectDirectory?: string
  pendingPrompts?: Array<{ userId: string; timestamp: number }>
  bookmarks?: Array<{ userId: string; stack: BookmarkEntry[] }>
}

const STATE_FILE = join(homedir(), ".openqq", "session_state.json")

export class SessionManager {
  private sessions = new Map<string, UserSession>()
  private userSessionHistory = new Map<string, Array<{ id: string; title: string }>>()
  /** 书签栈：userId → BookmarkEntry[] */
  private bookmarkStacks = new Map<string, BookmarkEntry[]>()
  private client: OpencodeClient
  private projectDirectory: string | undefined
  private pendingPrompts = new Set<string>()

  constructor(client: OpencodeClient, projectDirectory?: string) {
    this.client = client
    this.projectDirectory = projectDirectory
    this.loadFromDisk()
  }

  private saveToDisk(): void {
    try {
      const state: PersistedState = {
        sessions: Array.from(this.sessions.entries()).map(([userId, s]) => ({
          userId,
          sessionId: s.sessionId,
          title: s.title,
        })),
        projectDirectory: this.projectDirectory,
        pendingPrompts: this.pendingPrompts.size > 0
          ? Array.from(this.pendingPrompts).map((userId) => ({ userId, timestamp: Date.now() }))
          : undefined,
        bookmarks: Array.from(this.bookmarkStacks.entries()).map(([userId, stack]) => ({
          userId,
          stack,
        })),
      }
      mkdirSync(join(homedir(), ".openqq"), { recursive: true })
      writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), "utf-8")
    } catch (err) {
      console.warn(`[sessions] saveToDisk failed: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  private loadFromDisk(): void {
    try {
      if (!existsSync(STATE_FILE)) return
      const raw = readFileSync(STATE_FILE, "utf-8")
      const state: PersistedState = JSON.parse(raw)
      for (const entry of state.sessions) {
        this.sessions.set(entry.userId, {
          sessionId: entry.sessionId,
          title: entry.title,
        })
      }
      if (state.projectDirectory) {
        this.projectDirectory = state.projectDirectory
      }
      if (state.pendingPrompts) {
        for (const p of state.pendingPrompts) {
          this.pendingPrompts.add(p.userId)
        }
      }
      if (state.bookmarks) {
        for (const b of state.bookmarks) {
          this.bookmarkStacks.set(b.userId, b.stack)
        }
      }
      console.log(`[sessions] loaded ${state.sessions.length} sessions, ${this.pendingPrompts.size} pending, ${state.bookmarks?.length ?? 0} bookmark stacks`)
    } catch (err) {
      console.warn(`[sessions] loadFromDisk failed: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  getProjectDirectory(): string | undefined { return this.projectDirectory }

  setProjectDirectory(directory: string | undefined): void {
    this.projectDirectory = directory
    this.resetAll()
  }

  async getOrCreate(userId: string): Promise<UserSession> {
    const existing = this.sessions.get(userId)
    if (existing) {
      console.log(`[sessions] getOrCreate REUSE userId=${userId.slice(0, 8)}... sessionId=${existing.sessionId.slice(0, 12)}... dir=${this.projectDirectory || "(default)"}`)
      return existing
    }
    console.log(`[sessions] getOrCreate NEW userId=${userId.slice(0, 8)}... dir=${this.projectDirectory || "(default)"}`)
    const created = await createSession(this.client, this.projectDirectory)
    const session: UserSession = { sessionId: created.id, title: created.title }
    this.sessions.set(userId, session)
    this.trackSession(userId, created.id, created.title)
    this.saveToDisk()
    return session
  }

  async createNew(userId: string): Promise<UserSession> {
    const created = await createSession(this.client, this.projectDirectory)
    const session: UserSession = { sessionId: created.id, title: created.title }
    this.sessions.set(userId, session)
    this.trackSession(userId, created.id, created.title)
    this.saveToDisk()
    return session
  }

  getUserSessions(userId: string): Array<{ id: string; title: string }> {
    return this.userSessionHistory.get(userId) ?? []
  }

  switchSession(userId: string, sessionId: string, title?: string): void {
    const prev = this.sessions.get(userId)
    console.log(`[sessions] switchSession userId=${userId.slice(0, 8)}... from=${prev?.sessionId?.slice(0, 12) || "none"} to=${sessionId.slice(0, 12)}... dir=${this.projectDirectory || "(default)"}`)
    this.sessions.set(userId, {
      ...prev,
      sessionId,
      title,
    })
    this.trackSession(userId, sessionId, title ?? sessionId)
    this.saveToDisk()
  }

  getSession(userId: string): UserSession | undefined {
    return this.sessions.get(userId)
  }

  setModel(userId: string, providerId: string, modelId: string): void {
    const s = this.sessions.get(userId)
    if (s) {
      s.providerId = providerId
      s.modelId = modelId
    }
  }

  setAgent(userId: string, agentId: string): void {
    const s = this.sessions.get(userId)
    if (s) {
      s.agentId = agentId
    }
  }

  getModel(userId: string): { providerId?: string; modelId?: string } {
    const s = this.sessions.get(userId)
    return { providerId: s?.providerId, modelId: s?.modelId }
  }

  getAgent(userId: string): string | undefined {
    return this.sessions.get(userId)?.agentId
  }

  updateSessionTitle(userId: string, sessionId: string, title: string): void {
    const history = this.userSessionHistory.get(userId)
    if (history) {
      const entry = history.find((h) => h.id === sessionId)
      if (entry) entry.title = title
    }
    const current = this.sessions.get(userId)
    if (current && current.sessionId === sessionId) {
      current.title = title
    }
    this.saveToDisk()
  }

  resetAll(): void {
    this.sessions.clear()
    this.userSessionHistory.clear()
    this.saveToDisk()
  }

  // ---- 书签栈操作 ----

  /** 返回用户的书签栈（浅拷贝）。 */
  getBookmarks(userId: string): BookmarkEntry[] {
    return this.bookmarkStacks.get(userId) ?? []
  }

  /** 把当前 session 和 project 压入书签栈，然后创建新 session。 */
  pushBookmark(userId: string, name: string): BookmarkEntry {
    const current = this.sessions.get(userId)
    const entry: BookmarkEntry = {
      sessionId: current?.sessionId ?? "",
      title: current?.title ?? name,
      projectDirectory: this.projectDirectory,
    }
    const stack = this.bookmarkStacks.get(userId) ?? []
    stack.push(entry)
    this.bookmarkStacks.set(userId, stack)
    this.saveToDisk()
    return entry
  }

  /** 弹出书签栈顶，返回被保存的记录。如果栈为空返回 undefined。 */
  popBookmark(userId: string): BookmarkEntry | undefined {
    const stack = this.bookmarkStacks.get(userId)
    if (!stack || stack.length === 0) return undefined
    const entry = stack.pop()!
    if (stack.length === 0) {
      this.bookmarkStacks.delete(userId)
    }
    this.saveToDisk()
    return entry
  }

  private trackSession(userId: string, sessionId: string, title: string): void {
    const history = this.userSessionHistory.get(userId) ?? []
    if (!history.some((h) => h.id === sessionId)) {
      history.push({ id: sessionId, title })
      this.userSessionHistory.set(userId, history)
    }
  }

  savePendingPrompt(userId: string): void {
    this.pendingPrompts.add(userId)
    this.saveToDisk()
  }

  clearPendingPrompt(userId: string): void {
    this.pendingPrompts.delete(userId)
    this.saveToDisk()
  }

  getPendingPromptsOnStartup(): string[] {
    return Array.from(this.pendingPrompts)
  }
}

export type { UserSession }
