/**
 * 运行器的单元测试：用假 PTY 句柄验证生命周期、环形日志与停止语义。
 *
 * 这里不真起进程——真 PTY 的行为在 GUI 里做端到端验证；单测锁住的是
 * 「偏移读取」「截断标记」「SIGINT 优先、宽限期后终止」这些容易写错的约定。
 */

import assert from 'node:assert/strict'
import { PassThrough } from 'node:stream'
import { test } from 'node:test'

import { createSupervisor } from '../lib/supervisor.js'

/**
 * 造一个假 PTY 句柄，行为对齐 LocalTerminalHandle 的公开面。
 *
 * @returns {any} 句柄，另带 `_out` / `_exit` 两个测试钩子。
 */
function fakeTerminal() {
  const output = new PassThrough()
  let settle
  const done = new Promise((resolve) => {
    settle = resolve
  })
  const signals = []
  const handle = {
    pid: 4242,
    output,
    done,
    signals,
    terminated: false,
    async write() {},
    async terminate() {
      handle.terminated = true
      output.end()
      settle({ exitCode: null, signal: 'SIGTERM' })
    },
    async signalForeground(signal) {
      signals.push(signal)
      if (signal === 'SIGINT') {
        output.end()
        settle({ exitCode: 130, signal: null })
      }
    },
    async inspectForeground() {
      return { processGroupId: 4242, inputWaiting: true }
    },
    _out(text) {
      output.write(Buffer.from(text, 'utf8'))
    },
    async _exit(code) {
      output.end()
      settle({ exitCode: code, signal: null })
    },
  }
  return handle
}

/**
 * 造一个只提供 subprocess 的假 ctx。
 *
 * @param {any} handle - 假句柄。
 * @returns {{ ctx: any, spec: () => any }} 假上下文与最近一次 spawn spec。
 */
function fakeCtx(handle) {
  let lastSpec = null
  return {
    ctx: {
      get: name => (name === 'subprocess'
        ? {
            spawnTerminal: async (spec) => {
              lastSpec = spec
              return handle
            },
          }
        : undefined),
    },
    spec: () => lastSpec,
  }
}

/** 测试用的配置。 */
const CONFIG = {
  shellPath: '/bin/zsh',
  shellArgs: ['-lic'],
  maxRuns: 2,
  logMaxChars: 10,
  stopGraceMs: 20,
  inheritEnv: 'scrubbed',
  cols: 80,
  rows: 24,
}

/** 等待一个微任务轮次，让 push/done 的 await 链落地。 */
const tick = () => new Promise(resolve => setTimeout(resolve, 5))

/**
 * 造一个启动项。
 *
 * @param {string} command - 命令行。
 * @returns {object} 启动项。
 */
const item = (command, env = {}) => ({ id: 'i-1', name: '测试', command, env })

test('启动项用 zsh 的登录交互参数执行，并把命令放在 argv 末尾', async () => {
  const handle = fakeTerminal()
  const { ctx, spec } = fakeCtx(handle)
  const supervisor = createSupervisor({ ctx, config: CONFIG })
  const run = await supervisor.start({ item: item('echo hi'), cwd: '/tmp/proj', groupId: 'g-1', groupTitle: '测试组' })
  assert.equal(run.status, 'running')
  assert.deepEqual(spec().argv, ['/bin/zsh', '-lic', 'echo hi'])
  assert.equal(spec().cwd, '/tmp/proj')
  assert.equal(spec().terminalType, 'xterm-256color')
  assert.equal(run.groupTitle, '测试组')
  assert.equal(run.itemId, 'i-1')
})

test('输出按偏移读取，且不消费', async () => {
  const handle = fakeTerminal()
  const { ctx } = fakeCtx(handle)
  const supervisor = createSupervisor({ ctx, config: { ...CONFIG, logMaxChars: 1000 } })
  const run = await supervisor.start({ item: item('build'), cwd: '/tmp/proj', groupId: 'g-1', groupTitle: '测试组' })
  handle._out('hello ')
  handle._out('world')
  await tick()
  const first = supervisor.log(run.id, 0)
  assert.equal(first.text, 'hello world')
  assert.equal(first.next, 11)
  assert.equal(first.truncated, false)
  // 同一偏移再读一次，内容不变（读取非消费）。
  assert.equal(supervisor.log(run.id, 0).text, 'hello world')
  // 增量读取只给新的部分。
  handle._out('!')
  await tick()
  const delta = supervisor.log(run.id, first.next)
  assert.equal(delta.text, '!')
  assert.equal(delta.next, 12)
})

