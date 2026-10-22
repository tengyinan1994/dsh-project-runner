/**
 * 插件装配的集成测试：把真正的 `index.js` 挂到一个假宿主上跑一遍。
 *
 * 单测覆盖各模块内部；这里覆盖「装配」——apply 注册了几条路由、路由拿到的是不是
 * 同一份存储与运行器、卸载时有没有把 PTY 收掉，以及
 * `state → group → item → start → log → stop → remove → 卸载` 整条链在真 store 上
 * 是否走得通。真 PTY 由假句柄替代（真 PTY 的端到端验证在 GUI 里做）。
 */

import assert from 'node:assert/strict'
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { test } from 'node:test'

import { apply } from '../index.js'
import { ROUTES } from '../lib/routes.js'

/**
 * 造一个假 PTY 句柄。
 *
 * @returns {any} 句柄。
 */
function fakeTerminal() {
  const output = new PassThrough()
  let settle
  const done = new Promise((resolve) => {
    settle = resolve
  })
  return {
    pid: 777,
    output,
    done,
    terminated: false,
    async write() {},
    async terminate() {
      this.terminated = true
      output.end()
      settle({ exitCode: null, signal: 'SIGTERM' })
    },
    async signalForeground() {
      output.end()
      settle({ exitCode: 130, signal: null })
    },
    async inspectForeground() {
      return { processGroupId: 777, inputWaiting: true }
    },
    _out: text => output.write(Buffer.from(text, 'utf8')),
  }
}

/**
 * 造一个假宿主 ctx。
 *
 * @param {any} terminal - 假 PTY 句柄，或「每次 spawn 造一个新句柄」的工厂函数。
 *   重启场景必须用工厂：共用一个句柄时，新实例会立刻跟着旧句柄落终态，测出来的行为是假的。
 * @returns {{ ctx: any, state: any }} 假上下文与观测点。
 */
function fakeHost(terminal) {
  const state = { routes: [], disposers: [], specs: [], warnings: [], tools: [], terminals: [] }
  const ctx = {
    logger: { warn: message => state.warnings.push(String(message)), info: () => {} },
    webServer: {
      register(route) {
        state.routes.push(route)
        return () => {}
      },
    },
    tools: {
      register(definition) {
        state.tools.push(definition)
        return () => {}
      },
    },
    get(name) {
      if (name === 'subprocess') {
        return {
          async spawnTerminal(spec) {
            state.specs.push(spec)
            const handle = typeof terminal === 'function' ? terminal() : terminal
            state.terminals.push(handle)
            return handle
          },
        }
      }
      if (name === 'tools') return ctx.tools
      return undefined
    },
    // Cordis 的 inject 只在依赖可用时才回调；假宿主必须照这个语义来，
    // 否则测试会掩盖「没有 tools 服务时崩掉」这种真问题。
    inject(names, callback) {
      if (names.every(name => ctx.get(name) !== undefined)) callback(ctx)
      return () => {}
    },
    effect(callback) {
      const dispose = callback()
      state.disposers.push(dispose)
      return dispose
    },
  }
  return { ctx, state }
}

/**
 * 造一个最小的请求/响应对。
 *
 * @param {{ method?: string, url?: string, body?: unknown }} input - 形状。
 * @returns {{ req: any, res: any }} 请求与响应。
 */
function exchange(input = {}) {
  const stream = new PassThrough()
  stream.end(input.body === undefined ? undefined : Buffer.from(JSON.stringify(input.body), 'utf8'))
  const req = Object.assign(stream, {
    method: input.method ?? 'GET',
    url: input.url ?? '/',
    headers: { host: '127.0.0.1:19387' },
    socket: { remoteAddress: '127.0.0.1' },
  })
  const res = {
    status: 0,
    body: '',
    headersSent: false,
    writeHead(status) {
      this.status = status
      this.headersSent = true
    },
    end(chunk) {
      this.body += chunk === undefined ? '' : String(chunk)
    },
    destroy() {},
  }
  return { req, res }
}

