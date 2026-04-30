export function buildHelpText(): string {
  return [
    "可用命令（短别名 或 /全称）：",
    "nw | /new - 创建新会话",
    "st | /stop - 停止当前 AI 运行",
    "ss | /status - 查看状态（含当前 Moss 地址）",
    "sn | /sessions - 当前 project 的会话列表，回复序号切换",
    "hp | /help - 查看帮助",
    "md | /model - 列出/切换模型",
    "ag | /agent - 列出/切换 Agent",
    "rn | /rename <name> - 重命名会话",
    "ps | /push [name] - 保存书签并创建新会话（原会话继续运行）",
    "pp | /pop - 回到上一个书签 session",
    "rp | /replay - 重新输出当前 session 的最后一次 AI 回复",
    "bm | /bookmarks - 列出书签栈",
    "cn | /connect <url> - 连接到另一台 Moss 服务",
    "pl | /projects - 所有 project 列表，回复序号切换当前 project",
  ].join("\n")
}
