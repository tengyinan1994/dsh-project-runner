/**
 * 浏览器半侧的单元测试：绕过 DOM，只测日志渲染里的纯函数。
 *
 * `client.js` 是给客户端模块系统用的 bundle（模块顶层就调用
 * `window.__ModuleLoader__.load`），所以这里先造一个假的 `window`，再用
 * 假 `require` 拿到 factory 的导出——这样就能直接测 ANSI 解析，而不必为了
 * 一个进度条行为去搭浏览器环境。
 */

import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'

/** 捕获客户端模块系统注册的 factory。 */
let definition = null
globalThis.window = {
  __ModuleLoader__: {
    load(candidate) {
      definition = candidate
    },
  },
}

await import('../client.js')

/** 假 `require`：模块顶层只需要 React 的形状。 */
const requireStub = (name) => {
  if (name === 'react') {
    return {
      createElement: () => null,
      useState: () => [undefined, () => {}],
      useEffect: () => {},
      useMemo: fn => fn(),
      useRef: value => ({ current: value }),
      useCallback: fn => fn,
    }
  }
  throw new Error(`测试没有为 ${name} 准备桩`)
}

const client = definition.factory(requireStub)
const {
  parseAnsi, xterm256, styleToCss, LauncherPanel, LogBody, LauncherIcon, GroupForm, ItemForm, MoreMenu,
  popoverForSelection, nextPopover,
  runState, runFacts, envToText, textToEnv, shortenHome, relativeDir, homeFromStoreFile, groupColor,
  renderGroup, renderItem, stateProblem,
} = client.__internals

/** 把解析结果压成扁平文本，便于断言。 */
const flat = (result) => result.lines.map(line => line.map(span => span.text).join('')).join('\n')

const ESC = '\u001b'

test('bundle 注册了正确的模块 id，并导出 apply/inject', () => {
  assert.equal(definition.id, 'dsh-project-runner')
  assert.equal(typeof client.apply, 'function')
  // 不再 inject locale：界面中文写死，见文件头注释。
  // sidebarRight / sidebarRightTabs 是右栏「运行日志」tab 需要的服务。
  assert.deepEqual(client.inject, ['slots', 'layout', 'uiWorkspace', 'sidebarRight', 'sidebarRightTabs'])
  assert.equal(client.PANEL_TITLE, '启动器')
})

test('普通文本按行切分', () => {
  assert.equal(flat(parseAnsi('a\nb\nc', 10)), 'a\nb\nc')
})

test('SGR 颜色被还原成结构化片段', () => {
  const result = parseAnsi(`${ESC}[31mRED${ESC}[0m plain`, 10)
  assert.equal(flat(result), 'RED plain')
  assert.equal(result.lines[0][0].style.color, '#c04552', '默认（浅色主题）的红')
  assert.equal(result.lines[0][1].style.color, undefined)
})

test('加粗与下划线被记录', () => {
  const result = parseAnsi(`${ESC}[1;4mx${ESC}[22;24my`, 10)
  assert.equal(result.lines[0][0].style.bold, true)
  assert.equal(result.lines[0][0].style.underline, true)
  assert.equal(result.lines[0][1].style.bold, false)
  assert.equal(result.lines[0][1].style.underline, false)
})

test('\\r 是回车不是清行：后续字符从行首覆盖（真终端语义）', () => {
  assert.equal(flat(parseAnsi('tick\rtock', 10)), 'tock')
  assert.equal(flat(parseAnsi('progress 10%\rprogress 100%', 10)), 'progress 100%')
  // 覆盖不掉的长尾巴会留着——真实终端也是这样，所以进度条工具会配 K 一起用。
  assert.equal(flat(parseAnsi('abcdef\rab', 10)), 'abcdef')
})

test('\\r + K 组合：进度条只留最后一帧', () => {
  assert.equal(flat(parseAnsi(`downloading 10%\r${ESC}[Kdownloading 100%\n`, 10)), 'downloading 100%')
})

test('\\r\\n 被当作一次换行，不产生半行', () => {
  assert.equal(flat(parseAnsi('a\r\nb\r\n', 10)), 'a\nb')
})

test('K 从光标处擦除，不越权清掉已写内容', () => {
  assert.equal(flat(parseAnsi(`abc${ESC}[K`, 10)), 'abc')
  assert.equal(flat(parseAnsi(`abc${ESC}[2K`, 10)), '')
})

test('跨行光标寻址被忽略，不产生错行', () => {
  assert.equal(flat(parseAnsi(`a${ESC}[1Abc`, 10)), 'abc')
})

test('\\b 退格只挪光标，覆盖写入而不是删除', () => {
  // 真终端里退格不擦字符：'ab' 后退两格再用 c 覆盖行首 → 'cb'
  assert.equal(flat(parseAnsi('ab\b\bc', 10)), 'cb')
  // 配 K 才是「擦掉重写」的习惯用法
  assert.equal(flat(parseAnsi(`ab\b\b${ESC}[Kc`, 10)), 'c')
})

test('\\t 按 8 列制表位展开', () => {
  assert.equal(flat(parseAnsi('a\tb', 10)), `a${' '.repeat(7)}b`)
})

test('OSC 序列（BEL 结尾与 ST 结尾）被剥掉', () => {
  assert.equal(flat(parseAnsi(`${ESC}]0;标题\u0007body`, 10)), 'body')
  assert.equal(flat(parseAnsi(`${ESC}]8;;http://x${ESC}\\link`, 10)), 'link')
})

test('256 色与真彩色被还原', () => {
  assert.equal(parseAnsi(`${ESC}[38;5;196mX`, 10).lines[0][0].style.color, xterm256(196))
  assert.equal(parseAnsi(`${ESC}[38;2;10;20;30mX`, 10).lines[0][0].style.color, 'rgb(10, 20, 30)')
  assert.equal(parseAnsi(`${ESC}[48;5;21mX`, 10).lines[0][0].style.background, xterm256(21))
})

test('xterm256 覆盖前 16 色、色立方与灰阶', () => {
  assert.equal(xterm256(1), '#c04552')
  assert.equal(xterm256(16), 'rgb(0, 0, 0)')
  assert.equal(xterm256(231), 'rgb(255, 255, 255)')
  assert.equal(xterm256(232), 'rgb(8, 8, 8)')
  assert.equal(xterm256(999), '#5b6470', '非法码回落"白"槽，浅色主题下是深灰')
})

test('超长日志只保留最后 maxLines 行并标记 dropped', () => {
  const text = Array.from({ length: 50 }, (_, index) => `line ${String(index)}`).join('\n')
  const result = parseAnsi(text, 10)
  assert.equal(result.dropped, true)
  assert.equal(result.lines.length, 10)
  assert.equal(flat(result).split('\n')[0], 'line 40')
})

test('空文本也产出一行，面板不会塌', () => {
  const result = parseAnsi('', 10)
  assert.equal(result.lines.length, 1)
  assert.equal(flat(result), '')
})

test('相邻同一样式合并成一个片段，减少 DOM 节点', () => {
  const result = parseAnsi(`${ESC}[32maaa`, 10)
  assert.equal(result.lines[0].length, 1)
  assert.equal(result.lines[0][0].text, 'aaa')
})

test('styleToCss 把样式状态翻成 CSS', () => {
  assert.deepEqual(styleToCss({ color: '#fff', background: undefined, bold: true, dim: false, underline: true, inverse: false }), {
    color: '#fff',
    fontWeight: 700,
    textDecoration: 'underline',
  })
  const inverse = styleToCss({ color: '#fff', background: undefined, bold: false, dim: false, underline: false, inverse: true })
  // 反显：用前景色铺底、用主题**底色**当文字（原来写死近黑，深色主题下就是黑底黑字）
  assert.equal(inverse.color, 'var(--dsw-alias-bg-base)')
  assert.equal(inverse.backgroundColor, '#fff')
})




// #region 渲染冒烟：用最小 React 桩直接调组件
//
// 本机没有 react/react-dom/jsdom（DSH 的 React 只在运行时从平台模块表解析），
// 但「渲染函数里有没有 typo / undefined 引用」这件事不需要真 DOM：用最小桩跑
// 一遍组件函数即可。它挡不住布局问题，但能挡住会白屏的运行时错误。

/** 造一个最小 React：createElement 产出普通对象，hooks 返回初值。 */
function stubReact() {
  return {
    createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }),
    useState: initial => [typeof initial === 'function' ? initial() : initial, () => {}],
    useEffect: () => {},
    useMemo: fn => fn(),
    useRef: value => ({ current: value }),
    useCallback: fn => fn,
  }
}

/**
 * 把渲染树里的文字收集起来。
 *
 * 函数组件要真的调一次（`Field` 这类只负责套标签的组件，文字在它自己的
 * 渲染结果里，不在它的 children 里）。
 */
function collectText(node, out = []) {
  if (node === null || node === undefined || typeof node === 'boolean') return out
  if (typeof node === 'string' || typeof node === 'number') {
    out.push(String(node))
    return out
  }
  if (Array.isArray(node)) {
    for (const child of node) collectText(child, out)
    return out
  }
  if (typeof node !== 'object') return out
  if (typeof node.type === 'function') {
    collectText(node.type({ ...node.props, children: node.children }), out)
    return out
  }
  if ('children' in node) collectText(node.children, out)
  return out
}

/** 深度优先找第一个满足条件的元素节点。 */
function findNode(node, predicate) {
  if (node === null || node === undefined || typeof node !== 'object') return undefined
  if (Array.isArray(node)) {
    for (const child of node) {
      const found = findNode(child, predicate)
      if (found !== undefined) return found
    }
    return undefined
  }
  if (node.props !== undefined && predicate(node)) return node
  if ('children' in node) return findNode(node.children, predicate)
  return undefined
}

/** 收集所有满足条件的元素节点。 */
function findAll(node, predicate, out = []) {
  if (node === null || node === undefined || typeof node !== 'object') return out
  if (Array.isArray(node)) {
    for (const child of node) findAll(child, predicate, out)
    return out
  }
  if (node.props !== undefined && predicate(node)) out.push(node)
  if ('children' in node) findAll(node.children, predicate, out)
  return out
}

/** 用指定 React 桩重新加载 bundle，拿到绑定了该桩的导出。 */
async function loadWith(stub) {
  let captured = null
  globalThis.window = { __ModuleLoader__: { load: candidate => { captured = candidate } } }
  const url = new URL('../client.js', import.meta.url)
  url.searchParams.set('stub', String(Math.random()))
  await import(url.href)
  return captured.factory(() => stub)
}

