/**
 * 启动项清单存储的单元测试。
 *
 * 这一层是插件现在唯一的数据真源（不再解析 launch.json），所以重点锁住：
 * 落盘与读回、分组/条目的增删改与上下移、输入清洗、并发读盘的竞态、
 * 以及旧版「项目列表」的一次性迁移。
 */

import assert from 'node:assert/strict'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { createStore, legacyFilePath, nameFromCommand, storeFilePath } from '../lib/store.js'

/**
 * 造一个隔离在临时目录的存储。
 *
 * @param {string} [label] - 文件名后缀。
 * @returns {Promise<{ store: any, file: string, legacy: string, dir: string }>} 存储与路径。
 */
async function makeStore(label = 's') {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-launcher-store-'))
  const file = join(dir, `${label}.json`)
  const legacy = join(dir, 'legacy.json')
  return { store: createStore({ filePath: file, legacyFile: legacy }), file, legacy, dir }
}

test('空清单就是空列表，不报错', async () => {
  const { store, file } = await makeStore()
  assert.deepEqual(store.list(), [])
  assert.equal(store.file(), file)
})

test('读盘完成前 list() 是空的，ready() 之后才有内容', async () => {
  // 锁住「caller 必须先 await ready()」：漏了的话，DSH 重启后第一次开面板会是空的。
  const { file, legacy } = await makeStore()
  await writeFile(file, JSON.stringify({ groups: [{ id: 'g1', name: 'demo-web', dir: '/tmp/nj', items: [] }] }), 'utf8')
  const store = createStore({ filePath: file, legacyFile: legacy })
  assert.deepEqual(store.list(), [])
  await store.ready()
  assert.deepEqual(store.list().map(group => group.name), ['demo-web'])
})

test('新建分组并落盘，新分组排在最后', async () => {
  const { store, file } = await makeStore()
  await store.createGroup({ name: 'demo-web', dir: '/tmp/nj' })
  await store.createGroup({ name: 'delivery-app', dir: '/tmp/delivery-app' })
  assert.deepEqual(store.list().map(group => group.name), ['demo-web', 'delivery-app'])
  const saved = JSON.parse(await readFile(file, 'utf8'))
  assert.equal(saved.schemaVersion, 1)
  assert.deepEqual(saved.groups.map(group => group.name), ['demo-web', 'delivery-app'])
})

test('分组改名与改目录', async () => {
  const { store } = await makeStore()
  const group = await store.createGroup({ name: '旧名', dir: '/tmp/a' })
  const updated = await store.updateGroup(group.id, { name: '新名', dir: '/tmp/b' })
  assert.equal(updated.name, '新名')
  assert.equal(updated.dir, '/tmp/b')
  assert.equal(await store.updateGroup('nope', { name: 'x' }), undefined)
})

test('分组上下移，到边界返回 false', async () => {
  const { store } = await makeStore()
  const a = await store.createGroup({ name: 'a' })
  await store.createGroup({ name: 'b' })
  assert.equal(await store.moveGroup(a.id, 1), true)
  assert.deepEqual(store.list().map(group => group.name), ['b', 'a'])
  assert.equal(await store.moveGroup(a.id, 1), false, '已经在最后一位')
  assert.equal(await store.moveGroup(a.id, -1), true)
  assert.deepEqual(store.list().map(group => group.name), ['a', 'b'])
})

test('条目增删改与上下移', async () => {
  const { store } = await makeStore()
  const group = await store.createGroup({ name: 'g', dir: '/tmp/g' })
  const one = await store.createItem(group.id, { command: 'echo 1' })
  const two = await store.createItem(group.id, { name: '第二条', command: 'echo 2', cwd: '/tmp/x' })
  assert.equal(one.name, 'echo 1', '没填名称时用命令行首行')
  assert.equal(two.cwd, '/tmp/x')

  assert.equal(await store.moveItem(group.id, two.id, -1), true)
  assert.deepEqual(store.list()[0].items.map(item => item.name), ['第二条', 'echo 1'])

  const edited = await store.updateItem(group.id, one.id, { name: '改名', command: 'echo 1 edited', env: { A: '1', '非法键': 'x', B: 2 } })
  assert.equal(edited.name, '改名')
  assert.equal(edited.command, 'echo 1 edited')
  assert.deepEqual(edited.env, { A: '1' }, '非法键与非字符串值被清洗掉')

  assert.equal(await store.removeItem(group.id, one.id), true)
  assert.equal(await store.removeItem(group.id, one.id), false)
  assert.equal(store.list()[0].items.length, 1)
})

