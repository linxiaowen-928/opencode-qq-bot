# Moss QQ Bot

通过 QQ 机器人与 Moss AI Agent（LangGraph）对话。

基于 opencode-qq-bot 框架改造，适配 Moss 的自有 API。

## 启动

```bash
cd moss-qq-bot
bun install

# 连接外部 Moss
OPENCODE_BASE_URL=http://127.0.0.1:5000 bun run start
```

## 配置

编辑 `~/.mossqq/.env`：

```
QQ_APP_ID=你的Moss专用QQ机器人AppID
QQ_APP_SECRET=你的AppSecret
QQ_SANDBOX=true
OPENCODE_BASE_URL=http://127.0.0.1:5000
```

## systemd 开机自启

```bash
sudo cp scripts/moss-serve.service /etc/systemd/system/
sudo cp scripts/moss-qq-bot.service /etc/systemd/system/
sudo systemctl enable --now moss-serve
sudo systemctl enable --now moss-qq-bot
```

## API 文档

见 `API_SPEC.md` — Moss 后端需要实现的接口规范。
