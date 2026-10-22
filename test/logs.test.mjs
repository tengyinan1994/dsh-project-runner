/**
 * 日志子系统的单元测试：文件名、关键行抽取、按名字选运行实例、跨重启回看与清理。
 *
 * 这一层是「日志不只是监听」的地基：文件命名错了就找不回来，关键行抽错了就把
 * 十万字符的 Maven 日志全丢给模型（token 会哭）。
 */

import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import {
  DEFAULT_SIGNAL_LIMIT, dateDir, extractSignals, isFailedRun, listLogFiles, logFileName, logFilePath,
  enforceLogBudget, parseRange, pruneLogs, readLogTail, resolveRun, safeName, sliceLines, tailLines,
} from '../lib/logs.js'

test('文件名安全化：中文保留，斜杠空格收拾掉', () => {
  assert.equal(safeName('demo-api'), 'demo-api')
  assert.equal(safeName('a/b c"d'), 'a-b-c-d')
  assert.equal(safeName('   '), 'item')
  assert.equal(safeName('x'.repeat(80)).length, 48)
})

test('日志路径按日期分目录，文件名带分组/条目/实例 id', () => {
  const path = logFilePath('/logs', { id: 'run-4', groupTitle: 'demo-api', name: 'Admin Service', startedAt: Date.UTC(2026, 9, 13, 2, 0, 0) })
  const day = dateDir(Date.UTC(2026, 9, 13, 2, 0, 0))
  assert.equal(path, join('/logs', day, 'demo-api__Admin-Service__run-4.log'))
  assert.equal(logFileName({ id: 'run-1' }), 'group__item__run-1.log')
})

test('关键行抽取：默认只挑信号行，能按关键字过滤', () => {
  const text = [
    'INFO starting',
    'org.springframework.beans.factory.BeanCreationException: Error creating bean',
    'Caused by: java.lang.ClassNotFoundException: com.a.B',
    'INFO retry',
    'BUILD FAILURE',
  ].join('\n')
  const signals = extractSignals(text)
  assert.equal(signals.total, 5)
  assert.equal(signals.lines.length, 3)
  assert.equal(signals.usedSignal, true)
  assert.match(signals.lines[1], /ClassNotFoundException/)

  const grep = extractSignals(text, { grep: 'retry' })
  assert.deepEqual(grep.lines, ['INFO retry'])
  assert.equal(grep.usedSignal, false)
})

test('关键行抽取的上限与默认值', () => {
  const many = Array.from({ length: 400 }, (_, i) => `ERROR line ${String(i)}`).join('\n')
  assert.equal(extractSignals(many).lines.length, DEFAULT_SIGNAL_LIMIT)
  assert.equal(extractSignals(many, { limit: 10 }).lines.length, 10)
  assert.equal(extractSignals(many, { limit: 10 }).matched, 400)
  assert.match(extractSignals(many, { limit: 10 }).lines[0], /line 390/, '超限时保留最后 N 行')
})

test('tailLines 取尾部并报总行数', () => {
  const text = Array.from({ length: 50 }, (_, i) => `l${String(i)}`).join('\n')
  const tail = tailLines(text, 5)
  assert.deepEqual(tail.lines, ['l45', 'l46', 'l47', 'l48', 'l49'])
  assert.equal(tail.total, 50)
})

test('isFailedRun 判定失败', () => {
  assert.equal(isFailedRun({ status: 'failed' }), true)
  assert.equal(isFailedRun({ status: 'exited', exitCode: 1 }), true)
  assert.equal(isFailedRun({ status: 'exited', exitCode: 0 }), false)
  assert.equal(isFailedRun({ status: 'running' }), false)
  assert.equal(isFailedRun({ status: 'stopped', exitCode: 130 }), false, '人停的不算异常')
})

