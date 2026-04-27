import type { MessageContext } from "../qq/types.js"
import type { CommandContext } from "./types.js"
import { SELECTION_TTL_MS } from "./types.js"
import {
  abortSession,
  listProviderModels,
  listAgents as adapterListAgents,
  updateSessionTitle,
  healthCheck,
  listAllSessions,
} from "../opencode/adapter.js"

export async function handleNew(ctx: MessageContext, cmdCtx: CommandContext): Promise<string> {
  const session = await cmdCtx.sessions.createNew(ctx.userId)
  return [
    "已创建新会话",
    `标题：${session.title ?? "未命名会话"}`,
    `ID：${session.sessionId}`,
  ].join("\n")
}

export async function handleStop(ctx: MessageContext, cmdCtx: CommandContext): Promise<string> {
  const session = cmdCtx.sessions.getSession(ctx.userId)
  if (!session) {
    return "当前还没有会话可停止"
  }

  const projectDir = cmdCtx.sessions.getProjectDirectory()
  await abortSession(cmdCtx.client, session.sessionId, projectDir)
  return `已发送停止请求：${session.title ?? session.sessionId}`
}

export async function handleStatus(ctx: MessageContext, cmdCtx: CommandContext): Promise<string> {
  const session = cmdCtx.sessions.getSession(ctx.userId)
  const { providerId, modelId } = cmdCtx.sessions.getModel(ctx.userId)
  const agentId = cmdCtx.sessions.getAgent(ctx.userId)
  const projectDir = cmdCtx.sessions.getProjectDirectory()

  let openCodeStatus: string
  let serverSessionCount: number | null = null
  try {
    await healthCheck(cmdCtx.client)
    openCodeStatus = "运行中"
    try {
      const all = await listAllSessions(cmdCtx.clientRef.baseUrl)
      if (projectDir) {
        serverSessionCount = all.filter(s => s.directory === projectDir || s.projectWorktree === projectDir).length
      } else {
        serverSessionCount = all.length
      }
    } catch {
      // 忽略：健康检查通过但 list 失败时仅不展示数量
    }
  } catch {
    openCodeStatus = "异常"
  }

  let qqStatus: string
  try {
    await cmdCtx.getAccessToken()
    qqStatus = "正常"
  } catch {
    qqStatus = "异常"
  }

  const mode = cmdCtx.clientRef.external ? "外部" : "嵌入式"
  const countLine = serverSessionCount === null ? "" : `\n服务端 session 总数：${serverSessionCount}`
  const projectLine = projectDir ? `\n当前 project：${projectDir}` : ""

  return [
    "OpenCode 状态",
    `服务器：${openCodeStatus}`,
    `连接：${mode} - ${cmdCtx.clientRef.baseUrl}${countLine}${projectLine}`,
    `QQ 鉴权：${qqStatus}`,
    `会话：${session ? `${session.title ?? "未命名会话"} (${session.sessionId})` : "未创建"}`,
    `模型：${providerId && modelId ? `${providerId} / ${modelId}` : "默认"}`,
    `Agent：${agentId ?? "默认"}`,
  ].join("\n")
}

export async function handleSessions(ctx: MessageContext, cmdCtx: CommandContext): Promise<string> {
  // 从 OpenCode 服务端拉取完整 session 列表（跨 project）
  let allSessions: Array<{ id: string; title: string; directory: string; projectWorktree: string; updatedAt: number }> = []
  try {
    allSessions = await listAllSessions(cmdCtx.clientRef.baseUrl)
    allSessions.sort((a, b) => b.updatedAt - a.updatedAt)
  } catch {
    // 降级：无列表时展示空
  }

  if (allSessions.length === 0) {
    return "当前没有可切换的会话（服务端和本地均无记录）"
  }

  // 按 projectWorktree 分组
  const groups = new Map<string, typeof allSessions>()
  for (const s of allSessions) {
    const key = s.projectWorktree || "未知 project"
    const list = groups.get(key) ?? []
    list.push(s)
    groups.set(key, list)
  }

  const currentSessionId = cmdCtx.sessions.getSession(ctx.userId)?.sessionId
  cmdCtx.pendingSelections.set(ctx.userId, {
    type: "session",
    items: allSessions.map((s) => ({
      id: s.id,
      label: s.title,
      directory: s.directory,
    })),
    expiresAt: Date.now() + SELECTION_TTL_MS,
  })

  const lines: string[] = [`会话列表（共 ${allSessions.length} 个）：`]
  let idx = 1
  for (const [worktree, sessions] of groups) {
    const label = worktree === "/" ? "全局" : worktree.split("/").pop() || worktree
    lines.push(`\n[${label}] (${sessions.length} sessions)`)
    for (const s of sessions) {
      const prefix = s.id === currentSessionId ? "[当前] " : ""
      lines.push(`${idx}. ${prefix}${s.title}  ${formatRelativeTime(s.updatedAt)}`)
      idx++
    }
  }
  lines.push("回复序号切换会话（60 秒内有效）")
  return lines.join("\n")
}

