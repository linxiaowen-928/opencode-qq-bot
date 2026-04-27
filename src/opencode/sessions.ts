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

interface PersistedState {
  sessions: Array<{ userId: string; sessionId: string; title?: string }>
  projectDirectory?: string
}

const STATE_FILE = join(homedir(), ".openqq", "session_state.json")

export class SessionManager {
  private sessions = new Map<string, UserSession>()
  private userSessionHistory = new Map<string, Array<{ id: string; title: string }>>()
  private client: OpencodeClient
  private projectDirectory: string | undefined

  constructor(client: OpencodeClient, projectDirectory?: string) {
    this.client = client
    this.projectDirectory = projectDirectory
    this.loadFromDisk()
  }

  /**
   * 持久化当前状态到 ~/.openqq/session_state.json，使重启后能恢复会话映射。
   */
  private saveToDisk(): void {
    try {
      const state: PersistedState = {
        sessions: Array.from(this.sessions.entries()).map(([userId, s]) => ({
          userId,
          sessionId: s.sessionId,
          title: s.title,
        })),
        projectDirectory: this.projectDirectory,
      }
      mkdirSync(join(homedir(), ".openqq"), { recursive: true })
      writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), "utf-8")
    } catch (err) {
      console.warn(`[sessions] saveToDisk failed: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  /**
   * 启动时从磁盘加载上次的 session 映射和 projectDirectory。
   */
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
      console.log(`[sessions] loaded ${state.sessions.length} session mappings from disk, projectDir=${this.projectDirectory || "(none)"}`)
    } catch (err) {
      console.warn(`[sessions] loadFromDisk failed: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  getProjectDirectory(): string | undefined { return this.projectDirectory }

  /** 切换当前 project；同时清空所有用户的 session 映射（旧 sessionId 在新 project 无意义）。 */
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

  /**
   * 清空所有用户的 session 映射与历史。
   */
  resetAll(): void {
    this.sessions.clear()
    this.userSessionHistory.clear()
    this.saveToDisk()
  }

  private trackSession(userId: string, sessionId: string, title: string): void {
    const history = this.userSessionHistory.get(userId) ?? []
    if (!history.some((h) => h.id === sessionId)) {
      history.push({ id: sessionId, title })
      this.userSessionHistory.set(userId, history)
    }
  }
}

export type { UserSession }
