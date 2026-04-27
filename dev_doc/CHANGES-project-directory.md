# CHANGES 补充文档 · Project Directory 切换 + 跨 Project Session 可见

> 本文档是对 `CHANGES.md` 的补充，记录在 `/connect` 热切换之后新增的第三/四轮改动。
> 另一个 agent 仅凭本文档 + 原 github qqbot 代码，就能把同样的功能落到自己的 clone 上。
>
> 改动基于已经完成「第一轮：外接 opencode」「第二轮：`/connect` 热切换」的版本。
> 如果你的 qqbot 还没做这两轮，请先参考 `CHANGES.md`。

---

## 1. 背景与问题

完成 `/connect` 切到用户本机 `http://127.0.0.1:4096` 后，`sn` / `ss` 仍然只显示
2 条 session，而 opencode TUI 能看到 7 条。

curl 实测：

```bash
curl -s http://127.0.0.1:4096/session | jq length   # => 2（只有 qqbot project 的）
```

原因有两层：

1. **opencode serve 把 cwd 绑定为默认 project**——不带 `?directory=` 的 `/session`
   只返回 serve 启动目录所在 project 的 session。
2. **v1 `/session?directory=` 按 session.directory 精确匹配，不是按 project worktree**
   ——global project 的 worktree 是 `/`，但它的 session 各自属于不同 directory
   （`/Users/ljf/ComateProjects/...`、`/Users/ljf/Documents/GitRep/...` 等），
   用 `directory=/` 查不到任何结果。

但 `/experimental/session`（v2 SDK 暴露的端点）**不带 directory 就能返回全部
session**，且每条带 `project.worktree` 字段可以分组。

---

## 2. 设计思想

### 2.1 放弃「为每个 project 再起一个 server」

最早的 B-1 / B-2 方案是按需启动多个 embedded opencode 实例。SDK 的
`createOpencodeServer(ServerOptions)` 不接受 `cwd`，只能 spawn 子进程。开销大、
生命周期难管。

### 2.2 利用 opencode 原生 `?directory=` 参数（第三轮）

opencode REST API 支持 `?directory=` 路由，SDK 暴露为
`client.session.list({ query: { directory } })`。一个 serve 实例即可服务所有
project。用于 `createSession`、`promptAsync`、`abortSession`、`updateSessionTitle`
等写操作。

### 2.3 使用 `/experimental/session` 跨 project 拉取全部 session（第四轮）

v1 SDK 的 `client.session.list()` 不支持跨 project 列表。但 HTTP 端点
`/experimental/session` 可以，返回 `GlobalSession[]`（比普通 Session 多
`project: { id, name?, worktree }` 字段）。

v1 `OpencodeClient` 没有 `experimental` 属性，因此 `listAllSessions` 直接
用 `fetch(baseUrl + "/experimental/session")` 实现。

### 2.4 选 session 时自动切 directory

切换到某个 session 时，必须把 `projectDirectory` 切到该 session 的 `directory`，
否则后续 `promptAsync` / `abortSession` 等操作会路由到错误的 project。

### 2.5 核心原则

1. **读操作跨 project**：`sn`（列表）和 `pl`（计数）用 `/experimental/session` 一次拉齐。
2. **写操作按 directory**：`promptAsync`、`createSession`、`abortSession` 等仍传
   `directory` 参数，走 v1 API 路由。
3. **状态集中**：`SessionManager` 持有 `projectDirectory`，切换时 `resetAll()`。
4. **持久化**：`OPENCODE_PROJECT_DIRECTORY` 写入 `~/.openqq/.env`。
5. **交互一致**：`PendingSelection.type` 支持 `"session" | "model" | "project"`；
   `sn` 按 project 分组，选 session 自动切 directory。

---

## 3. 改动清单（9 个文件）