/** 造一组 fake 动作，记录调用。 */
function fakeActions() {
  const calls = []
  const record = name => (...args) => { calls.push([name, ...args]) }
  return {
    calls,
    actions: {
      select: record('select'),
      toggle: record('toggle'),
      openMenu: record('openMenu'),
      closeMenu: record('closeMenu'),
      cancelEdit: record('cancelEdit'),
      newGroup: record('newGroup'),
      editGroup: record('editGroup'),
      saveGroup: record('saveGroup'),
      removeGroup: record('removeGroup'),
      moveGroup: record('moveGroup'),
      newItem: record('newItem'),
      editItem: record('editItem'),
      saveItem: record('saveItem'),
      removeItem: record('removeItem'),
      canColor: () => true,
      moveItem: record('moveItem'),
      setKind: record('setKind'),
      start: record('start'),
      stop: record('stop'),
      copy: record('copy'),
    },
  }
}

/** 一条条目。 */
const sampleItem = (over = {}) => ({
  id: 'i1', name: 'MQTT collector MqttCollector', command: 'mvn -Pdev -pl :mqtt-collector spring-boot:run',
  cwd: '', env: {}, kind: 'service', ...over,
})

/** 一个分组。 */
const sampleGroup = (over = {}) => ({ id: 'g1', name: 'demo-api', dir: '/home/dev/proj', items: [], ...over })

test('主面板在空清单下渲染不抛错，给出中文引导与清单路径提示', async () => {
  const bound = await loadWith(stubReact())
  const tree = bound.__internals.LauncherPanel({ pickDirectory: () => Promise.resolve(null) })
  const text = collectText(tree).join('|')
  for (const expected of ['启动器', '个分组', '个启动项', '＋ 新建分组', '刷新', '还没有分组', '常驻服务']) {
    assert.equal(text.includes(expected), true, `面板应该渲染出「${expected}」`)
  }
  for (const absent of ['Run', 'Reload', 'Groups', 'Clear log', 'Choose']) {
    assert.equal(text.includes(absent), false, `不该出现英文「${absent}」`)
  }
})

test('图标组件按 owner props 渲染出 svg', async () => {
  const bound = await loadWith(stubReact())
  const icon = bound.__internals.LauncherIcon({ size: 18, active: true })
  assert.equal(icon.type, 'svg')
  assert.equal(icon.props.width, 18)
})

test('日志正文把 ANSI 颜色渲染成带样式的 span', async () => {
  const bound = await loadWith(stubReact())
  const tree = bound.__internals.LogBody({ text: '\u001b[31mRED\u001b[0m ok', truncated: false })
  const spans = findAll(tree, node => node.type === 'span')
  assert.equal(spans.length, 2)
  assert.equal(spans[0].props.style.color, '#c04552')
  assert.equal(collectText(tree).join(''), 'RED ok')
})

test('日志为空时显示等待提示；被截断时插入折叠提示行', async () => {
  const bound = await loadWith(stubReact())
  assert.equal(collectText(bound.__internals.LogBody({ text: '', truncated: false })).join(''), '等待输出…')
  assert.match(collectText(bound.__internals.LogBody({ text: 'x', truncated: true })).join('|'), /更早的日志已折叠/)
})

test('条目行只显示名称 + 运行图标 + ⋯；命令与性质都不在行里', async () => {
  const bound = await loadWith(stubReact())
  const { actions } = fakeActions()
  const tree = bound.__internals.renderItem({
    group: sampleGroup(), item: sampleItem(), index: 0, run: undefined, busy: '',
    selected: false, menuOpen: false, editing: null, home: '/home/dev', actions,
  })
  const text = collectText(tree).join('|')
  assert.equal(text.includes('MQTT collector MqttCollector'), true, '名称要在')
  // 用户明确要求列表里"就名称就行"：命令行不再重复出现在行里
  assert.equal(text.includes('mvn -Pdev -pl :mqtt-collector spring-boot:run'), false, '命令行不该出现在行里')
  assert.equal(text.includes('⋯'), true)
  for (const hidden of ['编辑', '复制命令', '删除', '上移', '下移', '运行', '停止']) {
    assert.equal(text.includes(hidden), false, `「${hidden}」不该作为文字常显（运行/停止改用图标 + aria-label）`)
  }

  // 运行按钮是个图标按钮：有 aria-label 与 svg，且不再是一颗文字按钮
  const runButton = findNode(tree, node => node.type === 'button' && node.props?.['aria-label'] === '运行')
  assert.ok(runButton !== undefined, '要有 aria-label=运行的图标按钮')
  // 图标是组件元素：findNode 不会替你调用函数组件，所以按组件类型找
  assert.ok(findNode(runButton, node => node.type === bound.__internals.RunIcon) !== undefined, '是图标不是文字')
})


test('⋯ 菜单列出全部次要操作，点击先关菜单再执行', async () => {
  const bound = await loadWith(stubReact())
  const calls = []
  const menu = bound.__internals.MoreMenu({
    entries: [
      { label: '编辑', onClick: () => calls.push('edit') },
      { label: '复制命令', onClick: () => calls.push('copy') },
      { label: '删除', danger: true, separator: true, onClick: () => calls.push('remove') },
    ],
    onClose: () => calls.push('close'),
  })
  const text = collectText(menu).join('|')
  for (const label of ['编辑', '复制命令', '删除']) assert.equal(text.includes(label), true)
  // 删除项走 danger 配色，且前面有一条分隔线
  const danger = findAll(menu, node => node.type === 'button' && node.props.style !== undefined && typeof node.props.style.color === 'string' && node.props.style.color.includes('error'))
  assert.equal(danger.length, 1)
  findAll(menu, node => node.type === 'button')[2].props.onClick()
  assert.deepEqual(calls, ['close', 'remove'])
})

test('一次性任务的性质与目录搬到了右栏详情，不是丢了', async () => {
  const bound = await loadWith(stubReact())
  const { actions } = fakeActions()
  const group = sampleGroup({ id: 'g1', dir: '/home/dev/proj', items: [
    sampleItem({ id: 'i1', name: '0 构建全部', command: 'mvn -Pdev install', cwd: '/home/dev/proj/backend', kind: 'task' }),
  ] })

  // 行里：只剩名称
  const row = bound.__internals.renderItem({
    group, item: group.items[0], index: 0, run: undefined, busy: '', selected: false,
    menuOpen: false, editing: null, home: '/home/dev', actions,
  })
  const rowText = collectText(row).join('|')
  assert.equal(rowText.includes('任务'), false, '列表里不再挂性质标记')
  assert.equal(rowText.includes('backend'), false, '列表里不再挂目录')

  // 详情里：性质 + 命令 + 目录都在（信息只是换了地方）
  const bound2 = await loadWith(stubReactWith([
    [group], null, '', [], null,
    { groupId: 'g1', itemId: 'i1' },                                  // selection
    { runId: null, text: '', truncated: false }, '', {}, null, null,  // log, filter, collapsed, editing, menu
    '', '', '', null, null, true, 11.5,                               // error, notice, busy, drag, dropAt, follow, fontSize
  ]))
  const panel = collectText(bound2.__internals.LauncherPanel({ pickDirectory: () => Promise.resolve(null) })).join('|')
  assert.equal(panel.includes('一次性任务'), true, '详情要标出这是一次性任务')
  assert.equal(panel.includes('mvn -Pdev install'), true, '详情要有命令')
  assert.equal(panel.includes('backend'), true, '详情要有目录')
})


test('条目行运行中：状态点变实心、按钮换成停止图标；选中行有底色', async () => {
  const bound = await loadWith(stubReact())
  const { actions } = fakeActions()
  const tree = bound.__internals.renderItem({
    group: sampleGroup(), item: sampleItem(), index: 1,
    run: { id: 'run-1', itemId: 'i1', status: 'running', startedAt: 1 }, busy: '',
    selected: true, menuOpen: false, editing: null, home: '/home/dev', actions,
  })
  const text = collectText(tree).join('|')
  assert.equal(text.includes('运行中'), false, '状态不再用文字表达')

  const stopButton = findNode(tree, node => node.type === 'button' && node.props?.['aria-label'] === '停止')
  assert.ok(stopButton !== undefined, '在跑的时候按钮要变成停止')
  assert.ok(findNode(stopButton, node => node.type === bound.__internals.StopIcon) !== undefined)

  // 状态点：绿点 + tooltip
  const dot = findNode(tree, node => node.props?.style?.borderRadius === '50%')
  assert.ok(dot !== undefined, '状态点要是圆点')
  assert.equal(dot.props.title, '运行中')
  assert.equal(dot.props.style.background, 'var(--dsw-alias-state-success-primary)')

  const row = findNode(tree, node => node.props !== undefined && node.props.className === 'dsl-row')
  assert.ok(row !== undefined)
  assert.match(String(row.props.style.boxShadow), /inset 2px/)
  assert.equal(typeof row.props.style.background, 'string')
})


test('条目行：编辑态改成渲染表单而不是行', async () => {
  const bound = await loadWith(stubReact())
  const { actions } = fakeActions()
  const tree = bound.__internals.renderItem({
    group: sampleGroup(), item: sampleItem(), index: 0, run: undefined, busy: '',
    selected: false, menuOpen: false, editing: { kind: 'item-edit', groupId: 'g1', itemId: 'i1' },
    home: '/home/dev', actions,
  })
  const text = collectText(tree).join('|')
  assert.equal(text.includes('命令行'), true)
  assert.equal(text.includes('性质'), true)
  assert.equal(text.includes('保存'), true)
})