export async function handleModel(ctx: MessageContext, args: string, cmdCtx: CommandContext): Promise<string> {
  if (!args) {
    const models = await listProviderModels(cmdCtx.client)
    if (models.length === 0) {
      return "当前没有可用模型"
    }

    const current = cmdCtx.sessions.getModel(ctx.userId)
    cmdCtx.pendingSelections.set(ctx.userId, {
      type: "model",
      items: models.map((m) => ({ id: m.id, label: m.label })),
      expiresAt: Date.now() + SELECTION_TTL_MS,
    })

    const lines = models.map((m, index) => {
      const isCurrent = current.providerId && current.modelId && `${current.providerId}/${current.modelId}` === m.id
      return `${index + 1}. ${isCurrent ? "[当前] " : ""}${m.label}`
    })

    return ["可用模型：", ...lines, "回复序号或 md <provider/model> 切换（60 秒内有效）"].join("\n")
  }

  if (/^\d+$/.test(args)) {
    const pending = cmdCtx.pendingSelections.get(ctx.userId)
    if (!pending || pending.type !== "model") {
      return "没有待选择的模型列表，请先发送 md 或 /model"
    }
    if (pending.expiresAt <= Date.now()) {
      return "模型选择已过期，请重新发送 md 或 /model"
    }
    const selection = Number(args)
    const item = pending.items[selection - 1]
    if (!item) {
      return `序号无效，请回复 1-${pending.items.length}`
    }
    cmdCtx.pendingSelections.delete(ctx.userId)
    const model = splitModelId(item.id)
    if (!model) {
      return `模型项无效：${item.label}`
    }
    await ensureSession(ctx.userId, cmdCtx)
    cmdCtx.sessions.setModel(ctx.userId, model.providerId, model.modelId)
    return `已切换模型：${item.label}`
  }

  const model = splitModelId(args)
  if (!model) {
    return "模型格式不对，请使用 md <provider/model>"
  }

  await ensureSession(ctx.userId, cmdCtx)
  cmdCtx.sessions.setModel(ctx.userId, model.providerId, model.modelId)
  return `已切换模型：${model.providerId} / ${model.modelId}`
}

export async function handleAgent(ctx: MessageContext, args: string, cmdCtx: CommandContext): Promise<string> {
  const agents = await adapterListAgents(cmdCtx.client)
  if (!args) {
    if (agents.length === 0) {
      return "当前没有可用 Agent"
    }

    const currentAgent = cmdCtx.sessions.getAgent(ctx.userId)
    const lines = agents.map((agent, index) => {
      const isCurrent = currentAgent === agent.id
      return `${index + 1}. ${isCurrent ? "[当前] " : ""}${agent.label}`
    })

    return ["可用 Agent：", ...lines, "回复 ag <name> 切换"].join("\n")
  }

  const normalized = args.trim().toLowerCase()
  const matched = agents.find((agent) => agent.id.toLowerCase() === normalized)
  if (!matched) {
    return `未找到 Agent：${args}`
  }

  await ensureSession(ctx.userId, cmdCtx)
  cmdCtx.sessions.setAgent(ctx.userId, matched.id)
  return `已切换 Agent：${matched.id}`
}

