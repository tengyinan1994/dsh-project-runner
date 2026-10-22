/**
 * 运行日志的落盘与检索。
 *
 * 日志不能只活在内存里：DSH 一重启、或者运行实例被移除，排查现场就没了。
 * 所以每个运行实例同时写一份文件到 `$DSH_HOME/launcher/logs/<日期>/`，
 * 而且这份文件是**人和模型都能读的普通文本**——面板上给路径，agent 工具
 * 直接读文件，跨重启也还在。
 *
 * 这里只放纯逻辑（文件名、关键行抽取、按名字找运行/找日志文件），
 * 读写文件的那部分在 supervisor 与 tool 里，便于单测不碰磁盘。
 *
 * @module dsh-launcher/lib/logs
 */

import { readdir, readFile, rm, rmdir, stat } from 'node:fs/promises'
import { join } from 'node:path'

/**
 * 「值得看」的日志行：排查时真正有用的信号。
 *
 * 这不是随便挑几个词——Java/Spring/Maven、Node/npm、Python 三类技术栈的
 * 失败现场都从这些行开始，而 Maven 一条失败日志动辄十万字符。
 */
export const SIGNAL_PATTERN = /Caused by|APPLICATION FAILED TO START|Error creating bean|UnsatisfiedDependency|BeanCreationException|BeanInstantiationException|NoSuchBeanDefinition|ClassNotFound|NoClassDefFound|TypeNotPresent|Failed to (parse|configure|instantiate|determine|load|execute|start)|Unable to (start|find|open)|Address already in use|Port .* was already in use|BUILD FAILURE|BUILD ERROR|npm ERR!|error TS\d+|Traceback \(most recent|SyntaxError|ModuleNotFoundError|ImportError|panic:|FATAL|Exception in thread|\bERROR\b|\bSEVERE\b|\bFATAL\b/i

/** 默认最多回多少行关键日志——按 token 预算定的，不是按屏幕高度。 */
export const DEFAULT_SIGNAL_LIMIT = 120

/** 单次工具调用允许返回的行数上限。 */
export const MAX_SIGNAL_LIMIT = 500

/** 允许的文件名安全化：只保留字母数字与常见分隔符，其余按 `-` 处理。 */
const UNSAFE_NAME = /[^\p{L}\p{N}._-]+/gu

/**
 * Windows 保留设备名：这些名字做文件名会失败（连扩展名都不行）。
 *
 * 分组/条目名是用户随便写的，有人把分组叫 `aux` 完全正常——但在 Windows 上
 * 写 `aux__x__run-1.log` 会直接报错，日志就落不了盘。
 */
const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i

/**
 * 把分组名/条目名收拾成可以放进文件名的样子。
 *
 * 中文要保留（用户的条目名就是中文），斜杠、空格、引号这些按 `-` 收掉。
 *
 * @param {string} value - 原始名称。
 * @param {number} [max] - 最大长度。
 * @returns {string} 安全片段；全空时返回 `item`。
 */
export function safeName(value, max = 48) {
  // 首尾去分隔符；Windows 还多一条：文件名不能以点或空格结尾
  let cleaned = String(value ?? '')
    .replace(UNSAFE_NAME, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/[.\s]+$/g, '')
  if (cleaned === '') return 'item'
  if (cleaned.length > max) cleaned = cleaned.slice(0, max).replace(/[.\s]+$/g, '')
  // `aux` / `con` / `com1` 这类名字在 Windows 上是设备名，前面垫一个下划线即可
  if (WINDOWS_RESERVED.test(cleaned)) return `_${cleaned}`
  return cleaned
}

/**
 * 日期目录名（本地时区，便于人肉翻目录）。
 *
 * @param {number} [timestamp] - 毫秒时间戳。
 * @returns {string} `YYYY-MM-DD`。
 */
export function dateDir(timestamp = Date.now()) {
  const date = new Date(timestamp)
  const pad = value => String(value).padStart(2, '0')
  return `${String(date.getFullYear())}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

/**
 * 一个运行实例的日志文件名。
 *
 * @param {{ id: string, groupTitle?: string, name?: string }} run - 运行记录。
 * @returns {string} 文件名（不含目录）。
 */
export function logFileName(run) {
  const group = safeName(run.groupTitle ?? 'group', 24)
  const item = safeName(run.name ?? 'item', 32)
  const id = safeName(run.id ?? 'run', 24)
  return `${group}__${item}__${id}.log`
}

/**
 * 一个运行实例的日志文件绝对路径。
 *
 * @param {string} logDir - 日志根目录。
 * @param {{ id: string, groupTitle?: string, name?: string, startedAt?: number }} run - 运行记录。
 * @returns {string} 绝对路径。
 */
export function logFilePath(logDir, run) {
  return join(logDir, dateDir(run.startedAt ?? Date.now()), logFileName(run))
}

/**
 * 从一段日志里抽出「值得看」的行。
 *
 * @param {string} text - 原始文本（可含 ANSI，这里只做行匹配）。
 * @param {{ grep?: string, limit?: number, includeMatches?: boolean }} [options] - 关键字与行数上限。
 * @returns {{ lines: string[], matched: number, total: number, usedSignal: boolean }} 抽出的行与统计。
 */
export function extractSignals(text, options = {}) {
  const limit = Math.min(Math.max(Number.isInteger(options.limit) ? options.limit : DEFAULT_SIGNAL_LIMIT, 1), MAX_SIGNAL_LIMIT)
  const grep = typeof options.grep === 'string' && options.grep.trim() !== '' ? options.grep.trim() : ''
  const all = String(text ?? '').split(/\r?\n/)
  const total = all.length
  const matched = []
  for (const line of all) {
    if (line.trim() === '') continue
    if (grep !== '') {
      if (line.includes(grep)) matched.push(line)
      continue
    }
    if (SIGNAL_PATTERN.test(line)) matched.push(line)
  }
  // 正则带 /g 时 test 会记住 lastIndex，这里没有 /g，安全。
  const usedSignal = grep === ''
  return {
    lines: matched.length > limit ? matched.slice(-limit) : matched,
    matched: matched.length,
    total,
    usedSignal,
  }
}

/**
 * 取一段文本的尾部若干行。
 *
 * @param {string} text - 原始文本。
 * @param {number} lines - 行数。
 * @returns {{ lines: string[], total: number }} 尾行与总行数。
 */
export function tailLines(text, lines) {
  const count = Math.min(Math.max(Number.isInteger(lines) ? lines : 200, 1), MAX_SIGNAL_LIMIT)
  const all = String(text ?? '').split(/\r?\n/)
  return { lines: all.slice(-count), total: all.length }
}

/**
 * 解析一个行范围说明。
 *
 * 这是「引用」那一半的解析器：面板往输入框里写的不是日志正文，而是一句
 * 短引用（例如 `第 12~45 行`、`关键行`、`末尾 200 行`），模型据此回来取。
 *
 * 支持：
 * - `12-45` / `12~45` / `12..45` —— 1 基闭区间；
 * - `12` —— 单行；
 * - `signal` / `关键行` —— 关键行（交给 extractSignals）；
 * - `tail200` / `末尾200` —— 末尾 200 行。
 *
 * @param {string} spec - 范围说明。
 * @param {number} totalLines - 总行数（用于夹取与校验）。
 * @returns {{ kind: 'range' | 'signal' | 'tail', from?: number, to?: number, tail?: number } | undefined} 解析结果；认不出时 undefined。
 */
export function parseRange(spec, totalLines) {
  const value = String(spec ?? '').trim()
  if (value === '') return undefined
  if (value === 'signal' || value === '关键行' || value === '信号行') return { kind: 'signal' }

  const tail = /^(?:tail|末尾|最后)\s*(\d+)$/i.exec(value)
  if (tail !== null) {
    return { kind: 'tail', tail: Math.min(Math.max(Number(tail[1]), 1), MAX_SIGNAL_LIMIT) }
  }

  const range = /^(\d+)\s*(?:[-~～.]{1,2})\s*(\d+)$/.exec(value)
  if (range !== null) {
    const total = Number.isInteger(totalLines) && totalLines > 0 ? totalLines : Number.MAX_SAFE_INTEGER
    const from = Math.min(Math.max(Number(range[1]), 1), total)
    const to = Math.min(Math.max(Number(range[2]), from), total)
    return { kind: 'range', from, to }
  }

  const single = /^(\d+)$/.exec(value)
  if (single !== null) {
    const total = Number.isInteger(totalLines) && totalLines > 0 ? totalLines : Number.MAX_SAFE_INTEGER
    const at = Math.min(Math.max(Number(single[1]), 1), total)
    return { kind: 'range', from: at, to: at }
  }
  return undefined
}

/**
 * 取一段文本的指定行区间（1 基、闭区间）。
 *
 * @param {string} text - 原始文本。
 * @param {number} from - 起始行（1 基）。
 * @param {number} to - 结束行（含）。
 * @returns {{ lines: string[], from: number, to: number, total: number }} 取到的行与位置。
 */
export function sliceLines(text, from, to) {
  const all = String(text ?? '').split(/\r?\n/)
  const total = all.length
  const start = Math.min(Math.max(Number(from) || 1, 1), total)
  const end = Math.min(Math.max(Number(to) || start, start), total)
  return { lines: all.slice(start - 1, end), from: start, to: end, total }
}

/**
 * 猜一个运行实例是否「失败」，用于「不指定时给最近一次失败的」。
 *
 * @param {{ status?: string, exitCode?: number | null }} run - 运行视图。
 * @returns {boolean} 是否失败。
 */
export function isFailedRun(run) {
  if (run.status === 'failed') return true
  if (run.status === 'exited' && run.exitCode !== 0 && run.exitCode !== null && run.exitCode !== undefined) return true
  return false
}

/**
 * 按参数挑一个运行实例。
 *
 * 解析顺序：显式 run id → 条目名（可加分组名限定）→ 不指定时「最近一次失败的运行」，
 * 都没有就取最新一次运行。这样用户说「启动器里那个炸了的」时最省事。
 *
 * @param {Array<any>} runs - 运行视图列表（任意顺序）。
 * @param {{ run?: string, group?: string, item?: string }} query - 查询。
 * @returns {any | undefined} 命中的运行视图。
 */
export function resolveRun(runs, query = {}) {
  const list = Array.isArray(runs) ? [...runs] : []
  if (list.length === 0) return undefined
  const byNewest = (left, right) => (right.startedAt ?? 0) - (left.startedAt ?? 0)
  const sorted = list.sort(byNewest)

  const runId = typeof query.run === 'string' ? query.run.trim() : ''
  if (runId !== '') {
    const exact = sorted.find(run => run.id === runId)
    if (exact !== undefined) return exact
    const loose = sorted.find(run => run.id.includes(runId) || runId.includes(run.id))
    if (loose !== undefined) return loose
  }

  const group = typeof query.group === 'string' ? query.group.trim().toLowerCase() : ''
  const item = typeof query.item === 'string' ? query.item.trim().toLowerCase() : ''
  if (group !== '' || item !== '') {
    const hits = sorted.filter((run) => {
      const title = String(run.groupTitle ?? '').toLowerCase()
      const name = String(run.name ?? '').toLowerCase()
      if (group !== '' && !title.includes(group)) return false
      if (item !== '' && !(name.includes(item) || String(run.command ?? '').toLowerCase().includes(item))) return false
      return true
    })
    if (hits.length > 0) {
      // 同一条目的多次运行里，优先给失败的——排查就是这个意图。
      return hits.find(isFailedRun) ?? hits[0]
    }
  }

  return sorted.find(isFailedRun) ?? sorted[0]
}

/**
 * 列出日志目录里已有的日志文件（新→旧），供跨重启后的回看。
 *
 * @param {string} logDir - 日志根目录。
 * @param {{ group?: string, item?: string, limit?: number }} [filter] - 文件名过滤。
 * @returns {Promise<Array<{ path: string, name: string, bytes: number, modifiedAt: number }>>} 文件列表。
 */
export async function listLogFiles(logDir, filter = {}) {
  const limit = Number.isInteger(filter.limit) ? filter.limit : 40
  const group = typeof filter.group === 'string' ? filter.group.trim().toLowerCase() : ''
  const item = typeof filter.item === 'string' ? filter.item.trim().toLowerCase() : ''
  const found = []
  let days = []
  try {
    days = await readdir(logDir)
  } catch {
    return []
  }
  for (const day of days) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) continue
    let names = []
    try {
      names = await readdir(join(logDir, day))
    } catch {
      continue
    }
    for (const name of names) {
      if (!name.endsWith('.log')) continue
      const lower = name.toLowerCase()
      if (group !== '' && !lower.includes(group)) continue
      if (item !== '' && !lower.includes(item)) continue
      const path = join(logDir, day, name)
      try {
        const info = await stat(path)
        found.push({ path, name: `${day}/${name}`, bytes: info.size, modifiedAt: info.mtimeMs })
      } catch {
        continue
      }
    }
  }
  return found.sort((left, right) => right.modifiedAt - left.modifiedAt).slice(0, limit)
}

/**
 * 读一个日志文件的尾部（跨重启回看用）。
 *
 * @param {string} path - 文件路径。
 * @param {number} [maxBytes] - 最多读多少字节（从尾部取）。
 * @returns {Promise<{ text: string, truncated: boolean, bytes: number }>} 文本与是否被截。
 */
export async function readLogTail(path, maxBytes = 2 * 1024 * 1024) {
  const info = await stat(path)
  if (info.size <= maxBytes) {
    return { text: await readFile(path, 'utf8'), truncated: false, bytes: info.size }
  }
  const { open } = await import('node:fs/promises')
  const handle = await open(path, 'r')
  try {
    const buffer = Buffer.alloc(maxBytes)
    await handle.read(buffer, 0, maxBytes, info.size - maxBytes)
    return { text: buffer.toString('utf8'), truncated: true, bytes: info.size }
  } finally {
    await handle.close()
  }
}

/**
 * 按总量上限清理日志：超过就把最旧的删到线下。
 *
 * 只按天保留是不够的——某天起二十个实例、单文件各接近上限，一天就能堆出几百 MB，
 * 七天就是几个 GB。所以除了「按天数」还要有「按总量」这道闸。
 *
 * @param {string} logDir - 日志根目录。
 * @param {number} maxTotalBytes - 总量上限（字节）；非正数表示不限。
 * @param {(message: string) => void} [logger] - 告警回调。
 * @returns {Promise<{ removedFiles: string[], freedBytes: number, totalBytes: number }>} 清理结果。
 */
export async function enforceLogBudget(logDir, maxTotalBytes, logger) {
  const result = { removedFiles: [], freedBytes: 0, totalBytes: 0 }
  if (!Number.isFinite(maxTotalBytes) || maxTotalBytes <= 0) return result
  const files = await listLogFiles(logDir, { limit: 100000 })
  let total = files.reduce((sum, file) => sum + file.bytes, 0)
  result.totalBytes = total
  if (total <= maxTotalBytes) return result
  // listLogFiles 是「新 → 旧」，这里要「旧 → 新」地删。
  for (const file of [...files].reverse()) {
    if (total <= maxTotalBytes) break
    try {
      await rm(file.path, { force: true })
      total -= file.bytes
      result.freedBytes += file.bytes
      result.removedFiles.push(file.path)
    } catch (error) {
      logger?.(`launcher: 删除旧日志失败 ${file.path} — ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  result.totalBytes = Math.max(total, 0)
  await removeEmptyDayDirs(logDir)
  return result
}

/**
 * 删掉空掉的日期目录（清完文件后不留空壳）。
 *
 * @param {string} logDir - 日志根目录。
 * @returns {Promise<void>} 无。
 */
async function removeEmptyDayDirs(logDir) {
  let days = []
  try {
    days = await readdir(logDir)
  } catch {
    return
  }
  for (const day of days) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) continue
    const path = join(logDir, day)
    try {
      const names = await readdir(path)
      if (names.length === 0) await rmdir(path)
    } catch {
      // 删不掉就算了，不影响使用。
    }
  }
}

/**
 * 清理超过保留期的日志目录。
 *
 * @param {string} logDir - 日志根目录。
 * @param {number} retentionDays - 保留天数。
 * @param {number} [now] - 当前时间（测试注入）。
 * @returns {Promise<{ removedDirs: string[], kept: number }>} 清理结果。
 */
export async function pruneLogs(logDir, retentionDays, now = Date.now()) {
  const cutoff = dateDir(now - Math.max(retentionDays, 0) * 24 * 60 * 60 * 1000)
  let days = []
  try {
    days = await readdir(logDir)
  } catch {
    return { removedDirs: [], kept: 0 }
  }
  const removedDirs = []
  let kept = 0
  for (const day of days) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) continue
    if (day < cutoff) {
      try {
        await rm(join(logDir, day), { recursive: true, force: true })
        removedDirs.push(day)
      } catch {
        kept += 1
      }
      continue
    }
    kept += 1
  }
  return { removedDirs, kept }
}