test('分组是章节头：可点色块 + 名称 + 条数 + ＋条目 + ⋯，收起后不渲染条目', async () => {
  const bound = await loadWith(stubReact())
  const { actions } = fakeActions()
  const item = sampleItem()
  const group = sampleGroup({ items: [item] })
  const open = bound.__internals.renderGroup({
    group, items: [item], collapsed: false, runningCount: 1, busy: '',
    selected: null, editing: null, menuOpen: null, home: '/home/dev', actions,
    pickDirectory: () => Promise.resolve(null), latestRunOf: () => undefined,
  })
  const openText = collectText(open).join('|')
  for (const expected of ['demo-api', '1 条', '1 运行中', '＋ 条目', '⋯', 'MQTT collector MqttCollector']) {
    assert.equal(openText.includes(expected), true, `分组应该渲染出「${expected}」`)
  }
  // 章节头粘顶；颜色改成一个可点的圆角色块（不再是贴边的竖线）
  const head = findNode(open, node => node.props?.style?.position === 'sticky')
  assert.ok(head !== undefined, '分组标题行应粘顶')
  assert.equal(String(head.props.style.boxShadow ?? '').includes('inset 3px'), false, '不该再有贴边竖线')
  const swatch = findNode(open, node => node.type === 'button' && node.props?.['aria-label'] === '修改分组颜色')
  assert.ok(swatch !== undefined, '分组名旁要有一个可点的色块')
  assert.equal(typeof swatch.props.style.borderRadius, 'number')
  assert.match(String(swatch.props.style.background), /^#[0-9a-f]{6}$/i, '色块要显示实际颜色')

  const folded = bound.__internals.renderGroup({
    group, items: [item], collapsed: true, runningCount: 0, busy: '',
    selected: null, editing: null, menuOpen: null, home: '/home/dev', actions,
    pickDirectory: () => Promise.resolve(null), latestRunOf: () => undefined,
  })
  const foldedText = collectText(folded).join('|')
  assert.equal(foldedText.includes('mvn -Pdev -pl :mqtt-collector spring-boot:run'), false)
  assert.equal(foldedText.includes('demo-api'), true)
})

test('折叠热区是整块标题区（含标题与目录），不是一个小三角', async () => {
  const bound = await loadWith(stubReact())
  const { actions, calls } = fakeActions()
  const group = sampleGroup()
  const tree = bound.__internals.renderGroup({
    group, items: [], collapsed: false, runningCount: 0, busy: '',
    selected: null, editing: null, menuOpen: null, home: '/home/dev', actions,
    pickDirectory: () => Promise.resolve(null), latestRunOf: () => undefined,
  })
  const toggle = findNode(tree, node => node.props !== undefined && node.props.className === 'dsl-hoverable' && typeof node.props.onClick === 'function')
  assert.ok(toggle !== undefined, '应有一个整块可点的折叠热区')
  assert.equal(toggle.props.title, '点击收起')
  assert.match(collectText(toggle).join('|'), /demo-api/)
  assert.match(collectText(toggle).join('|'), /~\/proj/)
  toggle.props.onClick()
  assert.deepEqual(calls, [['toggle', 'g1']])
})

test('空分组与被筛掉的分组都有说法', async () => {
  const bound = await loadWith(stubReact())
  const { actions } = fakeActions()
  const empty = bound.__internals.renderGroup({
    group: sampleGroup({ items: [] }), items: [], collapsed: false, runningCount: 0, busy: '',
    selected: null, editing: null, menuOpen: null, home: '/home/dev', actions,
    pickDirectory: () => Promise.resolve(null), latestRunOf: () => undefined,
  })
  assert.match(collectText(empty).join('|'), /这个分组还没有启动项/)

  const filtered = bound.__internals.renderGroup({
    group: sampleGroup({ items: [sampleItem()] }), items: [], collapsed: false, runningCount: 0, busy: '',
    selected: null, editing: null, menuOpen: null, home: '/home/dev', actions,
    pickDirectory: () => Promise.resolve(null), latestRunOf: () => undefined,
  })
  assert.match(collectText(filtered).join('|'), /没有匹配的启动项/)
})

test('没设目录的分组明说会用 home', async () => {
  const bound = await loadWith(stubReact())
  const { actions } = fakeActions()
  const tree = bound.__internals.renderGroup({
    group: sampleGroup({ dir: '', items: [] }), items: [], collapsed: false, runningCount: 0, busy: '',
    selected: null, editing: null, menuOpen: null, home: '/home/dev', actions,
    pickDirectory: () => Promise.resolve(null), latestRunOf: () => undefined,
  })
  assert.match(collectText(tree).join('|'), /默认工作目录未设置/)
})

test('表单：分组表单与条目表单各自的字段（含性质切换）', async () => {
  const bound = await loadWith(stubReact())
  const groupForm = bound.__internals.GroupForm({
    initial: { name: 'demo-api', dir: '/home/dev/proj' },
    onSave: () => {}, onCancel: () => {}, busy: false, pickDirectory: () => Promise.resolve(null),
  })
  const groupText = collectText(groupForm).join('|')
  for (const expected of ['分组名称', '默认工作目录', '选择…', '保存', '取消']) {
    assert.equal(groupText.includes(expected), true, `分组表单应该渲染出「${expected}」`)
  }

  const itemForm = bound.__internals.ItemForm({
    initial: { name: 'MQTT', command: 'mvn spring-boot:run', cwd: '', env: { A: '1' }, kind: 'task' },
    groupDir: '/home/dev/proj', onSave: () => {}, onCancel: () => {}, busy: false,
  })
  const itemText = collectText(itemForm).join('|')
  for (const expected of ['名称', '性质', '常驻服务', '一次性任务', '命令行', '工作目录', '环境变量', '保存']) {
    assert.equal(itemText.includes(expected), true, `条目表单应该渲染出「${expected}」`)
  }
  // kind=task 时提示文案换成「跑完就该结束」
  assert.match(itemText, /跑完就该结束/)
})

test('状态语义：常驻服务退出要提醒，一次性任务跑完算完成', async () => {
  const bound = await loadWith(stubReact())
  const { runState } = bound.__internals
  // 常驻服务
  assert.deepEqual(runState(null, 'service'), { text: '未启动', tone: 'muted' })
  assert.deepEqual(runState({ status: 'running' }, 'service'), { text: '运行中', tone: 'ok' })
  assert.deepEqual(runState({ status: 'exited', exitCode: 0 }, 'service'), { text: '已退出（本该常驻）', tone: 'warn' })
  assert.deepEqual(runState({ status: 'exited', exitCode: 1 }, 'service'), { text: '异常退出（退出码 1）', tone: 'error' })
  assert.deepEqual(runState({ status: 'stopped', exitCode: 130 }, 'service'), { text: '已停止', tone: 'muted' })
  assert.deepEqual(runState({ status: 'failed' }, 'service'), { text: '启动失败', tone: 'error' })
  // 一次性任务：跑完就是完成
  assert.deepEqual(runState(null, 'task'), { text: '未运行', tone: 'muted' })
  assert.deepEqual(runState({ status: 'exited', exitCode: 0 }, 'task'), { text: '已完成', tone: 'ok' })
  assert.deepEqual(runState({ status: 'exited', exitCode: 2 }, 'task'), { text: '失败（退出码 2）', tone: 'error' })
})

test('运行事实一行里带 pid / 首字节 / 起止时间', async () => {
  const bound = await loadWith(stubReact())
  const facts = bound.__internals.runFacts({ pid: 4242, firstOutputMs: 1850, startedAt: Date.now(), endedAt: null, signal: null })
  assert.match(facts, /pid 4242/)
  assert.match(facts, /首字节 1\.85s/)
  assert.match(facts, /起于 /)
})

test('env 文本与对象的互转', async () => {
  const bound = await loadWith(stubReact())
  const { envToText: toText, textToEnv: toEnv } = bound.__internals
  assert.equal(toText({ A: '1', B: 'x y' }), 'A=1\nB=x y')
  assert.deepEqual(toEnv('A=1\n# 注释\nBAD LINE\nB=x y\n'), { A: '1', B: 'x y' })
  assert.deepEqual(toEnv('A=1\n1BAD=x'), { A: '1' }, '非法键被丢弃')
})

test('路径缩写 helper', async () => {
  const bound = await loadWith(stubReact())
  const { shortenHome: short, relativeDir: rel, homeFromStoreFile: home } = bound.__internals
  assert.equal(short('/home/dev/proj/a', '/home/dev'), '~/proj/a')
  assert.equal(short('/home/dev', '/home/dev'), '~')
  assert.equal(short('/opt/x', '/home/dev'), '/opt/x')
  assert.equal(short('/opt/x', ''), '/opt/x', '推不出 home 时不硬缩')
  assert.equal(rel('/a/b/c', '/a/b'), 'c')
  assert.equal(rel('/a/b', '/a/b'), '.')
  assert.equal(rel('/a/x', '/a/b'), undefined)
  assert.equal(home('/home/dev/.dsh/launcher/items.json'), '/home/dev')
  assert.equal(home('/tmp/elsewhere.json'), '')
})

test('分组配色稳定：同一个分组永远同一个颜色', async () => {
  const bound = await loadWith(stubReact())
  const { groupColor } = bound.__internals
  assert.equal(groupColor('g-abc'), groupColor('g-abc'))
  assert.notEqual(groupColor('g-abc'), groupColor('g-other-xyz'))
  assert.match(groupColor('whatever'), /^#[0-9a-f]{6}$/)
})

test('宿主版本错配时给出可执行的一句话', async () => {
  const bound = await loadWith(stubReact())
  const { stateProblem: problem } = bound.__internals
  assert.equal(problem({ groups: [], runs: [] }), '')
  assert.match(problem({ projects: [], runs: [] }), /重启 DSH/)
  assert.match(problem(null), /没有返回可用的状态/)
})
// #endregion

test('缺能力时提示重启，读到之前不提示', async () => {
  const bound = await loadWith(stubReact())
  const { capabilityNotice: notice, supportsGroupColor: canColor } = bound.__internals
  assert.equal(notice(null), '', '还没读到能力清单时不该报警')
  assert.equal(notice(['item-kind', 'group-color']), '')
  assert.equal(notice(['item-kind']), '宿主半侧是旧版：分组颜色要重启 DSH 之后才会保存')
  assert.match(notice(['group-color']), /性质/)
  assert.match(notice([]), /重启 DSH/)

  // 能力判断：null（还没读到）当作支持，避免闪一下禁用态
  assert.equal(canColor(null), true)
  assert.equal(canColor(['item-kind', 'group-color']), true)
  assert.equal(canColor(['item-kind']), false)
})

test('旧宿主缺 group-color 时色块禁用并说明原因（不让它静默无反应）', async () => {
  const bound = await loadWith(stubReact())
  const { actions } = fakeActions()
  // 模拟旧宿主：canColor() 返回 false
  const legacy = { ...actions, canColor: () => false }
  const group = sampleGroup({ items: [] })
  const tree = bound.__internals.renderGroup({
    group, items: [], collapsed: false, runningCount: 0, busy: '', selected: null, editing: null,
    groupMenuOpen: false, itemMenu: null, drag: null, dropHint: null, dropTarget: false,
    dnd: undefined, home: '/home/dev', actions: legacy, latestRunOf: () => undefined,
  })
  const swatch = findNode(tree, node => node.type === 'button' && node.props?.['aria-label'] === '修改分组颜色')
  assert.equal(swatch.props.disabled, true, '旧宿主下色块要禁用')
  assert.match(swatch.props.title, /重启 DSH/, '并说明为什么')

  // 点了给一句提示，而不是什么都不发生
  const warned = []
  const warnTree = bound.__internals.renderGroup({
    group, items: [], collapsed: false, runningCount: 0, busy: '', selected: null, editing: null,
    groupMenuOpen: false, itemMenu: null, drag: null, dropHint: null, dropTarget: false,
    dnd: undefined, home: '/home/dev',
    actions: { ...legacy, warnColorUnsupported: () => warned.push(true) },
    latestRunOf: () => undefined,
  })
  findNode(warnTree, node => node.type === 'button' && node.props?.['aria-label'] === '修改分组颜色')
    .props.onClick({ stopPropagation: () => {}, currentTarget: { getBoundingClientRect: () => ({}) } })
  assert.equal(warned.length, 1)
})

test('视图记忆：切面板/刷新后能回到原来那一条', async () => {
  const store = { 'dsh.launcher.view.v1': JSON.stringify({ selection: { groupId: 'g1', itemId: 'i2' }, collapsed: { g9: true }, filter: 'admin', follow: false }) }
  globalThis.window = {
    __ModuleLoader__: { load: () => {} },
    localStorage: {
      getItem: key => store[key] ?? null,
      setItem: (key, value) => { store[key] = value },
    },
  }
  // 每次 loadWith 都会换掉 window，所以这里自己重载一次拿干净的模块缓存
  let captured = null
  globalThis.window = { __ModuleLoader__: { load: d => { captured = d } }, localStorage: { getItem: k => store[k] ?? null, setItem: (k, v) => { store[k] = v } } }
  const url = new URL('../client.js', import.meta.url)
  url.searchParams.set('memory', String(Math.random()))
  await import(url.href)
  const bound = captured.factory(() => stubReact())

  const view = bound.__internals.loadView()
  assert.deepEqual(view.selection, { groupId: 'g1', itemId: 'i2' })
  assert.deepEqual(view.collapsed, { g9: true })
  assert.equal(view.filter, 'admin')
  assert.equal(view.follow, false)

  // 面板渲染时直接用记忆里的视图（filter 生效 → 分区里没有匹配项）
  const tree = bound.__internals.LauncherPanel({ pickDirectory: () => Promise.resolve(null) })
  assert.equal(collectText(tree).join('|').includes('还没有分组'), true, '空清单时仍然是空态')

  // 写回：模块级缓存 + localStorage 都更新
  bound.__internals.saveView({ selection: null, collapsed: {}, filter: '', follow: true })
  assert.equal(JSON.parse(store['dsh.launcher.view.v1']).follow, true)
  assert.deepEqual(bound.__internals.loadView().selection, null)
})

test('没有记忆时给出中性默认值，且坏 JSON 不炸', async () => {
  const store = { 'dsh.launcher.view.v1': '{ 这不是 JSON' }
  let captured = null
  globalThis.window = { __ModuleLoader__: { load: d => { captured = d } }, localStorage: { getItem: k => store[k] ?? null, setItem: (k, v) => { store[k] = v } } }
  const url = new URL('../client.js', import.meta.url)
  url.searchParams.set('broken', String(Math.random()))
  await import(url.href)
  const bound = captured.factory(() => stubReact())
  const view = bound.__internals.loadView()
  assert.equal(view.selection, null)
  assert.deepEqual(view.collapsed, {})
  assert.equal(view.filter, '')
  assert.equal(view.follow, true)
})

test('引用格式：全角括号包起来的纯文本标记（带 run id 与条目名）', async () => {
  const bound = await loadWith(stubReact())
  const { formatReference: format, appendReference: append } = bound.__internals
  const run = { id: 'run-4', name: 'Admin Service' }
  assert.equal(format(run, { from: 12, to: 45 }), '【启动器日志 run-4 · Admin Service 第 12~45 行】')
  assert.equal(format(run, { from: 7, to: 7 }), '【启动器日志 run-4 · Admin Service 第 7~7 行】')
  assert.equal(format(run, null), '【启动器日志 run-4 · Admin Service 关键行】')
  assert.equal(format({ id: 'run-9' }, null), '【启动器日志 run-9 关键行】')
  // 首尾必须是全角括号：这是「这是我引的一段」的视觉边界
  assert.ok(format(run, { from: 1, to: 2 }).startsWith('【'))
  assert.ok(format(run, { from: 1, to: 2 }).endsWith('】'))

  // 追加到草稿：空草稿直接给引用，否则换行接在后面
  assert.equal(append('', '【引用】'), '【引用】')
  assert.equal(append('   ', '【引用】'), '【引用】')
  assert.equal(append('为什么炸了？', '【引用】'), '为什么炸了？\n【引用】')
  assert.equal(append('为什么炸了？  \n', '【引用】'), '为什么炸了？\n【引用】')
})

test('从选区读出「第几行到第几行」', async () => {
  const bound = await loadWith(stubReact())
  const { lineRangeFromSelection: rangeOf } = bound.__internals
  const line = n => ({ dataset: { line: String(n) }, parentElement: null })
  // 选区两端各自向上找 data-line
  assert.deepEqual(rangeOf({ anchorNode: line(12), focusNode: line(45) }), { from: 12, to: 45 })
  assert.deepEqual(rangeOf({ anchorNode: line(45), focusNode: line(12) }), { from: 12, to: 45 }, '反着选也要正过来')
  // 节点在行内（span 里）：顺着 parentElement 往上找
  const span = { parentElement: line(30) }
  assert.deepEqual(rangeOf({ anchorNode: span, focusNode: span }), { from: 30, to: 30 })
  // 选不到行 / 没有选区
  assert.equal(rangeOf({ anchorNode: { parentElement: null }, focusNode: line(3) }), null)
  assert.equal(rangeOf(null), null)
})

test('零实例时：只给一句空态，不出现「跟随最新」这种无意义的开关', async () => {
  const bound = await loadWith(stubReact())
  const drafts = []
  const tree = bound.__internals.LogTab({
    useInput: () => ({ draft: '为什么炸了？' }),
    inputActions: { setDraft: value => drafts.push(value) },
  })
  const text = collectText(tree).join('|')
  for (const expected of ['运行日志', '还没有运行实例', '字号', 'A-', 'A+', '11.5px']) {
    assert.equal(text.includes(expected), true, `日志 tab 应该渲染出「${expected}」`)
  }
  // 没有可跟的东西时，「跟随最新」既没作用也让人费解
  assert.equal(text.includes('跟随最新'), false, '没有实例时不该出现「跟随最新」')
  assert.equal(text.includes('已钉住'), false)
  // 引用按钮不常显：滑选后才浮出来
  for (const absent of ['引用选中行', '引用关键行', '添加到对话', '停止', '移除']) {
    assert.equal(text.includes(absent), false, `零实例时不该出现「${absent}」`)
  }
  assert.equal(collectText(bound.__internals.LogTabTitle()).join(''), '运行日志')
})

test('字号夹取在合理区间', async () => {
  const bound = await loadWith(stubReact())
  const { clampLogFont: clamp } = bound.__internals
  assert.equal(clamp(undefined), 11.5, '认不出给默认值')
  assert.equal(clamp(13), 13)
  assert.equal(clamp(2), 9, '下界')
  assert.equal(clamp(99), 20, '上界')
  assert.equal(clamp('12'), 12, '字符串数字也认')
})

test('日志正文带行号时，行号按总行数倒推（引用才对得上）', async () => {
  const bound = await loadWith(stubReact())
  const text = Array.from({ length: 30 }, (_, i) => `line ${String(i + 1)}`).join('\n')
  const tree = bound.__internals.LogBody({ text, truncated: false, lineNumbers: true })
  const lines = findAll(tree, node => typeof node.props?.['data-line'] === 'string')
  assert.equal(lines.length, 30)
  assert.equal(lines[0].props['data-line'], '1')
  assert.equal(lines[29].props['data-line'], '30')
  assert.match(collectText(lines[11]).join(''), /^12/)
})

test('apply 装配：侧栏入口 + 主面板 + 右栏「运行日志」tab 都注册出去', async () => {
  const bound = await loadWith(stubReact())
  const calls = { slots: [], tabs: [], injected: [] }
  const clientServices = { layout: {}, uiWorkspace: { pickDirectory: () => Promise.resolve(null) }, sidebarRight: { openTab: (kind) => { calls.opened = kind; return true } } }
  const ctx = {
    get: name => clientServices[name],
    inject: (names, callback) => callback(ctx),
    effect: (callback) => {
      const dispose = callback()
      return typeof dispose === 'function' ? dispose : () => {}
    },
    sidebarRightTabs: { register: definition => { calls.tabs.push(definition); return () => {} } },
    slots: {
      inject: (slot, callback) => {
        const dispose = callback()
        calls.slots.push(slot)
        return typeof dispose === 'function' ? dispose : () => {}
      },
      register: (definition, component) => {
        calls.injected.push({ definition, component })
        return () => {}
      },
    },
  }
  bound.apply(ctx)

  // 侧栏入口 + main 面板
  const sidebar = calls.injected.find(entry => entry.definition.name === 'sidebar.panellist')
  assert.equal(sidebar.definition.id, 'launcher')
  assert.equal(sidebar.definition.label, '启动器')
  const main = calls.injected.find(entry => entry.definition.name === 'main')
  assert.equal(main.definition.key, 'launcher')
  assert.equal(typeof main.component, 'function')

  // 右栏 tab 类型与 body
  assert.equal(calls.tabs.length, 1)
  assert.equal(calls.tabs[0].kind, 'launcher-log')
  assert.equal(calls.tabs[0].multiple, true)
  assert.equal(calls.tabs[0].title(), '运行日志')
  assert.equal(calls.tabs[0].guide[0].title(), '运行日志')
  // 类型清单里的图标必须自己给：不给的话侧栏会拿默认兜底（一个方盒，跟日志无关）
  assert.equal(typeof calls.tabs[0].guide[0].icon, 'function')
  const body = calls.injected.find(entry => entry.definition.name === 'sidebar.right.pane.tab')
  assert.equal(body.definition.key, 'dsh-project-runner/log')
  assert.equal(body.component, bound.__internals.LogTab)
  const title = calls.injected.find(entry => entry.definition.name === 'sidebar.right.pane.tab.title')
  assert.equal(title.definition.key, 'dsh-project-runner/log')
})

test('滑选后浮层落在选区旁边，且不会被顶出容器', async () => {
  const bound = await loadWith(stubReact())
  const { popoverForSelection: popover } = bound.__internals
  const lineNode = n => ({ dataset: { line: String(n) }, parentElement: null })
  const selectionAt = (from, to, rect) => ({
    anchorNode: lineNode(from),
    focusNode: lineNode(to),
    rangeCount: 1,
    getRangeAt: () => ({ getBoundingClientRect: () => rect }),
  })
  const host = { left: 100, top: 200, width: 400 }

  // 选区在容器中间：浮层落在选区上方居中
  const centered = popover(selectionAt(12, 45, { left: 300, top: 400, width: 80, height: 16 }), host)
  assert.deepEqual({ from: centered.from, to: centered.to }, { from: 12, to: 45 })
  assert.equal(Math.round(centered.left), 176, 'rect.left-host.left+rect.width/2-64 = 300-100+40-64')
  assert.equal(centered.top, 164, 'rect.top-host.top-36 = 400-200-36')

  // 选区贴在右上角：夹进容器内，不越界
  const clamped = popover(selectionAt(1, 2, { left: 100000, top: 0, width: 40, height: 16 }), host)
  assert.equal(clamped.left, 400 - 128 - 8, 'left 应被夹到容器内')
  assert.ok(clamped.top >= 8, 'top 不应为负')

  // 拿不到几何（例如 range 报错）：退回右上角
  const broken = popover({
    anchorNode: lineNode(3),
    focusNode: lineNode(3),
    rangeCount: 1,
    getRangeAt: () => { throw new Error('no rect') },
  }, host)
  assert.equal(broken.left, 400 - 128 - 8, '兜底位置与夹取上界一致')
  assert.equal(broken.top, 8)

  // 没选到行 → 不显示浮层
  assert.equal(popover({ anchorNode: { dataset: {}, parentElement: null }, focusNode: lineNode(3), rangeCount: 0, getRangeAt: () => null }, host), null)
})

test('取消选择后浮层必须收起（这是真发生过的 bug）', async () => {
  const bound = await loadWith(stubReact())
  const { nextPopover: next, popoverForSelection: popover } = bound.__internals
  const lineNode = n => ({ dataset: { line: String(n) }, parentElement: null })
  const host = { left: 0, top: 0, width: 400 }
  const shown = popover({ anchorNode: lineNode(3), focusNode: lineNode(5), rangeCount: 0, getRangeAt: () => null }, host)
  assert.ok(shown !== null)

  // 取消选择（选区塌掉/点到别处）：应收起
  assert.equal(next(shown, { anchorNode: { dataset: {}, parentElement: null }, focusNode: null, rangeCount: 0, getRangeAt: () => null }, host), null)
  assert.equal(next(shown, null, host), null)

  // 选区仍然有效且浮层已显示：跟到新位置
  const moved = next(shown, { anchorNode: lineNode(30), focusNode: lineNode(32), rangeCount: 0, getRangeAt: () => null }, host)
  assert.deepEqual({ from: moved.from, to: moved.to }, { from: 30, to: 32 })

  // 浮层本来没显示：划词时不抢先浮出来（避免拖动过程抖动）
  assert.equal(next(null, { anchorNode: lineNode(30), focusNode: lineNode(32), rangeCount: 0, getRangeAt: () => null }, host), null)
})

/** 造一个能按顺序注入 useState 初值的 React 桩（用于渲染有数据的组件）。 */
function stubReactWith(states) {
  let index = 0
  return {
    createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }),
    useState: (initial) => {
      const preset = states[index]
      index += 1
      return [preset !== undefined ? preset : (typeof initial === 'function' ? initial() : initial), () => {}]
    },
    useEffect: () => {},
    useMemo: fn => fn(),
    useRef: value => ({ current: value }),
    useCallback: fn => fn,
  }
}