test('命令行不能为空，分组不存在时报错/返回 undefined', async () => {
  const { store } = await makeStore()
  const group = await store.createGroup({ name: 'g' })
  const item = await store.createItem(group.id, { command: 'echo ok' })
  await assert.rejects(() => store.createItem(group.id, { command: '   ' }), /命令行不能为空/)
  assert.equal(await store.createItem('nope', { command: 'echo' }), undefined)
  // 已存在的条目改成空命令行要报错；条目不存在的查询先返回 undefined
  await assert.rejects(() => store.updateItem(group.id, item.id, { command: '' }), /命令行不能为空/)
  assert.equal(await store.updateItem(group.id, 'nope', { command: '' }), undefined)
})

test('条目性质 kind：默认常驻服务，可改成一次性任务，旧清单默认为服务', async () => {
  const { store, file, legacy } = await makeStore()
  const group = await store.createGroup({ name: 'g', dir: '/tmp/g' })
  const service = await store.createItem(group.id, { command: 'java -jar app.jar' })
  assert.equal(service.kind, 'service', '不填就是常驻服务')

  const task = await store.createItem(group.id, { name: '构建', command: 'mvn install', kind: 'task' })
  assert.equal(task.kind, 'task')

  const flipped = await store.updateItem(group.id, service.id, { kind: 'task' })
  assert.equal(flipped.kind, 'task')
  const rubbish = await store.updateItem(group.id, service.id, { kind: '随便什么' })
  assert.equal(rubbish.kind, 'service', '认不出的值一律回落到常驻服务')

  // 落盘后可读回
  const saved = JSON.parse(await readFile(file, 'utf8'))
  assert.equal(saved.groups[0].items.find(item => item.name === '构建').kind, 'task')

  // 上一版的清单没有 kind 字段 → 当成常驻服务
  const old = join(await mkdtemp(join(tmpdir(), 'dsh-launcher-old-')), 'items.json')
  await writeFile(old, JSON.stringify({ groups: [{ id: 'g1', name: '老清单', dir: '/tmp/o', items: [{ id: 'i1', command: 'echo hi' }] }] }), 'utf8')
  const reopened = createStore({ filePath: old, legacyFile: join(tmpdir(), 'nope.json') })
  await reopened.ready()
  assert.equal(reopened.list()[0].items[0].kind, 'service')
})

test('resolve 取出一条用于启动的完整定义', async () => {
  const { store } = await makeStore()
  const group = await store.createGroup({ name: 'demo-web', dir: '/tmp/nj' })
  const item = await store.createItem(group.id, { name: '后端', command: 'mvn -Plocal spring-boot:run' })
  const resolved = store.resolve(group.id, item.id)
  assert.equal(resolved.group.name, 'demo-web')
  assert.equal(resolved.group.dir, '/tmp/nj')
  assert.equal(resolved.item.command, 'mvn -Plocal spring-boot:run')
  assert.equal(resolved.item.kind, 'service')
  // 返回的是快照，改它不影响内部状态
  resolved.item.command = 'rm -rf /'
  assert.equal(store.resolve(group.id, item.id).item.command, 'mvn -Plocal spring-boot:run')
  assert.equal(store.resolve(group.id, 'nope'), undefined)
})

test('新实例读回上一个实例写的清单（重启后仍在）', async () => {
  const { store, file, legacy } = await makeStore()
  const group = await store.createGroup({ name: 'delivery-app', dir: '/tmp/delivery-app' })
  await store.createItem(group.id, { name: '服务端', command: 'go run .' })
  const reopened = createStore({ filePath: file, legacyFile: legacy })
  await reopened.ready()
  assert.equal(reopened.list()[0].name, 'delivery-app')
  assert.equal(reopened.list()[0].items[0].command, 'go run .')
})

test('清单损坏时按空清单继续并告警', async () => {
  const { file, legacy } = await makeStore()
  await writeFile(file, '{ 这不是 JSON', 'utf8')
  const warnings = []
  const store = createStore({ filePath: file, legacyFile: legacy, logger: { warn: message => warnings.push(String(message)) } })
  await store.ready()
  assert.deepEqual(store.list(), [])
  assert.equal(warnings.length, 1)
})

