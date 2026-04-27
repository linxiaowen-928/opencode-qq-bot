# CHANGES — opencode-qq-bot 自 clone 以来全部改动的复刻手册

> 目标：任何人/agent 拿到**上游 GitHub 仓库**（`https://github.com/gbwssve/opencode-qq-bot`）的 `fd29d26` 提交，按本文档就能一比一得到当前工作区的完整状态。
> 基线 commit：`fd29d26 fix: log fatal close code reason and exit on unrecoverable gateway errors`（该仓库截至本文档时只有这一个 commit，即 `master = HEAD = clone 初始态`）。
> 当前工作区相对基线：**13 个修改文件 +338/-61**，外加若干新增文件（见第 6 节）。
> 本仓库未运行任何测试，文档完成后由使用者自行验证。

---

## 0. 最快复刻路径（推荐）

本仓库 `patches/20260427-full.patch` 就是一份干净的 `git diff HEAD` 导出，直接 `git apply` 即可覆盖所有代码改动。新增/未跟踪文件按第 6 节手动补齐。

```bash
git clone https://github.com/gbwssve/opencode-qq-bot.git
cd opencode-qq-bot
git checkout fd29d26

# 应用代码改动
git apply /path/to/patches/20260427-full.patch

# 必须执行（patch 已把 SDK 版本改成 ^1.14.27）
npm install                 # 或 bun install
# 可选但建议：
npx tsc --noEmit            # 类型检查

# 根据第 6 节手动创建新增文件（SDK_UPGRADE_GUIDE.md、CHANGES.md 等，非运行必需）

# 可选配置：
cp .env.example ~/.openqq/.env  # 若上游没提供则首次启动会走交互式引导（见 §5.2）
```

> 若上游仓库已有新 commit 和 `fd29d26` 产生冲突，需在最新 HEAD 上手动 rebase；本 patch 基于 `fd29d26` 生成，跨 commit 可能需要 `git apply --3way`。

---

## 1. 改动总览（逐文件说明）

改动来自两段时间的工作，**本文档不严格区分作者/时序**（因两次改动都未 commit，无法用 git blame 分离）。最终效果以 patch 为准。

| 文件 | 行数变动 | 改动性质 |
| --- | --- | --- |
| `package.json` | +9 -2 | SDK 升级 1.2.21 → 1.14.27 + 新增 `tsx` devDep + `start:node` script |
| `src/opencode/adapter.ts` | +21 -30 | 类型安全改造：用 `Session`/`Agent` 类型替换 `Record<string, unknown>` |
| `src/opencode/events.ts` | +27 -8 | `session.error.sessionID` 可选兼容 + generation 热重启机制 |
| `src/opencode/client.ts` | +57 -3 | 新增 `ClientRef`/`createProxyClient`/`reconnectClientRef`/`createClientRef` |
| `src/opencode/sessions.ts` | +10 -0 | `switchSession` 同步写入历史；新增 `resetAll()` |
| `src/index.ts` | +89 -11 | 改用 ClientRef + Proxy；构造 `reconnect` 闭包；新增 `persistBaseUrl`；启动日志细化 |
| `src/config.ts` | +21 -1 | 交互式引导新增 `OPENCODE_BASE_URL` 一问 |
| `src/bridge.ts` | +7 -1 | `createBridge` 签名增加 `clientRef` 与 `reconnect` 参数 |
| `src/commands/types.ts` | +16 -1 | `CommandContext` 增加 `clientRef/router/reconnect`；导出 `ReconnectFn` |
| `src/commands/router.ts` | +4 -0 | 注册 `cn -> connect` 别名与 case |
| `src/commands/handlers.ts` | +58 -16 | `handleSessions` 改为服务端+本地合并；`handleStatus` 增加地址与计数；新增 `handleConnect` |
| `src/commands/help.ts` | +2 -1 | help 文案加入 `cn | /connect <url>` |
| `src/commands/index.ts` | +1 -1 | 导出 `ReconnectFn` 类型 |
| `src/qq/*` | **0** | 未改 |

---

## 2. 核心变更思路

### 2.1 SDK 升级（`@opencode-ai/sdk` 1.2.21 → 1.14.27）

- 新 SDK 中 `Session`、`Agent`、`Event` 等类型已完备；`Record<string, unknown>` 的防御式断言全部替换为类型化路径，保留 `.data ?? result` 的降级模式。
- 一个破坏性类型变化：`EventSessionError.properties.sessionID` 由必填变为可选 → 在 `events.ts` 用 `?? undefined` 显式收敛。
- `Agent` 类型移除 `id`，改用 `name` 作为标识符，`listAgents` 已兼容。
- `createOpencodeServer` / `createOpencodeClient` / `event.subscribe()` 签名保持兼容，index.ts 仅加注释。

### 2.2 外部 opencode 接入 + `/connect` 运行时热切换

> **要解决的问题**：`OPENCODE_BASE_URL` 未配置时 `index.ts` 会用 `createOpencodeServer` 在 bot 进程内起一个"嵌入式"opencode，与用户日常在本机使用的 opencode 完全隔离，所以 `/sessions` 看不到本机那台的会话。

**方案要点**：

1. **ClientRef + Proxy**（`src/opencode/client.ts`）。`OpencodeClient` 通过 Proxy 包一层，所有方法访问实时走 `ref.current`。其他模块依然拿 `OpencodeClient` 类型，不感知"可替换"这件事。
2. **EventRouter 热重启**（`src/opencode/events.ts`）。用自增 `generation` 隔离多代 consume 循环，旧循环下次事件或异常时自退；无 `AbortSignal` 支持，接受"旧 SSE 可能挂到 HTTP 超时才释放"的折衷。
3. **SessionManager.resetAll()**。切换到新 opencode 时清空本地 `sessions` 映射和历史（旧 sessionId 在新实例无效）。
4. **index.ts 闭包 `reconnect`**。把 `clientRef/serverClose/sessions/router` 捕获在闭包，传给 `CommandContext.reconnect`，命令 handler 只管 UI。
5. **`handleSessions` 聚合**。先从服务端拉 `session.list()`，再合并本地历史去重展示；修复了"只能看到 QQ 创建的那几条"。
6. **`handleConnect` 命令**。`cn <url>` / `/connect <url>`：校验 URL → 健康检查 → 关闭可能的嵌入式 server → `sessions.resetAll()` → `router.restart()` → 写回 `~/.openqq/.env`。
7. **`handleStatus` 可观测**。回复里新增 "`连接：外部/嵌入式 - <url>`" + "`服务端 session 总数：N`" 两行，用于确认接入是否生效。
8. **`config.ts` 首次引导**。除 QQ 凭证外，增加 `OPENCODE_BASE_URL` 一问，回车跳过则使用嵌入式并在 `.env` 留注释提示。