test('超出上限时从头丢弃，并用 truncated 标出', async () => {
  const handle = fakeTerminal()
  const { ctx } = fakeCtx(handle)
  const supervisor = createSupervisor({ ctx, config: CONFIG })
  const run = await supervisor.start({ item: item('noisy'), cwd: '/tmp/proj', groupId: 'g-1', groupTitle: '测试组' })
  handle._out('0123456789')
  handle._out('abcde')
  await tick()
  // 上限 10 字符，15 字符里丢掉最前面 5 个，保留的尾巴从偏移 5 起。
  const tail = supervisor.log(run.id, 0)
  assert.equal(tail.text, '56789abcde')
  assert.equal(tail.truncated, true)
  assert.equal(tail.from, 5)
  assert.equal(tail.next, 15)
  // 已经丢掉的偏移只能拿到保留的尾巴，而不是报错。
  assert.equal(supervisor.log(run.id, 3).text, '56789abcde')
  // 读取尾巴里的增量不再标记截断。
  const delta = supervisor.log(run.id, 10)
  assert.equal(delta.text, 'abcde')
  assert.equal(delta.truncated, false)
})

test('SIGINT 停不下来时在宽限期后整棵树终止', async () => {
  const handle = fakeTerminal()
  // 这个句柄收到 SIGINT 后不退出，专门触发宽限期兜底。
  handle.signalForeground = async (signal) => {
    handle.signals.push(signal)
  }
  const { ctx } = fakeCtx(handle)
  const supervisor = createSupervisor({ ctx, config: CONFIG })
  const run = await supervisor.start({ item: item('server'), cwd: '/tmp/proj', groupId: 'g-1', groupTitle: '测试组' })
  const stopping = await supervisor.stop(run.id)
  assert.equal(stopping.status, 'stopping')
  assert.deepEqual(handle.signals, ['SIGINT'])
  await new Promise(resolve => setTimeout(resolve, 60))
  assert.equal(handle.terminated, true)
})

test('force 直接终止进程树', async () => {
  const handle = fakeTerminal()
  const { ctx } = fakeCtx(handle)
  const supervisor = createSupervisor({ ctx, config: CONFIG })
  const run = await supervisor.start({ item: item('server'), cwd: '/tmp/proj', groupId: 'g-1', groupTitle: '测试组' })
  await supervisor.stop(run.id, { force: true })
  await tick()
  assert.equal(handle.terminated, true)
  // 人工停止的实例记 stopped，而不是 exited：面板上要能区分「自己结束」和「我停的」。
  assert.equal(supervisor.list()[0].status, 'stopped')
})

test('进程正常退出后状态与退出码可见', async () => {
  const handle = fakeTerminal()
  const { ctx } = fakeCtx(handle)
  const supervisor = createSupervisor({ ctx, config: CONFIG })
  const run = await supervisor.start({ item: item('true'), cwd: '/tmp/proj', groupId: 'g-1', groupTitle: '测试组' })
  await handle._exit(0)
  await tick()
  const settled = supervisor.list().find(candidate => candidate.id === run.id)
  assert.equal(settled.status, 'exited')
  assert.equal(settled.exitCode, 0)
  // 已结束的实例可以被移除；运行中的不行。
  assert.equal(supervisor.remove(run.id), true)
  assert.equal(supervisor.list().length, 0)
})

test('spawn 失败时记录 failed 与原因，日志里也能看到', async () => {
  const ctx = {
    get: name => (name === 'subprocess'
      ? { spawnTerminal: async () => { throw new Error('PTY 分配失败') } }
      : undefined),
  }
  const supervisor = createSupervisor({ ctx, config: { ...CONFIG, logMaxChars: 4096 } })
  const run = await supervisor.start({ item: item('x'), cwd: '/tmp/proj', groupId: 'g-1', groupTitle: '测试组' })
  assert.equal(run.status, 'failed')
  assert.match(run.error, /PTY 分配失败/)
  assert.match(supervisor.log(run.id, 0).text, /启动失败/)
})

test('没有 subprocess provider 时给出明确报错', async () => {
  const supervisor = createSupervisor({ ctx: { get: () => undefined }, config: CONFIG })
  await assert.rejects(() => supervisor.start({ item: item('x'), cwd: '/tmp/proj', groupId: 'g-1', groupTitle: '测试组' }), /subprocess/)
})

test('并发上限被拦住', async () => {
  const handles = [fakeTerminal(), fakeTerminal(), fakeTerminal()]
  let spawned = 0
  const ctx = {
    get: name => (name === 'subprocess'
      ? { spawnTerminal: async () => handles[spawned++] }
      : undefined),
  }
  const supervisor = createSupervisor({ ctx, config: { ...CONFIG, maxRuns: 2 } })
  await supervisor.start({ item: item('a'), cwd: '/tmp/proj', groupId: 'g-1', groupTitle: '测试组' })
  await supervisor.start({ item: item('b'), cwd: '/tmp/proj', groupId: 'g-1', groupTitle: '测试组' })
  await assert.rejects(() => supervisor.start({ item: item('c'), cwd: '/tmp/proj', groupId: 'g-1', groupTitle: '测试组' }), /上限/)
})

