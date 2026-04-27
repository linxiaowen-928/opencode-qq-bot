import type { OpencodeClient } from "./client.js"
import { createSession } from "./adapter.js"

interface UserSession {
  sessionId: string
  title?: string
  modelId?: string
  providerId?: string
  agentId?: string
}

export class SessionManager {
  private sessions = new Map<string, UserSession>()
  private userSessionHistory = new Map<string, Array<{ id: string; title: string }>>()
  private client: OpencodeClient
  private projectDirectory: string | undefined

  constructor(client: OpencodeClient, projectDirectory?: string) {
    this.client = client
    this.projectDirectory = projectDirectory
  }

  getProjectDirectory(): string | undefined { return this.projectDirectory }

  /** 切换当前 project；同时清空所有用户的 session 映射（旧 sessionId 在新 project 无意义）。 */
  setProjectDirectory(directory: string | undefined): void {
    this.projectDirectory = directory
    this.resetAll()
  }

  async getOrCreate(userId: string): Promise<UserSession> {
    const existing = this.sessions.get(userId)
    if (existing) return existing

    const created = await createSession(this.client, this.projectDirectory)
    const session: UserSession = { sessionId: created.id, title: created.title }
    this.sessions.set(userId, session)
    this.trackSession(userId, created.id, created.title)
    return session
  }

  async createNew(userId: string): Promise<UserSession> {
    const created = await createSession(this.client, this.projectDirectory)
    const session: UserSession = { sessionId: created.id, title: created.title }
    this.sessions.set(userId, session)
    this.trackSession(userId, created.id, created.title)
    return session
  }

  getUserSessions(userId: string): Array<{ id: string; title: string }> {
    return this.userSessionHistory.get(userId) ?? []
  }

  switchSession(userId: string, sessionId: string, title?: string): void {
    this.sessions.set(userId, {
      ...this.sessions.get(userId),
      sessionId,
      title,
    })
    this.trackSession(userId, sessionId, title ?? sessionId)
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
  }

  /**
   * 清空所有用户的 session 映射与历史。
   * 用在 /connect 切换到新的 opencode 后，因为旧 sessionId 在新实例上无意义。
   */
  resetAll(): void {
    this.sessions.clear()
    this.userSessionHistory.clear()
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