| # | 文件 | 性质 | 要点 |
|---|------|------|------|
| 1 | `src/opencode/adapter.ts` | 扩展 | `AdapterProject` / `AdapterAllSession` 类型；`listProjects`；`listAllSessions`（fetch experimental API）；`dirQuery` 辅助；所有 session 写操作加 `directory` 参数 |
| 2 | `src/opencode/sessions.ts` | 扩展 | 持有 `projectDirectory` 字段；`getProjectDirectory` / `setProjectDirectory`；切换时 `resetAll()` |
| 3 | `src/commands/types.ts` | 扩展 | `SetProjectDirectoryFn` 类型；`CommandContext` 加同名字段；`PendingSelection.type` 加 `"project"`；`items` 加 `directory?: string` |
| 4 | `src/commands/handlers.ts` | 重构 | `handleSessions` 改用 `listAllSessions` + 按 project 分组 + 相对时间；`handleProjects` 计数改用 `listAllSessions`；`handleStatus` 同理；`handleStop` / `handleRename` 透传 `projectDir` |
| 5 | `src/commands/router.ts` | 扩展 | `pl: "projects"` alias；switch 加分支；选 session 时自动 `setProjectDirectory(item.directory)`；选 project 时 `setProjectDirectory(item.id)` |
| 6 | `src/commands/help.ts` | 文案 | 追加 `pl` 说明，`sn` / `ss` 描述点出 project 维度 |
| 7 | `src/config.ts` | 扩展 | `Config.opencode.projectDirectory?: string` |
| 8 | `src/index.ts` | 扩展 | 初始化传 `projectDirectory`；`setProjectDirectory` 闭包；`persistEnvKV` 泛化 |
| 9 | `src/bridge.ts` | 接线 | `createBridge` 第 7 参数 `setProjectDirectory`；`promptAsync` 透传 `directory` |

---

## 4. 关键代码片段

### 4.1 `src/opencode/adapter.ts`

```ts
// ---- 写操作：用 v1 SDK + directory 参数 ----

export interface AdapterProject {
  id: string
  worktree: string
  vcs?: "git"
  createdAt: number
}

export interface PromptParams {
  sessionId: string
  text: string
  directory?: string
  model?: { providerID: string; modelID: string }
  agent?: string
}

function dirQuery(directory?: string): { query?: { directory: string } } {
  return directory ? { query: { directory } } : {}
}

export async function createSession(client, directory?: string) {
  const result = await client.session.create({ ...dirQuery(directory) })
  // ...
}
export async function listSessions(client, directory?: string) {
  const result = await client.session.list({ ...dirQuery(directory) })
  // ...
}
export async function listProjects(client): Promise<AdapterProject[]> {
  const result = await client.project.list({})
  const arr = (result.data ?? result) as Project[]
  return Array.isArray(arr) ? arr.map(toAdapterProject) : []
}
// abortSession / updateSessionTitle / promptAsync 同理加 directory 参数

// ---- 读操作：直接 HTTP 调 experimental API（跨 project） ----

export interface AdapterAllSession {
  id: string
  title: string
  directory: string            // session 所属的目录（用于 setProjectDirectory）
  projectWorktree: string      // project 的 worktree（用于分组显示）
  createdAt: number
  updatedAt: number
}

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
```

### 4.2 `src/opencode/sessions.ts`

```ts
export class SessionManager {
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

  // getOrCreate / createNew 内部创建 session 时：
  //   await createSession(this.client, this.projectDirectory)
}
```

### 4.3 `src/commands/types.ts`

```ts
export type SetProjectDirectoryFn = (directory: string | undefined) => void

export interface CommandContext {
  // ...已有字段
  setProjectDirectory: SetProjectDirectoryFn
}

export interface PendingSelection {
  type: "session" | "model" | "project"
  items: Array<{ id: string; label: string; directory?: string }>  // ← directory 给选 session 时用
  expiresAt: number
}
```

### 4.4 `src/commands/handlers.ts`

#### handleSessions（核心改动：分组显示 + 相对时间）

