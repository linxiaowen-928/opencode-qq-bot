// @input:  ./config, ./opencode/*, ./qq/*, ./bridge, @opencode-ai/sdk (createOpencodeServer)
// @output: (side-effect) 启动 Bot 进程
// @pos:    根层 - 入口: 启动编排 + 优雅关闭 + /connect 热切换
// @sdk:    适配 @opencode-ai/sdk v1.14.27 (createOpencodeServer 签名兼容)
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "fs"
import { join } from "path"
import { homedir } from "os"
import { loadConfig, ensureConfig } from "./config.js"
import { createProxyClient, createClientRef, healthCheck, reconnectClientRef } from "./opencode/client.js"
import { EventRouter } from "./opencode/events.js"
import { SessionManager } from "./opencode/sessions.js"
import { startGateway } from "./qq/gateway.js"
import { startBackgroundTokenRefresh, stopBackgroundTokenRefresh } from "./qq/token.js"
import { createBridge } from "./bridge.js"
import type { ReconnectFn, SetProjectDirectoryFn } from "./commands/index.js"

const CONFIG_DIR = join(homedir(), ".mossqq")
const ENV_FILE = join(CONFIG_DIR, ".env")

async function main(): Promise<void> {
  await ensureConfig()
  const config = loadConfig()

  let serverClose: (() => void) | null = null

  if (!config.opencode.externalUrl) {
    const { createOpencodeServer } = await import("@opencode-ai/sdk")
    const server = await createOpencodeServer({ port: 4096 })
    config.opencode.baseUrl = server.url
    serverClose = server.close
    console.log(`[index] 启动嵌入式 opencode: ${server.url}`)
    console.log(`[index] 提示：嵌入式实例仅包含 bot 自己创建的 session。如需看到本机 opencode 的全部 session，请配置 OPENCODE_BASE_URL`)
  } else {
    console.log(`[index] 使用外部 opencode: ${config.opencode.baseUrl}`)
  }

  const clientRef = createClientRef(config.opencode.baseUrl, config.opencode.externalUrl)
  const proxyClient = createProxyClient(clientRef)

  try {
    await healthCheck(proxyClient)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    if (config.opencode.externalUrl) {
      console.error(`[index] 无法连接外部 opencode (${config.opencode.baseUrl})：${msg}`)
      console.error(`[index] 请检查：1) Moss serve 是否在该地址运行；2) 若跨机器请检查隧道/防火墙；3) opencode 默认绑定 127.0.0.1，远程访问需 --hostname 0.0.0.0 或走 SSH 隧道`)
    } else {
      console.error(`[index] 嵌入式 opencode 健康检查失败：${msg}`)
    }
    throw err
  }

  startBackgroundTokenRefresh(config.qq.appId, config.qq.clientSecret)

  const initialProjectDir = config.opencode.projectDirectory || undefined
  const router = new EventRouter(clientRef.baseUrl, initialProjectDir)
  await router.start()

  const sessions = new SessionManager(proxyClient, initialProjectDir)

  const reconnect: ReconnectFn = async (newBaseUrl: string): Promise<void> => {
    const wasEmbedded = !clientRef.external
    await reconnectClientRef(clientRef, newBaseUrl)
    // clientRef 替换成功后：
    // 1) 关闭可能存在的嵌入式 server（切走后不再需要它占端口）
    if (wasEmbedded && serverClose) {
      try {
        serverClose()
      } catch (err) {
        console.warn(`[index] 关闭嵌入式 opencode 失败（可忽略）：${err instanceof Error ? err.message : String(err)}`)
      }
      serverClose = null
    }
    // 2) 清空 session 缓存（旧 sessionId 在新实例无效）
    sessions.resetAll()
    // 3) 重启事件订阅
    await router.restart()
    // 4) 持久化 OPENCODE_BASE_URL，下次启动自动使用
    try {
      persistEnvKV("OPENCODE_BASE_URL", newBaseUrl)
    } catch (err) {
      console.warn(`[index] 写入 .env 失败（不影响当前会话）：${err instanceof Error ? err.message : String(err)}`)
    }
    console.log(`[index] 已切换到外部 opencode: ${newBaseUrl}`)
  }

  const setProjectDirectory: SetProjectDirectoryFn = (directory: string | undefined) => {
    sessions.setProjectDirectory(directory)
    router.setDirectory(directory)
    try {
      persistEnvKV("OPENCODE_PROJECT_DIRECTORY", directory ?? "")
    } catch (err) {
      console.warn(`[index] 写入 project 目录失败：${err instanceof Error ? err.message : String(err)}`)
    }
  }

  const bridge = createBridge(config, proxyClient, clientRef, router, sessions, reconnect, setProjectDirectory)

  const gateway = await startGateway({
    appId: config.qq.appId,
    clientSecret: config.qq.clientSecret,
    onMessage: bridge.handleMessage,
    onReady: () => {
      console.log("[index] QQ Gateway 已就绪")
    },
  })

  console.log("[index] Moss QQ Bot 已启动")

  let shuttingDown = false
  const shutdown = (signal: string): void => {
    if (shuttingDown) return
    shuttingDown = true
    console.log(`[index] 收到 ${signal}，开始退出...`)
    gateway.stop()
    router.stop()
    stopBackgroundTokenRefresh()
    serverClose?.()
    setTimeout(() => process.exit(0), 0)
  }

  process.once("SIGINT", () => shutdown("SIGINT"))
  process.once("SIGTERM", () => shutdown("SIGTERM"))
}

/**
 * 把 OPENCODE_BASE_URL 或 OPENCODE_PROJECT_DIRECTORY 写回 ~/.mossqq/.env（保留其他键）。
 * 若文件不存在则创建。
 */
function persistEnvKV(key: string, value: string): void {
  mkdirSync(CONFIG_DIR, { recursive: true })
  const escapedKey = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const regex = new RegExp(`^#?\\s*${escapedKey}\\s*=`)
  const lines: string[] = []
  let replaced = false
  if (existsSync(ENV_FILE)) {
    const raw = readFileSync(ENV_FILE, "utf-8").split("\n")
    for (const line of raw) {
      const trimmed = line.trim()
      if (!trimmed) {
        lines.push(line)
        continue
      }
      if (regex.test(trimmed)) {
        if (!replaced) {
          lines.push(value ? `${key}=${value}` : `# ${key}=`)
          replaced = true
        }
      } else {
        lines.push(line)
      }
    }
  }
  if (!replaced) {
    lines.push(value ? `${key}=${value}` : `# ${key}=`)
  }
  writeFileSync(ENV_FILE, lines.join("\n").replace(/\n+$/, "") + "\n")
}

main().catch((error) => {
  console.error("[index] 启动失败:", error)
  stopBackgroundTokenRefresh()
  process.exit(1)
})
