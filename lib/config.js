/**
 * 插件配置：字段表、默认值与一个零依赖的校验器。
 *
 * 这里不 import schemastery / zod：发布版 DSH 把它们放在带哈希的 pnpm 路径
 * 后面，而本插件的全部意义就是「在任意 DSH 安装上不依赖一张自己的依赖图也能
 * 加载」。行配置由 loader 直接给到 `apply(ctx, config)`，这里做一次宽松校验：
 * 认不出的字段只告警、不抛错，一个拼错的键不该让整个面板消失。
 *
 * @module dsh-launcher/lib/config
 */

import { existsSync } from 'node:fs'
import { delimiter, isAbsolute, join } from 'node:path'

/** `inheritEnv` 的两个取值。 */
export const INHERIT_ENV_MODES = Object.freeze(['full', 'scrubbed'])

/**
 * Unix 下的默认参数：登录 + 交互 + 执行命令（等于终端里敲这条命令）。
 */
export const DEFAULT_SHELL_ARGS = Object.freeze(['-lic'])

/**
 * 按 shell 类型给出默认参数。
 *
 * 这是跨平台的关键：`-lic` 是 zsh/bash 的写法，Windows 上 **cmd 和 PowerShell 都不认**。
 *
 * | shell | 参数 | 含义 |
 * |---|---|---|
 * | cmd.exe | `/d /s /c` | 跳过 AutoRun、按原样解析、执行一条命令 |
 * | pwsh / powershell | `-NoLogo -Command` | 不打印横幅、执行一条命令（仍加载 profile） |
 * | bash（含 Git Bash） | `-lic` | 与 Unix 一致 |
 *
 * @param {string} shellPath - 已解析出的 shell（可以是裸名字，如 `pwsh`）。
 * @returns {string[]} 追加在 shellPath 之后的参数。
 */
export function defaultShellArgsFor(shellPath) {
  // 自己按两种分隔符切：Windows 路径也要能被识别，不依赖宿主的 path 实现
  const name = String(shellPath ?? '').split(/[\\/]/).pop().toLowerCase()
  if (name === 'cmd' || name === 'cmd.exe') return ['/d', '/s', '/c']
  if (name === 'powershell' || name === 'powershell.exe') return ['-NoLogo', '-Command']
  if (name === 'pwsh' || name === 'pwsh.exe') return ['-NoLogo', '-Command']
  return [...DEFAULT_SHELL_ARGS]
}

/**
 * 某个名字是否能在 PATH 上找到（Windows 上用 PATHEXT 补扩展名）。
 *
 * @param {string} name - 命令名（如 `pwsh`）。
 * @param {{ env?: Record<string, string | undefined>, platform?: string }} [options] - 便于测试注入。
 * @returns {boolean} 是否存在。
 */
function onPath(name, options = {}) {
  const env = options.env ?? process.env
  const platform = options.platform ?? process.platform
  const exts = platform === 'win32'
    ? (env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean)
    : ['']
  const dirs = String(env.PATH ?? '').split(platform === 'win32' ? ';' : delimiter)
  for (const dir of dirs) {
    if (dir === '') continue
    for (const ext of exts) {
      if (existsSync(join(dir, name + ext))) return true
    }
  }
  return false
}

/** 字段表：名称、类型、默认值、说明。 */
const FIELDS = Object.freeze({
  shellPath: { kind: 'string', default: '' },
  // 留空 = 按解析出的 shell 自动推导（Unix: -lic / cmd: /d /s /c / pwsh: -NoLogo -Command）
  shellArgs: { kind: 'stringArray', default: [] },
  maxRuns: { kind: 'positiveInt', default: 12 },
  logMaxChars: { kind: 'positiveInt', default: 400000 },
  stopGraceMs: { kind: 'positiveInt', default: 3000 },
  inheritEnv: { kind: 'enum', values: INHERIT_ENV_MODES, default: 'full' },
  cols: { kind: 'positiveInt', default: 160 },
  rows: { kind: 'positiveInt', default: 40 },
  storeFile: { kind: 'string', default: '' },
  logDir: { kind: 'string', default: '' },
  logRetentionDays: { kind: 'positiveInt', default: 7 },
  logFileMaxBytes: { kind: 'positiveInt', default: 20 * 1024 * 1024 },
  logMaxTotalBytes: { kind: 'positiveInt', default: 512 * 1024 * 1024 },
})

/**
 * 校验原始行配置。
 *
 * @param {unknown} raw - loader 传入的 config。
 * @returns {{ issues: Array<{ field: string, message: string }> }} 问题列表（可为空）。
 */
