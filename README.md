<div align="center">

# OpenCode QQ Bot

通过 QQ 机器人与 OpenCode AI 编程助手对话。

[![npm version](https://img.shields.io/npm/v/opencode-qq-bot)](https://www.npmjs.com/package/opencode-qq-bot)
[![License](https://img.shields.io/badge/license-MIT-green)](./LICENSE)
[![QQ Bot](https://img.shields.io/badge/QQ_Bot-API_v2-red)](https://bot.q.qq.com/wiki/)
[![OpenCode](https://img.shields.io/badge/OpenCode-AI-blue)](https://opencode.ai)
[![Bun](https://img.shields.io/badge/Bun->=1.0-fbf0df)](https://bun.sh)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.9-3178C6)](https://www.typescriptlang.org/)

</div>

---

龙虾都能用了,那opencode也要接上

<div align="center">
<img width="400" src="./images/photo_2026-03-07_22-52-48.jpg" />
<img width="400" src="./images/photo_2026-03-07_22-52-48 (2).jpg" />
<img width="400" src="./images/photo_2026-03-07_22-52-49.jpg" />
</div>

---

## 功能特性

- **QQ 群聊 + 私聊** - @机器人 或直接私信，两种方式都支持
- **历史会话接入** - `sn` 列出所有项目的历史 session，回复序号切换，自动切换到对应 project directory
- **跨项目可见** - 列表按 project 分组展示，附带相对时间
- **外部 OpenCode 热切换** - `/connect <url>` 运行时切换 opencode 实例，无需重启
- **Project 管理** - `pl` 列出 project 及 session 计数，支持切换
- **会话管理** - 每用户独立会话，支持新建、切换、重命名
- **流式推送** - AI 输出实时分段推送到 QQ，1 分钟间隔进度提示
- **模型/Agent 切换** - 随时切换 AI 模型和 Agent 模式
- **交互引导** - 首次运行自动引导配置，零门槛启动
- **背景启动脚本** - 提供 start-bg.sh / stop.sh 和 systemd 服务模板

---

## 快速开始

### 前置条件

- [Bun](https://bun.sh) >= 1.0 或 Node >= 18
- [OpenCode](https://opencode.ai) 已安装
- QQ 机器人的 AppID 和 AppSecret（下文有获取教程）

### 安装

```bash
bun install -g opencode-qq-bot
```

### 启动

```bash
openqq
```

首次运行会自动引导你填写 QQ 机器人凭证：

```
首次运行，需要配置 QQ 机器人凭证
(从 https://q.qq.com 机器人管理 -> 开发设置 获取)

QQ App ID: 1029******
QQ App Secret: ********
配置已保存到 ~/.openqq/.env
```

配置保存后，以后在任意目录直接 `openqq` 即可启动。

---

## 连接外部 OpenCode

默认情况下，`openqq` 会自动在进程内启动 opencode serve。

如果你已经单独运行了 opencode serve（比如同时在用 TUI），设置环境变量连接外部实例：

```bash
# 方式 1: 环境变量
OPENCODE_BASE_URL=http://127.0.0.1:4096 openqq

# 方式 2: 写入 ~/.openqq/.env
echo "OPENCODE_BASE_URL=http://127.0.0.1:4096" >> ~/.openqq/.env
```

### 运行时热切换

Bot 运行后也可以在 QQ 里运行时切换：

```
cn http://127.0.0.1:4096     # 切换到另一台机器的 opencode
```

---

## 命令列表

发送短别名或 `/全称` 执行命令：

| 命令 | 别名 | 功能 |
|------|------|------|
| `/new` | `nw` | 创建新会话 |
| `/stop` | `st` | 停止当前 AI 运行 |
| `/status` | `ss` | 查看服务器、连接地址、session 总数、当前 project |
| `/sessions` | `sn` | 跨 project 列出所有历史会话，回复序号切换 |
| `/connect <url>` | `cn` | 热切换到另一台 opencode 实例 |
| `/projects` | `pl` | 列出所有 project 及 session 计数 |
| `/model` | `md` | 列出可用模型，回复序号切换 |
| `/agent` | `ag` | 列出可用 Agent |
| `/rename <name>` | `rn` | 重命名当前会话 |
| `/help` | `hp` | 查看帮助 |

> **提示**：`sn` 选择会话时，如果该 session 属于不同 project，会自动切换 project directory。

---

## 创建 QQ 机器人

### 1. 注册 QQ 开放平台

前往 [QQ 开放平台](https://q.qq.com/qqbot/openclaw/) 注册账号。

### 2. 创建机器人

登录后进入「QQ 机器人」页面，点击「创建机器人」。

创建完成后进入机器人管理页面，在「开发设置」中获取：
- **AppID** - 机器人唯一标识
- **AppSecret** - 点击「重新生成」获取（不会明文存储，首次需要生成）

> 请妥善保管 AppSecret，不要泄露。

### 3. 沙箱配置

在机器人的「开发管理」->「沙箱配置」中：

1. 添加测试成员（填入 QQ 号）
2. 配置私聊：选择「在消息列表中配置」
3. 用测试成员的 QQ 扫码添加机器人

> 机器人不需要发布上线，沙箱模式下就能正常使用。

### 4. 群聊使用

要在群里使用，需要把机器人拉入群聊：

1. 在「开发管理」->「沙箱配置」中开启群聊支持
2. 在群设置中搜索并添加机器人
3. 群内 @机器人 发送消息

---

## 配置说明

所有配置通过环境变量或 `~/.openqq/.env` 文件管理：

| 变量 | 必填 | 默认值 | 说明 |
|------|------|--------|------|
| `QQ_APP_ID` | 是 | - | QQ 机器人 AppID |
| `QQ_APP_SECRET` | 是 | - | QQ 机器人 AppSecret |
| `QQ_SANDBOX` | 否 | `false` | 是否使用沙箱环境 |
| `OPENCODE_BASE_URL` | 否 | (自动启动) | 外部 opencode serve 地址 |
| `OPENCODE_PROJECT_DIRECTORY` | 否 | - | 默认 project 目录，`sn` 切换 session 时自动更新 |
| `ALLOWED_USERS` | 否 | (不限制) | 允许使用的 QQ 用户 ID，逗号分隔 |
| `MAX_REPLY_LENGTH` | 否 | `3000` | 单条回复最大字符数 |

---

## 后台启动

### 使用启动脚本

```bash
# 启动（日志输出到 logs/bot-YYYYMMDD.log）
bash scripts/start-bg.sh

# 查看日志
tail -f logs/bot-*.log

# 停止
bash scripts/stop.sh
```

### 使用 systemd（开机自启）

```bash
# 复制服务文件
sudo cp scripts/opencode-serve.service /etc/systemd/system/
sudo cp scripts/opencode-qq-bot.service /etc/systemd/system/

# 启动并设置开机自启
sudo systemctl enable --now opencode-serve
sudo systemctl enable --now opencode-qq-bot

# 查看状态
sudo systemctl status opencode-qq-bot
```

---

## 项目结构

```
opencode_qq_bot/
├── bin/openqq.js              # CLI 入口
├── scripts/
│   ├── start-bg.sh            # 后台启动脚本
│   ├── stop.sh                # 停止脚本
│   ├── opencode-serve.service # systemd 服务（opencode 后端）
│   └── opencode-qq-bot.service# systemd 服务（QQ bot）
├── src/
│   ├── index.ts               # 启动编排 + 优雅关闭 + /connect 热切换
│   ├── config.ts              # 配置加载 + 交互引导
│   ├── bridge.ts              # 核心桥接: QQ <-> OpenCode + 流式推送
│   ├── commands/
│   │   ├── handlers.ts        # 所有命令处理器
│   │   ├── router.ts          # 命令解析 + 路由 + 序号选择
│   │   ├── types.ts           # 命令类型定义
│   │   ├── help.ts            # 帮助文本
│   │   └── index.ts           # 导出
│   ├── qq/
│   │   ├── api.ts             # QQ REST API 封装
│   │   ├── gateway.ts         # WebSocket 状态机
│   │   ├── sender.ts          # 消息格式化 + 发送
│   │   └── types.ts           # QQ 类型定义
│   └── opencode/
│       ├── client.ts          # OpenCode SDK 封装 + ClientRef/Proxy
│       ├── adapter.ts         # Adapter 层: 目录感知 + 跨 project session
│       ├── events.ts          # SSE 事件路由（支持 /connect 热重启）
│       └── sessions.ts        # 会话管理 + project 切换
├── dev_doc/                   # 开发文档
├── .env.example
└── package.json
```

---

## 工作原理

```
QQ 用户 @机器人 发消息
       |
       v
  QQ Gateway (WebSocket)
       |
       v
  Bridge 桥接层
       |
       +---> /命令 ---> 命令处理 ---> 回复
       |
       +---> 普通消息
               |
               v
         SessionManager.getOrCreate(userId)
               |
               v
         promptAsync(fetch + ?directory=)
               |
               v
         opencode serve 异步处理
               |
               v
         SSE 事件流 (带 project directory 过滤)
               |
               v
         EventRouter 按 sessionId 分发
               |
               v
         流式收集 → 分段推送 QQ
               |
               v
         session.idle → 最终完整回复
```

- 使用 Fire-and-Forget 模式：`prompt_async` 不阻塞，通过 SSE 事件流异步收集回复
- SSE 订阅带 `?directory=`，只接收目标 project 的事件
- 收到第一个流式块时发送 "AI 正在处理中..."，之后每 1 分钟推送进度预览
- AI 完整回复后一次性推送最终结果
- `/connect` 使用 ClientRef 模式热切换，不中断服务

---

## 关键技术细节

### 跨 project session 可见

`sn` 命令调用 `/experimental/session` 端点拉取全部 project 的 session，按 `projectWorktree` 分组展示。选择某个 session 时自动切换到对应的 project directory。

### Runtime 热切换

ClientRef + Proxy 模式，`/connect <url>` 运行时：
1. 创建新 client，做健康检查
2. 替换 proxy 指向的目标
3. 关闭嵌入式 server（如果存在）
4. 清空 session 缓存
5. 重启 SSE 订阅
6. 持久化到 `~/.openqq/.env`

---

## 致谢

- [OpenCode](https://opencode.ai) - AI 编程助手
- [sliverp/qqbot](https://github.com/sliverp/qqbot) - QQ Bot API 封装参考
- [grinev/opencode-telegram-bot](https://github.com/grinev/opencode-telegram-bot) - 架构参考

## License

MIT