export async function handleRename(ctx: MessageContext, args: string, cmdCtx: CommandContext): Promise<string> {
  const title = args.trim()
  if (!title) {
    return "用法：rn <新名称>"
  }

  const session = cmdCtx.sessions.getSession(ctx.userId)
  if (!session) {
    return "当前还没有会话可重命名"
  }

  try {
    const projectDir = cmdCtx.sessions.getProjectDirectory()
    await updateSessionTitle(cmdCtx.client, session.sessionId, title, projectDir)
  } catch {
    // 服务端更新失败时仍更新本地，保证用户体验
  }
  cmdCtx.sessions.updateSessionTitle(ctx.userId, session.sessionId, title)
  return `已重命名当前会话：${title}`
}

export async function handleConnect(_ctx: MessageContext, args: string, cmdCtx: CommandContext): Promise<string> {
  const url = args.trim()
  if (!url) {
    return [
      "用法：cn <url>   例：cn http://127.0.0.1:4096",
      `当前连接：${cmdCtx.clientRef.external ? "外部" : "嵌入式"} - ${cmdCtx.clientRef.baseUrl}`,
    ].join("\n")
  }
  if (!/^https?:\/\//i.test(url)) {
    return "地址需以 http:// 或 https:// 开头"
  }

  const previous = cmdCtx.clientRef.baseUrl
  try {
    await cmdCtx.reconnect(url)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return `切换失败：${msg}\n当前仍连接：${previous}`
  }

  return [
    "已切换 OpenCode 连接（本地 session 缓存已清空）",
    `新地址：${cmdCtx.clientRef.baseUrl}`,
    "发送 sn 或 /sessions 查看新实例上的会话列表",
  ].join("\n")
}

export async function handleProjects(ctx: MessageContext, _args: string, cmdCtx: CommandContext): Promise<string> {
  const { listProjects } = await import("../opencode/adapter.js")
  const projects = await listProjects(cmdCtx.client)
  projects.sort((a, b) => a.worktree.localeCompare(b.worktree))

  // 一次拉全部 session，按 projectWorktree 统计
  const countsByWorktree = new Map<string, number>()
  try {
    const allSessions = await listAllSessions(cmdCtx.clientRef.baseUrl)
    for (const s of allSessions) {
      const key = s.projectWorktree || "/"
      countsByWorktree.set(key, (countsByWorktree.get(key) ?? 0) + 1)
    }
  } catch { /* 失败不致命 */ }

  if (projects.length === 0) {
    return "当前没有可用的 project"
  }

  const currentDir = cmdCtx.sessions.getProjectDirectory()
  cmdCtx.pendingSelections.set(ctx.userId, {
    type: "project",
    items: projects.map((p) => ({ id: p.worktree, label: p.worktree })),
    expiresAt: Date.now() + SELECTION_TTL_MS,
  })

  const lines = projects.map((p, index) => {
    const isCurrent = p.worktree === currentDir
    const count = countsByWorktree.get(p.worktree) ?? "?"
    return `${index + 1}. ${isCurrent ? "[当前] " : ""}${p.worktree} (${count} sessions)`
  })

  return [
    `Project 列表（共 ${projects.length} 个）：`,
    ...lines,
    "回复序号切换当前 project（60 秒内有效）",
  ].join("\n")
}

async function ensureSession(userId: string, cmdCtx: CommandContext): Promise<void> {
  await cmdCtx.sessions.getOrCreate(userId)
}

function splitModelId(value: string): { providerId: string; modelId: string } | null {
  const trimmed = value.trim()
  const slashIndex = trimmed.indexOf("/")
  if (slashIndex <= 0 || slashIndex === trimmed.length - 1) return null
  const providerId = trimmed.slice(0, slashIndex).trim()
  const modelId = trimmed.slice(slashIndex + 1).trim()
  if (!providerId || !modelId) return null
  return { providerId, modelId }
}

function formatRelativeTime(timestamp: number): string {
  const diff = Date.now() - timestamp
  if (diff < 60_000) return "刚刚"
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}分钟前`
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}小时前`
  if (diff < 604_800_000) return `${Math.floor(diff / 86_400_000)}天前`
  const d = new Date(timestamp)
  return `${d.getMonth() + 1}/${d.getDate()}`
}
