/**
 * 启动项清单的存储层。
 *
 * 这一版起，启动器不再解析 `.vscode/launch.json`——那是 DAP 调试配置格式，
 * run-only 翻译在 java / go / 浏览器三类上注定别扭。真源改成**插件自己管的清单**：
 * 分组 + 条目，每条就是「一条命令行 + 一个工作目录」。
 *
 * 存哪儿：`$DSH_HOME/launcher/items.json`。不往用户项目里写任何文件——项目的
 * `.vscode/` 属于项目，DSH 的启动项属于你本机的习惯。文件是普通 JSON，想手改
 * 也行；面板改；两者都能读到对方的结果（每次 /state 都重读盘）。
 *
 * @module dsh-launcher/lib/store
 */

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

/** 清单文件名，落在 DSH home 的 launcher 子目录下。 */
const STORE_FILE = 'items.json'

/** 上一版（项目 + launch.json）的状态文件，仅用于一次性迁移。 */
const LEGACY_FILE = 'launcher-projects.json'

/** 同时保留的分组上限。 */
const MAX_GROUPS = 64

/** 单个分组内的条目上限。 */
const MAX_ITEMS = 128

/** 清单格式版本；以后改结构时按它迁移。 */
const SCHEMA_VERSION = 1

/**
 * 条目的两种性质。
 *
 * `service`（常驻服务）退出是要提醒的——采集器悄悄退了就是事故；`task`
 * （一次性任务，比如一条构建命令）跑完本来就该结束，只看退出码。
 */
export const ITEM_KINDS = Object.freeze(['service', 'task'])

/**
 * 用户输入导致的失败（空命令、超上限）。
 *
 * 路由层据此回 400；其它异常是宿主 bug，回 500 并记完整栈——两者混在一起
 * 会让人把「我填错了」和「插件坏了」看成同一件事。
 */
export class ValidationError extends Error {
  /**
   * @param {string} message - 给用户看的原因。
   */
  constructor(message) {
    super(message)
    this.name = 'ValidationError'
  }
}

/**
 * DSH home 目录。
 *
 * @returns {string} 绝对路径。
 */
function dshHome() {
  return process.env.DSH_HOME ?? join(homedir(), '.dsh')
}

/**
 * 清单文件路径。
 *
 * @param {string} [home] - DSH home；省略时读 `$DSH_HOME`，再回落 `~/.dsh`。
 * @returns {string} 清单文件绝对路径。
 */
export function storeFilePath(home) {
  return join(home ?? dshHome(), 'launcher', STORE_FILE)
}

/**
 * 规范化分组颜色。
 *
 * 只认 6 位十六进制：既不锁死调色板（以后想加自定义色也走得通），
 * 又不让任意字符串进到 style 里。空串 = 自动（客户端按 id 派生一个稳定颜色）。
 *
 * @param {unknown} value - 原始值。
 * @returns {string} `#rrggbb`（小写）或空串。
 */
export function cleanColor(value) {
  const raw = text(value)
  return /^#[0-9a-fA-F]{6}$/.test(raw) ? raw.toLowerCase() : ''
}

/**
 * 运行日志的默认根目录：`$DSH_HOME/launcher/logs`。
 *
 * @param {string} [home] - DSH home。
 * @returns {string} 绝对路径。
 */
export function logDirPath(home) {
  return join(home ?? dshHome(), 'launcher', 'logs')
}

/**
 * 上一版状态文件路径（迁移用）。
 *
 * @param {string} [home] - DSH home。
 * @returns {string} 旧文件绝对路径。
 */
export function legacyFilePath(home) {
  return join(home ?? dshHome(), LEGACY_FILE)
}

/**
 * 造一个 id。时间戳 + 随机后缀：多窗口同时新建也不会撞。
 *
 * @param {string} prefix - 前缀（`g` 组，`i` 条目）。
 * @returns {string} id。
 */