test('resolveRun：显式 id → 条目名 → 最近失败的 → 最新', () => {
  const runs = [
    { id: 'run-1', name: '构建', itemId: 'i1', groupTitle: 'A组', command: 'mvn install', status: 'exited', exitCode: 0, startedAt: 100 },
    { id: 'run-2', name: 'Admin Service', itemId: 'i2', groupTitle: 'demo-api', command: 'mvn -pl :admin-service spring-boot:run', status: 'exited', exitCode: 1, startedAt: 200 },
    { id: 'run-3', name: 'MQTT collector', itemId: 'i3', groupTitle: 'demo-api', command: 'mvn -pl :mqtt-collector spring-boot:run', status: 'running', startedAt: 300 },
  ]
  assert.equal(resolveRun(runs, { run: 'run-1' }).id, 'run-1')
  assert.equal(resolveRun(runs, { run: '2' }).id, 'run-2', 'id 部分匹配')
  assert.equal(resolveRun(runs, { item: 'admin-service' }).id, 'run-2', '按命令匹配')
  assert.equal(resolveRun(runs, { item: 'Admin' }).id, 'run-2', '按名称匹配')
  assert.equal(resolveRun(runs, { group: 'demo-api', item: 'mqtt' }).id, 'run-3')
  // 不指定时优先给「最近一次失败的」——排查就是这个意图
  assert.equal(resolveRun(runs, {}).id, 'run-2')
  // 都成功时给最新一次
  assert.equal(resolveRun(runs.filter(run => run.status === 'exited' && run.exitCode === 0), {}).id, 'run-1')
  assert.equal(resolveRun([], {}), undefined)
  // 同一目录多次运行，优先失败的那次
  const twice = [
    { id: 'run-9', name: 'X', itemId: 'i9', status: 'running', startedAt: 400 },
    { id: 'run-8', name: 'X', itemId: 'i9', status: 'exited', exitCode: 1, startedAt: 300 },
  ]
  assert.equal(resolveRun(twice, { item: 'X' }).id, 'run-8')
})

test('跨重启回看：列出磁盘上的日志文件（新的在前）并按名字过滤', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-launcher-logs-'))
  await mkdir(join(dir, '2026-10-12'), { recursive: true })
  await mkdir(join(dir, '2026-10-13'), { recursive: true })
  await writeFile(join(dir, '2026-10-12', 'A组__构建__run-1.log'), 'old\n', 'utf8')
  await writeFile(join(dir, '2026-10-13', 'demo-api__Admin-Service__run-4.log'), 'newer\n', 'utf8')
  await writeFile(join(dir, '2026-10-13', 'notes.txt'), '忽略非 .log\n', 'utf8')

  const all = await listLogFiles(dir)
  assert.equal(all.length, 2)
  assert.match(all[0].name, /2026-10-13/)

  // 按构建产物/jar 名过滤不到日志名（日志名用的是条目名），这正是跨重启回看要按条目名找的原因
  const filtered = await listLogFiles(dir, { item: 'admin-service-jar' })
  assert.equal(filtered.length, 0, 'jar 名与日志名不同，按它过滤不到')
  const byName = await listLogFiles(dir, { item: 'admin' })
  assert.equal(byName.length, 1, '按条目名过滤得到 1 条')

  const tail = await readLogTail(all[0].path)
  assert.equal(tail.text, 'newer\n')
  assert.equal(tail.truncated, false)
  assert.ok((await readFile(all[0].path, 'utf8')).includes('newer'))

  assert.deepEqual(await listLogFiles('/tmp/definitely-missing-dir-9a', {}), [])
})

test('清理过期日志目录：只删超过保留期的日期目录', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-launcher-prune-'))
  await mkdir(join(dir, '2026-09-01'), { recursive: true })
  await mkdir(join(dir, '2026-10-12'), { recursive: true })
  await writeFile(join(dir, '2026-09-01', 'x.log'), 'x', 'utf8')
  const now = Date.UTC(2026, 9, 13, 12, 0, 0)
  const result = await pruneLogs(dir, 7, now)
  assert.deepEqual(result.removedDirs, ['2026-09-01'])
  assert.equal(result.kept, 1)
  const { readdir } = await import('node:fs/promises')
  assert.deepEqual((await readdir(dir)).filter(name => /^\d{4}-/.test(name)), ['2026-10-12'])
})

test('readLogTail 对超大文件只读尾部', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-launcher-tail-'))
  const path = join(dir, 'big.log')
  await writeFile(path, 'X'.repeat(5000), 'utf8')
  const tail = await readLogTail(path, 1000)
  assert.equal(tail.truncated, true)
  assert.equal(tail.bytes, 5000)
  assert.equal(tail.text.length, 1000)
})

test('parseRange：行区间 / 单行 / 关键行 / 末尾 N 行的写法都认', () => {
  assert.deepEqual(parseRange('12-45', 100), { kind: 'range', from: 12, to: 45 })
  assert.deepEqual(parseRange('12~45', 100), { kind: 'range', from: 12, to: 45 }, '中文波浪号')
  assert.deepEqual(parseRange('12～45', 100), { kind: 'range', from: 12, to: 45 })
  assert.deepEqual(parseRange('7', 100), { kind: 'range', from: 7, to: 7 }, '单行')
  assert.deepEqual(parseRange('signal', 100), { kind: 'signal' })
  assert.deepEqual(parseRange('关键行', 100), { kind: 'signal' })
  assert.deepEqual(parseRange('tail200', 5000), { kind: 'tail', tail: 200 })
  assert.deepEqual(parseRange('末尾 200', 5000), { kind: 'tail', tail: 200 })
  // 越界夹取
  assert.deepEqual(parseRange('90-200', 100), { kind: 'range', from: 90, to: 100 })
  assert.deepEqual(parseRange('30-10', 100), { kind: 'range', from: 30, to: 30 }, '倒着的区间取单行')
  assert.equal(parseRange('今天下午', 100), undefined)
  assert.equal(parseRange('', 100), undefined)
})

