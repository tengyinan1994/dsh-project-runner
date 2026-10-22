/**
 * 路由与围栏的单元测试：只测纯函数与处理器行为，不真监听端口。
 *
 * 写路由的语义是这一层的重点：校验失败要回 400 并说清原因，删除只删定义，
 * 每次写操作都把最新清单回给客户端。
 */

import assert from 'node:assert/strict'
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { test } from 'node:test'

import { API_PREFIX, ROUTES, isLoopbackAddress, isLoopbackHostname, makeRoutes, readJsonBody, trustFence, writeJson } from '../lib/routes.js'
import { createStore } from '../lib/store.js'

/**
 * 造一个最小的请求对象。
 *
 * @param {{ method?: string, url?: string, headers?: Record<string, string>, remote?: string, body?: string }} input - 形状。
 * @returns {any} 请求对象。
 */
function fakeRequest(input = {}) {
  const stream = new PassThrough()
  if (input.body !== undefined) stream.end(Buffer.from(input.body, 'utf8'))
  else stream.end()
  return Object.assign(stream, {
    method: input.method ?? 'GET',
    url: input.url ?? '/',
    headers: input.headers ?? {},
    socket: input.remote === undefined ? {} : { remoteAddress: input.remote },
  })
}

/**
 * 造一个收集响应的对象。
 *
 * @returns {any} 响应对象。
 */
function fakeResponse() {
  return {
    status: 0,
    headers: null,
    body: '',
    headersSent: false,
    writeHead(status, headers) {
      this.status = status
      this.headers = headers
      this.headersSent = true
    },
    end(chunk) {
      this.body += chunk === undefined ? '' : String(chunk)
    },
    destroy() {},
  }
}

/**
 * 造一份带假运行器的路由表（清单用真的 store，写在临时目录）。
 *
 * @returns {Promise<{ routes: any[], store: any, calls: any[], warnings: string[] }>} 路由与观测点。
 */
async function makeTestRoutes() {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-launcher-routes-'))
  const store = createStore({ filePath: join(dir, 'items.json'), legacyFile: join(dir, 'legacy.json') })
  const calls = []
  const warnings = []
  const supervisor = {
    list: () => [{ id: 'run-1', status: 'running' }],
    log: (id, from) => (id === 'run-1' ? { run: { id }, text: 'out', from, next: from + 3, truncated: false } : undefined),
    start: async (request) => {
      calls.push(['start', request.groupId, request.item.id, request.cwd, request.groupTitle])
      return { id: 'run-2', name: request.item.name, status: 'running' }
    },
    stop: async (id, options) => (id === 'run-1' ? { id, status: 'stopping', force: options.force === true } : undefined),
    clear: id => (id === 'run-1' ? { id, status: 'running' } : undefined),
    remove: id => id === 'run-1',
  }
  const routes = makeRoutes({
    config: { shellPath: '/bin/zsh', shellArgs: ['-lic'] },
    supervisor,
    store,
    logger: { warn: message => warnings.push(String(message)) },
  })
  return { routes, store, calls, warnings }
}

/**
 * 取一条路由（带查询串时按路径部分匹配）。
 *
 * @param {any[]} routes - 路由表。
 * @param {string} path - 路径（可含 `?query`）。
 * @returns {any} 路由。
 */
const routeOf = (routes, path) => routes.find(candidate => candidate.path === path.split('?')[0])

/**
 * 打一次请求。
 *
 * @param {any[]} routes - 路由表。
 * @param {string} path - 路由路径。
 * @param {{ method?: string, body?: unknown, remote?: string, host?: string }} [input] - 请求形状。
 * @returns {Promise<{ status: number, body: any }>} 响应。
 */
async function hit(routes, path, input = {}) {
  const res = fakeResponse()
  const method = input.method ?? 'GET'
  await routeOf(routes, path).handler(fakeRequest({
    method,
    url: path,
    body: input.body === undefined ? undefined : JSON.stringify(input.body),
    remote: input.remote ?? '127.0.0.1',
    headers: { host: input.host ?? '127.0.0.1:19387' },
  }), res)
  return { status: res.status, body: res.body === '' ? undefined : JSON.parse(res.body) }
}

