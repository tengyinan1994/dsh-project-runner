/**
 * 宿主半侧的 HTTP 面：`/api/dsh-launcher/*`。
 *
 * 浏览器半侧是同一个 origin 上的 fetch，所以这里用 `ctx.webServer.register`
 * 的具名 exact 路由，不需要 typert 的 Remote 通道，也不需要任何代码生成。
 *
 * 设计约束：
 * - **清单是宿主状态**（见 store.js）。`/state` 一次给齐分组、条目、运行列表；
 *   任何写路由都返回写完之后的最新清单，客户端不用再多跑一趟。
 * - **执行的是清单里的命令行**。面板能填命令，就等于「以你的身份执行命令」，
 *   所以信任边界只有一道：**围栏只认回环**（socket 地址 + Host 头；判断不出的
 *   IPC 桥接情况放行）。一旦 webserver 被配成 0.0.0.0，未配对的局域网客户端
 *   绝不能通过这个面板执行命令。
 * - **删除只删定义**。移除分组/条目/运行实例都不会顺手杀掉正在跑的进程——
 *   整理面板不该把你的服务弄停，要停就点「停止」。
 *
 * @module dsh-launcher/lib/routes
 */

import { ValidationError } from './store.js'

/** 路由前缀。 */
export const API_PREFIX = '/api/dsh-launcher'

/** 全部路由路径，客户端里镜像同一组字面量。 */
export const ROUTES = Object.freeze({
  state: `${API_PREFIX}/state`,
  runs: `${API_PREFIX}/runs`,
  log: `${API_PREFIX}/log`,
  start: `${API_PREFIX}/start`,
  stop: `${API_PREFIX}/stop`,
  clear: `${API_PREFIX}/clear`,
  remove: `${API_PREFIX}/remove`,
  groupCreate: `${API_PREFIX}/group/create`,
  groupUpdate: `${API_PREFIX}/group/update`,
  groupRemove: `${API_PREFIX}/group/remove`,
  groupMove: `${API_PREFIX}/group/move`,
  groupMoveTo: `${API_PREFIX}/group/move-to`,
  itemCreate: `${API_PREFIX}/item/create`,
  itemUpdate: `${API_PREFIX}/item/update`,
  itemRemove: `${API_PREFIX}/item/remove`,
  itemMove: `${API_PREFIX}/item/move`,
  itemMoveTo: `${API_PREFIX}/item/move-to`,
})

/** 请求体上限。 */
const MAX_BODY_BYTES = 64 * 1024

/**
 * IPv4 回环判定（127/8）。
 *
 * @param {string} value - 点分四段地址。
 * @returns {boolean} 是否落在 127/8。
 */
function isIPv4Loopback(value) {
  const parts = value.split('.')
  if (parts.length !== 4) return false
  if (!parts.every(part => /^\d{1,3}$/.test(part) && Number(part) <= 255)) return false
  return parts[0] === '127'
}

/**
 * 回环地址判定：127/8、::1、以及 IPv4-mapped ::ffff:127/8。
 *
 * @param {string | undefined} address - socket 远端地址或 Host 主机名。
 * @returns {boolean} 是否回环。
 */
export function isLoopbackAddress(address) {
  if (typeof address !== 'string' || address === '') return false
  if (address === '::1') return true
  const normalized = address.startsWith('::ffff:') ? address.slice(7) : address
  return isIPv4Loopback(normalized)
}

/**
 * Host 头里的主机名是否回环（含 localhost 与 `[::1]` 写法）。
 *
 * @param {string} hostname - 已剥掉端口的 Host。
 * @returns {boolean} 是否回环。
 */
export function isLoopbackHostname(hostname) {
  if (hostname === '') return false
  if (hostname.toLowerCase() === 'localhost') return true
  const bare = hostname.startsWith('[') && hostname.endsWith(']') ? hostname.slice(1, -1) : hostname
  return isLoopbackAddress(bare)
}

/**
 * 请求级围栏：远端地址与 Host 头都必须回环（判断不出时放行）。
 *
 * @param {import('node:http').IncomingMessage} req - 请求。
 * @returns {string | undefined} 拒绝原因，放行时为 undefined。
 */
export function trustFence(req) {
  const remote = req.socket?.remoteAddress
  if (typeof remote === 'string' && remote !== '' && !isLoopbackAddress(remote)) return 'loopback-only'
  const host = req.headers?.host
  if (typeof host === 'string' && host !== '') {
    const hostname = host.startsWith('[') ? host.slice(0, host.indexOf(']') + 1) : host.split(':')[0]
    if (!isLoopbackHostname(hostname)) return 'loopback-only'
  }
  return undefined
}