test('sliceLines：1 基闭区间取行', () => {
  const text = ['a', 'b', 'c', 'd', 'e'].join('\n')
  assert.deepEqual(sliceLines(text, 2, 4).lines, ['b', 'c', 'd'])
  assert.equal(sliceLines(text, 2, 4).total, 5)
  assert.deepEqual(sliceLines(text, 1, 99).lines, ['a', 'b', 'c', 'd', 'e'], '超过末尾就取到末尾')
  assert.deepEqual(sliceLines(text, 0, 2).lines, ['a', 'b'], '下界夹到 1')
})

test('总量上限：超限就删最旧的，删完顺手清掉空目录', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-launcher-budget-'))
  await mkdir(join(dir, '2026-10-01'), { recursive: true })
  await mkdir(join(dir, '2026-10-12'), { recursive: true })
  await mkdir(join(dir, '2026-10-13'), { recursive: true })
  // 三个文件各 1000 字节：01 最旧、13 最新
  await writeFile(join(dir, '2026-10-01', 'a.log'), 'a'.repeat(1000), 'utf8')
  await writeFile(join(dir, '2026-10-12', 'b.log'), 'b'.repeat(1000), 'utf8')
  await writeFile(join(dir, '2026-10-13', 'c.log'), 'c'.repeat(1000), 'utf8')

  // 上限 2500：必须删掉一个（最旧的 a.log）
  const tight = await enforceLogBudget(dir, 2500)
  assert.equal(tight.removedFiles.length, 1)
  assert.match(tight.removedFiles[0], /2026-10-01/)
  assert.equal(tight.totalBytes, 2000)
  const { readdir } = await import('node:fs/promises')
  assert.equal((await readdir(dir)).includes('2026-10-01'), false, '空日期目录应被清掉')

  // 上限充足：什么都不动
  const roomy = await enforceLogBudget(dir, 10 * 1024 * 1024)
  assert.deepEqual(roomy.removedFiles, [])
  assert.equal(roomy.totalBytes, 2000)

  // 上限为 0 / 非法：视为不限
  assert.deepEqual((await enforceLogBudget(dir, 0)).removedFiles, [])
  assert.deepEqual((await enforceLogBudget(dir, Number.NaN)).removedFiles, [])

  // 极端：上限 1 字节 → 全删光（并清空目录）
  const wipe = await enforceLogBudget(dir, 1)
  assert.equal(wipe.removedFiles.length, 2)
  assert.equal((await readdir(dir)).filter(name => /^\d{4}-/.test(name)).length, 0)
})

test('保留期清理与总量清理互补：先按天，再按量', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-launcher-both-'))
  await mkdir(join(dir, '2026-09-01'), { recursive: true })
  await mkdir(join(dir, '2026-10-13'), { recursive: true })
  await writeFile(join(dir, '2026-09-01', 'old.log'), 'x'.repeat(100), 'utf8')
  await writeFile(join(dir, '2026-10-13', 'new.log'), 'y'.repeat(100), 'utf8')
  const now = Date.UTC(2026, 9, 13, 12, 0, 0)
  const pruned = await pruneLogs(dir, 7, now)
  assert.deepEqual(pruned.removedDirs, ['2026-09-01'], '按天先清掉过期的')
  const budget = await enforceLogBudget(dir, 10 * 1024 * 1024)
  assert.deepEqual(budget.removedFiles, [], '剩下的没过量就不动')
})

test('Windows 保留设备名与末尾点/空格不能当文件名', () => {
  // 这些名字在 Windows 上是设备名，直接做文件名会写入失败
  assert.equal(safeName('aux'), '_aux')
  assert.equal(safeName('CON'), '_CON')
  assert.equal(safeName('com1'), '_com1')
  assert.equal(safeName('lpt9'), '_lpt9')
  // 只是以这些字母开头的名字是正常名字
  assert.equal(safeName('console'), 'console')
  assert.equal(safeName('auxiliary'), 'auxiliary')
  // Windows 上文件名不能以点或空格结尾
  assert.equal(safeName('demo.'), 'demo')
  assert.equal(safeName('demo   '), 'demo')
  assert.ok(!safeName(`${'a'.repeat(47)}.`).endsWith('.'))
})