```ts
export async function handleSessions(ctx, cmdCtx): Promise<string> {
  let allSessions = []
  try {
    allSessions = await listAllSessions(cmdCtx.clientRef.baseUrl)
  } catch {
    // 降级到 v1 API（只返回当前 project 的 session）
  }

  allSessions.sort((a, b) => b.updatedAt - a.updatedAt)

  // 按 projectWorktree 分组
  const groups = new Map<string, typeof allSessions>()
  for (const s of allSessions) {
    const key = s.projectWorktree || "未知 project"
    const list = groups.get(key) ?? []
    list.push(s)
    groups.set(key, list)
  }

  cmdCtx.pendingSelections.set(ctx.userId, {
    type: "session",
    items: allSessions.map((s) => ({
      id: s.id,
      label: s.title,
      directory: s.directory,         // ← 关键：选 session 时要用的 directory
    })),
    expiresAt: Date.now() + SELECTION_TTL_MS,
  })

  // 分组显示，每组标题用 worktree 最后一段
  let idx = 1
  for (const [worktree, sessions] of groups) {
    const label = worktree === "/" ? "全局" : worktree.split("/").pop() || worktree
    lines.push(`\n[${label}] (${sessions.length} sessions)`)
    for (const s of sessions) {
      lines.push(`${idx}. ${prefix}${s.title}  ${formatRelativeTime(s.updatedAt)}`)
      idx++
    }
  }
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
```

#### handleProjects（计数改用 listAllSessions）

```ts
export async function handleProjects(ctx, _args, cmdCtx): Promise<string> {
  const projects = await adapterListProjects(cmdCtx.client)
  projects.sort((a, b) => a.worktree.localeCompare(b.worktree))

  // 一次拉全部 session，按 projectWorktree 统计
  let countsByWorktree = new Map<string, number>()
  try {
    const allSessions = await listAllSessions(cmdCtx.clientRef.baseUrl)
    for (const s of allSessions) {
      const key = s.projectWorktree || "/"
      countsByWorktree.set(key, (countsByWorktree.get(key) ?? 0) + 1)
    }
  } catch { /* 失败不致命 */ }

  cmdCtx.pendingSelections.set(ctx.userId, {
    type: "project",
    items: projects.map((p) => ({ id: p.worktree, label: p.worktree })),
    expiresAt: Date.now() + SELECTION_TTL_MS,
  })

  // 展示：每个 project 一行，附 session 数
}
```

#### handleStatus

```ts
// 同样改用 listAllSessions 统计
const all = await listAllSessions(cmdCtx.clientRef.baseUrl)
if (projectDir) {
  serverSessionCount = all.filter(s => s.directory === projectDir || s.projectWorktree === projectDir).length
} else {
  serverSessionCount = all.length
}
```

### 4.5 `src/commands/router.ts`（选 session 自动切 directory）

```ts
const SHORT_ALIASES = { /* ... */ pl: "projects" }

// handlePendingSelection：
if (pending.type === "session") {
  // 如果该 session 有 directory 信息，自动切换 project directory
  if (item.directory) {
    const currentDir = cmdCtx.sessions.getProjectDirectory()
    if (currentDir !== item.directory) {
      cmdCtx.setProjectDirectory(item.directory)
    }
  }
  cmdCtx.sessions.switchSession(userId, item.id, item.label)
  return `已切换到会话：${item.label}`
}

if (pending.type === "project") {
  try {
    cmdCtx.setProjectDirectory(item.id)
  } catch (err) {
    return `切换 project 失败：${err instanceof Error ? err.message : String(err)}`
  }
  return [
    `已切换到 project：${item.label}`,
    "本地 session 缓存已清空，发送 sn 查看新 project 的会话列表",
  ].join("\n")
}
```

### 4.6 `src/config.ts`

```ts
export interface Config {
  opencode: {
    baseUrl: string
    externalUrl: boolean
    projectDirectory?: string    // ← 新增
  }
}
// loadConfig：
projectDirectory: process.env.OPENCODE_PROJECT_DIRECTORY?.trim() || undefined,
```

### 4.7 `src/index.ts`

```ts
const initialProjectDir = config.opencode.projectDirectory || undefined
const sessions = new SessionManager(proxyClient, initialProjectDir)

const setProjectDirectory: SetProjectDirectoryFn = (directory) => {
  sessions.setProjectDirectory(directory)
  try { persistEnvKV("OPENCODE_PROJECT_DIRECTORY", directory ?? "") }
  catch (err) { console.warn(`写入 project 目录失败：${err}`) }
}

const bridge = createBridge(
  config, proxyClient, clientRef, router, sessions, reconnect,
  setProjectDirectory,  // ← 第 7 个参数
)

// persistBaseUrl → persistEnvKV(key, value) 泛化
function persistEnvKV(key: string, value: string): void {
  // 正则匹配 ^#?\s*KEY\s*= → 替换/追加
}
```