/**
 * 写一个 JSON 响应。
 *
 * @param {import('node:http').ServerResponse} res - 响应。
 * @param {number} status - 状态码。
 * @param {unknown} payload - JSON 负载。
 * @returns {void}
 */
export function writeJson(res, status, payload) {
  const body = Buffer.from(JSON.stringify(payload), 'utf8')
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': String(body.byteLength),
    'cache-control': 'no-store',
  })
  res.end(body)
}

/**
 * 读一个 JSON 请求体。
 *
 * @param {import('node:http').IncomingMessage} req - 请求。
 * @returns {Promise<Record<string, unknown> | null>} 解析出的对象；非法时为 null。
 */
export function readJsonBody(req) {
  return new Promise((resolve) => {
    const chunks = []
    let size = 0
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > MAX_BODY_BYTES) {
        resolve(null)
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      if (chunks.length === 0) {
        resolve({})
        return
      }
      try {
        const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'))
        resolve(parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null)
      } catch {
        resolve(null)
      }
    })
    req.on('error', () => resolve(null))
  })
}

/**
 * 组装全部路由。
 *
 * @param {{
 *   config: { shellPath: string, shellArgs: string[], logDir?: string },
 *   supervisor: any,
 *   store: any,
 *   logger: { warn: (message: any) => void },
 * }} deps - 配置、运行器、清单存储与日志器。
 * @returns {Array<{ kind: 'exact', path: string, handler: (req: any, res: any) => Promise<void> }>} 路由表。
 */