test('回环地址判定覆盖 127/8、::1 与 IPv4-mapped', () => {
  assert.equal(isLoopbackAddress('127.0.0.1'), true)
  assert.equal(isLoopbackAddress('127.9.9.9'), true)
  assert.equal(isLoopbackAddress('::1'), true)
  assert.equal(isLoopbackAddress('::ffff:127.0.0.1'), true)
  assert.equal(isLoopbackAddress('192.168.1.10'), false)
  assert.equal(isLoopbackAddress('::ffff:10.0.0.2'), false)
  assert.equal(isLoopbackAddress(undefined), false)
})

test('Host 主机名判定覆盖 localhost 与 [::1]', () => {
  assert.equal(isLoopbackHostname('localhost'), true)
  assert.equal(isLoopbackHostname('LOCALHOST'), true)
  assert.equal(isLoopbackHostname('[::1]'), true)
  assert.equal(isLoopbackHostname('127.0.0.1'), true)
  assert.equal(isLoopbackHostname('example.com'), false)
})

test('围栏拒绝非回环来源与非法 Host，放行判断不出的情况', () => {
  assert.equal(trustFence(fakeRequest({ remote: '192.168.1.20', headers: { host: '127.0.0.1:19387' } })), 'loopback-only')
  assert.equal(trustFence(fakeRequest({ remote: '127.0.0.1', headers: { host: 'evil.example.com' } })), 'loopback-only')
  assert.equal(trustFence(fakeRequest({ remote: '127.0.0.1', headers: { host: '127.0.0.1:19387' } })), undefined)
  // IPC 桥接下没有 socket 信息，不能因此判定为不可信。
  assert.equal(trustFence(fakeRequest({ headers: {} })), undefined)
})

test('readJsonBody 解析对象、拒绝数组与坏 JSON', async () => {
  assert.deepEqual(await readJsonBody(fakeRequest({ body: '{"a":1}' })), { a: 1 })
  assert.equal(await readJsonBody(fakeRequest({ body: '[1,2]' })), null)
  assert.equal(await readJsonBody(fakeRequest({ body: '{oops' })), null)
  assert.deepEqual(await readJsonBody(fakeRequest({})), {})
})

test('writeJson 带 no-store 与 JSON 类型', async () => {
  const res = fakeResponse()
  writeJson(res, 200, { ok: true })
  assert.equal(res.status, 200)
  assert.equal(res.headers['content-type'], 'application/json; charset=utf-8')
  assert.equal(res.headers['cache-control'], 'no-store')
  assert.deepEqual(JSON.parse(res.body), { ok: true })
})

test('state 把清单、运行列表、shell 与清单路径一次给齐', async () => {
  const { routes, store } = await makeTestRoutes()
  await store.createGroup({ name: 'demo-web', dir: '/tmp/nj' })
  const { status, body } = await hit(routes, ROUTES.state)
  assert.equal(status, 200)
  assert.deepEqual(body.groups.map(group => group.name), ['demo-web'])
  assert.deepEqual(body.runs, [{ id: 'run-1', status: 'running' }])
  assert.equal(body.shell.path, '/bin/zsh')
  assert.match(body.storeFile, /items\.json$/)
  assert.deepEqual(body.capabilities, ['item-kind', 'group-color'], '能力清单供客户端识别旧宿主')
})

test('分组的建/改/删/移都返回最新清单', async () => {
  const { routes } = await makeTestRoutes()
  const created = await hit(routes, ROUTES.groupCreate, { method: 'POST', body: { name: 'delivery-app', dir: '/tmp/delivery-app' } })
  assert.equal(created.status, 200)
  const groupId = created.body.group.id
  assert.deepEqual(created.body.groups.map(group => group.name), ['delivery-app'])

  const renamed = await hit(routes, ROUTES.groupUpdate, { method: 'POST', body: { id: groupId, name: 'delivery-app 服务', dir: '/tmp/delivery-app' } })
  assert.equal(renamed.body.groups[0].name, 'delivery-app 服务')

  const second = await hit(routes, ROUTES.groupCreate, { method: 'POST', body: { name: 'demo-api' } })
  const secondId = second.body.group.id
  const moved = await hit(routes, ROUTES.groupMove, { method: 'POST', body: { id: secondId, delta: -1 } })
  assert.deepEqual(moved.body.groups.map(group => group.name), ['demo-api', 'delivery-app 服务'])
  assert.equal((await hit(routes, ROUTES.groupMove, { method: 'POST', body: { id: secondId, delta: -1 } })).status, 409)

  const removed = await hit(routes, ROUTES.groupRemove, { method: 'POST', body: { id: secondId } })
  assert.deepEqual(removed.body.groups.map(group => group.name), ['delivery-app 服务'])
  assert.equal((await hit(routes, ROUTES.groupRemove, { method: 'POST', body: { id: secondId } })).status, 404)
})