test('日志 tab 头部：分段控件浮起当前项，同名运行补 id 后缀', async () => {
  const runs = [
    { id: 'run-3', name: '前端 Web（frontend）', kind: 'service', status: 'running', startedAt: 300, groupTitle: 'demo-api', command: 'npm run dev', cwd: '/tmp/web' },
    { id: 'run-2', name: 'admin-service前端 Web', kind: 'service', status: 'running', startedAt: 200, groupTitle: 'demo-api', command: 'npm run dev', cwd: '/tmp/web' },
    { id: 'run-1', name: '前端 Web（frontend）', kind: 'service', status: 'stopped', startedAt: 100, groupTitle: 'demo-api', command: 'npm run dev', cwd: '/tmp/web', logFile: '/logs/run-1.log' },
  ]
  const bound = await loadWith(stubReactWith([
    runs,                                          // runs
    null,                                          // pinnedId
    true,                                          // followNewest
    { runId: null, text: '', truncated: false },   // log
    11.5,                                          // fontSize
    null,                                          // popover
    '',                                            // notice
  ]))
  const tree = bound.__internals.LogTab({ useInput: () => ({ draft: '' }), inputActions: { setDraft: () => {} } })
  const text = collectText(tree).join('|')

  // 当前项（run-3）：标签只放名称（右侧另有 id 标识，不重复）；非当前的同名项才带 id 后缀
  assert.equal(text.includes('前端 Web（frontend）'), true)
  assert.equal(text.includes('run-3'), true)
  assert.equal(text.includes('run-3run-3'), false, '当前项不该重复 id')
  assert.equal(text.includes('运行中'), true)
  assert.equal(text.includes('admin-service前端 Web'), true)
  assert.equal(text.includes('跟随最新 ✓'), true)

  // 分段控件：一条轨道 + 当前项浮起（白底 + 阴影），其余透明
  const track = findNode(tree, node => node.props !== undefined && node.props.style?.overflowX === 'auto')
  assert.ok(track !== undefined, '应有一条可横向滚动的分段轨道')
  const segments = findAll(track, node => node.type === 'button')
  assert.equal(segments.length, 3)
  const active = segments.find(node => node.props.style.boxShadow !== undefined)
  assert.ok(active !== undefined, '当前项应有浮起效果')
  assert.equal(segments.filter(node => node.props.style.boxShadow !== undefined).length, 1, '只能有一个浮起')

  // 每个分段都带状态点
  for (const segment of segments) {
    assert.ok(findAll(segment, node => node.props?.style?.borderRadius === '50%').length >= 1, '每个分段都要有状态点')
  }
})