export function makeRoutes({ config, supervisor, store, logger }) {
  /**
   * 围栏 + 方法 + 异常的统一外壳。
   *
   * @param {string} method - 期望的 HTTP 方法。
   * @param {(req: any, res: any) => Promise<void>} handler - 业务处理。
   * @returns {(req: any, res: any) => Promise<void>} 包装后的处理器。
   */
  const guard = (method, handler) => async (req, res) => {
    const denied = trustFence(req)
    if (denied !== undefined) {
      writeJson(res, 403, { error: `forbidden: ${denied}` })
      return
    }
    if (req.method !== method) {
      writeJson(res, 405, { error: `method not allowed: ${String(req.method)}` })
      return
    }
    try {
      await handler(req, res)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      // 校验类失败是用户填错了（回 400，不打栈）；其余是宿主自己的问题，
      // 回 500 并把栈记下来——这两种不能混成同一个状态码。
      if (error instanceof ValidationError) {
        if (!res.headersSent) writeJson(res, 400, { error: message })
        else res.destroy()
        return
      }
      logger.warn(`launcher: ${req.url} 处理失败 ${error instanceof Error ? error.stack ?? message : message}`)
      if (!res.headersSent) writeJson(res, 500, { error: `宿主内部错误：${message}` })
      else res.destroy()
    }
  }

  /**
   * 把请求体读成对象。
   *
   * @param {any} req - 请求。
   * @param {any} res - 响应。
   * @returns {Promise<Record<string, unknown> | undefined>} 对象，或在已回应错误时 undefined。
   */
  const bodyOf = async (req, res) => {
    const body = await readJsonBody(req)
    if (body === null) {
      writeJson(res, 400, { error: '请求体不是合法 JSON 对象' })
      return undefined
    }
    return body
  }

  /**
   * 取一个非空字符串字段。
   *
   * @param {Record<string, unknown>} body - 请求体。
   * @param {string} key - 字段名。
   * @returns {string} 值（缺失时为空串）。
   */
  const str = (body, key) => (typeof body[key] === 'string' ? body[key].trim() : '')

  /**
   * 写操作统一返回最新清单。
   *
   * @param {any} res - 响应。
   * @param {Record<string, unknown>} [extra] - 额外字段。
   * @returns {void}
   */
  const writeGroups = (res, extra = {}) => writeJson(res, 200, { ok: true, groups: store.list(), ...extra })

  const handleState = guard('GET', async (_req, res) => {
    await store.ready()
    writeJson(res, 200, {
      shell: { path: config.shellPath, args: config.shellArgs },
      storeFile: store.file(),
      logDir: config.logDir ?? '',
      groups: store.list(),
      runs: supervisor.list(),
      // 能力清单：客户端据此发现「宿主是旧版」（例如 kind 字段还不是它认的）。
      // 能力协商：客户端按这个列表判断宿主半侧是不是旧版（旧版会静默忽略新字段）。
      capabilities: ['item-kind', 'group-color'],
    })
  })

  const handleRuns = guard('GET', async (_req, res) => {
    writeJson(res, 200, { runs: supervisor.list() })
  })

  const handleLog = guard('GET', async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost')
    const id = url.searchParams.get('run') ?? ''
    const from = Number.parseInt(url.searchParams.get('from') ?? '0', 10)
    const result = supervisor.log(id, Number.isSafeInteger(from) ? from : 0)
    if (result === undefined) {
      writeJson(res, 404, { error: `没有这个运行实例：${id}` })
      return
    }
    writeJson(res, 200, result)
  })

  const handleStart = guard('POST', async (req, res) => {
    const body = await bodyOf(req, res)
    if (body === undefined) return
    const groupId = str(body, 'group')
    const itemId = str(body, 'item')
    if (groupId === '' || itemId === '') {
      writeJson(res, 400, { error: '需要 { group, item }' })
      return
    }
    const resolved = store.resolve(groupId, itemId)
    if (resolved === undefined) {
      writeJson(res, 404, { error: '这个启动项已经不存在了（清单可能刚被改过，刷新一下）' })
      return
    }
    const run = await supervisor.start({
      item: resolved.item,
      cwd: resolved.item.cwd !== '' ? resolved.item.cwd : resolved.group.dir,
      groupId,
      groupTitle: resolved.group.name,
    })
    writeJson(res, 200, { run, runs: supervisor.list() })
  })

  const handleStop = guard('POST', async (req, res) => {
    const body = await bodyOf(req, res)
    if (body === undefined) return
    const id = str(body, 'run')
    const run = await supervisor.stop(id, { force: body.force === true })
    if (run === undefined) {
      writeJson(res, 404, { error: `没有这个运行实例：${id}` })
      return
    }
    writeJson(res, 200, { run, runs: supervisor.list() })
  })

  const handleClear = guard('POST', async (req, res) => {
    const body = await bodyOf(req, res)
    if (body === undefined) return
    const run = supervisor.clear(str(body, 'run'))
    if (run === undefined) {
      writeJson(res, 404, { error: '没有这个运行实例' })
      return
    }
    writeJson(res, 200, { run, runs: supervisor.list() })
  })

  const handleRemove = guard('POST', async (req, res) => {
    const body = await bodyOf(req, res)
    if (body === undefined) return
    if (!supervisor.remove(str(body, 'run'))) {
      writeJson(res, 409, { error: '只能移除已经结束的运行实例' })
      return
    }
    writeJson(res, 200, { runs: supervisor.list() })
  })

  const handleGroupCreate = guard('POST', async (req, res) => {
    const body = await bodyOf(req, res)
    if (body === undefined) return
    const group = await store.createGroup({ name: str(body, 'name'), dir: str(body, 'dir'), color: str(body, 'color') })
    writeGroups(res, { group })
  })

  const handleGroupUpdate = guard('POST', async (req, res) => {
    const body = await bodyOf(req, res)
    if (body === undefined) return
    const id = str(body, 'id')
    if (id === '') {
      writeJson(res, 400, { error: '需要 { id }' })
      return
    }
    const patch = {}
    if (typeof body.name === 'string') patch.name = body.name
    if (typeof body.dir === 'string') patch.dir = body.dir
    if (typeof body.color === 'string') patch.color = body.color
    const group = await store.updateGroup(id, patch)
    if (group === undefined) {
      writeJson(res, 404, { error: '没有这个分组' })
      return
    }
    writeGroups(res, { group })
  })

  const handleGroupRemove = guard('POST', async (req, res) => {
    const body = await bodyOf(req, res)
    if (body === undefined) return
    if (!await store.removeGroup(str(body, 'id'))) {
      writeJson(res, 404, { error: '没有这个分组' })
      return
    }
    writeGroups(res)
  })

  const handleGroupMove = guard('POST', async (req, res) => {
    const body = await bodyOf(req, res)
    if (body === undefined) return
    const delta = body.delta === -1 ? -1 : 1
    if (!await store.moveGroup(str(body, 'id'), delta)) {
      writeJson(res, 409, { error: '已经在边上了' })
      return
    }
    writeGroups(res)
  })

  /**
   * 拖拽排序：把分组挪到 `before` 之前（`before` 为空 = 末尾）。
   *
   * 与 `/group/move`（±1，给「上移/下移」用）并存：拖拽的目标是任意位置，
   * 用 ±1 连打 N 次既慢又要写 N 次盘。
   */
  const handleGroupMoveTo = guard('POST', async (req, res) => {
    const body = await bodyOf(req, res)
    if (body === undefined) return
    const before = body.before === null || body.before === undefined ? null : str(body, 'before')
    await store.moveGroupTo(str(body, 'id'), before)
    writeGroups(res)
  })

  /** 拖拽换位/换组：把条目挪到目标分组里 `before` 之前（`before` 为空 = 末尾）。 */
  const handleItemMoveTo = guard('POST', async (req, res) => {
    const body = await bodyOf(req, res)
    if (body === undefined) return
    const before = body.before === null || body.before === undefined ? null : str(body, 'before')
    await store.moveItemTo(str(body, 'group'), str(body, 'item'), str(body, 'toGroup'), before)
    writeGroups(res)
  })

  const handleItemCreate = guard('POST', async (req, res) => {
    const body = await bodyOf(req, res)
    if (body === undefined) return
    const groupId = str(body, 'group')
    if (groupId === '') {
      writeJson(res, 400, { error: '需要 { group }' })
      return
    }
    const item = await store.createItem(groupId, {
      name: str(body, 'name'),
      command: typeof body.command === 'string' ? body.command : '',
      cwd: str(body, 'cwd'),
      env: body.env,
      kind: str(body, 'kind'),
    })
    if (item === undefined) {
      writeJson(res, 404, { error: '没有这个分组' })
      return
    }
    writeGroups(res, { item })
  })

  const handleItemUpdate = guard('POST', async (req, res) => {
    const body = await bodyOf(req, res)
    if (body === undefined) return
    const groupId = str(body, 'group')
    const itemId = str(body, 'item')
    if (groupId === '' || itemId === '') {
      writeJson(res, 400, { error: '需要 { group, item }' })
      return
    }
    const patch = {}
    if (typeof body.name === 'string') patch.name = body.name
    if (typeof body.command === 'string') patch.command = body.command
    if (typeof body.cwd === 'string') patch.cwd = body.cwd
    if (body.env !== undefined) patch.env = body.env
    if (typeof body.kind === 'string') patch.kind = body.kind
    const item = await store.updateItem(groupId, itemId, patch)
    if (item === undefined) {
      writeJson(res, 404, { error: '没有这个启动项' })
      return
    }
    writeGroups(res, { item })
  })

  const handleItemRemove = guard('POST', async (req, res) => {
    const body = await bodyOf(req, res)
    if (body === undefined) return
    if (!await store.removeItem(str(body, 'group'), str(body, 'item'))) {
      writeJson(res, 404, { error: '没有这个启动项' })
      return
    }
    writeGroups(res)
  })

  const handleItemMove = guard('POST', async (req, res) => {
    const body = await bodyOf(req, res)
    if (body === undefined) return
    const delta = body.delta === -1 ? -1 : 1
    if (!await store.moveItem(str(body, 'group'), str(body, 'item'), delta)) {
      writeJson(res, 409, { error: '已经在边上了' })
      return
    }
    writeGroups(res)
  })

  return [
    { kind: 'exact', path: ROUTES.state, handler: handleState },
    { kind: 'exact', path: ROUTES.runs, handler: handleRuns },
    { kind: 'exact', path: ROUTES.log, handler: handleLog },
    { kind: 'exact', path: ROUTES.start, handler: handleStart },
    { kind: 'exact', path: ROUTES.stop, handler: handleStop },
    { kind: 'exact', path: ROUTES.clear, handler: handleClear },
    { kind: 'exact', path: ROUTES.remove, handler: handleRemove },
    { kind: 'exact', path: ROUTES.groupCreate, handler: handleGroupCreate },
    { kind: 'exact', path: ROUTES.groupUpdate, handler: handleGroupUpdate },
    { kind: 'exact', path: ROUTES.groupRemove, handler: handleGroupRemove },
    { kind: 'exact', path: ROUTES.groupMove, handler: handleGroupMove },
    { kind: 'exact', path: ROUTES.groupMoveTo, handler: handleGroupMoveTo },
    { kind: 'exact', path: ROUTES.itemCreate, handler: handleItemCreate },
    { kind: 'exact', path: ROUTES.itemUpdate, handler: handleItemUpdate },
    { kind: 'exact', path: ROUTES.itemRemove, handler: handleItemRemove },
    { kind: 'exact', path: ROUTES.itemMove, handler: handleItemMove },
    { kind: 'exact', path: ROUTES.itemMoveTo, handler: handleItemMoveTo },
  ]
}