test('条目的建/改/删/移，以及校验失败回 400', async () => {
  const { routes } = await makeTestRoutes()
  const group = (await hit(routes, ROUTES.groupCreate, { method: 'POST', body: { name: 'g', dir: '/tmp/g' } })).body.group

  const empty = await hit(routes, ROUTES.itemCreate, { method: 'POST', body: { group: group.id, command: '   ' } })
  assert.equal(empty.status, 400)
  assert.match(empty.body.error, /命令行不能为空/)

  const created = await hit(routes, ROUTES.itemCreate, {
    method: 'POST',
    body: { group: group.id, name: '后端', command: 'mvn -Plocal spring-boot:run', env: { A: '1', '非法': 'x' } },
  })
  assert.equal(created.status, 200)
  assert.deepEqual(created.body.item.env, { A: '1' })
  assert.equal(created.body.item.kind, 'service')
  assert.deepEqual(created.body.groups[0].items.map(item => item.name), ['后端'])

  const updated = await hit(routes, ROUTES.itemUpdate, { method: 'POST', body: { group: group.id, item: created.body.item.id, cwd: '/tmp/g/module-a' } })
  assert.equal(updated.body.groups[0].items[0].cwd, '/tmp/g/module-a')

  const removed = await hit(routes, ROUTES.itemRemove, { method: 'POST', body: { group: group.id, item: created.body.item.id } })
  assert.deepEqual(removed.body.groups[0].items, [])
  assert.equal((await hit(routes, ROUTES.itemRemove, { method: 'POST', body: { group: group.id, item: 'nope' } })).status, 404)

  // kind 能建也能改（一次性任务例如一条构建命令）
  const task = await hit(routes, ROUTES.itemCreate, { method: 'POST', body: { group: group.id, name: '构建', command: 'mvn install', kind: 'task' } })
  assert.equal(task.body.item.kind, 'task')
  const flipped = await hit(routes, ROUTES.itemUpdate, { method: 'POST', body: { group: group.id, item: task.body.item.id, kind: 'service' } })
  assert.equal(flipped.body.groups[0].items.find(item => item.name === '构建').kind, 'service')
})

test('start 用清单里的定义启动，条目目录缺省时回落到分组目录', async () => {
  const { routes, calls } = await makeTestRoutes()
  const group = (await hit(routes, ROUTES.groupCreate, { method: 'POST', body: { name: 'demo-web', dir: '/tmp/nj' } })).body.group
  const item = (await hit(routes, ROUTES.itemCreate, { method: 'POST', body: { group: group.id, name: '后端', command: 'mvn -Plocal spring-boot:run' } })).body.item

  const started = await hit(routes, ROUTES.start, { method: 'POST', body: { group: group.id, item: item.id } })
  assert.equal(started.status, 200)
  assert.deepEqual(calls[0], ['start', group.id, item.id, '/tmp/nj', 'demo-web'])

  // 条目自带目录时优先
  await hit(routes, ROUTES.itemUpdate, { method: 'POST', body: { group: group.id, item: item.id, cwd: '/tmp/nj/module-a' } })
  await hit(routes, ROUTES.start, { method: 'POST', body: { group: group.id, item: item.id } })
  assert.equal(calls[1][3], '/tmp/nj/module-a')

  // 清单被改过（条目已不存在）时给 404，而不是执行别的东西
  const gone = await hit(routes, ROUTES.start, { method: 'POST', body: { group: group.id, item: 'nope' } })
  assert.equal(gone.status, 404)
})