### 4.8 `src/bridge.ts`

```ts
export function createBridge(
  config, client, clientRef, router, sessions, reconnect,
  setProjectDirectory: SetProjectDirectoryFn,  // ← 新增
): Bridge {
  const commandContext: CommandContext = {
    // ...
    setProjectDirectory,
  }

  void promptAsync(client, {
    sessionId, text, model, agent,
    directory: sessions.getProjectDirectory(),  // ← 新增
  })
}
```

---

## 5. 复现步骤（给另一个 agent 的操作指南）

前置：已在 qqbot 上完成前两轮改动（`/connect` + 外接 opencode）。

### 第 1 步：adapter 层（必须先动，否则下游编译不过）

1. 在 `src/opencode/adapter.ts` 中：
   - 新增 `AdapterProject` 接口和 `toAdapterProject` 转换函数
   - 新增 `dirQuery(directory?)` 辅助函数
   - 给 `createSession` / `listSessions` / `abortSession` / `updateSessionTitle`
     都加可选 `directory` 参数，通过 `dirQuery()` 传给 SDK 调用
   - `PromptParams` 接口加 `directory?: string`
   - `promptAsync` 通过 `dirQuery(params.directory)` 传递
   - 新增 `listProjects(client)` 调用 `client.project.list({})`
   - **新增 `AdapterAllSession` 接口和 `listAllSessions(baseUrl)` 函数**：
     直接 `fetch(baseUrl + "/experimental/session")`，解析返回的 JSON，
     映射为 `AdapterAllSession[]`（含 `directory` + `projectWorktree` 字段）

### 第 2 步：SessionManager

在 `src/opencode/sessions.ts` 中：
- 加 `private projectDirectory: string | undefined` 字段
- 构造函数加 `projectDirectory?` 第二参数
- 新增 `getProjectDirectory()` 和 `setProjectDirectory(directory)`
- `setProjectDirectory` 内调 `this.resetAll()`
- `getOrCreate` / `createNew` 内把 `this.projectDirectory` 传给 `createSession`

### 第 3 步：类型层

在 `src/commands/types.ts` 中：
- 新增 `SetProjectDirectoryFn` 类型
- `CommandContext` 加 `setProjectDirectory: SetProjectDirectoryFn`
- `PendingSelection.type` 加 `"project"`
- `PendingSelection.items` 元组加 `directory?: string` 字段
- `src/commands/index.ts` re-export 补上 `SetProjectDirectoryFn`

### 第 4 步：handlers（最复杂）

在 `src/commands/handlers.ts` 中：

**handleSessions 重写**：
- 调 `listAllSessions(cmdCtx.clientRef.baseUrl)` 拉全部 session
- 失败降级到 `listSessions(cmdCtx.client, projectDir)`
- 按 `projectWorktree` 分组（worktree=`/` 显示为 "全局"，其他取最后一段路径）
- 每条 session 后附 `formatRelativeTime(updatedAt)`
- `pendingSelections` 的 items 里每个加 `directory: s.directory`
- 删除旧的 "合并本地历史" 逻辑

**新增 formatRelativeTime**：
- `<1min` → "刚刚"
- `<1h` → "N分钟前"
- `<1d` → "N小时前"
- `<7d` → "N天前"
- 否则 → "M/D"

**handleProjects 重写**：
- `adapterListProjects` 改为动态 `import`（因为 handlers 顶部不再 import）
- 计数改用 `listAllSessions` 一次拉全部，按 `projectWorktree` 聚合

**handleStatus**：
- 计数改用 `listAllSessions`，设了 `projectDir` 时按 directory 或 worktree 过滤

**handleStop / handleRename**：
- 透传 `cmdCtx.sessions.getProjectDirectory()` 给 `abortSession` / `updateSessionTitle`

**顶部 import 改动**：
- 去掉 `listSessions as adapterListSessions` 和 `listProjects as adapterListProjects`
- 新增 `listAllSessions`