test('右栏日志 tab 能直接停服务：在跑的给停止/强制结束，结束的给清空/移除', async () => {
  const bound = await loadWith(stubReact())
  const live = { id: 'run-7', name: 'MQTT collector', kind: 'service', status: 'running', startedAt: 700, groupTitle: 'demo-api', command: 'mvn spring-boot:run', cwd: '/tmp' }
  const settled = { id: 'run-6', name: '构建全部', kind: 'task', status: 'exited', exitCode: 0, startedAt: 600, groupTitle: 'demo-api', command: 'mvn install', cwd: '/tmp' }

  // 状态注入顺序：runs, pinnedId, followNewest, log, fontSize, popover, notice, busy
  const renderWithRun = async (run) => {
    const bound2 = await loadWith(stubReactWith([
      [run], null, true, { runId: null, text: '', truncated: false }, 11.5, null, '', '',
    ]))
    return collectText(bound2.__internals.LogTab({ useInput: () => ({ draft: '' }), inputActions: { setDraft: () => {} } })).join('|')
  }

  const liveText = await renderWithRun(live)
  assert.equal(liveText.includes('停止'), true, '在跑的实例必须能在右栏停掉')
  assert.equal(liveText.includes('强制结束'), true)
  assert.equal(liveText.includes('清空日志'), true, '在跑的时候也要能清屏（服务继续跑）')
  assert.equal(liveText.includes('移除'), false, '还在跑的时候不该能移除')

  const settledText = await renderWithRun(settled)
  assert.equal(settledText.includes('停止'), false, '已结束的不该有停止按钮')
  assert.equal(settledText.includes('清空日志'), true)
  assert.equal(settledText.includes('移除'), true)
  assert.equal(settledText.includes('已完成'), true, '一次性任务跑完说「已完成」')
  void bound
})

test('清空日志：丢掉宿主缓冲之后，还必须丢掉本地缓冲（否则界面像没反应）', async () => {
  const settled = { id: 'run-6', name: '构建全部', kind: 'task', status: 'exited', exitCode: 0, startedAt: 600, groupTitle: 'demo-api', command: 'mvn install', cwd: '/tmp', logFile: '/logs/run-6.log' }

  // 收集 useRef 创建的 ref，好在点击之后检查它们被重置了
  const refs = []
  let captured = null
  globalThis.window = { __ModuleLoader__: { load: d => { captured = d } }, getSelection: () => null }
  globalThis.document = undefined
  const posts = []
  globalThis.fetch = async (url, options) => {
    posts.push({ url, body: options === undefined ? undefined : JSON.parse(options.body) })
    return { ok: true, status: 200, statusText: 'OK', json: async () => ({ ok: true, runs: [settled] }) }
  }
  const preset = [
    [settled],                                     // runs
    null,                                          // pinnedId
    true,                                          // followNewest
    { runId: 'run-6', text: '老的日志正文\n', truncated: false }, // log（本地还攥着旧文本）
    11.5,                                          // fontSize
    null,                                          // popover
    '',                                            // notice
    '',                                            // busy
    false,                                         // cleared
  ]
  let index = 0
  const stub = {
    createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }),
    useState: (initial) => {
      const value = preset[index]
      index += 1
      return [value !== undefined ? value : (typeof initial === 'function' ? initial() : initial), () => {}]
    },
    useEffect: () => {},
    useMemo: fn => fn(),
    useRef: (value) => { const ref = { current: value }; refs.push(ref); return ref },
    useCallback: fn => fn,
  }
  const url = new URL('../client.js', import.meta.url)
  url.searchParams.set('clear', String(Math.random()))
  await import(url.href)
  const bound = captured.factory(() => stub)
  const tree = bound.__internals.LogTab({ useInput: () => ({ draft: '' }), inputActions: { setDraft: () => {} } })

  const button = findAll(tree, node => node.type === 'button' && collectText(node).join('') === '清空日志')[0]
  assert.ok(button !== undefined, '已结束的实例应有「清空日志」按钮')
  await button.props.onClick()
  await new Promise(resolve => setTimeout(resolve, 0))

  // 真的打了宿主的 clear 接口
  assert.equal(posts.some(post => post.url === '/api/dsh-launcher/clear' && post.body.run === 'run-6'), true)
  // 本地缓冲被丢掉：偏移归零、文本清空（这才是「点了有反应」的关键）
  assert.equal(refs.some(ref => ref.current !== null && typeof ref.current === 'object' && ref.current.next === 0 && ref.current.runId === 'run-6'), true, '偏移应被重置')
  assert.equal(refs.some(ref => ref.current !== null && typeof ref.current === 'object' && ref.current.text === '' && ref.current.runId === 'run-6'), true, '本地文本应被清空')
  delete globalThis.fetch
})

