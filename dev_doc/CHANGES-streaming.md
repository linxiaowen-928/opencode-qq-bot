# CHANGES 补充文档 · 流式分段推送

> 本文档记录第五轮改动：将 QQ bot 的 AI 回复从"等待完成后一次性推送"改为
> "流式分段推送"，让用户实时看到 AI 的输出进度。
>
> 依赖：前四轮改动（SDK 升级 + `/connect` + project directory 切换 + 跨 project session 可见）
> 已全部完成。另一个 agent 拿到本文档 + 前两份 CHANGES 文档 + 原 github qqbot 代码，
> 即可完整复刻。

---

## 1. 背景与问题

原有行为：

1. 用户发消息 → bot 调 `promptAsync` → 等待 `session.idle` 事件 → 一次性推送完整回复
2. 超时设为 5 分钟，超时报 "AI 响应超时（5 分钟）"

问题：

- 复杂任务 opencode 可能跑几十分钟甚至更久，5 分钟超时太短
- 等待期间用户完全无反馈，不知道 bot 是在工作还是卡死了
- opencode 的输出是流式的（`message.part.updated` 事件持续推送文本增量），但 bot 丢弃了这些中间状态

---

## 2. 设计思想

### 2.1 分段推送

利用 opencode SSE 的 `message.part.updated` 事件，把 AI 的流式输出分段推送到 QQ：

- **收到第一个流式文本块** → 立即回复 "AI 正在处理中..."
- **之后每 1 分钟** → 推送 `[AI 输出中] <前 500 字>` 预览
- **`session.idle`** → 推送完整最终结果

### 2.2 超时放宽

从 5 分钟改为 60 分钟。复杂任务（大规模重构、跨文件修改）确实可能需要较长时间。

### 2.3 快速回复不触发中间推送

如果 AI 在 1 分钟内就完成了（简单问答），不会发送 "处理中" 和进度预览，
直接发最终结果。只有收到第一个 `message.part.updated` 后才启动定时器。

---

## 3. 改动清单（1 个文件）

| # | 文件 | 性质 | 要点 |
|---|------|------|------|
| 1 | `src/bridge.ts` | 重构 | `waitForSessionReply` 改为回调式分段推送；超时 5min→60min；新增 `StreamCallbacks` 接口 |

---

## 4. 关键代码片段

### 4.1 常量修改

```ts
// 之前
const RESPONSE_TIMEOUT_MS = 5 * 60 * 1000

// 之后
const RESPONSE_TIMEOUT_MS = 60 * 60 * 1000   // 60 分钟
const PROGRESS_INTERVAL_MS = 60 * 1000        // 1 分钟进度推送间隔
```

### 4.2 新增 StreamCallbacks 接口

```ts
interface StreamCallbacks {
  /** 收到第一个流式文本块时调用（用于发 "处理中" 提示） */
  onFirstChunk: () => Promise<void>
  /** 每 PROGRESS_INTERVAL_MS 调用一次，传入当前积累的文本 */
  onProgress: (text: string) => Promise<void>
  /** session.idle 时调用，传入最终完整文本 */
  onDone: (text: string) => Promise<void>
}
```

### 4.3 调用点改动（createBridge 内 handleMessage）

```ts
// 之前
const replyText = await waitForSessionReply(router, session.sessionId, () => {
  void promptAsync(client, { ... })
})
if (replyText.trim()) {
  await sendReply(ctx, replyText)
}

// 之后
let repliedProcessing = false

await waitForSessionReply(
  router,
  session.sessionId,
  () => {
    void promptAsync(client, { ... })
  },
  {
    onFirstChunk: async () => {
      if (!repliedProcessing) {
        repliedProcessing = true
        await sendReply(ctx, "AI 正在处理中...")
      }
    },
    onProgress: async (text) => {
      const prefix = "[AI 输出中] "
      const preview = text.length > 500 ? text.slice(0, 500) + "..." : text
      await sendReply(ctx, prefix + preview)
    },
    onDone: async (text) => {
      if (text.trim()) {
        await sendReply(ctx, text)
      }
    },
  },
)
```

### 4.4 waitForSessionReply 完整重写

```ts
function waitForSessionReply(
  router: EventRouter,
  sessionId: string,
  startPrompt: () => void,
  callbacks: StreamCallbacks,         // ← 新增参数
): Promise<void> {                    // ← 返回值从 Promise<string> 改为 Promise<void>
  return new Promise<void>((resolve, reject) => {
    let settled = false
    let latestText = ""
    let hasReceivedChunk = false
    let progressTimerId: ReturnType<typeof setInterval> | null = null

    const finish = (done: () => void): void => {
      if (settled) return
      settled = true
      if (progressTimerId) clearInterval(progressTimerId)   // ← 清理定时器
      clearTimeout(timeoutId)
      router.unregister(sessionId)
      done()
    }

    const timeoutId = setTimeout(() => {
      finish(() => reject(new Error("AI 响应超时（60 分钟）")))
    }, RESPONSE_TIMEOUT_MS)

    router.unregister(sessionId)
    router.register(sessionId, (event: Event) => {
      if (event.type === "message.part.updated") {
        const part = event.properties.part
        if (part.type === "text") {
          latestText = part.text
          if (!hasReceivedChunk) {
            hasReceivedChunk = true
            void callbacks.onFirstChunk()            // ← 第一个块：发 "处理中"
            progressTimerId = setInterval(() => {     // ← 启动定时进度推送
              if (!settled && latestText) {
                void callbacks.onProgress(latestText)
              }
            }, PROGRESS_INTERVAL_MS)
          }
        }
        return
      }

      if (event.type === "session.idle") {
        finish(() => {
          void callbacks.onDone(latestText || "(AI 未返回内容)").then(() => resolve())
        })
        return
      }

      if (event.type === "session.error") {
        finish(() => reject(new Error(toErrorMessage(event.properties.error) || "未知错误")))
      }
    })

    try {
      startPrompt()
    } catch (error) {
      finish(() => reject(error instanceof Error ? error : new Error(String(error))))
    }
  })
}
```