### 第 5 步：router

在 `src/commands/router.ts` 中：
- `SHORT_ALIASES` 加 `pl: "projects"`
- switch 加 `case "projects": return handleProjects(...)`
- `handlePendingSelection`：
  - `pending.type === "session"` 分支：如果 `item.directory` 且与当前不同，
    调 `cmdCtx.setProjectDirectory(item.directory)`
  - `pending.type === "project"` 分支：调 `cmdCtx.setProjectDirectory(item.id)`

### 第 6 步：help

`src/commands/help.ts` 加一行 `"pl | /projects - 所有 project 列表，回复序号切换当前 project"`

### 第 7 步：config

`src/config.ts` 的 `Config.opencode` 加 `projectDirectory?: string`，
`loadConfig` 里从 `OPENCODE_PROJECT_DIRECTORY` 读入。

### 第 8 步：index

`src/index.ts`：
- `SessionManager` 构造多传 `initialProjectDir`
- 新增 `setProjectDirectory` 闭包（调 `sessions.setProjectDirectory` + `persistEnvKV`）
- 把原 `persistBaseUrl(url)` 泛化为 `persistEnvKV(key, value)`
- `createBridge` 加第 7 参数

### 第 9 步：bridge

`src/bridge.ts`：
- `createBridge` 签名加 `setProjectDirectory: SetProjectDirectoryFn`
- `commandContext` 对象加 `setProjectDirectory`
- `promptAsync` 调用加 `directory: sessions.getProjectDirectory()`

### 第 10 步：验证

```bash
npx tsc --noEmit                         # 必须 0 error
OPENCODE_BASE_URL=http://127.0.0.1:4096 npm run start:node
```

QQ 里发：
- `sn`：应列出全部 session，按 project 分组，附相对时间
- `pl`：列出 project + session 计数
- 选 session：自动切到该 session 的 directory
- 选 project：切到 project 的 worktree
- `/status`：显示 "当前 project：..."
- 重启 bot：保持上次选择的 project（`~/.openqq/.env` 持久化）

---

## 6. 验证要点 / 常见坑

1. **`resetAll()` 不能忘**：切换 project/directory 时旧的 `userId → sessionId`
   映射在新 project 下是不存在的 id，调用 `promptAsync` / `abortSession` 会 404。

2. **`persistEnvKV` 的正则要转义 key**：抽象成通用函数后，key 须做
   `replace(/[.*+?^${}()|[\]\\]/g, '\\$&')` 防御。

3. **`client.project.list({})` 必须带空对象**：SDK 签名要求 options 参数。

4. **v1 `/session?directory=` 是按 session.directory 精确匹配**，不是按 project
   worktree。global project 的 worktree 是 `/`，用它查会返回 0 条。这就是为什么
   `sn` 和 `pl` 的计数必须改用 `/experimental/session`。

5. **选 session 必须自动切 directory**：session ID 只在它自己的 project 下有效。
   不切 directory 的话，`promptAsync` 会路由到错误的 project，导致 404 或操作了
   另一个 project 的 session。

6. **`opencode serve` 的 cwd 决定了默认 project**：不带 `?directory=` 的请求都
   走 serve 启动目录的 project。建议在项目根目录或 home 启动 serve。

7. **为什么 `listAllSessions` 用 fetch 不用 SDK**：v1 `OpencodeClient` 没有
   `experimental` 属性。v2 client 有，但切换 client 版本影响面太大。直接 fetch
   一个端点更安全。

8. **experimental API 可能变**：`/experimental/session` 属于 v2 实验性 API，
   未来可能改名或改返回格式。如果升级 opencode 后 `sn` 报错，先 curl 这个端点
   看返回结构是否变了。

---

## 7. 回滚

全部改动局限在：

- `src/opencode/{adapter,sessions}.ts`
- `src/commands/{types,handlers,router,help,index}.ts`
- `src/{config,index,bridge}.ts`
- `~/.openqq/.env` 里的 `OPENCODE_PROJECT_DIRECTORY` 键

直接 `git checkout -- <上述文件>` 并从 env 文件删除该键即可完全回到第二轮状态。

---

_最后更新：2026-04-27_