function makeId(prefix) {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

/**
 * 收拾一个字符串字段。
 *
 * @param {unknown} value - 原始值。
 * @param {number} [max] - 长度上限。
 * @returns {string} 去空白后的字符串。
 */
function text(value, max = 4000) {
  if (typeof value !== 'string') return ''
  const trimmed = value.trim()
  return trimmed.length > max ? trimmed.slice(0, max) : trimmed
}

/**
 * 收拾一份环境变量：只留「键合法、值是字符串」的项。
 *
 * @param {unknown} value - 原始 env。
 * @returns {Record<string, string>} 干净的 env。
 */
function cleanEnv(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return {}
  const result = {}
  for (const [key, raw] of Object.entries(value)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue
    if (typeof raw !== 'string') continue
    result[key] = raw
  }
  return result
}

/**
 * 规范化条目性质。
 *
 * @param {unknown} value - 原始值。
 * @returns {'service' | 'task'} 性质；认不出的一律按常驻服务。
 */
function cleanKind(value) {
  return value === 'task' ? 'task' : 'service'
}

/**
 * 从命令行里猜一个名字：取第一行、截断。用户没填名称时用它。
 *
 * @param {string} command - 命令行。
 * @returns {string} 名称。
 */
export function nameFromCommand(command) {
  const first = String(command).split('\n')[0].trim()
  if (first === '') return '未命名'
  return first.length > 40 ? `${first.slice(0, 40)}…` : first
}

/**
 * 建一个清单存储。
 *
 * @param {{
 *   filePath?: string,
 *   legacyFile?: string,
 *   logger?: { warn: (message: any) => void },
 * }} [deps] - 文件路径与日志器。
 * @returns {{
 *   ready: () => Promise<void>,
 *   list: () => Array<object>,
 *   file: () => string,
 *   resolve: (groupId: string, itemId: string) => object | undefined,
 *   createGroup: (input: object) => Promise<object>,
 *   updateGroup: (id: string, patch: object) => Promise<object | undefined>,
 *   removeGroup: (id: string) => Promise<boolean>,
 *   moveGroup: (id: string, delta: number) => Promise<boolean>,
 *   createItem: (groupId: string, input: object) => Promise<object | undefined>,
 *   updateItem: (groupId: string, itemId: string, patch: object) => Promise<object | undefined>,
 *   removeItem: (groupId: string, itemId: string) => Promise<boolean>,
 *   moveItem: (groupId: string, itemId: string, delta: number) => Promise<boolean>,
 *   dispose: () => Promise<void>,
 * }} 存储。
 */
export function createStore({ filePath = storeFilePath(), legacyFile = legacyFilePath(), logger } = {}) {
  /** @type {Array<{ id: string, name: string, dir: string, items: Array<object> }>} */
  let groups = []
  /** memo 化的首次读盘：并发调用共享同一个 promise。 */
  let loading = null
  /** 串行化写入，避免两次快速编辑互相覆盖。 */
  let writing = Promise.resolve()

  /**
   * 读一次清单；缺失/损坏都按空清单继续，不阻断插件。
   *
   * @returns {Promise<void>} 无。
   */
  const load = async () => {
    try {
      const parsed = JSON.parse(await readFile(filePath, 'utf8'))
      const raw = Array.isArray(parsed) ? parsed : parsed?.groups
      if (!Array.isArray(raw)) return
      groups = raw.map(normalizeGroup).filter(group => group !== undefined).slice(0, MAX_GROUPS)
    } catch (error) {
      const code = error !== null && typeof error === 'object' ? error.code : undefined
      if (code !== 'ENOENT') {
        logger?.warn?.(`launcher: 读取启动项清单失败（${error instanceof Error ? error.message : String(error)}），按空清单继续`)
        return
      }
      await migrateLegacy()
    }
  }

  /**
   * 一次性迁移：上一版的「已打开项目」列表变成分组（目录已填好，条目待加）。
   *
   * @returns {Promise<void>} 无。
   */
  const migrateLegacy = async () => {
    try {
      const parsed = JSON.parse(await readFile(legacyFile, 'utf8'))
      const entries = Array.isArray(parsed) ? parsed : parsed?.projects
      if (!Array.isArray(entries)) return
      const migrated = []
      for (const entry of entries) {
        const dir = typeof entry === 'string' ? entry : entry?.dir
        if (typeof dir !== 'string' || dir.trim() === '') continue
        const name = (typeof entry === 'object' && text(entry?.title)) || text(dir).split('/').filter(Boolean).pop() || text(dir)
        migrated.push({ id: makeId('g'), name, dir: text(dir), items: [] })
      }
      if (migrated.length === 0) return
      groups = migrated.slice(0, MAX_GROUPS)
      // 迁移结果立刻落盘：写成功之后就不会再走这条路（新文件已存在）。
      await persist()
      logger?.info?.(`launcher: 已把上一版的 ${String(migrated.length)} 个项目迁移成分组`)
    } catch (error) {
      const code = error !== null && typeof error === 'object' ? error.code : undefined
      if (code !== 'ENOENT') {
        logger?.warn?.(`launcher: 迁移旧项目列表失败 ${error instanceof Error ? error.message : String(error)}`)
      }
    }
  }

  /**
   * 保证读盘只发生一次，且每个调用方都等到它结束。
   *
   * @returns {Promise<void>} 无。
   */
  const ready = () => {
    loading ??= load()
    return loading
  }

  /**
   * 原子落盘：先写临时文件再 rename。
   *
   * @returns {Promise<void>} 无。
   */
  const persist = () => {
    const snapshot = JSON.stringify({ schemaVersion: SCHEMA_VERSION, groups }, null, 2)
    writing = writing.then(async () => {
      const temporary = `${filePath}.tmp`
      try {
        await mkdir(dirname(filePath), { recursive: true })
        await writeFile(temporary, snapshot, 'utf8')
        await rename(temporary, filePath)
      } catch (error) {
        logger?.warn?.(`launcher: 保存启动项清单失败 ${error instanceof Error ? error.message : String(error)}`)
      }
    })
    return writing
  }

  /**
   * 深拷贝一份对外可见的清单，避免调用方改到内部状态。
   *
   * @returns {Array<object>} 分组列表。
   */
  const snapshot = () => groups.map(group => ({ ...group, items: group.items.map(item => ({ ...item, env: { ...item.env } })) }))

  /**
   * 找一个分组。
   *
   * @param {string} id - 分组 id。
   * @returns {any} 分组（内部对象）。
   */
  const findGroup = id => groups.find(group => group.id === id)

  /**
   * 在数组里按 delta 挪一项，返回是否真的动了。
   *
   * @param {Array<any>} list - 数组。
   * @param {number} index - 当前位置。
   * @param {number} delta - 位移。
   * @returns {boolean} 是否发生了移动。
   */
  const shift = (list, index, delta) => {
    const target = index + delta
    if (index < 0 || target < 0 || target >= list.length) return false
    const [entry] = list.splice(index, 1)
    list.splice(target, 0, entry)
    return true
  }

  return {
    ready,
    file: () => filePath,

    list() {
      void ready()
      return snapshot()
    },

    resolve(groupId, itemId) {
      const group = groups.find(candidate => candidate.id === groupId)
      if (group === undefined) return undefined
      const item = group.items.find(candidate => candidate.id === itemId)
      if (item === undefined) return undefined
      return { group: { ...group, items: [] }, item: { ...item, env: { ...item.env } } }
    },

    async createGroup(input) {
      await ready()
      if (groups.length >= MAX_GROUPS) throw new ValidationError(`分组已达上限 ${MAX_GROUPS} 个`)
      const name = text(input?.name) || '新分组'
      const group = { id: makeId('g'), name, dir: text(input?.dir), color: cleanColor(input?.color), items: [] }
      groups = [...groups, group]
      await persist()
      return { ...group }
    },

    async updateGroup(id, patch) {
      await ready()
      const group = findGroup(id)
      if (group === undefined) return undefined
      if (patch?.name !== undefined) group.name = text(patch.name) || group.name
      if (patch?.dir !== undefined) group.dir = text(patch.dir)
      if (patch?.color !== undefined) group.color = cleanColor(patch.color)
      await persist()
      return { ...group, items: [] }
    },

    async removeGroup(id) {
      await ready()
      const next = groups.filter(group => group.id !== id)
      if (next.length === groups.length) return false
      groups = next
      await persist()
      return true
    },

    async moveGroup(id, delta) {
      await ready()
      const moved = shift(groups, groups.findIndex(group => group.id === id), delta < 0 ? -1 : 1)
      if (moved) await persist()
      return moved
    },

    /**
     * 把一个分组挪到另一个分组的位置（拖拽用）。
     *
     * 与 `moveGroup(id, ±1)` 的区别：拖拽的目标是**任意位置**，不是相邻一格。
     * `beforeId` 为 null/空表示挪到末尾。
     *
     * @param {string} id - 要移动的分组 id。
     * @param {string | null} beforeId - 插到这个分组之前；null = 末尾。
     * @returns {Promise<boolean>} 是否发生变化。
     */
    async moveGroupTo(id, beforeId) {
      await ready()
      const from = groups.findIndex(group => group.id === id)
      if (from < 0) return false
      // 拖到自己身上：什么都不做（不能当成「挪到末尾」）
      if (beforeId === id) return false
      const [moved] = groups.splice(from, 1)
      const anchor = beforeId === null || beforeId === undefined || beforeId === ''
        ? -1
        : groups.findIndex(group => group.id === beforeId)
      // 插到自己原来的位置 → 没变化
      if (anchor < 0) {
        if (from === groups.length) {
          groups.splice(from, 0, moved)
          return false
        }
        groups.push(moved)
      } else {
        if (anchor === from) {
          groups.splice(from, 0, moved)
          return false
        }
        groups.splice(anchor, 0, moved)
      }
      await persist()
      return true
    },

    /**
     * 把一个启动项挪到指定分组、指定条目的位置（拖拽用；支持跨分组）。
     *
     * @param {string} groupId - 原分组 id。
     * @param {string} itemId - 要移动的条目 id。
     * @param {string} toGroupId - 目标分组 id。
     * @param {string | null} beforeId - 插到这个条目之前；null = 目标分组末尾。
     * @returns {Promise<boolean>} 是否发生变化。
     */
    async moveItemTo(groupId, itemId, toGroupId, beforeId) {
      await ready()
      const source = findGroup(groupId)
      const target = findGroup(toGroupId)
      if (source === undefined || target === undefined) return false
      const from = source.items.findIndex(item => item.id === itemId)
      if (from < 0) return false
      // 拖到自己身上：什么都不做
      if (source === target && beforeId === itemId) return false
      if (source !== target) {
        if (target.items.length >= MAX_ITEMS) throw new ValidationError(`目标分组的启动项已达上限 ${MAX_ITEMS} 条`)
        const [moved] = source.items.splice(from, 1)
        const anchor = beforeId === null || beforeId === undefined || beforeId === '' ? -1 : target.items.findIndex(item => item.id === beforeId)
        if (anchor < 0) target.items.push(moved)
        else target.items.splice(anchor, 0, moved)
        await persist()
        return true
      }
      const [moved] = source.items.splice(from, 1)
      const anchor = beforeId === null || beforeId === undefined || beforeId === ''
        ? -1
        : source.items.findIndex(item => item.id === beforeId)
      if (anchor < 0) {
        if (from === source.items.length) {
          source.items.splice(from, 0, moved)
          return false
        }
        source.items.push(moved)
      } else {
        if (anchor === from) {
          source.items.splice(from, 0, moved)
          return false
        }
        source.items.splice(anchor, 0, moved)
      }
      await persist()
      return true
    },

    async createItem(groupId, input) {
      await ready()
      const group = findGroup(groupId)
      if (group === undefined) return undefined
      if (group.items.length >= MAX_ITEMS) throw new ValidationError(`单个分组的启动项已达上限 ${MAX_ITEMS} 条`)
      const command = text(input?.command)
      if (command === '') throw new ValidationError('命令行不能为空')
      const item = {
        id: makeId('i'),
        name: text(input?.name) || nameFromCommand(command),
        command,
        cwd: text(input?.cwd),
        env: cleanEnv(input?.env),
        kind: cleanKind(input?.kind),
      }
      group.items.push(item)
      await persist()
      return { ...item, env: { ...item.env } }
    },

    async updateItem(groupId, itemId, patch) {
      await ready()
      const group = findGroup(groupId)
      const item = group?.items.find(candidate => candidate.id === itemId)
      if (group === undefined || item === undefined) return undefined
      if (patch?.command !== undefined) {
        const command = text(patch.command)
        if (command === '') throw new ValidationError('命令行不能为空')
        item.command = command
      }
      if (patch?.name !== undefined) item.name = text(patch.name) || nameFromCommand(item.command)
      if (patch?.cwd !== undefined) item.cwd = text(patch.cwd)
      if (patch?.env !== undefined) item.env = cleanEnv(patch.env)
      if (patch?.kind !== undefined) item.kind = cleanKind(patch.kind)
      await persist()
      return { ...item, env: { ...item.env } }
    },

    async removeItem(groupId, itemId) {
      await ready()
      const group = findGroup(groupId)
      if (group === undefined) return false
      const next = group.items.filter(item => item.id !== itemId)
      if (next.length === group.items.length) return false
      group.items = next
      await persist()
      return true
    },

    async moveItem(groupId, itemId, delta) {
      await ready()
      const group = findGroup(groupId)
      if (group === undefined) return false
      const moved = shift(group.items, group.items.findIndex(item => item.id === itemId), delta < 0 ? -1 : 1)
      if (moved) await persist()
      return moved
    },

    async dispose() {
      await writing
    },
  }
}

/**
 * 规范化一个从磁盘读到的分组；结构不对就丢掉。
 *
 * @param {unknown} raw - 原始记录。
 * @returns {object | undefined} 分组。
 */
function normalizeGroup(raw) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return undefined
  const name = text(raw.name)
  const dir = text(raw.dir)
  if (name === '' && dir === '') return undefined
  const items = (Array.isArray(raw.items) ? raw.items : [])
    .map((entry) => {
      if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) return undefined
      const command = text(entry.command)
      if (command === '') return undefined
      return {
        id: text(entry.id) || makeId('i'),
        name: text(entry.name) || nameFromCommand(command),
        command,
        cwd: text(entry.cwd),
        env: cleanEnv(entry.env),
        // 上一版的清单没有 kind，默认当成常驻服务（当时放的都是应用）。
        kind: cleanKind(entry.kind),
      }
    })
    .filter(entry => entry !== undefined)
    .slice(0, MAX_ITEMS)
  return {
    id: text(raw.id) || makeId('g'),
    name: name || dir.split('/').filter(Boolean).pop() || '分组',
    dir,
    // 上一版的清单没有 color：默认空串 = 客户端按 id 派生一个稳定颜色。
    color: cleanColor(raw.color),
    items,
  }
}