/**
 * 从注册表里取一条路由（带查询串时按路径部分匹配）。
 *
 * @param {any} host - 假宿主观测点。
 * @param {string} path - 路由路径（可含 `?query`）。
 * @returns {any} 路由。
 */
function routeOf(host, path) {
  const route = host.routes.find(candidate => candidate.path === path.split('?')[0])
  assert.ok(route !== undefined, `没有注册 ${path}`)
  return route
}

/**
 * 打一次请求并解析响应。
 *
 * @param {any} host - 假宿主观测点。
 * @param {string} path - 路由路径。
 * @param {{ method?: string, body?: unknown }} [input] - 请求形状。
 * @returns {Promise<{ status: number, body: any }>} 响应。
 */
async function hit(host, path, input = {}) {
  const { req, res } = exchange({ method: input.method, url: path, body: input.body })
  await routeOf(host, path).handler(req, res)
  return { status: res.status, body: res.body === '' ? undefined : JSON.parse(res.body) }
}

test('apply 注册全部路由、落盘清单、卸载时收掉进程', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-launcher-plugin-'))
  const storeFile = join(dir, 'items.json')
  const terminal = fakeTerminal()
  const { ctx, state } = fakeHost(terminal)
  // storeFile 已经指到临时目录，但「上一版项目列表」的迁移路径默认读 $DSH_HOME；
  // 把 home 也挪到临时目录，测试才不会把用户真实的 launcher-projects.json 搬进来。
  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = dir
  apply(ctx, { maxRuns: 3, logMaxChars: 4096, stopGraceMs: 500, storeFile })

  assert.equal(state.routes.length, 17, '应注册 17 条路由（含拖拽用的 move-to 两条）')
  assert.equal(state.warnings.length, 0)

  // 五个 agent 工具：两个只读 + 三个动运行实例的。schema 必须是原生 JSON Schema
  // （defineTool DSL 的 per-property `required: true` / `type: 'json'` 会被注册表拒绝）。
  assert.deepEqual(state.tools.map(tool => tool.name),
    ['launcher_status', 'launcher_log', 'launcher_run', 'launcher_stop', 'launcher_restart'])
  for (const tool of state.tools) {
    assert.equal(tool.parameters.type, 'object')
    assert.equal(typeof tool.parameters.properties, 'object')
    assert.equal(tool.output.schema.type, 'object')
    for (const property of Object.values(tool.parameters.properties)) {
      assert.equal('required' in property, false, `${tool.name} 的参数不该用 DSL 的 required:true`)
      assert.notEqual(property.type, 'json')
    }
  }

  // /state：初始为空清单
  const first = await hit(state, ROUTES.state)
  assert.equal(first.status, 200)
  assert.deepEqual(first.body.groups, [])
  assert.equal(first.body.storeFile, storeFile)
  assert.equal(first.body.shell.path.endsWith('zsh') || first.body.shell.path.endsWith('sh'), true)

  // 建分组 → 建条目 → 都在返回里
  const group = (await hit(state, ROUTES.groupCreate, { method: 'POST', body: { name: 'demo-web', dir: dir } })).body.group
  const item = (await hit(state, ROUTES.itemCreate, {
    method: 'POST',
    body: { group: group.id, name: '后端本地', command: 'mvn -Plocal spring-boot:run' },
  })).body.item
  assert.equal(item.name, '后端本地')

  // 落盘可读
  const saved = JSON.parse(await readFile(storeFile, 'utf8'))
  assert.equal(saved.groups[0].name, 'demo-web')
  assert.equal(saved.groups[0].items[0].command, 'mvn -Plocal spring-boot:run')

  // /state 能读回
  const second = await hit(state, ROUTES.state)
  assert.equal(second.body.groups[0].items[0].name, '后端本地')

  // /start：按清单定义起进程，cwd 用分组目录
  const started = await hit(state, ROUTES.start, { method: 'POST', body: { group: group.id, item: item.id } })
  assert.equal(started.status, 200)
  assert.equal(started.body.run.status, 'running')
  assert.equal(started.body.run.groupTitle, 'demo-web')
  assert.equal(started.body.run.itemId, item.id)
  assert.deepEqual(state.specs[0].argv.slice(-1), ['mvn -Plocal spring-boot:run'])
  assert.equal(state.specs[0].cwd, dir)

  // 输出进来后 /log 能读到，并带上首字节耗时
  terminal._out('up\r\n')
  await new Promise(resolve => setTimeout(resolve, 10))
  const logged = await hit(state, `${ROUTES.log}?run=${started.body.run.id}&from=0`)
  assert.equal(logged.status, 200)
  assert.equal(logged.body.text, 'up\r\n')
  assert.equal(typeof logged.body.run.firstOutputMs, 'number')

  // /stop 收掉进程，随后 /remove 清出列表
  const stopped = await hit(state, ROUTES.stop, { method: 'POST', body: { run: started.body.run.id, force: true } })
  assert.equal(stopped.status, 200)
  assert.equal(terminal.terminated, true)
  await new Promise(resolve => setTimeout(resolve, 10))
  assert.equal((await hit(state, ROUTES.remove, { method: 'POST', body: { run: started.body.run.id } })).status, 200)
  assert.deepEqual((await hit(state, ROUTES.runs)).body.runs, [])

  // 拖拽接口：move-to 两条路由真的要能改顺序、能跨组搬（拖拽排序的地基）
  const groupB = (await hit(state, ROUTES.groupCreate, { method: 'POST', body: { name: 'web-app', dir: dir } })).body.group
  const moved = await hit(state, ROUTES.groupMoveTo, { method: 'POST', body: { id: groupB.id, before: group.id } })
  assert.equal(moved.status, 200)
  assert.deepEqual(moved.body.groups.map(entry => entry.name), ['web-app', 'demo-web'], '拖到某个分组之前')

  const itemB = (await hit(state, ROUTES.itemCreate, {
    method: 'POST',
    body: { group: groupB.id, name: 'Client', command: 'pnpm dev' },
  })).body.item
  const crossGroup = await hit(state, ROUTES.itemMoveTo, {
    method: 'POST',
    body: { group: groupB.id, item: itemB.id, toGroup: group.id, before: item.id },
  })
  assert.equal(crossGroup.status, 200)
  const byName = name => crossGroup.body.groups.find(entry => entry.name === name)
  assert.deepEqual(byName('demo-web').items.map(entry => entry.name), ['Client', '后端本地'], '跨组插到指定条目前')
  assert.deepEqual(byName('web-app').items, [])

  // 接管工具：模型能不能**自己**把服务起起来、停掉、重启（而不是让用户去点面板）。
  // 每次 spawn 一个新句柄：重启要停旧起新，共用句柄会让新实例立刻落终态。
  const host3 = fakeHost(() => fakeTerminal())
  const storeFile3 = join(await mkdtemp(join(tmpdir(), 'dsh-launcher-plugin3-')), 'items.json')
  apply(host3.ctx, { maxRuns: 3, storeFile: storeFile3, stopGraceMs: 200 })
  const toolOf = name => {
    const tool = host3.state.tools.find(candidate => candidate.name === name)
    assert.ok(tool, `缺少工具 ${name}`)
    return tool
  }
  const group3 = (await hit(host3.state, ROUTES.groupCreate, { method: 'POST', body: { name: 'AI 能力底座', dir } })).body.group
  const item3 = (await hit(host3.state, ROUTES.itemCreate, {
    method: 'POST',
    body: { group: group3.id, name: '起 web 端（aicap）', command: 'pnpm dsh aicap' },
  })).body.item

  // run：按名字模糊命中并真的起进程
  const started3 = await toolOf('launcher_run').execute({ item: 'web 端' })
  assert.equal(started3.note, undefined)
  assert.equal(started3.status, 'running')
  assert.equal(host3.state.specs.length, 1, 'run 工具要真的起一个进程')
  assert.deepEqual(host3.state.specs[0].argv.slice(-1), ['pnpm dsh aicap'])
  assert.equal(host3.state.specs[0].cwd, dir, 'cwd 用分组目录')

  // 重复启动要被拒绝（常见后果是端口占用）
  const again = await toolOf('launcher_run').execute({ item: '起 web 端' })
  assert.equal(again.note, 'already-running')
  assert.equal(host3.state.specs.length, 1, '已运行就不要再起一个')

  // 名字命中多个时不猜，把候选摊开
  await hit(host3.state, ROUTES.itemCreate, { method: 'POST', body: { group: group3.id, name: '起 web 端（dev）', command: 'pnpm dev:web' } })
  const ambiguous = await toolOf('launcher_run').execute({ item: 'web 端' })
  assert.equal(ambiguous.note, 'no-item')
  assert.match(ambiguous.text, /命中了多个/, ambiguous.text)

  // restart：停掉在跑的那个、等它落终态、再起一个新的
  const restarted = await toolOf('launcher_restart').execute({ item: '起 web 端（aicap）' })
  assert.equal(restarted.status, 'running')
  assert.match(restarted.text, /已停 run-\d+ 并等它退出/, restarted.text)
  assert.equal(host3.state.specs.length, 2, '重启 = 停一个 + 起一个')
  const runs3 = (await hit(host3.state, ROUTES.runs)).body.runs
  assert.equal(runs3.filter(run => run.status === 'running').length, 1, '重启后只该有一个在跑')
  assert.equal(runs3.filter(run => run.status === 'stopped').length, 1, '旧实例应已落终态')

  // stop：按 id 停，再按名字停一次应说明「没在运行」
  const stopped3 = await toolOf('launcher_stop').execute({ run: restarted.run })
  assert.equal(stopped3.run, restarted.run)
  assert.match(stopped3.text, /已停止/, stopped3.text)
  const nothing = await toolOf('launcher_stop').execute({ item: '起 web 端（aicap）' })
  assert.equal(nothing.note, 'not-running')

  // 找不到的启动项：给出现有清单而不是抛错
  const missing = await toolOf('launcher_run').execute({ item: '不存在的服务' })
  assert.equal(missing.note, 'no-item')
  assert.match(missing.text, /清单里没有匹配/)

  // 卸载：第二个 effect 的 disposer 负责 terminate 还活着的 PTY
  const second2 = fakeTerminal()
  const host2 = fakeHost(second2)
  const storeFile2 = join(await mkdtemp(join(tmpdir(), 'dsh-launcher-plugin2-')), 'items.json')
  apply(host2.ctx, { maxRuns: 3, storeFile: storeFile2 })
  const group2 = (await hit(host2.state, ROUTES.groupCreate, { method: 'POST', body: { name: 'g', dir } })).body.group
  const item2 = (await hit(host2.state, ROUTES.itemCreate, { method: 'POST', body: { group: group2.id, command: 'sleep 100' } })).body.item
  await hit(host2.state, ROUTES.start, { method: 'POST', body: { group: group2.id, item: item2.id } })
  assert.equal(second2.terminated, false)
  // 按 Cordis 的卸载语义逆序释放全部 effect，而不是猜某个下标
  for (const dispose of [...host2.state.disposers].reverse()) {
    if (typeof dispose === 'function') await dispose()
  }
  assert.equal(second2.terminated, true, '卸载时必须终止存活的 PTY')

  if (previousHome === undefined) delete process.env.DSH_HOME
  else process.env.DSH_HOME = previousHome
})
