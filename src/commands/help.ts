export function buildHelpText(): string {
  return [
    "可用命令（短别名 或 /全称）：",
    "nw | /new - 创建新会话",
    "st | /stop - 停止当前 AI 运行",
    "ss | /status - 查看状态（含当前 opencode 地址）",
    "sn | /sessions - 历史会话，回复序号切换",
    "hp | /help - 查看帮助",
    "md | /model - 列出/切换模型",
    "ag | /agent - 列出/切换 Agent",
    "rn | /rename <name> - 重命名会话",
    "cn | /connect <url> - 切换到另一台 opencode（会清空本地 session 缓存）",
    "pl | /projects - 所有 project 列表，回复序号切换当前 project",
  ].join("\n")
}