test('空态区分「已清空」与「还没产出」', async () => {
  const settled = { id: 'run-6', name: '构建全部', kind: 'task', status: 'exited', exitCode: 0, startedAt: 600, groupTitle: 'demo-api', command: 'mvn install', cwd: '/tmp', logFile: '/logs/run-6.log' }
  const render = async (cleared) => {
    const bound = await loadWith(stubReactWith([
      [settled], null, true, { runId: 'run-6', text: '', truncated: false }, 11.5, null, '', '', cleared,
    ]))
    return collectText(bound.__internals.LogTab({ useInput: () => ({ draft: '' }), inputActions: { setDraft: () => {} } })).join('|')
  }
  const clearedText = await render(true)
  assert.match(clearedText, /面板里的日志已清空/)
  assert.equal(clearedText.includes('磁盘上的完整记录还在'), true)
  assert.equal(clearedText.includes('等待输出'), false, '清空之后不该说「等待输出」')

  const freshText = await render(false)
  assert.equal(freshText.includes('等待输出'), true, '没清空、也没产出时仍是等待输出')
  assert.equal(freshText.includes('面板里的日志已清空'), false)
})

test('只有一个实例时也不显示「跟随最新」（没有可跟的东西）', async () => {
  const only = { id: 'run-1', name: '唯一实例', kind: 'service', status: 'running', startedAt: 100, groupTitle: 'g', command: 'echo hi', cwd: '/tmp' }
  const bound = await loadWith(stubReactWith([
    [only], null, true, { runId: null, text: 'hello\n', truncated: false }, 11.5, null, '', '', false,
  ]))
  const text = collectText(bound.__internals.LogTab({ useInput: () => ({ draft: '' }), inputActions: { setDraft: () => {} } })).join('|')
  assert.equal(text.includes('跟随最新'), false, '只有一个实例时没有可跟的东西')
  assert.equal(text.includes('唯一实例'), true, '实例本身仍要显示')
  assert.equal(text.includes('运行中'), true)
  assert.equal(text.includes('停止'), true, '在跑的实例仍要能停')
})

test('两个以上实例才出现切换器与跟随开关', async () => {
  const runs = [
    { id: 'run-2', name: 'B 服务', kind: 'service', status: 'running', startedAt: 200, groupTitle: 'g', command: 'echo b', cwd: '/tmp' },
    { id: 'run-1', name: 'A 服务', kind: 'service', status: 'stopped', startedAt: 100, groupTitle: 'g', command: 'echo a', cwd: '/tmp' },
  ]
  const bound = await loadWith(stubReactWith([
    runs, null, true, { runId: null, text: '', truncated: false }, 11.5, null, '', '', false,
  ]))
  const tree = bound.__internals.LogTab({ useInput: () => ({ draft: '' }), inputActions: { setDraft: () => {} } })
  const text = collectText(tree).join('|')
  assert.equal(text.includes('跟随最新'), true)
  const track = findNode(tree, node => node.props !== undefined && node.props.style?.overflowX === 'auto')
  assert.ok(track !== undefined, '两个以上实例才给分段切换器')
  assert.equal(findAll(track, node => node.type === 'button').length, 2)
})

test('「运行日志」图标是一页带行的文本，不是默认兜底', async () => {
  const bound = await loadWith(stubReact())
  const { LogTabIcon: icon, LogTabTitle: title } = bound.__internals

  const svg = icon({ size: 18 })
  assert.equal(svg.type, 'svg')
  assert.equal(svg.props.width, 18)
  const paths = findAll(svg, node => node.type === 'path')
  assert.equal(paths.length, 3, '页面轮廓 + 折角 + 三行输出')
  assert.match(String(paths[2].props.d), /M7\.7 9\.6/)
  // 尺寸缺省时也要能画（侧栏可能不传 size）
  assert.equal(icon().props.width, 18)
  assert.equal(icon({ size: 0 }).props.width, 18)

  // tab 标题 = 图标 + 文字（图标是组件元素，findNode 不会替你调用函数组件，所以按组件类型找）
  const rendered = title()
  const iconElement = findNode(rendered, node => node.type === icon)
  assert.ok(iconElement !== undefined, '标题里应有图标组件')
  assert.equal(iconElement.props.size, 14)
  assert.equal(collectText(rendered).join(''), '运行日志')
})

test('⋯ 菜单：用 fixed 定位并按触发器坐标算，绝不被左栏的滚动容器裁掉', async () => {
  const bound = await loadWith(stubReact())
  const { menuPosition: pos } = bound.__internals

  // 右边缘对齐触发按钮
  const anchor = { left: 300, right: 330, top: 100, bottom: 126 }
  const below = pos(anchor, 5, { width: 1000, height: 800 })
  assert.equal(below.left, 330 - 152, '右边缘对齐')
  assert.equal(below.top, 130, '默认挂在按钮下方')

  // 贴着视口右边：夹进来，不越界
  const clamped = pos({ left: 980, right: 1010, top: 10, bottom: 36 }, 5, { width: 1000, height: 800 })
  assert.ok(clamped.left <= 1000 - 152 - 8, `left 应被夹住，实际 ${String(clamped.left)}`)
  assert.ok(clamped.left >= 8)

  // 下方空间不够：往上翻，且不越出上边界
  const flipped = pos({ left: 300, right: 330, top: 700, bottom: 726 }, 5, { width: 1000, height: 760 })
  assert.ok(flipped.top < 700, '应翻到按钮上方')
  assert.ok(flipped.top >= 8, '不能翻出视口上边界')

  // 没有锚点（测试或异常情况）不炸
  assert.deepEqual(pos(undefined, 3, { width: 800, height: 600 }), { left: 8, top: 8 })

  // 菜单根节点必须是 fixed：absolute 会被 overflow: auto 的祖先裁掉
  const menu = bound.__internals.MoreMenu({ entries: [{ label: '删除', onClick: () => {} }], onClose: () => {}, anchor })
  assert.equal(menu.props.style.position, 'fixed')
  assert.equal(menu.props.style.left, below.left)
  assert.equal(menu.props.style.top, below.top)
})

test('菜单只在面板根部渲染一处（行里渲染会被 sticky 表头盖住）', async () => {
  const bound = await loadWith(stubReact())
  const { actions } = fakeActions()
  const item = sampleItem()
  const group = sampleGroup({ items: [item] })

  // 行/分组自己不再渲染菜单，只留触发按钮与「按下」高亮
  const groupOnly = bound.__internals.renderGroup({
    group, items: [item], collapsed: false, runningCount: 0, busy: '',
    selected: null, editing: null, groupMenuOpen: true, itemMenu: null, home: '/home/dev',
    actions, pickDirectory: () => Promise.resolve(null), latestRunOf: () => undefined,
  })
  assert.equal(findAll(groupOnly, node => node.type === bound.__internals.MoreMenu).length, 0, '分组头不该自己渲染菜单')

  const row = bound.__internals.renderItem({
    group, item, index: 0, run: undefined, busy: '', selected: false, menuOpen: true,
    editing: null, home: '/home/dev', actions,
  })
  assert.equal(findAll(row, node => node.type === bound.__internals.MoreMenu).length, 0, '条目行不该自己渲染菜单')

  // 面板根部渲染：分组菜单与条目菜单各测一次，且都只有一个
  const renderPanelWithMenu = async (menu) => {
    const bound2 = await loadWith(stubReactWith([
      [group],                                 // groups
      null, '', [], null,                      // shell, storeFile, runs, capabilities
      null, { runId: null, text: '', truncated: false }, '', {}, null, // selection, log, filter, collapsed, editing
      menu,                                    // menu
      '', '', '', true, 11.5,                  // error, notice, busy, follow, logFontSize
    ]))
    const tree = bound2.__internals.LauncherPanel({ pickDirectory: () => Promise.resolve(null) })
    // loadWith 每次都新建模块实例，函数对象不跨实例相等，所以拿这一份的 MoreMenu 比
    return { tree, menuType: bound2.__internals.MoreMenu, text: collectText(tree).join('|') }
  }

  const groupMenu = await renderPanelWithMenu({ menuKind: 'group', groupId: 'g1', itemId: null, anchor: undefined })
  assert.equal(findAll(groupMenu.tree, node => node.type === groupMenu.menuType).length, 1)
  assert.equal(groupMenu.text.includes('编辑分组'), true)
  assert.equal(groupMenu.text.includes('复制命令'), false, '分组菜单里不该混进条目操作')

  const itemMenu = await renderPanelWithMenu({ menuKind: 'item', groupId: 'g1', itemId: 'i1', anchor: undefined })
  assert.equal(findAll(itemMenu.tree, node => node.type === itemMenu.menuType).length, 1)
  assert.equal(itemMenu.text.includes('复制命令'), true)
  assert.equal(itemMenu.text.includes('编辑分组'), false, '条目菜单里不该混进分组操作')

  // 菜单指向的条目已经不存在时不渲染空菜单（也不炸）
  const stale = await renderPanelWithMenu({ menuKind: 'item', groupId: 'g1', itemId: '没了', anchor: undefined })
  assert.equal(findAll(stale.tree, node => node.type === stale.menuType).length, 0)
})

test('拖拽落点：上/下半区决定插在本行前还是下一行前', async () => {
  const bound = await loadWith(stubReact())
  const { dropBefore: before } = bound.__internals
  const rect = { top: 100, height: 40 }   // 中线 120

  // 上半区 → 插到自己之前
  assert.equal(before(rect, 105, 'i2', 'i3'), 'i2')
  assert.equal(before(rect, 120, 'i2', 'i3'), 'i2', '正好中线算上半区')
  // 下半区 → 插到下一行之前
  assert.equal(before(rect, 130, 'i2', 'i3'), 'i3')
  // 下半区且没有下一行 → 末尾
  assert.equal(before(rect, 130, 'i9', undefined), null)
})