test('runs / log / stop / clear / remove 的行为', async () => {
  const { routes } = await makeTestRoutes()
  assert.deepEqual((await hit(routes, ROUTES.runs)).body.runs, [{ id: 'run-1', status: 'running' }])
  assert.deepEqual((await hit(routes, `${ROUTES.log}?run=run-1&from=5`)).body, { run: { id: 'run-1' }, text: 'out', from: 5, next: 8, truncated: false })
  assert.equal((await hit(routes, `${ROUTES.log}?run=nope`)).status, 404)
  assert.equal((await hit(routes, ROUTES.stop, { method: 'POST', body: { run: 'run-1', force: true } })).body.run.force, true)
  assert.equal((await hit(routes, ROUTES.clear, { method: 'POST', body: { run: 'run-1' } })).status, 200)
  assert.equal((await hit(routes, ROUTES.remove, { method: 'POST', body: { run: 'run-1' } })).status, 200)
  assert.equal((await hit(routes, ROUTES.remove, { method: 'POST', body: { run: 'run-9' } })).status, 409)
})

test('方法不符返回 405，非回环来源返回 403', async () => {
  const { routes } = await makeTestRoutes()
  assert.equal((await hit(routes, ROUTES.runs, { method: 'POST' })).status, 405)
  const denied = await hit(routes, ROUTES.state, { remote: '10.1.2.3', host: '10.1.2.3:19387' })
  assert.equal(denied.status, 403)
  assert.match(denied.body.error, /loopback-only/)
  // 写路由同样被拦：这是「以你的身份执行命令」的入口
  const deniedWrite = await hit(routes, ROUTES.groupCreate, { method: 'POST', body: { name: 'x' }, remote: '10.1.2.3', host: '10.1.2.3:19387' })
  assert.equal(deniedWrite.status, 403)
})

test('写操作真的落到了磁盘', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-launcher-persist-'))
  const file = join(dir, 'items.json')
  const store = createStore({ filePath: file, legacyFile: join(dir, 'legacy.json') })
  const routes = makeRoutes({
    config: { shellPath: '/bin/zsh', shellArgs: ['-lic'] },
    supervisor: { list: () => [] },
    store,
    logger: { warn: () => {} },
  })
  const group = (await hit(routes, ROUTES.groupCreate, { method: 'POST', body: { name: 'demo-web', dir: '/tmp/nj' } })).body.group
  await hit(routes, ROUTES.itemCreate, { method: 'POST', body: { group: group.id, name: '后端', command: 'mvn -Plocal spring-boot:run' } })
  const saved = JSON.parse(await readFile(file, 'utf8'))
  assert.equal(saved.groups[0].items[0].command, 'mvn -Plocal spring-boot:run')
})

test('API 前缀集中在一处，客户端镜像它', () => {
  assert.equal(API_PREFIX, '/api/dsh-launcher')
  assert.equal(ROUTES.state, '/api/dsh-launcher/state')
  assert.equal(ROUTES.itemCreate, '/api/dsh-launcher/item/create')
})

test('用户填错回 400 且不打栈，宿主 bug 回 500 并记栈', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-launcher-errors-'))
  const store = createStore({ filePath: join(dir, 'items.json'), legacyFile: join(dir, 'legacy.json') })
  const warnings = []
  const routes = makeRoutes({
    config: { shellPath: '/bin/zsh', shellArgs: ['-lic'] },
    // list() 故意炸掉，模拟宿主侧 bug
    supervisor: { list: () => { throw new TypeError('boom') } },
    store,
    logger: { warn: message => warnings.push(String(message)) },
  })
  const created = await hit(routes, ROUTES.groupCreate, { method: 'POST', body: { name: 'g', dir: '/tmp/g' } })
  assert.equal(created.status, 200)

  // 用户填错：400，说明原因，不记栈
  const bad = await hit(routes, ROUTES.itemCreate, { method: 'POST', body: { group: created.body.group.id, command: '   ' } })
  assert.equal(bad.status, 400)
  assert.match(bad.body.error, /命令行不能为空/)
  assert.equal(warnings.length, 0, '用户填错不该打宿主栈')

  // 宿主 bug：500，记栈
  const boom = await hit(routes, ROUTES.state)
  assert.equal(boom.status, 500)
  assert.match(boom.body.error, /宿主内部错误/)
  assert.equal(warnings.length, 1)
  assert.match(warnings[0], /boom/)
})