test('已停止的历史不占用"同时在跑"的额度', async () => {
  // 现场教训：反复重启攒了一堆已停止的记录，把 maxRuns 占满后新实例起不来。
  let spawned = 0
  const ctx = {
    get: name => (name === 'subprocess'
      ? { spawnTerminal: async () => { spawned += 1; return fakeTerminal() } }
      : undefined),
  }
  const supervisor = createSupervisor({ ctx, config: { ...CONFIG, maxRuns: 2 } })
  for (let index = 0; index < 4; index += 1) {
    const run = await supervisor.start({ item: item(`x${index}`), cwd: '/tmp/proj', groupId: 'g-1', groupTitle: '测试组' })
    await supervisor.stop(run.id)
  }
  const settled = supervisor.list().filter(run => run.status === 'stopped').length
  assert.ok(settled <= 2, `终态记录应被淘汰到上限内，实际 ${settled}`)
  const fresh = await supervisor.start({ item: item('again'), cwd: '/tmp/proj', groupId: 'g-1', groupTitle: '测试组' })
  assert.equal(fresh.status, 'running')
})

test('同时在跑的活实例仍然被上限拦住', async () => {
  const ctx = {
    get: name => (name === 'subprocess' ? { spawnTerminal: async () => fakeTerminal() } : undefined),
  }
  const supervisor = createSupervisor({ ctx, config: { ...CONFIG, maxRuns: 2 } })
  await supervisor.start({ item: item('a'), cwd: '/tmp/proj', groupId: 'g-1', groupTitle: '测试组' })
  await supervisor.start({ item: item('b'), cwd: '/tmp/proj', groupId: 'g-1', groupTitle: '测试组' })
  await assert.rejects(() => supervisor.start({ item: item('c'), cwd: '/tmp/proj', groupId: 'g-1', groupTitle: '测试组' }), /上限/)
})

test('clear 丢弃已保留日志但保留总偏移', async () => {
  const handle = fakeTerminal()
  const { ctx } = fakeCtx(handle)
  const supervisor = createSupervisor({ ctx, config: { ...CONFIG, logMaxChars: 1000 } })
  const run = await supervisor.start({ item: item('x'), cwd: '/tmp/proj', groupId: 'g-1', groupTitle: '测试组' })
  handle._out('abc')
  await tick()
  supervisor.clear(run.id)
  const after = supervisor.log(run.id, 0)
  assert.equal(after.text, '')
  assert.equal(after.next, 3)
})

test('inheritEnv=full 会把父环境带回去（除保留标记），scrubbed 不带', async () => {
  const handle = fakeTerminal()
  const { ctx, spec } = fakeCtx(handle)
  process.env.DSH_LAUNCHER_TEST_KEY = 'secret'
  process.env.DSH_SUBPROCESS_CONTROL = 'pipe'
  try {
    const full = createSupervisor({ ctx, config: { ...CONFIG, inheritEnv: 'full' } })
    await full.start({ item: item('x'), cwd: '/tmp/proj', groupId: 'g-1', groupTitle: '测试组' })
    assert.equal(spec().env.DSH_LAUNCHER_TEST_KEY, 'secret')
    assert.equal('DSH_SUBPROCESS_CONTROL' in spec().env, false)

    // 非交互护栏：shell 启动脚本的交互提问会顶住 PTY，命令根本不执行（踩过：卡在 oh-my-zsh 更新提问）。
    assert.equal(spec().env.DISABLE_AUTO_UPDATE, 'true')
    assert.equal(spec().env.DISABLE_UPDATE_PROMPT, 'true')
    // 启动项自己配了同名变量时以它为准。
    const custom = createSupervisor({ ctx, config: { ...CONFIG, inheritEnv: 'full' } })
    await custom.start({
      item: item('y', { DISABLE_AUTO_UPDATE: 'false' }),
      cwd: '/tmp/proj',
      groupId: 'g-1',
      groupTitle: '测试组',
    })
    assert.equal(spec().env.DISABLE_AUTO_UPDATE, 'false', '启动项自己的 env 优先')

    const scrubbed = createSupervisor({ ctx, config: { ...CONFIG, inheritEnv: 'scrubbed' } })
    await scrubbed.start({ item: item('x'), cwd: '/tmp/proj', groupId: 'g-1', groupTitle: '测试组' })
    assert.equal('DSH_LAUNCHER_TEST_KEY' in spec().env, false)
  } finally {
    delete process.env.DSH_LAUNCHER_TEST_KEY
    delete process.env.DSH_SUBPROCESS_CONTROL
  }
})

test('disposeAll 终止全部存活实例', async () => {
  const handles = [fakeTerminal(), fakeTerminal()]
  let spawned = 0
  const ctx = {
    get: name => (name === 'subprocess'
      ? { spawnTerminal: async () => handles[spawned++] }
      : undefined),
  }
  const supervisor = createSupervisor({ ctx, config: CONFIG })
  await supervisor.start({ item: item('a'), cwd: '/tmp/proj', groupId: 'g-1', groupTitle: '测试组' })
  await supervisor.start({ item: item('b'), cwd: '/tmp/proj', groupId: 'g-1', groupTitle: '测试组' })
  await supervisor.disposeAll()
  assert.deepEqual(handles.map(handle => handle.terminated), [true, true])
})