---

## 3. 关键代码片段（照抄即可运行，原文详见 patch）

### 3.1 `src/opencode/client.ts` 追加

```ts
export interface ClientRef {
  current: OpencodeClient
  baseUrl: string
  external: boolean
}

export function createClientRef(baseUrl: string, external: boolean): ClientRef {
  return { current: createOpencodeClient({ baseUrl }), baseUrl, external }
}

export function createProxyClient(ref: ClientRef): OpencodeClient {
  return new Proxy({} as OpencodeClient, {
    get(_t, prop) { return Reflect.get(ref.current as unknown as object, prop) },
    has(_t, prop) { return Reflect.has(ref.current as unknown as object, prop) },
  })
}

export async function reconnectClientRef(ref: ClientRef, newBaseUrl: string): Promise<void> {
  const next = createOpencodeClient({ baseUrl: newBaseUrl })
  try { await next.session.list() }
  catch (err) { throw new Error(`新地址不可达：${err instanceof Error ? err.message : String(err)}`) }
  ref.current = next
  ref.baseUrl = newBaseUrl
  ref.external = true
}
```

### 3.2 `src/opencode/events.ts` 关键新增

```ts
private generation = 0

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

private async consume(myGen: number): Promise<void> {
  while (this.running && myGen === this.generation) {
    try {
      const result = await this.client.event.subscribe()
      for await (const event of result.stream) {
        if (!this.running || myGen !== this.generation) break
        /* ... 原分发逻辑 ... */
      }
      this.resetBackoff()
    } catch (err) {
      if (!this.running || myGen !== this.generation) break
      await this.backoff()
    }
  }
}
```

### 3.3 `src/index.ts` 的 reconnect 闭包

```ts
const clientRef = createClientRef(config.opencode.baseUrl, config.opencode.externalUrl)
const proxyClient = createProxyClient(clientRef)
await healthCheck(proxyClient)

const router = new EventRouter(proxyClient)
await router.start()
const sessions = new SessionManager(proxyClient)

const reconnect: ReconnectFn = async (newBaseUrl) => {
  const wasEmbedded = !clientRef.external
  await reconnectClientRef(clientRef, newBaseUrl)
  if (wasEmbedded && serverClose) {
    try { serverClose() } catch {}
    serverClose = null
  }
  sessions.resetAll()
  await router.restart()
  try { persistBaseUrl(newBaseUrl) } catch {}
}

const bridge = createBridge(config, proxyClient, clientRef, router, sessions, reconnect)
```

> `persistBaseUrl` 实现：读 `~/.openqq/.env`，正则替换 `^#?\s*OPENCODE_BASE_URL\s*=`，不存在则追加。完整源码见 patch。

### 3.4 `src/commands/handlers.ts` 的 handleConnect

```ts
export async function handleConnect(_ctx: MessageContext, args: string, cmdCtx: CommandContext): Promise<string> {
  const url = args.trim()
  if (!url) {
    return [
      "用法：cn <url>   例：cn http://127.0.0.1:4096",
      `当前连接：${cmdCtx.clientRef.external ? "外部" : "嵌入式"} - ${cmdCtx.clientRef.baseUrl}`,
    ].join("\n")
  }
  if (!/^https?:\/\//i.test(url)) return "地址需以 http:// 或 https:// 开头"

  const previous = cmdCtx.clientRef.baseUrl
  try { await cmdCtx.reconnect(url) }
  catch (err) {
    return `切换失败：${err instanceof Error ? err.message : String(err)}\n当前仍连接：${previous}`
  }
  return [
    "已切换 OpenCode 连接（本地 session 缓存已清空）",
    `新地址：${cmdCtx.clientRef.baseUrl}`,
    "发送 sn 或 /sessions 查看新实例上的会话列表",
  ].join("\n")
}
```

### 3.5 `src/commands/handlers.ts` 的 handleSessions（服务端合并）

```ts
export async function handleSessions(ctx, cmdCtx): Promise<string> {
  let serverSessions: Array<{ id: string; title: string }> = []
  try {
    const fetched = await adapterListSessions(cmdCtx.client)
    serverSessions = fetched.sort((a, b) => b.updatedAt - a.updatedAt)
                            .map((s) => ({ id: s.id, title: s.title }))
  } catch { /* 降级到本地历史 */ }

  const localSessions = cmdCtx.sessions.getUserSessions(ctx.userId)
  const seenIds = new Set(serverSessions.map((s) => s.id))
  const merged = [...serverSessions, ...localSessions.filter((s) => !seenIds.has(s.id))]

  if (merged.length === 0) return "当前没有可切换的会话（服务端和本地均无记录）"

  const currentSessionId = cmdCtx.sessions.getSession(ctx.userId)?.sessionId
  cmdCtx.pendingSelections.set(ctx.userId, {
    type: "session",
    items: merged.map((s) => ({ id: s.id, label: s.title })),
    expiresAt: Date.now() + SELECTION_TTL_MS,
  })

  const lines = merged.map((s, i) => `${i + 1}. ${s.id === currentSessionId ? "[当前] " : ""}${s.title}`)
  return [`会话列表（共 ${merged.length} 个）：`, ...lines, "回复序号切换会话（60 秒内有效）"].join("\n")
}
```

---

## 4. API / 类型合约（下游调用者必须遵守的最小契约）

### 4.1 `CommandContext` 新字段

```ts
export interface CommandContext {
  config: Config
  client: OpencodeClient       // 现在是 ClientRef 上的 Proxy
  clientRef: ClientRef         // 新增：handler 读取 baseUrl/external
  router: EventRouter          // 新增：暂无 handler 使用，为后续扩展预留
  sessions: SessionManager
  getAccessToken: () => Promise<string>
  pendingSelections: Map<string, PendingSelection>
  reconnect: ReconnectFn       // 新增：切换 opencode 入口
}

export type ReconnectFn = (newBaseUrl: string) => Promise<void>
```

### 4.2 `createBridge` 签名

```ts
// before
createBridge(config, client, router, sessions)
// after
createBridge(config, client, clientRef, router, sessions, reconnect)
```

### 4.3 `EventRouter` 生命周期

- `start()`：幂等（`running=true` 后直接返回）
- `stop()`：标记停止 + `generation++`
- `restart()`（新增）：`generation++` + 起新 consume 循环
- 调用者**不要**在 reconnect 时手动 `stop()` 再 `start()`，直接 `restart()` 即可

