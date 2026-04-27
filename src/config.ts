// @input:  process.env, ~/.openqq/.env
// @output: Config, loadConfig, ensureConfig
// @pos:    根层 - 环境变量加载 + 首次运行交互式引导
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs"
import { join } from "path"
import { homedir } from "os"
import { createInterface } from "readline"

export interface Config {
  qq: {
    appId: string
    clientSecret: string
    sandbox: boolean
  }
  opencode: {
    baseUrl: string
    externalUrl: boolean
    projectDirectory?: string
  }
  allowedUsers: string[]
  maxReplyLength: number
}

const CONFIG_DIR = join(homedir(), ".openqq")
const ENV_FILE = join(CONFIG_DIR, ".env")

function askTwo(q1: string, q2: string): Promise<[string, string]> {
  return new Promise((resolve, reject) => {
    let done = false
    const rl = createInterface({ input: process.stdin, output: process.stdout })
    rl.on("close", () => { if (!done) reject(new Error("输入被中断")) })
    rl.question(q1, (a1) => {
      rl.question(q2, (a2) => {
        done = true
        rl.close()
        resolve([a1.trim(), a2.trim()])
      })
    })
  })
}

function askOne(question: string): Promise<string> {
  return new Promise((resolve, reject) => {
    let done = false
    const rl = createInterface({ input: process.stdin, output: process.stdout })
    rl.on("close", () => { if (!done) reject(new Error("输入被中断")) })
    rl.question(question, (ans) => {
      done = true
      rl.close()
      resolve(ans.trim())
    })
  })
}

export async function ensureConfig(): Promise<void> {
  if (process.env.QQ_APP_ID && process.env.QQ_APP_SECRET) return

  if (existsSync(ENV_FILE)) {
    loadEnvFile(ENV_FILE)
    if (process.env.QQ_APP_ID && process.env.QQ_APP_SECRET) return
  }

  const localEnv = join(process.cwd(), ".env")
  if (existsSync(localEnv)) {
    loadEnvFile(localEnv)
    if (process.env.QQ_APP_ID && process.env.QQ_APP_SECRET) return
  }

  console.log("首次运行，需要配置 QQ 机器人凭证")
  console.log("(从 https://q.qq.com 机器人管理 -> 开发设置 获取)\n")

  const [appId, appSecret] = await askTwo("QQ App ID: ", "QQ App Secret: ")

  if (!appId || !appSecret) {
    throw new Error("App ID 和 App Secret 不能为空")
  }

  console.log("\n可选：配置外部 opencode 地址，用于看到本机 opencode 的全部 session")
  console.log("  - 本机 opencode：http://127.0.0.1:4096（需先执行 opencode serve）")
  console.log("  - 跨机器请走 SSH 隧道 / frp 等，不要把 opencode 直接暴露公网")
  console.log("  - 留空则启动嵌入式 opencode（只能看到 bot 自己创建的 session）\n")
  const baseUrl = await askOne("OPENCODE_BASE_URL（回车跳过）: ")

  mkdirSync(CONFIG_DIR, { recursive: true })
  const envContent = [
    `QQ_APP_ID=${appId}`,
    `QQ_APP_SECRET=${appSecret}`,
    `QQ_SANDBOX=false`,
    baseUrl ? `OPENCODE_BASE_URL=${baseUrl}` : `# OPENCODE_BASE_URL=http://127.0.0.1:4096`,
    `ALLOWED_USERS=`,
    `MAX_REPLY_LENGTH=3000`,
  ].join("\n") + "\n"

  writeFileSync(ENV_FILE, envContent)
  console.log(`\n配置已保存到 ${ENV_FILE}`)

  process.env.QQ_APP_ID = appId
  process.env.QQ_APP_SECRET = appSecret
  if (baseUrl) process.env.OPENCODE_BASE_URL = baseUrl
}

function loadEnvFile(path: string): void {
  const content = readFileSync(path, "utf-8")
  for (const line of content.split("\n")) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith("#")) continue
    const eqIdx = trimmed.indexOf("=")
    if (eqIdx < 0) continue
    const key = trimmed.slice(0, eqIdx).trim()
    const val = trimmed.slice(eqIdx + 1).trim()
    if (!process.env[key]) {
      process.env[key] = val
    }
  }
}

export function loadConfig(): Config {
  const appId = process.env.QQ_APP_ID
  const clientSecret = process.env.QQ_APP_SECRET

  if (!appId) throw new Error("缺少 QQ_APP_ID，运行 openqq 重新配置")
  if (!clientSecret) throw new Error("缺少 QQ_APP_SECRET，运行 openqq 重新配置")

  const allowedRaw = process.env.ALLOWED_USERS?.trim() ?? ""
  const allowedUsers = allowedRaw
    ? allowedRaw.split(",").map((s: string) => s.trim()).filter(Boolean)
    : []

  return {
    qq: {
      appId,
      clientSecret,
      sandbox: process.env.QQ_SANDBOX === "true",
    },
    opencode: {
      baseUrl: process.env.OPENCODE_BASE_URL?.trim() || "",
      externalUrl: !!process.env.OPENCODE_BASE_URL?.trim(),
      projectDirectory: process.env.OPENCODE_PROJECT_DIRECTORY?.trim() || undefined,
    },
    allowedUsers,
    maxReplyLength: parseInt(process.env.MAX_REPLY_LENGTH ?? "3000", 10),
  }
}