---

## 5. 复现步骤

前置：已完成前四轮改动。

### 唯一改动：`src/bridge.ts`

1. **改常量**：
   - `const RESPONSE_TIMEOUT_MS = 5 * 60 * 1000` → `60 * 60 * 1000`
   - 新增 `const PROGRESS_INTERVAL_MS = 60 * 1000`

2. **新增 `StreamCallbacks` 接口**（在 `isAllowedUser` 函数后面、`waitForSessionReply` 前面）：
   ```ts
   interface StreamCallbacks {
     onFirstChunk: () => Promise<void>
     onProgress: (text: string) => Promise<void>
     onDone: (text: string) => Promise<void>
   }
   ```

3. **改调用点**（`createBridge` 内 `handleMessage` 的 try 块）：
   - 把 `const replyText = await waitForSessionReply(...)` + `sendReply` 替换为
     带 `callbacks` 的新调用（见 §4.3）
   - 注意 `repliedProcessing` 标志位防止重复发 "处理中"

4. **重写 `waitForSessionReply` 函数**：
   - 签名加 `callbacks: StreamCallbacks` 参数
   - 返回类型从 `Promise<string>` 改为 `Promise<void>`
   - 内部逻辑见 §4.4，关键变化：
     - 新增 `hasReceivedChunk` 和 `progressTimerId` 状态
     - `message.part.updated` 分支里，首次收到时调 `onFirstChunk` + 启动 `setInterval`
     - `session.idle` 分支里调 `onDone` 然后 resolve
     - `finish` 函数里清 `progressTimerId`

5. **删除旧代码**：
   - 删除原来 `if (replyText.trim()) { await sendReply(ctx, replyText) }` 这段
     （已移入 `onDone` 回调）

6. **验证**：
   ```bash
   npx tsc --noEmit   # 必须 0 error
   ```

---

## 6. 验证要点 / 常见坑

1. **`repliedProcessing` 标志不能删**：`onFirstChunk` 可能被调多次（如果
   `message.part.updated` 在同一个 event loop tick 内到达多个），标志位保证
   "AI 正在处理中..." 只发一次。

2. **`progressTimerId` 必须在 `finish` 里清除**：否则 session 结束后定时器
   还在跑，会向已结束的对话推消息。

3. **快速回复（<1 分钟）不触发中间推送**：只有 `hasReceivedChunk=true` 后才
   启动 `setInterval`。如果 AI 很快就 `session.idle` 了，用户只收到最终结果，
   没有多余的 "处理中" 和进度消息。

4. **`onDone` 里也要判断 `text.trim()`**：空回复不推送，和之前行为一致。

5. **进度预览截断到 500 字**：QQ 消息有长度限制（`maxReplyLength` 默认 3000），
   进度预览只发前 500 字 + "..."，避免消息过长。最终结果走 `replyToQQ` 的
   `splitMessage` 自动分段。

6. **超时改为 60 分钟**：如果真的需要更长，直接改 `RESPONSE_TIMEOUT_MS` 常量。
   设为 0 表示永不超时（不推荐，SSE 连接可能断开）。

---

## 7. 用户体验示例

```
用户：帮我重构这个模块
bot：AI 正在处理中...                          ← 收到第一个流式块后（通常几秒内）
bot：[AI 输出中] 我来分析一下当前代码结构...     ← 1 分钟后
bot：[AI 输出中] 发现以下问题：1. ...2. ...      ← 2 分钟后
bot：以下是完整的重构方案：...                   ← 完成，推送最终结果
```

简单问答（<1 分钟完成）：

```
用户：什么是 TypeScript？
bot：TypeScript 是 JavaScript 的超集...         ← 直接收到最终结果，无中间推送
```

---

## 8. 回滚

本改动只涉及 `src/bridge.ts`，回滚方式：

1. 恢复 `RESPONSE_TIMEOUT_MS = 5 * 60 * 1000`
2. 删除 `PROGRESS_INTERVAL_MS` 常量和 `StreamCallbacks` 接口
3. 把 `waitForSessionReply` 改回返回 `Promise<string>` 的版本
4. 调用点改回 `const replyText = await waitForSessionReply(...)` + `sendReply`

---

_最后更新：2026-04-27_