---

## 5. 使用方式

### 5.1 构建/运行

```bash
# 推荐 Bun
bun install && bun run start

# 或 Node + tsx
npm install && npm run start:node
```

### 5.2 首次运行交互式引导

启动时若 `~/.openqq/.env` 不存在，会依次询问：

1. `QQ App ID:`
2. `QQ App Secret:`
3. `OPENCODE_BASE_URL（回车跳过）:`  ← **本次新增**

### 5.3 连接本机 opencode 的完整步骤

1. **目标机器**：`opencode serve --hostname 127.0.0.1 --port 4096`（跨机器请走 SSH 隧道 / frp / Tailscale；**不要** `--hostname 0.0.0.0` 直挂公网）。
2. **bot 配置**（二选一）：
   - 编辑 `~/.openqq/.env`：`OPENCODE_BASE_URL=http://127.0.0.1:4096` 后启动；
   - 或已在跑的 bot 里 QQ 发送 `cn http://127.0.0.1:4096`。
3. **验证**：QQ 发送 `ss` → 回复里应有 `连接：外部 - http://127.0.0.1:4096` 和非 0 的 `服务端 session 总数`；发送 `sn` 可看到本机 opencode 的全部会话。

---

## 6. 新增/未跟踪文件

以下文件不在 patch 中，按需手动补齐：

| 路径 | 必要性 | 内容摘要 |
| --- | --- | --- |
| `CHANGES.md` | 文档（本文件） | — |
| `SDK_UPGRADE_GUIDE.md` | 文档（SDK 升级报告，非运行必需） | 详细列出 SDK 变化、类型对照、风险点。可省略。 |
| `patches/20260427-full.patch` | 复刻辅助 | 本仓库已包含；跨环境复刻时请带上。 |
| `package-lock.json` | 依赖锁 | 若用 npm 则自动生成，不需手工创建。 |
| `.comate/backups/backup_20260427_sdk_upgrade/` | 历史备份 | 原作者保留的 SDK 升级前快照，不影响运行。 |
| `.comate/backups/backup_20260427_111542_opencode-qq-bot/` | 历史备份 | /connect 改造前快照，不影响运行。 |

**对运行必要的只有 `patches/20260427-full.patch`**（若你选择用它来 `git apply`）；其他都是文档/备份。

---

## 7. 已知限制 / 风险

1. **SSE 旧连接残留**：`/connect` 热切换后老 SSE 可能挂到 HTTP 超时才释放，不影响功能。未来可用带 `AbortSignal` 的 subscribe API 改进。
2. **bun.lock 与 package-lock.json 并存**：SDK 升级时用了 `npm install`，建议新下游只保留其中一个并统一工具链。
3. **未跑真实端到端测试**：SDK 升级后 Bun 运行时、QQ 推送全链路都仅过了 `tsc --noEmit`；请在目标环境手动验证。
4. **`resetAll` 会打断进行中的对话**：`/connect` 时所有用户的当前会话被清空，正在 `waitForSessionReply` 的请求会超时；这是正确行为（新 opencode 的 sessionId 完全不同）。
5. **`persistBaseUrl` 简易实现**：多实例 bot 共用同一 `~/.openqq/.env` 时可能互相覆盖；单实例场景无影响。

---

## 8. 验证清单（建议按顺序执行）

```bash
# 类型
npx tsc --noEmit

# 静态启动（不接 QQ，仅看日志 + 健康检查）
OPENCODE_BASE_URL=http://127.0.0.1:4096 npm run start:node
# 预期日志：
#   [index] 使用外部 opencode: http://127.0.0.1:4096
#   [opencode] health check passed
#   [index] QQ Gateway 已就绪

# 运行时切换（bot 已接 QQ 后）
# QQ 发送: ss       → 看 "连接: 外部 - ..." + session 总数
# QQ 发送: sn       → 列表是否包含本机 opencode 已有会话
# QQ 发送: cn http://otherhost:4096  → 验证切换 + .env 是否被更新
```

---

## 9. 完整 patch（将下方 `~~~diff ... ~~~` 之间的内容保存为 `full.patch` 即可 `git apply`）

操作步骤（另一个 agent 收到这份 MD 后执行）：

```bash
git clone https://github.com/gbwssve/opencode-qq-bot.git
cd opencode-qq-bot
git checkout fd29d26

# 1) 把下面 ~~~diff 代码块里的内容（含首行 `diff --git ...` 到末尾）完整保存为 full.patch
# 2) 应用
git apply full.patch

# 3) 安装依赖（SDK 版本已改为 ^1.14.27）
npm install         # 或 bun install

# 4) 可选：类型检查
npx tsc --noEmit

# 5) 启动
npm run start:node  # 或 bun run start
```

> **注意保留换行与空格原样**；某些 IDE 粘贴时会把 `\t` 替成空格，`git apply` 严格按字符匹配。建议用原始模式（"paste without formatting"）保存。
> 若 `git apply` 报失败且你不是在 `fd29d26` 上，试 `git apply --3way full.patch`。

~~~diff
diff --git a/package.json b/package.json
index 9833915..a8b25c8 100644
--- a/package.json
+++ b/package.json
@@ -9,6 +9,7 @@
   "scripts": {
     "dev": "bun run --watch src/index.ts",
     "start": "bun run src/index.ts",
+    "start:node": "npx tsx src/index.ts",
     "typecheck": "tsc --noEmit"
   },
   "files": [
@@ -16,19 +17,26 @@
     "src",
     "tsconfig.json"
   ],
-  "keywords": ["qq", "bot", "opencode", "ai", "coding-assistant"],
+  "keywords": [
+    "qq",
+    "bot",
+    "opencode",
+    "ai",
+    "coding-assistant"
+  ],
   "license": "MIT",
   "repository": {
     "type": "git",
     "url": "https://github.com/gbwssve/opencode-qq-bot"
   },
   "dependencies": {
-    "@opencode-ai/sdk": "^1.2.21",
+    "@opencode-ai/sdk": "^1.14.27",
     "ws": "^8.18.0"
   },
   "devDependencies": {
     "@types/node": "^22.0.0",
     "@types/ws": "^8.5.0",
+    "tsx": "^4.21.0",
     "typescript": "^5.9.0"
   }
 }
diff --git a/src/bridge.ts b/src/bridge.ts
index 10e7326..3e1be7c 100644
--- a/src/bridge.ts
+++ b/src/bridge.ts
@@ -2,7 +2,7 @@ import type { Config } from "./config.js"
 import type { MessageContext } from "./qq/types.js"
 import { getAccessToken } from "./qq/token.js"
 import { replyToQQ } from "./qq/sender.js"
