// @input:  @opencode-ai/sdk
// @output: createClient, getClient, healthCheck, OpencodeClient, ClientRef, createClientRef, createProxyClient, reconnectClientRef
// @pos:    opencode层 - OpenCode SDK 客户端封装 + 运行时可替换的 ClientRef
import { createOpencodeClient, type OpencodeClient } from "@opencode-ai/sdk"

let client: OpencodeClient | null = null

export function createClient(baseUrl: string): OpencodeClient {
  client = createOpencodeClient({ baseUrl })
  return client
}

export function getClient(): OpencodeClient {
  if (!client) throw new Error("OpenCode client not initialized")
  return client
}

export async function healthCheck(oc: OpencodeClient): Promise<void> {
  try {
    await oc.session.list()
    console.log("[opencode] health check passed")
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    throw new Error(`OpenCode server unreachable: ${msg}`)
  }
}

export type { OpencodeClient }

/**
 * 运行时可变的 client 引用。
 * - current: 当前真实的 OpencodeClient 实例
 * - baseUrl: 连接地址
 * - external: 是否连接到外部 opencode（false = 嵌入式）
 */
export interface ClientRef {
  current: OpencodeClient
  baseUrl: string
  external: boolean
}

export function createClientRef(baseUrl: string, external: boolean): ClientRef {
  return {
    current: createOpencodeClient({ baseUrl }),
    baseUrl,
    external,
  }
}

/**
 * 生成一个"代理"OpencodeClient：所有方法访问都会实时走到 ref.current，
 * 这样改造时其他模块签名保持 `OpencodeClient` 不变，只要持有此 proxy 即可感知
 * ref 的替换（/connect 后新地址立即生效）。
 */
export function createProxyClient(ref: ClientRef): OpencodeClient {
  return new Proxy({} as OpencodeClient, {
    get(_target, prop, _receiver) {
      return Reflect.get(ref.current as unknown as object, prop)
    },
    has(_target, prop) {
      return Reflect.has(ref.current as unknown as object, prop)
    },
  })
}

/**
 * 替换 ClientRef 指向的底层 client：
 * 1. 创建新的 OpencodeClient
 * 2. 做一次 session.list 作为健康检查
 * 3. 成功后写入 ref.current / ref.baseUrl / ref.external = true
 * 失败则抛错，ref 保持原状。
 */
export async function reconnectClientRef(ref: ClientRef, newBaseUrl: string): Promise<void> {
  const next = createOpencodeClient({ baseUrl: newBaseUrl })
  try {
    await next.session.list()
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    throw new Error(`新地址不可达：${msg}`)
  }
  ref.current = next
  ref.baseUrl = newBaseUrl
  ref.external = true
}
