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
  baseUrl: string
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
// NOTE: 使用 fetch 直连而非 SDK 的 promptAsync，因为 SDK v1 的 SessionPromptAsyncData
// 类型不支持 query.directory，会导致 prompt 发到错误的 project 中。

export async function promptAsync(_client: OpencodeClient, params: PromptParams): Promise<void> {
  const url = `${params.baseUrl.replace(/\/+$/, "")}/session/${params.sessionId}/prompt_async`
  const urlWithDir = params.directory
    ? `${url}?directory=${encodeURIComponent(params.directory)}`
    : url
  console.log(`[moss-adapter] promptAsync url=${urlWithDir}`)
  const body: Record<string, unknown> = {
    parts: [{ type: "text", text: params.text }],
  }
  if (params.model) body.model = params.model
  if (params.agent) body.agent = params.agent
  const res = await fetch(urlWithDir, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  })
  if (!res.ok) {
    const text = await res.text().catch(() => "")
    throw new Error(`promptAsync failed (${res.status}): ${text.slice(0, 200)}`)
  }
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
