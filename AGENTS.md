# opencode-qq-bot

QQ Bot 桥接 OpenCode AI。用户通过 QQ 发消息 → opencode serve 处理 → SSE 事件流回复。

## 快速命令

```bash
bun install          # 安装依赖
bun run start        # 启动（Bun）
npm run start:node   # 启动（Node + tsx）
npx tsc --noEmit     # 类型检查
```

`/mnt/fireshare/` 是 FUSE 挂载，不支持 symlink。`bun install` 可能报 `EIO`，改用 `npm install --no-bin-links`。

## 架构

```
QQ 消息 → Gateway(WebSocket) → Bridge → adapter(promptAsync via fetch)
                                              ↓
                                        opencode serve
                                              ↓
                                        SSE EventRouter → Bridge callback → QQ 回复
```

核心文件：

| 路径 | 职责 |
|---|---|
| `src/index.ts` | 入口：编排启动 + `/connect` 热切换 |
| `src/bridge.ts` | 桥接层：消息路由、流式推送、消息队列 |
| `src/opencode/adapter.ts` | **通过 HTTP fetch 直连 opencode REST API**（不走 SDK） |
| `src/opencode/events.ts` | SSE 事件订阅 + generation 热重启 |
| `src/opencode/sessions.ts` | 会话管理 + 书签栈 + 持久化到磁盘 |
| `src/commands/handlers.ts` | 所有 QQ 命令实现 |
| `src/qq/gateway.ts` | QQ WebSocket 连接 |
| `src/qq/token.ts` | QQ AccessToken 后台刷新 |

## 关键设计决策

**promptAsync 用 fetch 直连而非 SDK**：SDK v1 的 `SessionPromptAsyncData` 不支持 `query.directory`，无法带 project 目录参数。改用 `POST /session/{id}/prompt_async?directory=` 直发。

**SSE 订阅必须带 `projectDirectory`**：`EventRouter` 初始化时传入当前 project 目录，SSE 端点 `GET /event?directory=` 只接收该 project 的事件。切换 project 时 `setDirectory` 会 `generation++` 触发 consume 循环重启。

**session 映射持久化**：`~/.openqq/session_state.json`，重启自动恢复。每切换/创建 session 都写入磁盘。

**消息队列**：用户处理中时后续消息缓存到 `messageQueue: Map<userId, string[]>`，当前 prompt 完成后合并发送（`\n---\n` 分隔）。

**流式推送**：delta 驱动。`waitForSessionReply` 在 `message.part.updated` 时跟踪 `latestText`，AI 产出 >200 字新内容且距上次推送 >30 秒时推增量到 QQ。

## 命令列表（QQ 中可用）

| 别名 | 命令 | 功能 |
|---|---|---|
| `nw` | `/new` | 创建新会话 |
| `st` | `/stop` | 中止当前 AI |
| `ss` | `/status` | 查看状态 |
| `sn` | `/sessions` | 当前 project 的会话列表 |
| `hp` | `/help` | 帮助 |
| `md` | `/model` | 切换模型 |
| `ag` | `/agent` | 切换 Agent |
| `rn` | `/rename` | 重命名会话 |
| `ps` | `/push [name]` | 保存书签 + 新建 session |
| `pp` | `/pop` | 回到上一个书签 |
| `rp` | `/replay` | 重放最后 AI 回复 |
| `bm` | `/bookmarks` | 列出书签 |
| `cn` | `/connect <url>` | 运行时切换 opencode 地址 |
| `pl` | `/projects` | 切换 project |

## 注意事项

- `prompt_async` 适配器用 `fetch` 直连，`model` 和 `agent` 参数通过 `body` 传送
- Moss QQ Bot 是此项目的克隆（`/mnt/fireshare/code/moss-qq-bot`），修改 `config.ts` 端口和 `index.ts` 日志前缀即可适配其他 AI 后端
- `scripts/*.service` 是 systemd 模板，含本地路径，不提交 git（已在 `.gitignore`）
- QQ 被动回复有速率限制：群聊 5 次/5 分钟，私聊 5 次/60 分钟
- `session_state.json` 的 `pendingPrompts` 字段用于重启中断检测
