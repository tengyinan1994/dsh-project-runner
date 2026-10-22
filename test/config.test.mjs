/**
 * 配置解析的单元测试：默认值、平台差异、非法值回退。
 *
 * 这里的重点是**跨平台**：Unix 的 `-lic` 在 Windows 的 cmd / PowerShell 上根本不被接受，
 * 所以「默认参数」必须由解析出来的 shell 决定，而不是写死一个数组。
 */

import assert from 'node:assert/strict'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { defaultShellArgsFor, normalizeShellPath, resolveConfig } from '../lib/config.js'

test('默认参数按 shell 类型推导（这是 Windows 能跑的关键）', () => {
  // Unix：登录 + 交互 + 执行命令
  assert.deepEqual(defaultShellArgsFor('/bin/zsh'), ['-lic'])
  assert.deepEqual(defaultShellArgsFor('/bin/bash'), ['-lic'])
  assert.deepEqual(defaultShellArgsFor('/bin/sh'), ['-lic'])
  // Git Bash 也是 bash
  assert.deepEqual(defaultShellArgsFor('C:\\Program Files\\Git\\bin\\bash.exe'), ['-lic'])
  // Windows：cmd 与 PowerShell 各有自己的写法
  assert.deepEqual(defaultShellArgsFor('cmd'), ['/d', '/s', '/c'])
  assert.deepEqual(defaultShellArgsFor('C:\\Windows\\System32\\cmd.exe'), ['/d', '/s', '/c'])
  assert.deepEqual(defaultShellArgsFor('pwsh'), ['-NoLogo', '-Command'])
  assert.deepEqual(defaultShellArgsFor('pwsh.exe'), ['-NoLogo', '-Command'])
  assert.deepEqual(defaultShellArgsFor('powershell'), ['-NoLogo', '-Command'])
  // 大小写不敏感
  assert.deepEqual(defaultShellArgsFor('CMD.EXE'), ['/d', '/s', '/c'])
})

test('unix 下仍然优先 $SHELL 与常见路径，行为与改造前一致', () => {
  const shell = normalizeShellPath('', { platform: 'linux', env: { SHELL: '/bin/zsh' } })
  assert.equal(shell, '/bin/zsh', '存在的 $SHELL 优先')
  const fallback = normalizeShellPath('', { platform: 'linux', env: {} })
  assert.ok(fallback.startsWith('/bin/'), `回落到常见路径，实际 ${fallback}`)
  // 显式配置永远优先，且不改写
  assert.equal(normalizeShellPath('C:\\Windows\\System32\\cmd.exe', { platform: 'linux', env: {} }), 'C:\\Windows\\System32\\cmd.exe')
})

test('windows 下按 pwsh → powershell → cmd 的顺序找（有就升级，没有就兜底）', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-runner-win-'))
  await writeFile(join(dir, 'pwsh.EXE'), '')
  await writeFile(join(dir, 'cmd.exe'), '')

  // PATH 里有 pwsh → 用它（会加载 profile，和 unix 的 -lic 语义最接近）
  assert.equal(
    normalizeShellPath('', { platform: 'win32', env: { PATH: dir, PATHEXT: '.EXE;.CMD', COMSPEC: join(dir, 'cmd.exe') } }),
    'pwsh',
  )

  // PATH 里什么都没有 → 用 $COMSPEC（一定存在）
  assert.equal(
    normalizeShellPath('', { platform: 'win32', env: { PATH: '', PATHEXT: '.EXE', COMSPEC: join(dir, 'cmd.exe') } }),
    join(dir, 'cmd.exe'),
  )

  // 什么都没有 → 最后兜底 cmd.exe，保证「装完至少能跑」
  assert.equal(normalizeShellPath('', { platform: 'win32', env: { PATH: '' } }), 'cmd.exe')

  // Git Bash 的 $SHELL 若指向真存在的绝对路径（非 /usr/bin/bash 这种），优先使用
  assert.equal(
    normalizeShellPath('', { platform: 'win32', env: { SHELL: join(dir, 'cmd.exe'), PATH: dir, PATHEXT: '.EXE' } }),
    join(dir, 'cmd.exe'),
  )
})

test('resolveConfig：没配 shellArgs 时按 shell 推导，配了就听用户的', () => {
  const win = resolveConfig({ shellPath: 'cmd.exe' })
  assert.deepEqual(win.shellArgs, ['/d', '/s', '/c'], 'cmd 不该拿到 -lic')
  const pwsh = resolveConfig({ shellPath: 'pwsh' })
  assert.deepEqual(pwsh.shellArgs, ['-NoLogo', '-Command'])
  const explicit = resolveConfig({ shellPath: 'pwsh', shellArgs: ['-Command'] })
  assert.deepEqual(explicit.shellArgs, ['-Command'], '显式配置优先')
  // Unix 默认值保持 -lic
  assert.deepEqual(resolveConfig({ shellPath: '/bin/zsh' }).shellArgs, ['-lic'])
})

test('resolveConfig：默认值齐全，非法值回退默认（一个拼错的键不该让面板消失）', () => {
  const d = resolveConfig({})
  assert.equal(d.maxRuns, 12)
  assert.equal(d.logMaxChars, 400000)
  assert.equal(d.stopGraceMs, 3000)
  assert.equal(d.inheritEnv, 'full')
  assert.equal(d.cols, 160)
  assert.equal(d.rows, 40)
  assert.equal(d.logRetentionDays, 7)
  assert.equal(d.logMaxTotalBytes, 512 * 1024 * 1024)
  assert.equal(d.logFileMaxBytes, 20 * 1024 * 1024)

  const bad = resolveConfig({ maxRuns: -5, inheritEnv: 'wat', unknownField: 1, cols: 'wide' })
  assert.equal(bad.maxRuns, 12, '非法数字回退')
  assert.equal(bad.inheritEnv, 'full', '非法枚举回退')
  assert.equal(bad.cols, 160)
})

test('resolveConfig：scrubbed 模式被接受', () => {
  assert.equal(resolveConfig({ inheritEnv: 'scrubbed' }).inheritEnv, 'scrubbed')
})