test('磁盘上的脏数据被清洗：缺命令的条目丢掉，非法分组丢掉', async () => {
  const { file, legacy } = await makeStore()
  await writeFile(file, JSON.stringify({
    groups: [
      { id: 'g1', name: '好的', dir: '/tmp/a', items: [{ id: 'i1', command: 'echo ok' }, { id: 'i2', command: '' }, 'garbage'] },
      { name: '', dir: '' },
      'garbage',
    ],
  }), 'utf8')
  const store = createStore({ filePath: file, legacyFile: legacy })
  await store.ready()
  const groups = store.list()
  assert.equal(groups.length, 1)
  assert.equal(groups[0].items.length, 1)
  assert.equal(groups[0].items[0].command, 'echo ok')
})

test('旧版「项目列表」一次性迁移成分组，且不重复迁移', async () => {
  const { file, legacy } = await makeStore()
  await writeFile(legacy, JSON.stringify({ projects: [{ dir: '/tmp/nj', title: 'demo-web' }, '/tmp/delivery-app'] }), 'utf8')
  const infos = []
  const store = createStore({ filePath: file, legacyFile: legacy, logger: { info: m => infos.push(String(m)), warn: () => {} } })
  await store.ready()
  const groups = store.list()
  assert.deepEqual(groups.map(group => group.name), ['demo-web', 'delivery-app'])
  assert.deepEqual(groups.map(group => group.dir), ['/tmp/nj', '/tmp/delivery-app'])
  assert.deepEqual(groups[0].items, [], '迁移只带目录，条目要用户自己加')
  assert.equal(infos.length, 1)
  assert.ok(JSON.parse(await readFile(file, 'utf8')).groups.length === 2, '迁移结果已落盘')

  // 第二次启动：新文件已存在，不再看旧文件
  const again = createStore({ filePath: file, legacyFile: legacy })
  await again.ready()
  assert.equal(again.list().length, 2)
})

test('nameFromCommand 取首行并截断', () => {
  assert.equal(nameFromCommand('mvn -Plocal spring-boot:run'), 'mvn -Plocal spring-boot:run')
  assert.equal(nameFromCommand('  echo hi  \n第二个参数'), 'echo hi')
  assert.equal(nameFromCommand(''), '未命名')
  assert.equal(nameFromCommand('x'.repeat(80)).length, 41)
})

test('路径默认值：DSH home 下的 launcher/items.json', () => {
  assert.equal(storeFilePath('/tmp/fake-home'), '/tmp/fake-home/launcher/items.json')
  assert.equal(legacyFilePath('/tmp/fake-home'), '/tmp/fake-home/launcher-projects.json')
})

test('moveGroupTo：拖到任意位置（含末尾、原地不动）', async () => {
  const home = await mkdtemp(join(tmpdir(), 'dsh-launcher-store-'))
  // 隔离 DSH_HOME：否则会迁移本机真实的 launcher-projects.json，测试就跟着本机状态飘
  process.env.DSH_HOME = home
  const store = createStore({ filePath: join(home, 'items.json'), logger: { warn: () => {} } })
  const a = (await store.createGroup({ name: 'A', dir: '/tmp' })).id
  const b = (await store.createGroup({ name: 'B', dir: '/tmp' })).id
  const c = (await store.createGroup({ name: 'C', dir: '/tmp' })).id
  const names = () => store.list().map(group => group.name)

  // A 拖到 C 之前：B C A → 把 A 插到 C 前 → B A C
  assert.equal(await store.moveGroupTo(a, c), true)
  assert.deepEqual(names(), ['B', 'A', 'C'])

  // 拖到末尾
  assert.equal(await store.moveGroupTo(a, null), true)
  assert.deepEqual(names(), ['B', 'C', 'A'])

  // 原地：已经在末尾再拖到末尾 → 不算变化，也不重复插入
  assert.equal(await store.moveGroupTo(a, null), false)
  assert.deepEqual(names(), ['B', 'C', 'A'])

  // 拖到自己前面 → 不变
  assert.equal(await store.moveGroupTo(b, b), false)
  assert.deepEqual(names(), ['B', 'C', 'A'])

  // 不存在的 id 不动
  assert.equal(await store.moveGroupTo('不存在', null), false)
  assert.deepEqual(names(), ['B', 'C', 'A'])

  // 落盘后重读一致
  const reloaded = createStore({ filePath: join(home, 'items.json'), logger: { warn: () => {} } })
  await reloaded.ready()
  assert.deepEqual(reloaded.list().map(group => group.name), ['B', 'C', 'A'])
  await store.dispose()
  await reloaded.dispose()
})