test('条目行是可拖的，并接上了拖拽回调', async () => {
  const bound = await loadWith(stubReact())
  const { actions } = fakeActions()
  const started = []
  const overed = []
  const dropped = []
  const dnd = {
    startDrag: payload => (event) => { started.push(payload) },
    overGroupSection: () => () => false,
    overGroupHeader: () => () => false,
    overGroupBody: () => () => false,
    // 返回 true = 我接受这次落下（元素据此才 preventDefault）
    overItem: (group, item, index) => (event) => { overed.push([group.id, item.id, index, event.currentTarget !== undefined]); return true },
    finishDrop: () => { dropped.push(true) },
    cancelDrag: () => {},
  }
  const group = sampleGroup({ items: [sampleItem()] })
  const row = bound.__internals.renderItem({
    group, item: sampleItem(), index: 0, run: undefined, busy: '', selected: false, menuOpen: false,
    // 有东西正在被拖，dragover 才会接管（没有东西在拖时早退是刻意的）
    editing: null, drag: { kind: 'item', groupId: 'g1', itemId: 'i2' }, dropHint: null,
    dnd, home: '/home/dev', actions,
  })

  assert.equal(row.props.draggable, true, '整行要能拖')
  row.props.onDragStart({ dataTransfer: { setData: () => {} } })
  assert.deepEqual(started, [{ kind: 'item', groupId: 'g1', itemId: 'i1' }], '抓取时带上分组与条目 id')

  let prevented = false
  let stopped = false
  row.props.onDragOver({
    preventDefault: () => { prevented = true },
    stopPropagation: () => { stopped = true },
    clientY: 10,
    currentTarget: { getBoundingClientRect: () => ({ top: 0, height: 100 }) },
  })
  assert.equal(prevented, true, '必须 preventDefault，否则浏览器不允许放下')
  // 阻止冒泡是这次修复的核心：不阻止的话事件会继续冒到分组区域，
  // 把"插在这一行之前"改写成"追加到末尾"，于是拖最后一条往上拖等于原地不动。
  assert.equal(stopped, true, '必须阻止冒泡，否则精确落点被外层改写')
  assert.equal(overed.length, 1)
  assert.equal(overed[0][0], 'g1')
  assert.equal(overed[0][1], 'i1')

  row.props.onDrop({ preventDefault: () => {} })
  assert.equal(dropped.length, 1)

  // 处理函数说"不接受"时（比如正在拖的是分组），不能 preventDefault、也不能阻止冒泡：
  // 否则这一行会变成非法落点，指针显示成可放下，实际什么都发生不了。
  const groupBound = await loadWith(stubReact())
  const laxDnd = { ...dnd, overItem: () => () => false }
  const row2 = groupBound.__internals.renderItem({
    group, item: sampleItem(), index: 0, run: undefined, busy: '', selected: false, menuOpen: false,
    editing: null, drag: { kind: 'group', groupId: 'g9' }, dropHint: null, dnd: laxDnd,
    home: '/home/dev', actions,
  })
  let prevented2 = false
  let stopped2 = false
  row2.props.onDragOver({
    preventDefault: () => { prevented2 = true },
    stopPropagation: () => { stopped2 = true },
    clientY: 10,
    currentTarget: { getBoundingClientRect: () => ({ top: 0, height: 100 }) },
  })
  assert.equal(prevented2, false, '不接受就不该 preventDefault')
  assert.equal(stopped2, false, '不接受就该让事件继续冒泡给外层')
})

test('拖拽进行中的视觉：被拖的行变淡，落点画插入线', async () => {
  const bound = await loadWith(stubReact())
  const { actions } = fakeActions()
  const item = sampleItem()
  const group = sampleGroup({ items: [item] })
  const base = {
    group, item, index: 0, run: undefined, busy: '', selected: false, menuOpen: false,
    editing: null, home: '/home/dev', actions,
  }

  // 正在拖这一行 → 变淡
  const dragging = bound.__internals.renderItem({ ...base, drag: { kind: 'item', groupId: 'g1', itemId: 'i1' }, dropHint: null })
  assert.equal(dragging.props.style.opacity, 0.45)

  // 落点在本行之前 → 顶部一条粗线（3px，带左端小方块）
  const beforeLine = bound.__internals.renderItem({ ...base, drag: { kind: 'item', groupId: 'g1', itemId: 'i9' }, dropHint: 'before' })
  const line = findNode(beforeLine, node => node.props?.['data-insert-line'] === 'before')
  assert.ok(line !== undefined, '上半区要有插入线')
  assert.equal(line.props.style.height, 3, '细到 1px 看不见，实测确认要 3px')
  assert.equal(line.props.style.top, -2)
  assert.ok(findNode(line, node => node.type === 'span') !== undefined, '左端要有小方块当箭头')

  // 落点在末尾 → 线的位置换到下方
  const afterLine = bound.__internals.renderItem({ ...base, drag: { kind: 'item', groupId: 'g1', itemId: 'i9' }, dropHint: 'after' })
  assert.equal(findNode(afterLine, node => node.props?.['data-insert-line'] === 'after').props.style.bottom, -2)

  // 没在拖时不画线
  const idle = bound.__internals.renderItem({ ...base, drag: null, dropHint: null })
  assert.equal(findNode(idle, node => node.props?.['data-insert-line'] !== undefined), undefined)
})

test('分组头也是拖拽把手：拖分组排序 + 拖条目落到该组时高亮', async () => {
  const bound = await loadWith(stubReact())
  const { actions } = fakeActions()
  const started = []
  const dnd = {
    startDrag: payload => () => { started.push(payload) },
    overGroup: () => () => {},
    overGroupBody: () => () => {},
    overItem: () => () => {},
    finishDrop: () => {},
    cancelDrag: () => {},
  }
  const group = sampleGroup({ items: [] })

  const head = bound.__internals.renderGroup({
    group, items: [], collapsed: false, runningCount: 0, busy: '', selected: null, editing: null,
    groupMenuOpen: false, itemMenu: null, drag: null, dropHint: null, dropTarget: false,
    dnd, home: '/home/dev', actions, latestRunOf: () => undefined,
  })
  const header = findNode(head, node => node.props?.draggable === true)
  assert.ok(header !== undefined, '分组头要能拖')
  header.props.onDragStart({ dataTransfer: { setData: () => {} } })
  assert.deepEqual(started, [{ kind: 'group', groupId: 'g1' }])

  // 拖条目悬停在该组上 → 分组头高亮
  const target = bound.__internals.renderGroup({
    group, items: [], collapsed: false, runningCount: 0, busy: '', selected: null, editing: null,
    groupMenuOpen: false, itemMenu: null, drag: { kind: 'item', groupId: 'g9', itemId: 'i9' },
    dropHint: null, dropTarget: true, dnd, home: '/home/dev', actions, latestRunOf: () => undefined,
  })
  const hlHead = findNode(target, node => node.props?.draggable === true)
  assert.equal(hlHead.props.style.background, 'var(--dsw-alias-bg-layer-2)')

  // 被拖的分组变淡
  const faded = bound.__internals.renderGroup({
    group, items: [], collapsed: false, runningCount: 0, busy: '', selected: null, editing: null,
    groupMenuOpen: false, itemMenu: null, drag: { kind: 'group', groupId: 'g1' }, dropHint: null,
    dropTarget: false, dnd, home: '/home/dev', actions, latestRunOf: () => undefined,
  })
  assert.equal(findNode(faded, node => node.props?.draggable === true).props.style.opacity, 0.45)
})

test('插入线画在正确的分组上：包括「放到整张清单末尾」', async () => {
  const g1 = sampleGroup({ id: 'g1', name: 'A组', items: [sampleItem()] })
  const g2 = sampleGroup({ id: 'g2', name: 'B组', items: [sampleItem({ id: 'i2' })] })

  // 状态注入顺序：groups, shell, storeFile, runs, capabilities, selection, log, filter,
  //               collapsed, editing, menu, error, notice, busy, drag, dropAt, follow, logFontSize
  const renderWith = async (drag, dropAt) => {
    const bound = await loadWith(stubReactWith([
      [g1, g2], null, '', [], null, null, { runId: null, text: '', truncated: false }, '',
      {}, null, null, '', '', '', drag, dropAt, true, 11.5,
    ]))
    const tree = bound.__internals.LauncherPanel({ pickDirectory: () => Promise.resolve(null) })
    return { tree, text: collectText(tree).join('|') }
  }

  // 拖 g1，落点是「g2 之前」→ 线画在 B组 上沿
  const beforeG2 = await renderWith({ kind: 'group', groupId: 'g1' }, { type: 'group', beforeGroupId: 'g2' })
  const beforeLines = findAll(beforeG2.tree, node => node.props?.['data-insert-line'] !== undefined)
  assert.equal(beforeLines.length, 1, '同一时刻只应有一条插入线')
  assert.equal(beforeLines[0].props['data-insert-line'], 'before')

  // 拖 g1，落点是「末尾」（beforeGroupId = null）→ 线画在**最后一个分组**下沿
  const toEnd = await renderWith({ kind: 'group', groupId: 'g1' }, { type: 'group', beforeGroupId: null })
  const endLines = findAll(toEnd.tree, node => node.props?.['data-insert-line'] !== undefined)
  assert.equal(endLines.length, 1, '放到末尾也要有可见落点')
  assert.equal(endLines[0].props['data-insert-line'], 'after')

  // 拖到"自己之前"（原地）也算一个明确落点
  const selfBefore = await renderWith({ kind: 'group', groupId: 'g2' }, { type: 'group', beforeGroupId: 'g1' })
  assert.equal(findAll(selfBefore.tree, node => node.props?.['data-insert-line'] !== undefined).length, 1)

  // 没在拖 → 没有任何插入线
  const idle = await renderWith(null, null)
  assert.equal(findAll(idle.tree, node => node.props?.['data-insert-line'] !== undefined).length, 0)
})

test('条目拖拽：追加到末尾的线画在本组最后一行下方', async () => {
  const item = sampleItem({ id: 'i1' })
  const group = sampleGroup({ id: 'g1', items: [item] })
  const bound = await loadWith(stubReactWith([
    [group], null, '', [], null, null, { runId: null, text: '', truncated: false }, '',
    {}, null, null, '', '', '', { kind: 'item', groupId: 'g1', itemId: 'i9' },
    { type: 'item', groupId: 'g1', itemId: null, beforeItemId: null }, true, 11.5,
  ]))
  const tree = bound.__internals.LauncherPanel({ pickDirectory: () => Promise.resolve(null) })
  const lines = findAll(tree, node => node.props?.['data-insert-line'] !== undefined)
  assert.equal(lines.length, 1)
  assert.equal(lines[0].props['data-insert-line'], 'after', '末尾追加要画在最后一行下方')
})