-import type { OpencodeClient } from "./opencode/client.js"
+import type { ClientRef, OpencodeClient } from "./opencode/client.js"
 import { promptAsync } from "./opencode/adapter.js"
 import { EventRouter } from "./opencode/events.js"
 import { SessionManager } from "./opencode/sessions.js"
@@ -14,6 +14,7 @@ import {
   isCommand,
   type CommandContext,
   type PendingSelection,
+  type ReconnectFn,
 } from "./commands/index.js"
 
 const RESPONSE_TIMEOUT_MS = 5 * 60 * 1000
@@ -25,8 +26,10 @@ interface Bridge {
 export function createBridge(
   config: Config,
   client: OpencodeClient,
+  clientRef: ClientRef,
   router: EventRouter,
   sessions: SessionManager,
+  reconnect: ReconnectFn,
 ): Bridge {
   const busyUsers = new Set<string>()
   const greeted = new Set<string>()
@@ -34,9 +37,12 @@ export function createBridge(
   const commandContext: CommandContext = {
     config,
     client,
+    clientRef,
+    router,
     sessions,
     getAccessToken: () => getAccessToken(config.qq.appId, config.qq.clientSecret),
     pendingSelections,
+    reconnect,
   }
 
   const handleMessage = async (ctx: MessageContext): Promise<void> => {
diff --git a/src/commands/handlers.ts b/src/commands/handlers.ts
index 0a488a6..8597bcf 100644
--- a/src/commands/handlers.ts
+++ b/src/commands/handlers.ts
@@ -5,10 +5,10 @@ import {
   abortSession,
   listProviderModels,
   listAgents as adapterListAgents,
+  listSessions as adapterListSessions,
   updateSessionTitle,
   healthCheck,
 } from "../opencode/adapter.js"
-
 export async function handleNew(ctx: MessageContext, cmdCtx: CommandContext): Promise<string> {
   const session = await cmdCtx.sessions.createNew(ctx.userId)
   return [
@@ -34,9 +34,16 @@ export async function handleStatus(ctx: MessageContext, cmdCtx: CommandContext):
   const agentId = cmdCtx.sessions.getAgent(ctx.userId)
 
   let openCodeStatus: string
+  let serverSessionCount: number | null = null
   try {
     await healthCheck(cmdCtx.client)
     openCodeStatus = "运行中"
+    try {
+      const list = await adapterListSessions(cmdCtx.client)
+      serverSessionCount = list.length
+    } catch {
+      // 忽略：健康检查通过但 list 失败时仅不展示数量
+    }
   } catch {
     openCodeStatus = "异常"
   }
@@ -49,9 +56,13 @@ export async function handleStatus(ctx: MessageContext, cmdCtx: CommandContext):
     qqStatus = "异常"
   }
 
+  const mode = cmdCtx.clientRef.external ? "外部" : "嵌入式"
+  const countLine = serverSessionCount === null ? "" : `\n服务端 session 总数：${serverSessionCount}`
+
   return [
     "OpenCode 状态",
     `服务器：${openCodeStatus}`,
+    `连接：${mode} - ${cmdCtx.clientRef.baseUrl}${countLine}`,
     `QQ 鉴权：${qqStatus}`,
     `会话：${session ? `${session.title ?? "未命名会话"} (${session.sessionId})` : "未创建"}`,
     `模型：${providerId && modelId ? `${providerId} / ${modelId}` : "默认"}`,
@@ -60,24 +71,46 @@ export async function handleStatus(ctx: MessageContext, cmdCtx: CommandContext):
 }
 
 export async function handleSessions(ctx: MessageContext, cmdCtx: CommandContext): Promise<string> {
-  const sessions = cmdCtx.sessions.getUserSessions(ctx.userId)
-  if (sessions.length === 0) {
-    return "当前没有可切换的历史会话"
+  // 从 OpenCode 服务端拉取完整 session 列表
+  let serverSessions: Array<{ id: string; title: string }> = []
+  try {
+    const fetched = await adapterListSessions(cmdCtx.client)
+    serverSessions = fetched
+      .sort((a, b) => b.updatedAt - a.updatedAt)
+      .map((s) => ({ id: s.id, title: s.title }))
+  } catch {
+    // 服务端获取失败时降级到本地历史
+  }
+
+  // 合并: 服务端列表为主，本地历史补充（去重）
+  const localSessions = cmdCtx.sessions.getUserSessions(ctx.userId)
+  const seenIds = new Set(serverSessions.map((s) => s.id))
+  const merged = [
+    ...serverSessions,
+    ...localSessions.filter((s) => !seenIds.has(s.id)),
+  ]
+
+  if (merged.length === 0) {
+    return "当前没有可切换的会话（服务端和本地均无记录）"
   }
 
   const currentSessionId = cmdCtx.sessions.getSession(ctx.userId)?.sessionId
   cmdCtx.pendingSelections.set(ctx.userId, {
     type: "session",
-    items: sessions.map((s) => ({ id: s.id, label: s.title })),
+    items: merged.map((s) => ({ id: s.id, label: s.title })),
     expiresAt: Date.now() + SELECTION_TTL_MS,
   })
 
-  const lines = sessions.map((s, index) => {
+  const lines = merged.map((s, index) => {
     const prefix = s.id === currentSessionId ? "[当前] " : ""
     return `${index + 1}. ${prefix}${s.title}`
   })
 
-  return ["会话列表：", ...lines, "回复序号切换会话（60 秒内有效）"].join("\n")
+  return [
+    `会话列表（共 ${merged.length} 个）：`,
+    ...lines,
+    "回复序号切换会话（60 秒内有效）",
+  ].join("\n")
 }
 
 export async function handleModel(ctx: MessageContext, args: string, cmdCtx: CommandContext): Promise<string> {
@@ -195,3 +228,30 @@ function splitModelId(value: string): { providerId: string; modelId: string } |
   if (!providerId || !modelId) return null
   return { providerId, modelId }
 }
+
+export async function handleConnect(_ctx: MessageContext, args: string, cmdCtx: CommandContext): Promise<string> {
+  const url = args.trim()
+  if (!url) {
+    return [
+      "用法：cn <url>   例：cn http://127.0.0.1:4096",
+      `当前连接：${cmdCtx.clientRef.external ? "外部" : "嵌入式"} - ${cmdCtx.clientRef.baseUrl}`,
+    ].join("\n")
+  }
+  if (!/^https?:\/\//i.test(url)) {
+    return "地址需以 http:// 或 https:// 开头"
+  }
+
+  const previous = cmdCtx.clientRef.baseUrl
+  try {
+    await cmdCtx.reconnect(url)
+  } catch (err) {
+    const msg = err instanceof Error ? err.message : String(err)
+    return `切换失败：${msg}\n当前仍连接：${previous}`
+  }
+
+  return [
+    "已切换 OpenCode 连接（本地 session 缓存已清空）",
+    `新地址：${cmdCtx.clientRef.baseUrl}`,
+    "发送 sn 或 /sessions 查看新实例上的会话列表",
+  ].join("\n")
+}
diff --git a/src/commands/help.ts b/src/commands/help.ts
index 0d514a7..accf59c 100644
--- a/src/commands/help.ts
+++ b/src/commands/help.ts
@@ -3,11 +3,12 @@ export function buildHelpText(): string {
     "可用命令（短别名 或 /全称）：",
     "nw | /new - 创建新会话",
     "st | /stop - 停止当前 AI 运行",
-    "ss | /status - 查看状态",
+    "ss | /status - 查看状态（含当前 opencode 地址）",
     "sn | /sessions - 历史会话，回复序号切换",
     "hp | /help - 查看帮助",
     "md | /model - 列出/切换模型",
     "ag | /agent - 列出/切换 Agent",
     "rn | /rename <name> - 重命名会话",
+    "cn | /connect <url> - 切换到另一台 opencode（会清空本地 session 缓存）",
   ].join("\n")
 }
diff --git a/src/commands/index.ts b/src/commands/index.ts
index dd3d897..f3506d6 100644
--- a/src/commands/index.ts
+++ b/src/commands/index.ts
@@ -1,3 +1,3 @@
 export { isCommand, handleCommand, handlePendingSelection } from "./router.js"
 export { buildHelpText } from "./help.js"
-export type { CommandContext, PendingSelection } from "./types.js"
+export type { CommandContext, PendingSelection, ReconnectFn } from "./types.js"
diff --git a/src/commands/router.ts b/src/commands/router.ts
index c93a5f4..9bf3b3a 100644
--- a/src/commands/router.ts
+++ b/src/commands/router.ts
@@ -8,6 +8,7 @@ import {
   handleModel,
   handleAgent,
   handleRename,
+  handleConnect,
 } from "./handlers.js"
 import { buildHelpText } from "./help.js"
 
@@ -20,6 +21,7 @@ const SHORT_ALIASES: Record<string, string> = {
   md: "model",
   ag: "agent",
   rn: "rename",
+  cn: "connect",
 }
 
 export function isCommand(content: string): boolean {
@@ -70,6 +72,8 @@ export async function handleCommand(ctx: MessageContext, cmdCtx: CommandContext)
       return handleAgent(ctx, parsed.args, cmdCtx)
     case "rename":
       return handleRename(ctx, parsed.args, cmdCtx)
+    case "connect":
+      return handleConnect(ctx, parsed.args, cmdCtx)
     default:
       return `不支持的命令：${parsed.name}\n发送 hp 或 /help 查看可用命令`
   }
diff --git a/src/commands/types.ts b/src/commands/types.ts
index fa7ef21..db01e29 100644
--- a/src/commands/types.ts
+++ b/src/commands/types.ts
@@ -1,15 +1,30 @@
 import type { Config } from "../config.js"
-import type { OpencodeClient } from "../opencode/client.js"
+import type { ClientRef, OpencodeClient } from "../opencode/client.js"
+import type { EventRouter } from "../opencode/events.js"
 import { SessionManager } from "../opencode/sessions.js"
 
 export const SELECTION_TTL_MS = 60_000
 
+/**
+ * 切换 opencode 连接地址的回调。实现位于 index.ts / bridge.ts：
+ * - 校验 + 调用 reconnectClientRef
+ * - 重启 EventRouter
+ * - 清空 SessionManager 缓存
+ * - 持久化到 ~/.openqq/.env
+ * 成功返回新地址，失败 throw Error（由 handler 捕获生成回复）。
+ */
+export type ReconnectFn = (newBaseUrl: string) => Promise<void>
+
 export interface CommandContext {
   config: Config
+  /** 注意：该 client 实为 ClientRef 上的 Proxy，运行时替换 ref.current 后所有方法自动走新实例 */
   client: OpencodeClient
+  clientRef: ClientRef
+  router: EventRouter
   sessions: SessionManager
   getAccessToken: () => Promise<string>
   pendingSelections: Map<string, PendingSelection>
+  reconnect: ReconnectFn
 }
 
 export interface PendingSelection {
diff --git a/src/config.ts b/src/config.ts
index b19f7e2..e3a6aa1 100644
--- a/src/config.ts
+++ b/src/config.ts
@@ -38,6 +38,19 @@ function askTwo(q1: string, q2: string): Promise<[string, string]> {
   })
 }
 
+function askOne(question: string): Promise<string> {
+  return new Promise((resolve, reject) => {
+    let done = false
+    const rl = createInterface({ input: process.stdin, output: process.stdout })
+    rl.on("close", () => { if (!done) reject(new Error("输入被中断")) })
+    rl.question(question, (ans) => {
+      done = true
+      rl.close()
+      resolve(ans.trim())
+    })
+  })
+}
+
 export async function ensureConfig(): Promise<void> {
   if (process.env.QQ_APP_ID && process.env.QQ_APP_SECRET) return
 
@@ -61,12 +74,18 @@ export async function ensureConfig(): Promise<void> {
     throw new Error("App ID 和 App Secret 不能为空")
   }
 
+  console.log("\n可选：配置外部 opencode 地址，用于看到本机 opencode 的全部 session")
+  console.log("  - 本机 opencode：http://127.0.0.1:4096（需先执行 opencode serve）")
+  console.log("  - 跨机器请走 SSH 隧道 / frp 等，不要把 opencode 直接暴露公网")
+  console.log("  - 留空则启动嵌入式 opencode（只能看到 bot 自己创建的 session）\n")
+  const baseUrl = await askOne("OPENCODE_BASE_URL（回车跳过）: ")
+
   mkdirSync(CONFIG_DIR, { recursive: true })
   const envContent = [
     `QQ_APP_ID=${appId}`,
     `QQ_APP_SECRET=${appSecret}`,
     `QQ_SANDBOX=false`,
-    `# OPENCODE_BASE_URL=http://localhost:4096`,
+    baseUrl ? `OPENCODE_BASE_URL=${baseUrl}` : `# OPENCODE_BASE_URL=http://127.0.0.1:4096`,
     `ALLOWED_USERS=`,
     `MAX_REPLY_LENGTH=3000`,
   ].join("\n") + "\n"
@@ -76,6 +95,7 @@ export async function ensureConfig(): Promise<void> {
 
   process.env.QQ_APP_ID = appId
   process.env.QQ_APP_SECRET = appSecret
+  if (baseUrl) process.env.OPENCODE_BASE_URL = baseUrl
 }
 
 function loadEnvFile(path: string): void {
diff --git a/src/index.ts b/src/index.ts
index e7f116d..2614d26 100644
--- a/src/index.ts
+++ b/src/index.ts
@@ -1,13 +1,21 @@
 // @input:  ./config, ./opencode/*, ./qq/*, ./bridge, @opencode-ai/sdk (createOpencodeServer)
 // @output: (side-effect) 启动 Bot 进程
-// @pos:    根层 - 入口: 启动编排 + 优雅关闭
+// @pos:    根层 - 入口: 启动编排 + 优雅关闭 + /connect 热切换
+// @sdk:    适配 @opencode-ai/sdk v1.14.27 (createOpencodeServer 签名兼容)
+import { existsSync, readFileSync, writeFileSync, mkdirSync } from "fs"
+import { join } from "path"
+import { homedir } from "os"
 import { loadConfig, ensureConfig } from "./config.js"
-import { createClient, healthCheck } from "./opencode/client.js"
+import { createProxyClient, createClientRef, healthCheck, reconnectClientRef } from "./opencode/client.js"
 import { EventRouter } from "./opencode/events.js"
 import { SessionManager } from "./opencode/sessions.js"
 import { startGateway } from "./qq/gateway.js"
 import { startBackgroundTokenRefresh, stopBackgroundTokenRefresh } from "./qq/token.js"
 import { createBridge } from "./bridge.js"
+import type { ReconnectFn } from "./commands/index.js"
+
+const CONFIG_DIR = join(homedir(), ".openqq")
+const ENV_FILE = join(CONFIG_DIR, ".env")
 
 async function main(): Promise<void> {
   await ensureConfig()
@@ -20,19 +28,62 @@ async function main(): Promise<void> {
     const server = await createOpencodeServer({ port: 4096 })
     config.opencode.baseUrl = server.url
     serverClose = server.close
-    console.log(`[index] opencode serve 已启动: ${server.url}`)
+    console.log(`[index] 启动嵌入式 opencode: ${server.url}`)
+    console.log(`[index] 提示：嵌入式实例仅包含 bot 自己创建的 session。如需看到本机 opencode 的全部 session，请配置 OPENCODE_BASE_URL`)
+  } else {
+    console.log(`[index] 使用外部 opencode: ${config.opencode.baseUrl}`)
   }
 
-  const client = createClient(config.opencode.baseUrl)
-  await healthCheck(client)
+  const clientRef = createClientRef(config.opencode.baseUrl, config.opencode.externalUrl)
+  const proxyClient = createProxyClient(clientRef)
+
+  try {
+    await healthCheck(proxyClient)
+  } catch (err) {
+    const msg = err instanceof Error ? err.message : String(err)
+    if (config.opencode.externalUrl) {
+      console.error(`[index] 无法连接外部 opencode (${config.opencode.baseUrl})：${msg}`)
+      console.error(`[index] 请检查：1) opencode serve 是否在该地址运行；2) 若跨机器请检查隧道/防火墙；3) opencode 默认绑定 127.0.0.1，远程访问需 --hostname 0.0.0.0 或走 SSH 隧道`)
+    } else {
+      console.error(`[index] 嵌入式 opencode 健康检查失败：${msg}`)
+    }
+    throw err
+  }
 
   startBackgroundTokenRefresh(config.qq.appId, config.qq.clientSecret)
 
-  const router = new EventRouter(client)
+  const router = new EventRouter(proxyClient)
   await router.start()
 
-  const sessions = new SessionManager(client)
-  const bridge = createBridge(config, client, router, sessions)
+  const sessions = new SessionManager(proxyClient)
+
+  const reconnect: ReconnectFn = async (newBaseUrl: string): Promise<void> => {
+    const wasEmbedded = !clientRef.external
+    await reconnectClientRef(clientRef, newBaseUrl)
+    // clientRef 替换成功后：
+    // 1) 关闭可能存在的嵌入式 server（切走后不再需要它占端口）
+    if (wasEmbedded && serverClose) {
+      try {
+        serverClose()
+      } catch (err) {
+        console.warn(`[index] 关闭嵌入式 opencode 失败（可忽略）：${err instanceof Error ? err.message : String(err)}`)
+      }
+      serverClose = null
+    }
+    // 2) 清空 session 缓存（旧 sessionId 在新实例无效）
+    sessions.resetAll()
+    // 3) 重启事件订阅
+    await router.restart()
+    // 4) 持久化 OPENCODE_BASE_URL，下次启动自动使用
+    try {
+      persistBaseUrl(newBaseUrl)
+    } catch (err) {
+      console.warn(`[index] 写入 .env 失败（不影响当前会话）：${err instanceof Error ? err.message : String(err)}`)
+    }
+    console.log(`[index] 已切换到外部 opencode: ${newBaseUrl}`)
+  }
+
+  const bridge = createBridge(config, proxyClient, clientRef, router, sessions, reconnect)
 
   const gateway = await startGateway({
     appId: config.qq.appId,
@@ -61,6 +112,39 @@ async function main(): Promise<void> {
   process.once("SIGTERM", () => shutdown("SIGTERM"))
 }
 
+/**
+ * 把 OPENCODE_BASE_URL 写回 ~/.openqq/.env（保留其他键）。
+ * 若文件不存在则创建。
+ */
+function persistBaseUrl(url: string): void {
+  mkdirSync(CONFIG_DIR, { recursive: true })
+  const lines: string[] = []
+  let replaced = false
+  if (existsSync(ENV_FILE)) {
+    const raw = readFileSync(ENV_FILE, "utf-8").split("\n")
+    for (const line of raw) {
+      const trimmed = line.trim()
+      if (!trimmed) {
+        lines.push(line)
+        continue
+      }
+      // 匹配包括被注释掉的 OPENCODE_BASE_URL
+      if (/^#?\s*OPENCODE_BASE_URL\s*=/.test(trimmed)) {
+        if (!replaced) {
+          lines.push(`OPENCODE_BASE_URL=${url}`)
+          replaced = true
+        }
+      } else {
+        lines.push(line)
+      }
+    }
+  }
+  if (!replaced) {
+    lines.push(`OPENCODE_BASE_URL=${url}`)
+  }
+  writeFileSync(ENV_FILE, lines.join("\n").replace(/\n+$/, "") + "\n")
+}
+
 main().catch((error) => {
   console.error("[index] 启动失败:", error)
   stopBackgroundTokenRefresh()
diff --git a/src/opencode/adapter.ts b/src/opencode/adapter.ts
index 3dc3449..fe98653 100644
--- a/src/opencode/adapter.ts
+++ b/src/opencode/adapter.ts
@@ -1,5 +1,5 @@
 import type { OpencodeClient } from "./client.js"
-import type { Event } from "@opencode-ai/sdk"
+import type { Event, Session, Agent } from "@opencode-ai/sdk"
 
 export interface AdapterSession {
   id: string
@@ -31,35 +31,27 @@ export interface SSEStream {
   stream: AsyncIterable<Event>
 }
 
-function toAdapterSession(raw: Record<string, unknown>): AdapterSession | null {
-  const id = typeof raw.id === "string" ? raw.id : undefined
-  if (!id) return null
+function toAdapterSession(raw: Session): AdapterSession {
   return {
-    id,
-    title: typeof raw.title === "string" ? raw.title : id,
-    createdAt: typeof raw.time === "object" && raw.time !== null
-      ? Number((raw.time as Record<string, unknown>).created ?? 0)
-      : 0,
-    updatedAt: typeof raw.time === "object" && raw.time !== null
-      ? Number((raw.time as Record<string, unknown>).updated ?? 0)
-      : 0,
+    id: raw.id,
+    title: raw.title ?? raw.id,
+    createdAt: raw.time?.created ?? 0,
+    updatedAt: raw.time?.updated ?? 0,
   }
 }
 
 export async function createSession(client: OpencodeClient): Promise<AdapterSession> {
   const result = await client.session.create({})
-  const raw = (result.data ?? result) as unknown as Record<string, unknown>
-  const session = toAdapterSession(raw)
-  if (!session) throw new Error("session.create returned invalid data")
-  return session
+  const raw = (result.data ?? result) as Session
+  if (!raw.id) throw new Error("session.create returned invalid data")
+  return toAdapterSession(raw)
 }
 
 export async function listSessions(client: OpencodeClient): Promise<AdapterSession[]> {
   const result = await client.session.list()
-  const arr = Array.isArray(result.data) ? result.data : Array.isArray(result) ? result : []
-  return (arr as Record<string, unknown>[])
-    .map(toAdapterSession)
-    .filter((s): s is AdapterSession => s !== null)
+  const arr = (result.data ?? result) as Session[]
+  if (!Array.isArray(arr)) return []
+  return arr.map(toAdapterSession)
 }
 
 export async function abortSession(client: OpencodeClient, sessionId: string): Promise<void> {
@@ -68,10 +60,9 @@ export async function abortSession(client: OpencodeClient, sessionId: string): P
 
 export async function updateSessionTitle(client: OpencodeClient, sessionId: string, title: string): Promise<AdapterSession> {
   const result = await client.session.update({ path: { id: sessionId }, body: { title } })
-  const raw = (result.data ?? result) as unknown as Record<string, unknown>
-  const session = toAdapterSession(raw)
-  if (!session) throw new Error("session.update returned invalid data")
-  return session
+  const raw = (result.data ?? result) as Session
+  if (!raw.id) throw new Error("session.update returned invalid data")
+  return toAdapterSession(raw)
 }
 
 export async function promptAsync(client: OpencodeClient, params: PromptParams): Promise<void> {
@@ -87,7 +78,7 @@ export async function promptAsync(client: OpencodeClient, params: PromptParams):
 
 export async function listProviderModels(client: OpencodeClient): Promise<AdapterModel[]> {
   const result = await client.provider.list()
-  const data = (result.data ?? result) as unknown as Record<string, unknown>
+  const data = (result.data ?? result) as Record<string, unknown>
   const allProviders = Array.isArray(data.all) ? data.all as Record<string, unknown>[] : []
   const models: AdapterModel[] = []
 
@@ -98,6 +89,7 @@ export async function listProviderModels(client: OpencodeClient): Promise<Adapte
     const rawModels = provider.models
     if (!rawModels || typeof rawModels !== "object") continue
 
+    // 新 SDK 中 models 是 { [key: string]: Model } 对象，非数组
     const entries = Array.isArray(rawModels) ? rawModels : Object.values(rawModels)
     for (const m of entries) {
       if (!m || typeof m !== "object") continue
@@ -114,12 +106,14 @@ export async function listProviderModels(client: OpencodeClient): Promise<Adapte
 
 export async function listAgents(client: OpencodeClient): Promise<AdapterAgent[]> {
   const result = await client.app.agents()
-  const arr = Array.isArray(result.data) ? result.data : Array.isArray(result) ? result : []
-  return (arr as Record<string, unknown>[])
+  const arr = (result.data ?? result) as Agent[]
+  if (!Array.isArray(arr)) return []
+  return arr
     .map((a) => {
-      const id = typeof a.id === "string" ? a.id : typeof a.name === "string" ? a.name : undefined
+      // 新 SDK Agent 类型使用 name 字段作为标识符
+      const id = a.name ?? (a as Record<string, unknown>).id as string | undefined
       if (!id) return null
-      const desc = typeof a.description === "string" ? a.description : undefined
+      const desc = a.description
       return { id, label: desc ? `${id} - ${desc}` : id }
     })
     .filter((a): a is AdapterAgent => a !== null)
diff --git a/src/opencode/client.ts b/src/opencode/client.ts
index 0c1bb9f..cc6b90e 100644
--- a/src/opencode/client.ts
+++ b/src/opencode/client.ts
@@ -1,6 +1,6 @@
 // @input:  @opencode-ai/sdk
-// @output: createClient, getClient, healthCheck, OpencodeClient
-// @pos:    opencode层 - OpenCode SDK 客户端封装 + 健康检查
+// @output: createClient, getClient, healthCheck, OpencodeClient, ClientRef, createClientRef, createProxyClient, reconnectClientRef
+// @pos:    opencode层 - OpenCode SDK 客户端封装 + 运行时可替换的 ClientRef
 import { createOpencodeClient, type OpencodeClient } from "@opencode-ai/sdk"
 
 let client: OpencodeClient | null = null
@@ -25,4 +25,60 @@ export async function healthCheck(oc: OpencodeClient): Promise<void> {
   }
 }
 
+/**
+ * 运行时可变的 client 引用。
+ * - current: 当前真实的 OpencodeClient 实例
+ * - baseUrl: 连接地址
+ * - external: 是否连接到外部 opencode（false = 嵌入式）
+ */
+export interface ClientRef {
+  current: OpencodeClient
+  baseUrl: string
+  external: boolean
+}
+
+export function createClientRef(baseUrl: string, external: boolean): ClientRef {
+  return {
+    current: createOpencodeClient({ baseUrl }),
+    baseUrl,
+    external,
+  }
+}
+
+/**
+ * 生成一个"代理"OpencodeClient：所有方法访问都会实时走到 ref.current，
+ * 这样改造时其他模块签名保持 `OpencodeClient` 不变，只要持有此 proxy 即可感知
+ * ref 的替换（/connect 后新地址立即生效）。
+ */
+export function createProxyClient(ref: ClientRef): OpencodeClient {
+  return new Proxy({} as OpencodeClient, {
+    get(_target, prop, _receiver) {
+      return Reflect.get(ref.current as unknown as object, prop)
+    },
+    has(_target, prop) {
+      return Reflect.has(ref.current as unknown as object, prop)
+    },
+  })
+}
+
+/**
+ * 替换 ClientRef 指向的底层 client：
+ * 1. 创建新的 OpencodeClient
+ * 2. 做一次 session.list 作为健康检查
+ * 3. 成功后写入 ref.current / ref.baseUrl / ref.external = true
+ * 失败则抛错，ref 保持原状。
+ */
+export async function reconnectClientRef(ref: ClientRef, newBaseUrl: string): Promise<void> {
+  const next = createOpencodeClient({ baseUrl: newBaseUrl })
+  try {
+    await next.session.list()
+  } catch (err) {
+    const msg = err instanceof Error ? err.message : String(err)
+    throw new Error(`新地址不可达：${msg}`)
+  }
+  ref.current = next
+  ref.baseUrl = newBaseUrl
+  ref.external = true
+}
+
 export type { OpencodeClient }
diff --git a/src/opencode/events.ts b/src/opencode/events.ts
index eadd7bf..a0c5533 100644
--- a/src/opencode/events.ts
+++ b/src/opencode/events.ts
@@ -1,6 +1,6 @@
 // @input:  @opencode-ai/sdk (Event, SSE stream), ./client (OpencodeClient)
 // @output: EventRouter, EventCallback
-// @pos:    opencode层 - 全局 SSE 事件订阅 + 按 sessionId 分发
+// @pos:    opencode层 - 全局 SSE 事件订阅 + 按 sessionId 分发 + 支持 /connect 热重启
 import type { OpencodeClient } from "./client.js"
 import type { Event } from "@opencode-ai/sdk"
 
@@ -9,6 +9,9 @@ export type EventCallback = (event: Event) => void
 export class EventRouter {
   private listeners = new Map<string, EventCallback>()
   private running = false
+  // generation 用于区分 consume 循环的"代"；reconnect 时自增，旧循环下次检查到
+  // 代号不匹配会主动退出，避免多个 consume 同时向同一个 listeners 表分发事件
+  private generation = 0
   private client: OpencodeClient
 
   constructor(client: OpencodeClient) {
@@ -18,11 +21,26 @@ export class EventRouter {
   async start(): Promise<void> {
     if (this.running) return
     this.running = true
-    this.consume()
+    this.generation += 1
+    const myGen = this.generation
+    void this.consume(myGen)
   }
 
   stop(): void {
     this.running = false
+    this.generation += 1
+  }
+
+  /**
+   * 强制重启 consume 循环：旧循环在下一次事件或 SSE 报错时退出。
+   * 注意：旧 SSE 连接若长期无事件且不报错，可能残留直到底层 HTTP 超时——
+   * 这是无 AbortSignal 支持下的可接受折衷。
+   */
+  async restart(): Promise<void> {
+    this.generation += 1
+    this.running = true
+    const myGen = this.generation
+    void this.consume(myGen)
   }
 
   register(sessionId: string, callback: EventCallback): void {
@@ -33,13 +51,13 @@ export class EventRouter {
     this.listeners.delete(sessionId)
   }
 
-  private async consume(): Promise<void> {
-    while (this.running) {
+  private async consume(myGen: number): Promise<void> {
+    while (this.running && myGen === this.generation) {
       try {
         const result = await this.client.event.subscribe()
 
         for await (const event of result.stream) {
-          if (!this.running) break
+          if (!this.running || myGen !== this.generation) break
           const sessionId = this.extractSessionId(event)
           if (sessionId) {
             const cb = this.listeners.get(sessionId)
@@ -49,12 +67,13 @@ export class EventRouter {
         // 成功消费流后重置重连延迟
         this.resetBackoff()
       } catch (err) {
-        if (!this.running) break
+        if (!this.running || myGen !== this.generation) break
         const msg = err instanceof Error ? err.message : String(err)
-        console.error(`[events] SSE connection error: ${msg}`)
+        console.error(`[events] SSE connection error (gen=${myGen}): ${msg}`)
         await this.backoff()
       }
     }
+    console.log(`[events] consume loop exited (gen=${myGen})`)
   }
 
   private extractSessionId(event: Event): string | undefined {
@@ -69,7 +88,7 @@ export class EventRouter {
       case "session.status":
         return event.properties.sessionID
       case "session.error":
-        return event.properties.sessionID
+        return event.properties.sessionID ?? undefined
       case "message.removed":
         return event.properties.sessionID
       default:
diff --git a/src/opencode/sessions.ts b/src/opencode/sessions.ts
index d6dda31..428170d 100644
--- a/src/opencode/sessions.ts
+++ b/src/opencode/sessions.ts
@@ -47,6 +47,7 @@ export class SessionManager {
       sessionId,
       title,
     })
+    this.trackSession(userId, sessionId, title ?? sessionId)
   }
 
   getSession(userId: string): UserSession | undefined {
@@ -89,6 +90,15 @@ export class SessionManager {
     }
   }
 
+  /**
+   * 清空所有用户的 session 映射与历史。
+   * 用在 /connect 切换到新的 opencode 后，因为旧 sessionId 在新实例上无意义。
+   */
+  resetAll(): void {
+    this.sessions.clear()
+    this.userSessionHistory.clear()
+  }
+
   private trackSession(userId: string, sessionId: string, title: string): void {
     const history = this.userSessionHistory.get(userId) ?? []
     if (!history.some((h) => h.id === sessionId)) {
~~~

该 patch 共 800 行，覆盖全部 13 个已跟踪文件的修改。与本仓库 `patches/20260427-full.patch` 字节级等价。