export function validateConfig(raw) {
  const issues = []
  if (raw === undefined || raw === null) return { issues }
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    return { issues: [{ field: '<root>', message: '配置必须是一个对象' }] }
  }
  for (const [key, value] of Object.entries(raw)) {
    const spec = FIELDS[key]
    if (spec === undefined) {
      issues.push({ field: key, message: `未知字段 ${key}，已忽略` })
      continue
    }
    if (value === undefined) continue
    const problem = checkField(key, value, spec)
    if (problem !== undefined) issues.push({ field: key, message: problem })
  }
  return { issues }
}

/**
 * 单个字段的类型检查。
 *
 * @param {string} key - 字段名。
 * @param {unknown} value - 原始值。
 * @param {{ kind: string, values?: readonly string[] }} spec - 字段规格。
 * @returns {string | undefined} 问题描述。
 */
function checkField(key, value, spec) {
  switch (spec.kind) {
    case 'string':
      return typeof value === 'string' ? undefined : `${key} 必须是字符串`
    case 'boolean':
      return typeof value === 'boolean' ? undefined : `${key} 必须是布尔值`
    case 'positiveInt':
      return Number.isSafeInteger(value) && value > 0 ? undefined : `${key} 必须是正整数`
    case 'stringArray':
      return Array.isArray(value) && value.every(item => typeof item === 'string')
        ? undefined
        : `${key} 必须是字符串数组`
    case 'enum':
      return typeof value === 'string' && spec.values.includes(value)
        ? undefined
        : `${key} 只能是 ${spec.values.join(' / ')}`
    default:
      return undefined
  }
}

/**
 * 解析成一份处处可用的配置。
 *
 * @param {unknown} raw - loader 传入的 config。
 * @returns {{
 *   shellPath: string, shellArgs: string[], maxRuns: number, logMaxChars: number,
 *   stopGraceMs: number, inheritEnv: 'full' | 'scrubbed', cols: number, rows: number,
 *   storeFile: string, logDir: string, logRetentionDays: number, logFileMaxBytes: number,
 *   logMaxTotalBytes: number,
 * }} 解析后的配置；非法字段回落默认值。
 */
export function resolveConfig(raw) {
  const source = raw !== null && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}
  const issues = new Set(validateConfig(source).issues.map(issue => issue.field))
  const pick = (key) => {
    const value = source[key]
    if (issues.has(key) || value === undefined) return FIELDS[key].default
    return value
  }
  const shellPath = normalizeShellPath(pick('shellPath'))
  const configuredArgs = pick('shellArgs')
  return {
    shellPath,
    // 没配就用「这个 shell 认的」默认值：Unix 是 -lic，Windows 的 cmd/pwsh 另有写法
    shellArgs: configuredArgs.length > 0 ? [...configuredArgs] : defaultShellArgsFor(shellPath),
    maxRuns: pick('maxRuns'),
    logMaxChars: pick('logMaxChars'),
    stopGraceMs: pick('stopGraceMs'),
    inheritEnv: pick('inheritEnv'),
    cols: pick('cols'),
    rows: pick('rows'),
    storeFile: pick('storeFile'),
    logDir: pick('logDir'),
    logRetentionDays: pick('logRetentionDays'),
    logFileMaxBytes: pick('logFileMaxBytes'),
    logMaxTotalBytes: pick('logMaxTotalBytes'),
  }
}

/**
 * 选定真正要执行的 shell：显式配置优先，其次 $SHELL，最后按平台常见路径回退。
 *
 * @param {string} configured - 行配置里的 shellPath（可为空串）。
 * @returns {string} 一个存在的可执行文件路径，或最后的兜底猜测。
 */
export function normalizeShellPath(configured, options = {}) {
  const env = options.env ?? process.env
  const platform = options.platform ?? process.platform
  if (typeof configured === 'string' && configured !== '') return configured

  // Windows：$SHELL 通常是 Git Bash 设的，有就用；否则 pwsh → powershell → cmd。
  // 顺序的理由：PowerShell 会加载用户 profile，与 Unix 下 -lic 的语义最接近；
  // cmd.exe 一定存在，作为最后兜底保证「装完至少能跑」。
  if (platform === 'win32') {
    const shellEnv = env.SHELL
    if (typeof shellEnv === 'string' && isAbsolute(shellEnv) && existsSync(shellEnv)) return shellEnv
    if (onPath('pwsh', { env, platform })) return 'pwsh'
    if (onPath('powershell', { env, platform })) return 'powershell'
    const comspec = env.COMSPEC
    if (typeof comspec === 'string' && comspec !== '' && existsSync(comspec)) return comspec
    return 'cmd.exe'
  }

  const candidates = [env.SHELL, '/bin/zsh', '/bin/bash', '/bin/sh'].filter(
    value => typeof value === 'string' && value !== '' && isAbsolute(value),
  )
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate
  }
  return '/bin/sh'
}