test('状态点规则：没在跑就没有点，在跑绿点，异常红点', async () => {
  const bound = await loadWith(stubReact())
  const { actions } = fakeActions()
  const group = sampleGroup()
  const dotOf = (run, kind = 'service') => {
    const row = bound.__internals.renderItem({
      group, item: sampleItem({ kind }), index: 0, run, busy: '', selected: false,
      menuOpen: false, editing: null, home: '/home/dev', actions,
    })
    return findNode(row, node => node.props?.style?.borderRadius === '50%')
  }
  const ok = 'var(--dsw-alias-state-success-primary)'
  const bad = 'var(--dsw-alias-state-error-primary)'

  // 没在跑 → 不画点（但留占位，否则名称会左右跳）
  for (const [label, run, kind] of [
    ['未跑过', undefined, 'service'],
    ['已停止', { id: 'r5', status: 'stopped', startedAt: 1 }, 'service'],
    ['任务已完成', { id: 'r3', status: 'exited', exitCode: 0, startedAt: 1 }, 'task'],
    ['服务正常退出', { id: 'r4', status: 'exited', exitCode: 0, startedAt: 1 }, 'service'],
  ]) {
    const dot = dotOf(run, kind)
    assert.equal(dot.props.style.visibility, 'hidden', `${label}：不该有点`)
    assert.equal(dot.props.title, undefined, `${label}：没有点就不挂 tooltip`)
  }

  // 在跑 → 绿点
  for (const status of ['starting', 'running', 'stopping']) {
    const dot = dotOf({ id: 'r1', status, startedAt: 1 })
    assert.equal(dot.props.style.background, ok, `${status} 应该是绿点`)
    assert.notEqual(dot.props.style.visibility, 'hidden')
  }

  // 异常 → 红点（含启动失败这种从来没跑起来过的）
  assert.equal(dotOf({ id: 'r2', status: 'exited', exitCode: 1, startedAt: 1 }).props.style.background, bad)
  assert.equal(dotOf({ id: 'r6', status: 'failed', startedAt: 1 }).props.style.background, bad)
  assert.equal(dotOf({ id: 'r2', status: 'exited', exitCode: 1, startedAt: 1 }).props.title, '异常退出（退出码 1）')

  // 名称 tooltip 里仍带完整状态文字（点没了也不至于查不到状态）
  const row = bound.__internals.renderItem({
    group, item: sampleItem(), index: 0, run: { id: 'r4', status: 'exited', exitCode: 0, startedAt: 1 },
    busy: '', selected: false, menuOpen: false, editing: null, home: '/home/dev', actions,
  })
  const name = findNode(row, node => node.type === 'span' && typeof node.props?.title === 'string' && node.props.title.startsWith('MQTT collector'))
  assert.match(name.props.title, /已退出（本该常驻）/, '没有点的时候状态要从名称 tooltip 里能查到')
})


test('分组颜色：自定义优先，没有就按 id 派生（新建分组照样有色）', async () => {
  const bound = await loadWith(stubReact())
  const { resolveGroupColor } = bound.__internals
  const auto = resolveGroupColor({ id: 'g1' })
  assert.match(auto, /^#[0-9a-f]{6}$/)

  // 自定义色压过派生色
  assert.equal(resolveGroupColor({ id: 'g1', color: '#123abc' }), '#123abc')
  // 非法值回落派生色，不会把任意字符串塞进 style
  for (const bad of ['', 'red', '#12345', 'javascript:alert(1)', '#GGGGGG']) {
    assert.equal(resolveGroupColor({ id: 'g1', color: bad }), auto, `非法色 ${JSON.stringify(bad)} 应回落`)
  }
  // 同一个 id 永远同一个派生色
  assert.equal(resolveGroupColor({ id: 'g1' }), resolveGroupColor({ id: 'g1' }))
})

test('取色面板：一排色块 + 自动 + 关闭，位置 fixed 不被裁', async () => {
  const bound = await loadWith(stubReact())
  const picked = []
  let closed = 0
  const panel = bound.__internals.GroupColorPicker({
    anchor: { left: 300, right: 330, top: 100, bottom: 126 },
    current: '#123abc',
    auto: '#4f6bd8',
    colors: ['#4f6bd8', '#2f9e6f', '#c07a1f'],
    onPick: color => picked.push(color),
    onClose: () => { closed += 1 },
  })
  assert.equal(panel.props.style.position, 'fixed', 'fixed 才不会被左栏滚动容器裁掉')

  const dots = findAll(panel, node => node.type === 'button' && node.props?.style?.width === 20)
  assert.equal(dots.length, 3, '每个调色板颜色一个色块')
  assert.ok(String(dots[0].props.style.boxShadow).includes('#4f6bd8') === false, '非当前色不加高亮环')
  // 当前色要能看出来（面板里第三个是 current）
  const currentDot = dots.find(node => String(node.props.style.background) === '#123abc')
  assert.equal(currentDot, undefined, '当前色不在这个调色板里时不高亮任何一项')

  dots[1].props.onClick()
  assert.deepEqual(picked, ['#2f9e6f'])
  const autoButton = findNode(panel, node => node.type === 'button' && collectText(node).join('') === '自动')
  autoButton.props.onClick()
  assert.deepEqual(picked, ['#2f9e6f', ''], '「自动」提交空串 = 回到派生色')
  findNode(panel, node => node.type === 'button' && collectText(node).join('') === '✕').props.onClick()
  assert.equal(closed, 1)
})

test('分组调色板是马卡龙色系：柔和、不过灰、彼此分得开', async () => {
  const bound = await loadWith(stubReact())
  const colors = bound.__internals.GROUP_COLORS
  const rgb = hex => [1, 3, 5].map(i => Number.parseInt(hex.slice(i, i + 2), 16))

  assert.ok(colors.length >= 6, '分组种类多，颜色太少会撞色')
  assert.equal(new Set(colors).size, colors.length, '不能有重复色')

  for (const hex of colors) {
    assert.match(hex, /^#[0-9a-f]{6}$/, `${hex} 要是小写十六进制（同一个色永远是同一个字符串）`)
    const [r, g, b] = rgb(hex)
    const lightness = (Math.max(r, g, b) + Math.min(r, g, b)) / 2 / 255
    const span = Math.max(r, g, b) - Math.min(r, g, b)
    assert.ok(lightness >= 0.72, `${hex} 亮度 ${lightness.toFixed(2)} 太低，不是马卡龙色`)
    assert.ok(span >= 30, `${hex} 跨度 ${String(span)} 太小，会发灰`)
    assert.ok(span <= 110, `${hex} 跨度 ${String(span)} 太大，太饱和了`)
  }

  // 两两距离：色块只有 10px，糊成一片就失去"一眼区分分组"的意义
  for (let i = 0; i < colors.length; i += 1) {
    for (let j = i + 1; j < colors.length; j += 1) {
      const a = rgb(colors[i])
      const b = rgb(colors[j])
      const distance = Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2])
      assert.ok(distance >= 30, `${colors[i]} 与 ${colors[j]} 距离只有 ${distance.toFixed(1)}，太像了`)
    }
  }
})

test('只用 DSH 真有的主题 token（用错 token 会静默回落到浅色兜底，暗色主题必错）', async () => {
  const source = await readFile(new URL('../client.js', import.meta.url), 'utf8')
  // 官方 token 清单来自 client 侧 Theme 检查器的 listTokens（14 个颜色 token，light/dark 各一套）
  const OFFICIAL = new Set([
    '--dsw-alias-bg-base', '--dsw-alias-bg-layer-1', '--dsw-alias-bg-layer-2', '--dsw-alias-bg-overlay',
    '--dsw-alias-border-l1', '--dsw-alias-border-l2', '--dsw-alias-brand-primary',
    '--dsw-alias-label-primary', '--dsw-alias-label-secondary',
    '--dsw-alias-state-error-primary', '--dsw-alias-state-idle-primary',
    '--dsw-alias-state-success-primary', '--dsw-alias-state-warn-primary',
    '--dsw-alias-specific-sidebar-fill',
  ])
  const used = new Set([...source.matchAll(/var\((--dsw-[a-z0-9-]+)/g)].map(match => match[1]))
  assert.ok(used.size > 5, '应该真的用到了主题 token')

  for (const token of used) {
    if (token.startsWith('--dsw-font-')) continue   // 字体栈不是颜色 token，Theme 检查器不列
    assert.equal(OFFICIAL.has(token), true, `${token} 不是 DSH 提供的 token（用错会静默回落成兜底色）`)
  }

  // 颜色 token 不该再带硬编码兜底：兜底是"另一种主题的颜色"，暗色下就是它出问题
  const withFallback = [...source.matchAll(/var\((--dsw-alias-[a-z0-9-]+),\s*[^)]+\)/g)].map(match => match[0])
  assert.deepEqual(withFallback, [], `这些还在用兜底色：${withFallback.join('、')}`)
})

test('ANSI 调色板分浅色/深色两套，且每一色在各自底色上都读得清', async () => {
  const bound = await loadWith(stubReact())
  const { parseAnsi: parse, xterm256: x256 } = bound.__internals
  const ESC = '\u001b'

  // 同一个 SGR 31，两套主题给不同值
  assert.equal(parse(`${ESC}[31mR${ESC}[0m`, 10, 'light').lines[0][0].style.color, '#c04552')
  assert.equal(parse(`${ESC}[31mR${ESC}[0m`, 10, 'dark').lines[0][0].style.color, '#ff6b74')
  assert.notEqual(x256(1, 'light'), x256(1, 'dark'))

  // 相对亮度与对比度（WCAG）
  const lum = (hex) => {
    const channel = value => (value / 255 <= 0.03928 ? value / 255 / 12.92 : ((value / 255 + 0.055) / 1.055) ** 2.4)
    const [r, g, b] = [1, 3, 5].map(i => Number.parseInt(hex.slice(i, i + 2), 16))
    return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b)
  }
  const contrast = (a, b) => {
    const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x)
    return (hi + 0.05) / (lo + 0.05)
  }

  // 各自主题的底色（DSH 浅色近白、深色近 #1c1e26）
  const cases = [['light', '#ffffff'], ['dark', '#1c1e26']]
  for (const [scheme, background] of cases) {
    for (let code = 0; code < 16; code += 1) {
      const color = x256(code, scheme)
      const ratio = contrast(color, background)
      assert.ok(ratio >= 2.5, `${scheme} 主题下 ANSI ${String(code)} (${color}) 对比度只有 ${ratio.toFixed(2)}，看不清`)
    }
  }

  // 一套色不可能两边都合适：浅色主题的"白"必须比深色主题的"白"暗
  assert.ok(lum(x256(7, 'light')) < lum(x256(7, 'dark')), '浅色主题的"白"槽要压暗，否则白底上看不见')
  assert.ok(lum(x256(0, 'light')) < lum(x256(0, 'dark')), '深色主题的"黑"槽要提亮，否则深底上看不见')
})
