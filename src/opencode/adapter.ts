import type { OpencodeClient } from "./client.js"
import type { Event, Session, Agent, Project } from "@opencode-ai/sdk"

export interface AdapterSession {
  id: string
  title: string
  createdAt: number
  updatedAt: number
}

export interface AdapterModel {
  id: string
  providerId: string
  modelId: string
  label: string
}

export interface AdapterAgent {
  id: string
  label: string
}

export interface PromptParams {
  sessionId: string
  text: string
  directory?: string
  model?: { providerID: string; modelID: string }
  agent?: string
}

export interface SSEStream {
  stream: AsyncIterable<Event>
}

export interface AdapterProject {
  id: string
  worktree: string
  vcs?: string
  createdAt: number
}

export interface AdapterAllSession {
  id: string
  title: string
  directory: string
  projectWorktree: string
  createdAt: number
  updatedAt: number
}

// ---- helpers ----

function dirQuery(directory?: string): { query?: { directory: string } } {
  return directory ? { query: { directory } } : {}
}

// ---- conversion ----

function toAdapterSession(raw: Session): AdapterSession {
  return {
    id: raw.id,
    title: raw.title ?? raw.id,
    createdAt: raw.time?.created ?? 0,
    updatedAt: raw.time?.updated ?? 0,
  }
}

function toAdapterProject(raw: Project): AdapterProject {
  return {
    id: raw.id,
    worktree: raw.worktree,
    vcs: raw.vcs as string | undefined,
    createdAt: raw.time?.created ?? 0,
  }
}

// ---- session CRUD (v1 SDK, directory-aware) ----

export async function createSession(client: OpencodeClient, directory?: string): Promise<AdapterSession> {
  const result = await client.session.create({ ...dirQuery(directory) })
  const raw = (result.data ?? result) as Session
  if (!raw.id) throw new Error("session.create returned invalid data")
  return toAdapterSession(raw)
}

export async function listSessions(client: OpencodeClient, directory?: string): Promise<AdapterSession[]> {
  const result = await client.session.list({ ...dirQuery(directory) })
  const arr = (result.data ?? result) as Session[]
  if (!Array.isArray(arr)) return []
  return arr.map(toAdapterSession)
}

export async function abortSession(client: OpencodeClient, sessionId: string, directory?: string): Promise<void> {
  await client.session.abort({ path: { id: sessionId }, ...dirQuery(directory) })
}

export async function updateSessionTitle(client: OpencodeClient, sessionId: string, title: string, directory?: string): Promise<AdapterSession> {
  const result = await client.session.update({ path: { id: sessionId }, body: { title }, ...dirQuery(directory) })
  const raw = (result.data ?? result) as Session
  if (!raw.id) throw new Error("session.update returned invalid data")
  return toAdapterSession(raw)
}

// ---- prompt ----

export async function promptAsync(client: OpencodeClient, params: PromptParams): Promise<void> {
  console.log(`[adapter] promptAsync sessionId=${params.sessionId.slice(0,12)}... dir=${params.directory || '(none)'}`)
  await client.session.promptAsync({
    path: { id: params.sessionId },
    ...dirQuery(params.directory),
    body: {
      parts: [{ type: "text", text: params.text }],
      ...(params.model ? { model: params.model } : {}),
      ...(params.agent ? { agent: params.agent } : {}),
    },
  })
}

// ---- models ----

export async function listProviderModels(client: OpencodeClient): Promise<AdapterModel[]> {
  const result = await client.provider.list()
  const data = (result.data ?? result) as Record<string, unknown>
  const allProviders = Array.isArray(data.all) ? data.all as Record<string, unknown>[] : []
  const models: AdapterModel[] = []

  for (const provider of allProviders) {
    const providerId = typeof provider.id === "string" ? provider.id : undefined
    if (!providerId) continue

    const rawModels = provider.models
    if (!rawModels || typeof rawModels !== "object") continue

    // 新 SDK 中 models 是 { [key: string]: Model } 对象，非数组
    const entries = Array.isArray(rawModels) ? rawModels : Object.values(rawModels)
    for (const m of entries) {
      if (!m || typeof m !== "object") continue
      const rec = m as Record<string, unknown>
      const modelId = typeof rec.id === "string" ? rec.id : undefined
      if (!modelId) continue
      const modelName = typeof rec.name === "string" ? rec.name : modelId
      models.push({ id: `${providerId}/${modelId}`, providerId, modelId, label: `${providerId} / ${modelName}` })
    }
  }

  return models
}

// ---- agents ----

export async function listAgents(client: OpencodeClient): Promise<AdapterAgent[]> {
  const result = await client.app.agents()
  const arr = (result.data ?? result) as Agent[]
  if (!Array.isArray(arr)) return []
  return arr
    .map((a) => {
      // 新 SDK Agent 类型使用 name 字段作为标识符
      const id = a.name ?? (a as Record<string, unknown>).id as string | undefined
      if (!id) return null
      const desc = a.description
      return { id, label: desc ? `${id} - ${desc}` : id }
    })
    .filter((a): a is AdapterAgent => a !== null)
}

// ---- projects ----

export async function listProjects(client: OpencodeClient): Promise<AdapterProject[]> {
  const result = await client.project.list({})
  const arr = (result.data ?? result) as Project[]
  if (!Array.isArray(arr)) return []
  return arr.map(toAdapterProject)
}

// ---- cross-project sessions (experimental API) ----

export async function listAllSessions(baseUrl: string): Promise<AdapterAllSession[]> {
  const url = `${baseUrl.replace(/\/+$/, "")}/experimental/session`
  const res = await fetch(url)
  if (!res.ok) throw new Error(`experimental/session 返回 ${res.status}`)
  const arr = await res.json() as Array<Record<string, unknown>>
  if (!Array.isArray(arr)) return []
  return arr.map((s) => {
    const proj = (s.project ?? {}) as Record<string, unknown>
    const time = (s.time ?? {}) as Record<string, unknown>
    return {
      id: String(s.id ?? ""),
      title: String(s.title ?? s.id ?? ""),
      directory: String(s.directory ?? ""),
      projectWorktree: String(proj.worktree ?? ""),
      createdAt: Number(time.created ?? 0),
      updatedAt: Number(time.updated ?? 0),
    }
  })
}

// ---- events ----

export async function subscribeEvents(client: OpencodeClient): Promise<SSEStream> {
  const result = await client.event.subscribe()
  return { stream: result.stream as AsyncIterable<Event> }
}

// ---- health ----

export async function healthCheck(client: OpencodeClient): Promise<void> {
  try {
    await client.session.list()
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    throw new Error(`OpenCode server unreachable: ${msg}`)
  }
}