test('moveItemTo：跨分组拖拽（含组内重排、拖到空组）', async () => {
  const home = await mkdtemp(join(tmpdir(), 'dsh-launcher-store-'))
  process.env.DSH_HOME = home
  const store = createStore({ filePath: join(home, 'items.json'), logger: { warn: () => {} } })
  const g1 = (await store.createGroup({ name: 'G1', dir: '/tmp' })).id
  const g2 = (await store.createGroup({ name: 'G2', dir: '/tmp' })).id
  const i1 = (await store.createItem(g1, { name: 'i1', command: 'echo 1' })).id
  const i2 = (await store.createItem(g1, { name: 'i2', command: 'echo 2' })).id
  const i3 = (await store.createItem(g1, { name: 'i3', command: 'echo 3' })).id
  const items = id => (store.list().find(group => group.id === id) ?? { items: [] }).items.map(item => item.name)

  // 组内：i3 拖到 i1 之前
  assert.equal(await store.moveItemTo(g1, i3, g1, i1), true)
  assert.deepEqual(items(g1), ['i3', 'i1', 'i2'])

  // 跨组：i1 拖到 G2 的末尾
  assert.equal(await store.moveItemTo(g1, i1, g2, null), true)
  assert.deepEqual(items(g1), ['i3', 'i2'])
  assert.deepEqual(items(g2), ['i1'])

  // 跨组：i2 插到 G2 里 i1 之前
  assert.equal(await store.moveItemTo(g1, i2, g2, i1), true)
  assert.deepEqual(items(g1), ['i3'])
  assert.deepEqual(items(g2), ['i2', 'i1'])

  // 原地：i3 已经在 G1 末尾
  assert.equal(await store.moveItemTo(g1, i3, g1, null), false)
  assert.deepEqual(items(g1), ['i3'])

  // 目标分组不存在 → 不动
  assert.equal(await store.moveItemTo(g1, i3, '不存在', null), false)
  assert.deepEqual(items(g1), ['i3'])

  const reloaded = createStore({ filePath: join(home, 'items.json'), logger: { warn: () => {} } })
  await reloaded.ready()
  assert.deepEqual(reloaded.list().map(group => group.name), ['G1', 'G2'])
  await store.dispose()
  await reloaded.dispose()
})

test('分组颜色：只认 6 位十六进制，非法值当自动；能改也能清回自动', async () => {
  const home = await mkdtemp(join(tmpdir(), 'dsh-launcher-store-'))
  process.env.DSH_HOME = home
  const store = createStore({ filePath: join(home, 'items.json'), logger: { warn: () => {} } })

  const plain = await store.createGroup({ name: '没指定颜色', dir: '/tmp' })
  assert.equal(plain.color, '', '不指定就是空串（客户端按 id 派生）')

  const colored = await store.createGroup({ name: '指定颜色', dir: '/tmp', color: '#4F6BD8' })
  assert.equal(colored.color, '#4f6bd8', '统一转小写')

  const bad = await store.createGroup({ name: '非法颜色', dir: '/tmp', color: 'red; background: url(x)' })
  assert.equal(bad.color, '', '非法值不能进 style')

  assert.equal((await store.updateGroup(colored.id, { color: '#C2415C' })).color, '#c2415c')
  assert.equal((await store.updateGroup(colored.id, { color: '' })).color, '', '空串 = 回到自动')
  assert.equal((await store.updateGroup(colored.id, { color: 'nope' })).color, '', '非法值等于清掉')

  await store.dispose()
  const reloaded = createStore({ filePath: join(home, 'items.json'), logger: { warn: () => {} } })
  await reloaded.ready()
  assert.equal(reloaded.list().find(group => group.name === '指定颜色').color, '', '落盘后重读一致')
  await reloaded.dispose()
})
