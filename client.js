/**
 * dsh-project-runner 的浏览器半侧。
 *
 * 手写的 `__ModuleLoader__` bundle，故意不经过 tsdown/vite：客户端模块系统只要求
 * 「注册一个 factory，在里面 require 平台模块表里的模块」，而本插件要的东西很少
 * （React + 三个客户端服务），为它引一套构建链会让「link 进来就能用」变成
 * 「先装依赖再 build」。
 *
 * 界面语言固定中文，不走 `ctx.locale`：文案键就是中文原文。走本地化踩过一次坑——
 * DSH 的语言解析把 zh 回落到了 en，侧栏于是出现一个叫「Run」的面板。
 *
 * 这一版只管**插件自己的启动项清单**（分组 + 条目），不再解析 launch.json。
 * 它做两件事：
 * 1. 往 `sidebar.panellist` 注册「启动器」入口（每个 list id 对应一个 main 面板）；
 * 2. 往 `main` 注册 key = `launcher` 的面板：左边分组与条目（可增删改、上下移），
 *    右边运行实例 + 实时日志。
 *
 * @module dsh-project-runner/client
 */

window.__ModuleLoader__.load({
  id: 'dsh-project-runner',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    const React = require('react')
    const h = React.createElement

    /** 面板 id：同时是 sidebar.panellist 的 list id 与 main 的 key。 */
    const PANEL_ID = 'launcher'
    /** 侧栏入口与面板标题。 */
    const PANEL_TITLE = '启动器'
    /** 轮询间隔：运行状态 + 日志增量。 */
    const POLL_MS = 600
    /** 单次渲染最多解析的日志字符数。 */
    const RENDER_CHAR_LIMIT = 160000
    /** 单次渲染最多保留的行数。 */
    const RENDER_LINE_LIMIT = 1500

    /** 面板视图（选中项/折叠/筛选/跟随/日志字号）的记忆键。 */
    const VIEW_KEY = 'dsh.launcher.view.v1'

    /** 日志字号范围与步长。 */
    const LOG_FONT_MIN = 9
    const LOG_FONT_MAX = 20
    const LOG_FONT_STEP = 1

    /**
     * 夹取日志字号；认不出时给默认值。
     *
     * @param {unknown} value - 原始值。
     * @returns {number} 字号（px）。
     */
    function clampLogFont(value) {
      const size = Number(value)
      if (!Number.isFinite(size)) return 11.5
      return Math.min(Math.max(size, LOG_FONT_MIN), LOG_FONT_MAX)
    }

    /**
     * 面板视图的模块级缓存。
     *
     * 切到别的面板时 `main` 插槽会卸载组件（layout 只渲染当前面板那一项），
     * 于是组件内 state 全丢、右栏变成「还没有选中启动项」——用户看到的就是
     * 「我刚起的服务，日志没了」。模块本身不卸载，所以这份缓存能跨面板切换
     * 活下来；localStorage 则负责跨页面刷新。
     */
    let rememberedView = null

    /**
     * 读回上次的面板视图。
     *
     * @returns {{ selection: any, collapsed: Record<string, boolean>, filter: string, follow: boolean }} 视图。
     */
    function loadView() {
      if (rememberedView !== null) return rememberedView
      const fallback = { selection: null, collapsed: {}, filter: '', follow: true, logFontSize: 11.5 }
      try {
        const raw = window.localStorage.getItem(VIEW_KEY)
        if (raw === null) {
          rememberedView = fallback
          return fallback
        }
        const parsed = JSON.parse(raw)
        rememberedView = {
          selection: parsed !== null && typeof parsed.selection === 'object' ? parsed.selection : null,
          collapsed: parsed !== null && typeof parsed.collapsed === 'object' && parsed.collapsed !== null ? parsed.collapsed : {},
          filter: typeof parsed?.filter === 'string' ? parsed.filter : '',
          follow: parsed?.follow !== false,
          logFontSize: clampLogFont(parsed?.logFontSize),
        }
      } catch {
        rememberedView = fallback
      }
      return rememberedView
    }

    /**
     * 记住当前的面板视图。
     *
     * @param {{ selection: any, collapsed: Record<string, boolean>, filter: string, follow: boolean }} view - 视图。
     * @returns {void}
     */
    function saveView(view) {
      rememberedView = view
      try {
        window.localStorage.setItem(VIEW_KEY, JSON.stringify(view))
      } catch {
        // 存不下不影响使用：本次面板切换仍然靠模块级缓存记得住。
      }
    }

    /** 宿主路由（与 lib/routes.js 的 ROUTES 镜像）。 */
    const API = {
      state: '/api/dsh-launcher/state',
      runs: '/api/dsh-launcher/runs',
      log: '/api/dsh-launcher/log',
      start: '/api/dsh-launcher/start',
      stop: '/api/dsh-launcher/stop',
      clear: '/api/dsh-launcher/clear',
      remove: '/api/dsh-launcher/remove',
      groupCreate: '/api/dsh-launcher/group/create',
      groupUpdate: '/api/dsh-launcher/group/update',
      groupRemove: '/api/dsh-launcher/group/remove',
      groupMove: '/api/dsh-launcher/group/move',
      groupMoveTo: '/api/dsh-launcher/group/move-to',
      itemCreate: '/api/dsh-launcher/item/create',
      itemUpdate: '/api/dsh-launcher/item/update',
      itemRemove: '/api/dsh-launcher/item/remove',
      itemMove: '/api/dsh-launcher/item/move',
      itemMoveTo: '/api/dsh-launcher/item/move-to',
    }

    // #region HTTP

    /**
     * 宿主返回的 `/state` 是否可用；不可用时给出人话解释。
     *
     * 客户端 bundle 是按文件最新版服务的，而宿主半侧常驻在 DSH 进程里——改了
     * `lib/*.js` 又没重启 DSH 时，两边就会对不上。与其让人看到一个空面板，
     * 不如直接说清楚要重启。
     *
     * @param {any} payload - `/state` 的响应体。
     * @returns {string} 问题描述；正常时为空串。
     */
    function stateProblem(payload) {
      if (payload === null || typeof payload !== 'object') return '宿主没有返回可用的状态'
      if (!Array.isArray(payload.groups)) {
        return '宿主半侧还是旧版（/state 里没有 groups）：重启 DSH 之后就能用这一版'
      }
      return ''
    }

    /**
     * 宿主缺少某项能力时的提示。返回空串表示不用提示。
     *
     * `capabilities === null` 表示「还没读到」——这时不该报警，否则每次打开面板
     * 都会先闪一句旧版提示。
     *
     * @param {string[] | null} capabilities - `/state` 里的能力清单。
     * @returns {string} 提示文案；正常时为空串。
     */
    function capabilityNotice(capabilities) {
      if (capabilities === null) return ''
      const missing = []
      if (!capabilities.includes('item-kind')) missing.push('条目的「性质」（常驻服务 / 一次性任务）')
      if (!capabilities.includes('group-color')) missing.push('分组颜色')
      if (missing.length === 0) return ''
      return `宿主半侧是旧版：${missing.join('、')}要重启 DSH 之后才会保存`
    }

    /**
     * 宿主支不支持分组颜色。
     *
     * 不支持的旧宿主会**静默忽略** color 字段：点颜色看起来"没反应"，
     * 而这是最难查的一类症状。所以宁可直接把入口禁用并说明原因。
     *
     * @param {string[] | null} capabilities - `/state` 给的能力列表。
     * @returns {boolean} 是否支持。
     */
    function supportsGroupColor(capabilities) {
      if (capabilities === null) return true   // 还没读到就当支持，避免闪一下禁用态
      return capabilities.includes('group-color')
    }

    /**
     * 打一个 JSON 接口，非 2xx 时把宿主给的 error 文本抛出去。
     *
     * @param {string} url - 完整同源路径。
     * @param {RequestInit} [options] - fetch 选项。
     * @returns {Promise<any>} 解析后的响应体。
     */
    async function request(url, options) {
      const response = await fetch(url, options)
      let payload = null
      try {
        payload = await response.json()
      } catch {
        payload = null
      }
      if (!response.ok) {
        throw new Error(payload && typeof payload.error === 'string' ? payload.error : `${response.status} ${response.statusText}`)
      }
      return payload
    }

    /**
     * POST 一个 JSON 体。
     *
     * @param {string} url - 路径。
     * @param {Record<string, unknown>} body - 请求体。
     * @returns {Promise<any>} 响应体。
     */
    function postJson(url, body) {
      return request(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      })
    }

    // #endregion

    // #region 日志渲染：ANSI → 行/片段

    /**
     * 16 色 ANSI 调色板——**必须分浅色/深色两套**。
     *
     * 一套色不可能同时活在白底和深底上：ANSI 的「黑」(30) 在深色主题里几乎看不见，
     * 而「白」(37/97) 在白底上同样看不见。真实终端也是这个道理（浅色主题的终端
     * 会换一套调色板）。这里按主题给两套，每一色都对所在底色保证可读对比度，
     * 并由测试盯着（≥ 2.5:1）。
     *
     * 注意「白」在浅色主题里映射成深灰：这是日志查看器不是仿真终端，可读性优先。
     */
    const ANSI_LIGHT = {
      30: '#3f4451', 31: '#c04552', 32: '#4f9a3a', 33: '#b8763a',
      34: '#2f7fd0', 35: '#a94fd0', 36: '#2e8f9c', 37: '#5b6470',
      90: '#5a6270', 91: '#d64550', 92: '#6aa83f', 93: '#c07a2a',
      94: '#2b8fd6', 95: '#b45fd0', 96: '#2a9aa8', 97: '#3f4652',
    }
    const ANSI_DARK = {
      30: '#7f8694', 31: '#ff6b74', 32: '#9ede73', 33: '#f0b45d',
      34: '#5fb3ff', 35: '#d98bf5', 36: '#4fd0dd', 37: '#d8dbe2',
      90: '#9aa3b2', 91: '#ff8a92', 92: '#b7e88f', 93: '#f6c67d',
      94: '#7cc7ff', 95: '#e5a8ff', 96: '#74dbe6', 97: '#f2f4f8',
    }
    /**
     * 当前主题方案的小 store。
     *
     * 日志是按 ANSI 解析成具体颜色字符串的（不是 CSS 变量），所以换主题必须**重新解析**。
     * 用一个极小的订阅 store 把「主题变了」传进组件，比到处传 ctx 简单得多。
     */
    const ansiTheme = {
      scheme: 'light',
      listeners: new Set(),
      set(scheme) {
        if (scheme === this.scheme) return
        this.scheme = scheme
        for (const listener of this.listeners) listener(scheme)
      },
    }

    /**
     * 订阅当前主题方案（浅色/深色）。
     *
     * @returns {'light' | 'dark'} 方案。
     */
    function useAnsiScheme() {
      const [scheme, setScheme] = React.useState(ansiTheme.scheme)
      React.useEffect(() => {
        ansiTheme.listeners.add(setScheme)
        setScheme(ansiTheme.scheme)
        return () => ansiTheme.listeners.delete(setScheme)
      }, [])
      return scheme
    }

    /** 当前主题下的 ANSI 前景色表。 */
    const ansiColors = scheme => (scheme === 'dark' ? ANSI_DARK : ANSI_LIGHT)
    /** 背景色（标准 8 色）：直接用同一套，保证与前景同调。 */
    const ansiBackgrounds = scheme => {
      const palette = ansiColors(scheme)
      return { 40: palette[30], 41: palette[31], 42: palette[32], 43: palette[33], 44: palette[34], 45: palette[35], 46: palette[36], 47: palette[37] }
    }

    /** 一个空样式状态。 */
    const NO_STYLE = { color: undefined, background: undefined, bold: false, dim: false, underline: false, inverse: false }

    /**
     * 把一段带 ANSI 的文本渲染成「行 → 样式片段」。
     *
     * 这是一个日志用的行渲染器，不是终端模拟器：它按真实终端的光标语义处理
     * 一行之内的编辑——`\r` 只回车（后续字符从行首覆盖，这正是 maven/npm
     * 进度条的行为），`K` 从光标处擦到行尾，`2K` 清整行，`C/D/G` 移动光标，
     * `\t` 按 8 列制表位展开——但不做跨行的光标寻址（`A/B/H` 之类忽略），
     * 也不做整屏重绘。这样日志里每行呈现的就是「最终落在这行上的内容」。
     *
     * @param {string} text - 原始文本（含 ANSI、`\r`、`\t`）。
     * @param {number} maxLines - 最多保留的行数。
     * @returns {{ lines: Array<Array<{ text: string, style: object }>>, dropped: boolean }} 行与是否发生过截断。
     */
    function parseAnsi(text, maxLines, scheme) {
      const fores = ansiColors(scheme)
      const backs = ansiBackgrounds(scheme)
      const source = text.length > RENDER_CHAR_LIMIT ? text.slice(-RENDER_CHAR_LIMIT) : text
      const dropped = source.length !== text.length
      const lines = []
      /** 当前行的字符单元；光标就是插入/覆盖位置。 */
      let cells = []
      let cursor = 0
      let style = { ...NO_STYLE }
      let index = 0

      /** 落定一行。 */
      const endLine = () => {
        lines.push(toSpans(cells))
        cells = []
        cursor = 0
      }
      /** 在光标处写入一个字符（覆盖已有内容或追加）。 */
      const put = (char) => {
        while (cells.length < cursor) cells.push({ char: ' ', style: NO_STYLE })
        cells[cursor] = { char, style }
        cursor += 1
      }
      /** 写入一段可见文本，`\t` 展开成制表位空格。 */
      const putText = (value) => {
        for (const char of value) {
          if (char === '\t') {
            const stop = 8 - (cursor % 8)
            for (let pad = 0; pad < stop; pad += 1) put(' ')
            continue
          }
          put(char)
        }
      }
      /** 处理 CSI 擦除/移动参数。 */
      const applyErase = (final, params) => {
        const first = params === '' ? 0 : Number.parseInt(params.split(';')[0], 10)
        const amount = Number.isNaN(first) ? 0 : first
        if (final === 'K') {
          if (amount === 1) {
            cells = cells.slice(cursor)
            cursor = 0
          } else if (amount === 2) {
            cells = []
            cursor = 0
          } else cells = cells.slice(0, cursor)
          return
        }
        if (final === 'D') cursor = Math.max(0, cursor - Math.max(amount, 1))
        else if (final === 'C') cursor = Math.min(cells.length, cursor + Math.max(amount, 1))
        else if (final === 'G') cursor = Math.min(cells.length, Math.max(0, Math.max(amount, 1) - 1))
      }
      /** 应用一条 SGR 参数。 */
      const applySgr = (params) => {
        const codes = params === '' ? [0] : params.split(';').map(part => (part === '' ? 0 : Number.parseInt(part, 10)))
        for (let item = 0; item < codes.length; item += 1) {
          const code = codes[item]
          if (Number.isNaN(code)) continue
          if (code === 0) style = { ...NO_STYLE }
          else if (code === 1) style = { ...style, bold: true }
          else if (code === 2) style = { ...style, dim: true }
          else if (code === 4) style = { ...style, underline: true }
          else if (code === 7) style = { ...style, inverse: true }
          else if (code === 22) style = { ...style, bold: false, dim: false }
          else if (code === 24) style = { ...style, underline: false }
          else if (code === 27) style = { ...style, inverse: false }
          else if (code === 39) style = { ...style, color: undefined }
          else if (code === 49) style = { ...style, background: undefined }
          else if (fores[code] !== undefined) style = { ...style, color: fores[code] }
          else if (backs[code] !== undefined) style = { ...style, background: backs[code] }
          else if (code === 38 || code === 48) {
            const key = code === 38 ? 'color' : 'background'
            const mode = codes[item + 1]
            if (mode === 5) {
              style = { ...style, [key]: xterm256(codes[item + 2], scheme) }
              item += 2
            } else if (mode === 2) {
              const r = codes[item + 2]
              const g = codes[item + 3]
              const b = codes[item + 4]
              if ([r, g, b].every(value => Number.isInteger(value) && value >= 0 && value <= 255)) {
                style = { ...style, [key]: `rgb(${r}, ${g}, ${b})` }
              }
              item += 4
            }
          }
        }
      }

      while (index < source.length) {
        const char = source[index]
        if (char === '\u001b') {
          const next = source[index + 1]
          if (next === '[') {
            let end = index + 2
            while (end < source.length && !(source.charCodeAt(end) >= 64 && source.charCodeAt(end) <= 126)) end += 1
            const final = source[end]
            const params = source.slice(index + 2, end)
            if (final === 'm') applySgr(params)
            else if (final === 'K' || final === 'D' || final === 'C' || final === 'G') applyErase(final, params)
            index = end + 1
            continue
          }
          if (next === ']') {
            const bell = source.indexOf('\u0007', index + 2)
            const terminator = source.indexOf('\u001b\\', index + 2)
            let end = -1
            if (bell >= 0 && terminator >= 0) end = Math.min(bell, terminator)
            else if (bell >= 0) end = bell
            else if (terminator >= 0) end = terminator
            if (end < 0) {
              index = source.length
              break
            }
            index = source[end] === '\u0007' ? end + 1 : end + 2
            continue
          }
          index += 2
          continue
        }
        if (char === '\n') {
          endLine()
          index += 1
          continue
        }
        if (char === '\r') {
          if (source[index + 1] === '\n') {
            endLine()
            index += 2
            continue
          }
          // 只回车，不清行：后面的字符从行首开始覆盖。
          cursor = 0
          index += 1
          continue
        }
        if (char === '\b') {
          cursor = Math.max(0, cursor - 1)
          index += 1
          continue
        }
        if (char === '\u0007') {
          index += 1
          continue
        }
        let end = index
        while (end < source.length && !'\n\r\b\u0007\u001b'.includes(source[end])) end += 1
        putText(source.slice(index, end))
        index = end
      }
      if (cells.length > 0 || cursor > 0 || lines.length === 0) endLine()

      const overflow = lines.length > maxLines
      return { lines: overflow ? lines.slice(-maxLines) : lines, dropped: dropped || overflow }
    }

    /**
     * 把一行字符单元合并成样式片段（相邻同一样式合并，减少 DOM 节点）。
     *
     * @param {Array<{ char: string, style: object }>} cells - 字符单元。
     * @returns {Array<{ text: string, style: object }>} 片段。
     */
    function toSpans(cells) {
      const spans = []
      for (const cell of cells) {
        if (cell === undefined) continue
        const last = spans[spans.length - 1]
        if (last !== undefined && last.style === cell.style) {
          last.text += cell.char
          continue
        }
        spans.push({ text: cell.char, style: cell.style })
      }
      return spans
    }

    /**
     * 256 色表项 → CSS 颜色。
     *
     * @param {number} code - 0..255。
     * @returns {string} CSS 颜色。
     */
    function xterm256(code, scheme) {
      const palette = ansiColors(scheme)
      if (!Number.isInteger(code) || code < 0 || code > 255) return palette[37]
      if (code < 16) return palette[code < 8 ? 30 + code : 90 + (code - 8)] ?? palette[37]
      if (code < 232) {
        const value = code - 16
        const steps = [0, 95, 135, 175, 215, 255]
        const r = steps[Math.floor(value / 36) % 6]
        const g = steps[Math.floor(value / 6) % 6]
        const b = steps[value % 6]
        return `rgb(${r}, ${g}, ${b})`
      }
      const grey = 8 + (code - 232) * 10
      return `rgb(${grey}, ${grey}, ${grey})`
    }

    /**
     * 把片段样式翻成 React 的 style 对象。
     *
     * @param {object} style - 解析出的样式状态。
     * @returns {Record<string, string>} CSS。
     */
    function styleToCss(style) {
      const css = {}
      if (style.color !== undefined) css.color = style.color
      if (style.background !== undefined) css.backgroundColor = style.background
      if (style.bold) css.fontWeight = 700
      if (style.dim) css.opacity = '0.7'
      if (style.underline) css.textDecoration = 'underline'
      if (style.inverse) {
        // 反显 = 用前景色铺底、用**底色**当文字色，这样才像"挖"出来的字。
        css.backgroundColor = style.color ?? 'currentColor'
        css.color = 'var(--dsw-alias-bg-base)'
      }
      return css
    }

    /**
     * 渲染日志正文。
     *
     * @param {{ text: string, truncated: boolean }} input - 日志文本与是否被主机截断。
     * @param {(key: string) => string} t - 翻译函数。
     * @returns {any} React 节点。
     */
    function LogBody({ text, truncated, t }) {
      const parsed = React.useMemo(() => parseAnsi(text, RENDER_LINE_LIMIT), [text])
      if (text === '') {
        return h('div', { style: { color: 'var(--dsw-alias-label-secondary)', fontSize: 12, padding: '10px 2px' } }, t('等待输出'))
      }
      const children = []
      if (truncated || parsed.dropped) {
        children.push(
          h('div', { key: 'folded', style: { color: 'var(--dsw-alias-label-secondary)', fontSize: 11, padding: '2px 0' } },
            `… ${t('更早的日志已折叠')} …`),
        )
      }
      for (let lineIndex = 0; lineIndex < parsed.lines.length; lineIndex += 1) {
        const spans = parsed.lines[lineIndex]
        children.push(
          h(
            'div',
            { key: `l${String(lineIndex)}`, style: { whiteSpace: 'pre-wrap', wordBreak: 'break-word', minHeight: '1.35em' } },
            spans.length === 0
              ? '\u00a0'
              : spans.map((span, spanIndex) => h('span', { key: `s${String(spanIndex)}`, style: styleToCss(span.style) }, span.text)),
          ),
        )
      }
      return h('div', null, children)
    }

    // #endregion
    // #region 小工具：环境变量、路径、颜色、状态

    /**
     * 把 env 对象转成「每行 KEY=VALUE」的文本。
     *
     * @param {Record<string, string>} env - 环境变量。
     * @returns {string} 文本。
     */
    function envToText(env) {
      return Object.entries(env ?? {}).map(([key, value]) => `${key}=${value}`).join('\n')
    }

    /**
     * 把「每行 KEY=VALUE」的文本转回 env 对象。
     *
     * @param {string} text - 文本。
     * @returns {Record<string, string>} 环境变量。
     */
    function textToEnv(text) {
      const env = {}
      for (const raw of String(text).split('\n')) {
        const line = raw.trim()
        if (line === '' || line.startsWith('#')) continue
        const equals = line.indexOf('=')
        if (equals <= 0) continue
        const key = line.slice(0, equals).trim()
        if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue
        env[key] = line.slice(equals + 1)
      }
      return env
    }

    /**
     * 把 home 前缀缩成 `~`。
     *
     * @param {string} value - 绝对路径。
     * @param {string} home - home 路径。
     * @returns {string} 显示用路径。
     */
    function shortenHome(value, home) {
      const path = String(value ?? '')
      if (typeof home !== 'string' || home === '') return path
      if (path === home) return '~'
      return path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path
    }

    /**
     * 条目目录相对分组目录的写法。
     *
     * @param {string} dir - 条目目录。
     * @param {string} base - 分组目录。
     * @returns {string | undefined} 相对路径；不在其下时为 undefined。
     */
    function relativeDir(dir, base) {
      if (typeof dir !== 'string' || typeof base !== 'string' || base === '') return undefined
      if (dir === base) return '.'
      return dir.startsWith(`${base}/`) ? dir.slice(base.length + 1) : undefined
    }

    /**
     * 从清单文件路径反推 home：`<home>/.dsh/launcher/items.json`。
     *
     * @param {string} file - 清单文件路径。
     * @returns {string} home 路径；认不出时为空串。
     */
    function homeFromStoreFile(file) {
      const match = /^(.*)\/\.dsh\/launcher\/[^/]+$/.exec(String(file ?? ''))
      return match === null ? '' : match[1]
    }

    /**
     * 拖拽时，根据指针在目标行里的位置算出「插到哪之前」。
     *
     * 上半区 = 插到本行之前，下半区 = 插到下一行之前（下一行不存在就是末尾）。
     *
     * @param {{ top: number, height: number }} rect - 目标行矩形。
     * @param {number} clientY - 指针纵坐标。
     * @param {string} selfId - 目标行自己的 id。
     * @param {string | undefined} nextId - 下一行的 id（没有则 undefined）。
     * @returns {string | null} 应插在哪个 id 之前；null = 末尾。
     */
    function dropBefore(rect, clientY, selfId, nextId) {
      const after = clientY > rect.top + rect.height / 2
      if (!after) return selfId
      return nextId === undefined ? null : nextId
    }

    /**
     * 拖拽回调的兜底。
     *
     * 行/分组在没拿到 dnd 时（比如单独渲染一个行做测试）不该崩——拖拽是增强，
     * 不是行的存在前提。
     */
    const NOOP_DND = {
      startDrag: () => () => {},
      overGroup: () => () => {},
      overGroupBody: () => () => {},
      overItem: () => () => {},
      finishDrop: () => {},
      cancelDrag: () => {},
    }

    /**
     * 分组取色面板：一排色块 + 「自动」。
     *
     * @param {{
     *   anchor?: { left: number, right: number, top: number, bottom: number },
     *   current: string, auto: string, colors: string[],
     *   onPick: (color: string) => void, onClose: () => void,
     * }} props - 位置、当前色、派生色、调色板与回调。
     * @returns {any} React 节点。
     */
    function GroupColorPicker({ anchor, current, auto, colors, onPick, onClose }) {
      const position = menuPosition(anchor, 2)
      const dot = (value, label, title) => h('button', {
        key: label,
        style: {
          ...S.colorDot,
          background: value,
          ...(value === current ? { boxShadow: `0 0 0 2px var(--dsw-alias-bg-overlay), 0 0 0 3.5px ${value}` } : {}),
        },
        className: 'dsl-swatch',
        title,
        'aria-label': title,
        onClick: () => onPick(value),
      })
      return h('div', {
        style: { ...S.colorPanel, left: position.left, top: position.top },
        onMouseDown: event => event.stopPropagation(),
        onClick: event => event.stopPropagation(),
      },
        ...colors.map(value => dot(value, value, `用这个颜色（${value}）`)),
        h('button', {
          style: { ...S.ghostButton, padding: '0 6px', height: 22 },
          className: 'dsl-ghost',
          title: '跟分组自动派生（不指定颜色）',
          onClick: () => onPick(''),
        }, '自动'),
        h('button', {
          style: { ...S.iconButton, padding: '0 5px' },
          className: 'dsl-ghost',
          title: '关闭',
          onClick: onClose,
        }, '✕'),
      )
    }

    /**
     * 「运行」图标（实心三角）。
     *
     * 用 SVG 不用 ▶ 字符：几何字符在不同字体下大小/基线不一致，而这个按钮在列表里
     * 要重复出现几十次，歪一点就很明显。
     *
     * @param {{ size?: number }} [props] - 尺寸。
     * @returns {any} React 节点。
     */
    function RunIcon(props) {
      const edge = typeof props?.size === 'number' && props.size > 0 ? props.size : 13
      return h('svg', { width: edge, height: edge, viewBox: '0 0 16 16', 'aria-hidden': 'true', style: { display: 'block' } },
        h('path', { d: 'M5 3.4 12.4 8 5 12.6z', fill: 'currentColor', stroke: 'currentColor', strokeWidth: 1.2, strokeLinejoin: 'round' }),
      )
    }

    /**
     * 「停止」图标（实心圆角方块）。
     *
     * @param {{ size?: number }} [props] - 尺寸。
     * @returns {any} React 节点。
     */
    function StopIcon(props) {
      const edge = typeof props?.size === 'number' && props.size > 0 ? props.size : 13
      return h('svg', { width: edge, height: edge, viewBox: '0 0 16 16', 'aria-hidden': 'true', style: { display: 'block' } },
        h('rect', { x: 4, y: 4, width: 8, height: 8, rx: 1.6, fill: 'currentColor' }),
      )
    }

    /**
     * 拖拽时那条「插到这里」的指示线。
     *
     * 之前是 1 像素级的一条细线，用户反馈"看不出会落到哪"。现在加粗到 3px，
     * 左端再压一个小方块当箭头，位置也留出负边距让它压在行缝上。
     *
     * @param {'before' | 'after'} hint - 画在目标的上沿还是下沿。
     * @returns {any} React 节点。
     */
    function insertLine(hint) {
      const color = 'var(--dsw-alias-brand-primary)'
      return h('div', {
        'data-insert-line': hint,
        style: {
          position: 'absolute',
          left: 0,
          right: 0,
          height: 3,
          borderRadius: 2,
          background: color,
          boxShadow: '0 0 0 1px rgba(79, 107, 216, .28)',
          pointerEvents: 'none',
          zIndex: 4,
          ...(hint === 'after' ? { bottom: -2 } : { top: -2 }),
        },
      },
        h('span', {
          style: { position: 'absolute', left: 0, top: -1, width: 10, height: 5, borderRadius: 2, background: color },
        }),
      )
    }

    /** ⋯ 菜单的估算宽度与单行高度（用来夹取位置与判断是否该往上翻）。 */
    const MENU_WIDTH = 152
    const MENU_ROW_HEIGHT = 29
    const MENU_PADDING = 10
    const MENU_MARGIN = 8

    /**
     * 算出 ⋯ 菜单该出现在哪。
     *
     * 必须用 `position: fixed` 并按触发器位置算坐标：菜单原来挂在条目行里做
     * `absolute`，而左栏是 `overflow: auto` 的滚动容器——**绝对定位会被祖先裁掉**，
     * 于是"删除分组"右边缺一截、"改成一次性任务"被切。
     *
     * @param {{ left: number, right: number, top: number, bottom: number } | undefined} anchor - 触发按钮的矩形。
     * @param {number} rows - 菜单项数量（含分隔线，用来估高）。
     * @param {{ width?: number, height?: number }} [viewport] - 视口尺寸（测试可注入）。
     * @returns {{ left: number, top: number }} 视口坐标。
     */
    function menuPosition(anchor, rows, viewport) {
      const viewWidth = viewport?.width ?? (typeof window === 'undefined' ? 0 : window.innerWidth) ?? 0
      const viewHeight = viewport?.height ?? (typeof window === 'undefined' ? 0 : window.innerHeight) ?? 0
      const height = Math.max(rows, 1) * MENU_ROW_HEIGHT + MENU_PADDING
      if (anchor === undefined || anchor === null) return { left: MENU_MARGIN, top: MENU_MARGIN }
      // 右边缘对齐触发按钮，再夹进视口
      const limit = viewWidth > 0 ? viewWidth - MENU_WIDTH - MENU_MARGIN : Number.MAX_SAFE_INTEGER
      const left = Math.max(MENU_MARGIN, Math.min(anchor.right - MENU_WIDTH, limit))
      // 下方放不下就往上翻
      const below = anchor.bottom + 4
      const top = viewHeight > 0 && below + height > viewHeight - MENU_MARGIN
        ? Math.max(MENU_MARGIN, anchor.top - height - 4)
        : below
      return { left, top }
    }

    /**
     * 往输入框写的那句「引用」，而不是日志正文。
     *
     * 这是我们商量定的形态：滑选一段日志后，进对话的是一个**变量**
     * （`【启动器日志 run-4 Admin Service 第 12~45 行】`），模型据此回来取那几行。
     * 好处是不把十万字符塞进对话，引用本身又自带定位信息。
     *
     * @param {{ id: string, name?: string }} run - 运行视图。
     * @param {{ from: number, to: number } | null} range - 行范围；null 表示「关键行」。
     * @returns {string} 引用文本。
     */
    function formatReference(run, range) {
      const label = [run.id, run.name].filter(part => typeof part === 'string' && part !== '').join(' · ')
      // 草稿是纯文本节点（setDraft → $createTextNode），没有任何上色 API，
      // 所以「这是我引的日志」只能靠符号表达：【】是全角书名号式的强边界，
      // 在人眼和模型眼里都比普通括号更像「一段被引用的东西」。
      return range === null
        ? `【启动器日志 ${label} 关键行】`
        : `【启动器日志 ${label} 第 ${String(range.from)}~${String(range.to)} 行】`
    }

    /**
     * 把引用追加到现有草稿后面。
     *
     * @param {string} draft - 当前草稿。
     * @param {string} reference - 引用文本。
     * @returns {string} 新草稿。
     */
    function appendReference(draft, reference) {
      const base = String(draft ?? '')
      if (base.trim() === '') return reference
      return `${base.replace(/\s+$/, '')}\n${reference}`
    }

    /**
     * 从浏览器的选区里读出「第几行到第几行」。
     *
     * 日志每行都带 `data-line`，所以顺着选区两端的节点往上找最近的 `[data-line]`
     * 就能拿到准确范围——这比按字符数换算可靠得多。
     *
     * @param {any} selection - `window.getSelection()` 的结果。
     * @returns {{ from: number, to: number } | null} 行范围；没选中或选不到行时为 null。
     */
    function lineRangeFromSelection(selection) {
      if (selection === null || selection === undefined) return null
      const lineOf = (node) => {
        let current = node
        while (current !== null && current !== undefined) {
          const raw = current.dataset === undefined ? undefined : current.dataset.line
          if (raw !== undefined) {
            const value = Number.parseInt(raw, 10)
            if (Number.isSafeInteger(value) && value > 0) return value
          }
          current = current.parentElement ?? null
        }
        return undefined
      }
      const from = lineOf(selection.anchorNode)
      const to = lineOf(selection.focusNode)
      if (from === undefined || to === undefined) return null
      return { from: Math.min(from, to), to: Math.max(from, to) }
    }

    /** 「添加到对话」浮层的估算宽度 + 边距，用来把它夹在容器内。 */
    const POPOVER_WIDTH = 128
    const POPOVER_MARGIN = 8

    /**
     * 算出「添加到对话」浮层该出现在哪。
     *
     * 抽成纯函数是为了能测：几何计算最容易在小窗口/长选区下把按钮顶到屏幕外，
     * 而这类问题只有真跑起来才看得见。
     *
     * @param {any} selection - `window.getSelection()` 的结果。
     * @param {{ left?: number, top?: number, width?: number }} hostRect - 日志容器的边界。
     * @returns {{ from: number, to: number, left: number, top: number } | null} 位置；没选到行时为 null。
     */
    function popoverForSelection(selection, hostRect) {
      const range = lineRangeFromSelection(selection)
      if (range === null) return null
      const hostLeft = typeof hostRect?.left === 'number' ? hostRect.left : 0
      const hostTop = typeof hostRect?.top === 'number' ? hostRect.top : 0
      const hostWidth = typeof hostRect?.width === 'number' ? hostRect.width : 320
      // 兜底位置与夹取上界用同一个数，免得「兜底被自己夹一下」这种别扭。
      let left = hostWidth - POPOVER_WIDTH - POPOVER_MARGIN
      let top = POPOVER_MARGIN
      try {
        const rect = selection.rangeCount > 0 ? selection.getRangeAt(0).getBoundingClientRect() : null
        if (rect !== null && rect !== undefined && rect.width + rect.height > 0) {
          left = rect.left - hostLeft + rect.width / 2 - POPOVER_WIDTH / 2
          top = rect.top - hostTop - 36
        }
      } catch {
        // 拿不到几何就退回容器右上角。
      }
      const ceiling = Math.max(hostWidth - POPOVER_WIDTH - POPOVER_MARGIN, POPOVER_MARGIN)
      return {
        from: range.from,
        to: range.to,
        left: Math.max(POPOVER_MARGIN, Math.min(left, ceiling)),
        top: Math.max(POPOVER_MARGIN, top),
      }
    }

    /**
     * 选择变化之后浮层该处于什么状态。
     *
     * 三种结果：选区不再覆盖日志行 → 收起（这就是「我取消选择了，按钮还在」那个 bug）；
     * 选区有效但浮层本来没显示 → 保持不显示（避免只是划词就开始跟手抖动）；
     * 选区有效且浮层已显示 → 跟到新位置。
     *
     * @param {{ from: number, to: number, left: number, top: number } | null} current - 当前浮层。
     * @param {any} selection - `window.getSelection()`。
     * @param {{ left?: number, top?: number, width?: number } | undefined} hostRect - 日志容器边界。
     * @returns {{ from: number, to: number, left: number, top: number } | null} 新状态。
     */
    function nextPopover(current, selection, hostRect) {
      const next = popoverForSelection(selection, hostRect)
      if (next === null) return null
      return current === null ? null : next
    }

    /** 分组的项目色：一个分组永远是同一个颜色，多项目并行时靠它一眼区分。 */
    /**
     * 分组调色板：马卡龙色系。
     *
     * 选色约束（都有测试盯着，免得以后手滑塞进一个深色）：
     * - 亮度 L ≥ 0.72：柔和不刺眼，是这个色系的定义；
     * - 彩度跨度（max-min 通道差）在 30–110：太低发灰、太高就不是马卡龙了；
     * - 两两 RGB 距离 ≥ 30：色块只有 10px，糊成一片就失去"一眼区分分组"的意义。
     */
    const GROUP_COLORS = ['#a6c1f0', '#a3e0b4', '#f9cfa8', '#cbb9e8', '#f6b8c3', '#96d8e4', '#f5e88f', '#c8dfa6']

    /**
     * 由分组 id 稳定地取一个颜色。
     *
     * @param {string} id - 分组 id。
     * @returns {string} 颜色。
     */
    function groupColor(id) {
      let hash = 0
      for (const char of String(id)) hash = (hash * 31 + char.codePointAt(0)) % 9973
      return GROUP_COLORS[hash % GROUP_COLORS.length]
    }

    /**
     * 一个分组实际用的颜色：自定义优先，否则按 id 派生。
     *
     * 派生色是旧行为（改色之前所有分组都靠它），保留下来是为了**不强制用户选色**：
     * 新建分组照样有自己的颜色，想改再改。
     *
     * @param {{ id: string, color?: string }} group - 分组。
     * @returns {string} 颜色。
     */
    function resolveGroupColor(group) {
      const custom = typeof group?.color === 'string' ? group.color : ''
      return /^#[0-9a-fA-F]{6}$/.test(custom) ? custom : groupColor(group?.id ?? '')
    }

    /** 语义色：只用在状态上，其余保持中性——这样「有颜色」就等于「有信息」。 */
    const TONE_COLOR = {
      ok: 'var(--dsw-alias-state-success-primary)',
      warn: 'var(--dsw-alias-state-warn-primary)',
      error: 'var(--dsw-alias-state-error-primary)',
      // muted 用在提示文字上，所以用文字色而不是状态色（idle 圆点现在根本不显示）。
      muted: 'var(--dsw-alias-label-secondary)',
    }
    // 状态胶囊用实心底 + 白字：浅底浅字在浅色主题下对比度不够（「异常退出」看不清）。
    // 灰态（未跑/已停止）保持中性浅底——它不是要你注意的事。
    const TONE_CHIP = {
      // 实心底 + 底色文字：底色与语义色天然互为对比（深底主题里语义色偏亮、
      // 浅底主题里偏深），所以这组配色在两种主题下都成立。
      ok: { background: 'var(--dsw-alias-state-success-primary)', color: 'var(--dsw-alias-bg-base)', fontWeight: 600 },
      warn: { background: 'var(--dsw-alias-state-warn-primary)', color: 'var(--dsw-alias-bg-base)', fontWeight: 600 },
      error: { background: 'var(--dsw-alias-state-error-primary)', color: 'var(--dsw-alias-bg-base)', fontWeight: 600 },
      muted: { background: 'var(--dsw-alias-bg-layer-2)', color: 'var(--dsw-alias-label-secondary)' },
    }

    /** 还在跑的状态。 */
    const LIVE = new Set(['starting', 'running', 'stopping'])

    /**
     * 把一个运行实例说成一句人话——**性质不同，说法不同**：
     * 常驻服务退出是异常（要看见），一次性任务跑完就是完成（只看退出码）。
     *
     * @param {any} run - 运行视图；没有就跑过时为 null。
     * @param {'service' | 'task'} kind - 条目性质。
     * @returns {{ text: string, tone: 'ok' | 'warn' | 'error' | 'muted' }} 状态文案与色调。
     */
    function runState(run, kind) {
      const isTask = kind === 'task'
      if (run === null || run === undefined) return { text: isTask ? '未运行' : '未启动', tone: 'muted' }
      if (run.status === 'starting') return { text: '启动中', tone: 'warn' }
      if (run.status === 'running') return { text: '运行中', tone: 'ok' }
      if (run.status === 'stopping') return { text: '停止中', tone: 'warn' }
      if (run.status === 'stopped') return { text: '已停止', tone: 'muted' }
      if (run.status === 'failed') return { text: '启动失败', tone: 'error' }
      const code = run.exitCode === null || run.exitCode === undefined ? '?' : String(run.exitCode)
      if (isTask) {
        return run.exitCode === 0 ? { text: '已完成', tone: 'ok' } : { text: `失败（退出码 ${code}）`, tone: 'error' }
      }
      return run.exitCode === 0
        ? { text: '已退出（本该常驻）', tone: 'warn' }
        : { text: `异常退出（退出码 ${code}）`, tone: 'error' }
    }

    /**
     * 运行实例的一行事实：pid / 首字节 / 起止时间 / 退出码。
     *
     * @param {any} run - 运行视图。
     * @returns {string} 一行事实。
     */
    function runFacts(run) {
      const parts = []
      if (run.pid !== null && run.pid !== undefined) parts.push(`pid ${String(run.pid)}`)
      if (typeof run.firstOutputMs === 'number') parts.push(`首字节 ${(run.firstOutputMs / 1000).toFixed(2)}s`)
      if (run.startedAt !== undefined) parts.push(`起于 ${new Date(run.startedAt).toLocaleTimeString('zh-CN', { hour12: false })}`)
      if (run.endedAt !== null && run.endedAt !== undefined) parts.push(`止于 ${new Date(run.endedAt).toLocaleTimeString('zh-CN', { hour12: false })}`)
      if (run.signal) parts.push(`信号 ${String(run.signal)}`)
      return parts.join(' · ')
    }

    /**
     * 渲染日志正文。
     *
     * @param {{ text: string, truncated: boolean }} input - 日志文本与是否被主机截断。
     * @returns {any} React 节点。
     */
    function LogBody({ text, truncated, lineNumbers }) {
      const scheme = useAnsiScheme()
      const parsed = React.useMemo(() => parseAnsi(text, RENDER_LINE_LIMIT, scheme), [text, scheme])
      // 渲染的是尾部若干行，所以行号要按「这份文本的总行数」倒推，
      // 否则引用出来的「第 N 行」对不上宿主那边的行序。
      const totalLines = React.useMemo(() => (String(text ?? '') === '' ? 0 : String(text).split('\n').length), [text])
      const firstLineNumber = Math.max(totalLines - parsed.lines.length + 1, 1)
      if (text === '') {
        return h('div', { style: { color: 'var(--dsw-alias-label-secondary)', fontSize: 12, padding: '10px 2px' } }, '等待输出…')
      }
      const children = []
      if (truncated || parsed.dropped) {
        children.push(
          h('div', { key: 'folded', style: { color: 'var(--dsw-alias-label-secondary)', fontSize: 11, padding: '2px 0' } },
            '…… 更早的日志已折叠 ……'),
        )
      }
      for (let lineIndex = 0; lineIndex < parsed.lines.length; lineIndex += 1) {
        const spans = parsed.lines[lineIndex]
        const lineNumber = firstLineNumber + lineIndex
        const body = spans.length === 0
          ? '\u00a0'
          : spans.map((span, spanIndex) => h('span', { key: `s${String(spanIndex)}`, style: styleToCss(span.style) }, span.text))
        children.push(
          lineNumbers === true
            ? h('div', { key: `l${String(lineIndex)}`, 'data-line': String(lineNumber), style: { display: 'flex', gap: 8, minHeight: '1.35em' } },
                h('span', { style: { flex: '0 0 auto', minWidth: 38, textAlign: 'right', color: 'var(--dsw-alias-label-secondary)', userSelect: 'none' } }, String(lineNumber)),
                h('span', { style: { flex: 1, minWidth: 0, whiteSpace: 'pre-wrap', wordBreak: 'break-word' } }, body),
              )
            : h('div', { key: `l${String(lineIndex)}`, style: { whiteSpace: 'pre-wrap', wordBreak: 'break-word', minHeight: '1.35em' } }, body),
        )
      }
      return h('div', null, children)
    }

    // #endregion

    // #region 图标

    /**
     * 侧栏里的「启动器」图标（播放键）。
     *
     * @param {{ size: number, active: boolean }} props - 侧栏给的尺寸与选中态。
     * @returns {any} React 节点。
     */
    function LauncherIcon({ size, active }) {
      return h(
        'svg',
        { width: size, height: size, viewBox: '0 0 24 24', fill: 'none', 'aria-hidden': 'true', style: { display: 'block' } },
        h('path', {
          d: 'M8.4 4.8h7.2A3.6 3.6 0 0 1 19.2 8.4v7.2a3.6 3.6 0 0 1-3.6 3.6H8.4a3.6 3.6 0 0 1-3.6-3.6V8.4a3.6 3.6 0 0 1 3.6-3.6Z',
          stroke: 'currentColor',
          strokeWidth: active ? 1.9 : 1.6,
          strokeLinejoin: 'round',
          opacity: active ? 1 : 0.9,
        }),
        h('path', { d: 'M10.1 8.6 15.6 12l-5.5 3.4V8.6Z', fill: 'currentColor' }),
      )
    }

    // #endregion

    // #region 面板

    /** 样式。层级靠形态（章节头带底纹 / 条目是缩进行）与分隔（斑马纹 + 发丝线），不靠字号硬拉。 */
    const S = {
      // main 面板的父容器是「display:flex; flex-direction:column; overflow:hidden」的中间列。
      root: { display: 'flex', flexDirection: 'column', flex: '1 1 auto', height: '100%', minHeight: 0, minWidth: 0, background: 'var(--dsw-alias-bg-base)' },
      header: { padding: '11px 16px 9px', borderBottom: '0.5px solid var(--dsw-alias-border-l1)', display: 'flex', flexDirection: 'column', gap: 6 },
      headerRow: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' },
      title: { fontSize: 14, fontWeight: 600, color: 'var(--dsw-alias-label-primary)' },
      meta: { display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' },
      storeLine: { fontSize: 10.5, color: 'var(--dsw-alias-label-secondary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },

      button: {
        fontSize: 12,
        height: 26,
        lineHeight: '24px',
        padding: '0 10px',
        borderRadius: 6,
        border: '0.5px solid var(--dsw-alias-border-l1)',
        background: 'var(--dsw-alias-bg-layer-1)',
        color: 'var(--dsw-alias-label-primary)',
        cursor: 'pointer',
        whiteSpace: 'nowrap',
      },
      runButton: {
        fontSize: 12,
        height: 26,
        lineHeight: '26px',
        padding: '0 14px',
        borderRadius: 13,
        border: 'none',
        background: 'var(--dsw-alias-brand-primary)',
        color: 'var(--dsw-alias-bg-base)',
        cursor: 'pointer',
        whiteSpace: 'nowrap',
        fontWeight: 500,
      },
      stopButton: {
        fontSize: 12,
        height: 26,
        lineHeight: '24px',
        padding: '0 12px',
        borderRadius: 13,
        border: '0.5px solid var(--dsw-alias-state-error-primary)',
        background: 'transparent',
        color: 'var(--dsw-alias-state-error-primary)',
        cursor: 'pointer',
        whiteSpace: 'nowrap',
      },
      ghostButton: {
        fontSize: 12,
        height: 26,
        lineHeight: '24px',
        padding: '0 9px',
        borderRadius: 6,
        border: 'none',
        background: 'transparent',
        color: 'var(--dsw-alias-label-secondary)',
        cursor: 'pointer',
        whiteSpace: 'nowrap',
      },
      iconButton: {
        fontSize: 13,
        width: 26,
        height: 26,
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        borderRadius: 6,
        border: 'none',
        background: 'transparent',
        color: 'var(--dsw-alias-label-secondary)',
        cursor: 'pointer',
      },
      ghostDanger: { color: 'var(--dsw-alias-state-error-primary)' },
      input: {
        boxSizing: 'border-box',
        width: '100%',
        fontSize: 12,
        padding: '5px 8px',
        borderRadius: 6,
        border: '0.5px solid var(--dsw-alias-border-l1)',
        background: 'var(--dsw-alias-bg-base)',
        color: 'var(--dsw-alias-label-primary)',
      },
      mono: { fontFamily: 'var(--dsw-font-mono, ui-monospace, monospace)' },

      chip: {
        fontSize: 10.5,
        lineHeight: '17px',
        padding: '0 7px',
        borderRadius: 99,
        background: 'var(--dsw-alias-bg-layer-2)',
        color: 'var(--dsw-alias-label-secondary)',
        whiteSpace: 'nowrap',
        flex: '0 0 auto',
      },

      body: { display: 'flex', flex: 1, minHeight: 0 },
      // 左栏底色比主区深一档：它是「导航」，右栏是「内容」。
      list: { width: 392, minWidth: 300, flex: '0 0 auto', borderRight: '0.5px solid var(--dsw-alias-border-l1)', overflow: 'auto', background: 'var(--dsw-alias-bg-layer-1)', paddingBottom: 24 },
      filterRow: { padding: '8px 10px 6px', position: 'sticky', top: 0, zIndex: 6, background: 'var(--dsw-alias-bg-layer-1)' },

      // ——— 分组：整行是一条「章节头」，带项目色条 + 底纹，和条目完全不同的形态 ———
      groupHead: {
        position: 'sticky',
        top: 41,
        zIndex: 5,
        display: 'flex',
        alignItems: 'center',
        gap: 4,
        padding: '6px 8px 6px 9px',
        background: 'var(--dsw-alias-bg-layer-2)',
        borderTop: '0.5px solid var(--dsw-alias-border-l1)',
        borderBottom: '0.5px solid var(--dsw-alias-border-l1)',
      },
      groupToggle: {
        flex: 1,
        minWidth: 0,
        display: 'flex',
        flexDirection: 'column',
        gap: 2,
        alignItems: 'stretch',
        textAlign: 'left',
        background: 'transparent',
        border: 'none',
        padding: '2px 0',
        borderRadius: 6,
        color: 'inherit',
        cursor: 'pointer',
      },
      groupTitleRow: { display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 },
      caret: { fontSize: 9, color: 'var(--dsw-alias-label-secondary)', flex: '0 0 auto', width: 9, textAlign: 'center' },
      swatch: {
        flex: '0 0 auto',
        width: 10,
        height: 10,
        padding: 0,
        border: 'none',
        borderRadius: 3.5,
        cursor: 'pointer',
        // 浅色在小尺寸下必须有边界，否则在浅色主题里"糊"进背景
        boxShadow: '0 0 0 1px rgba(0, 0, 0, .12)',
      },
      colorPanel: {
        position: 'fixed',
        zIndex: 60,
        display: 'flex',
        alignItems: 'center',
        gap: 6,
        padding: '7px 9px',
        borderRadius: 10,
        background: 'var(--dsw-alias-bg-overlay)',
        border: '0.5px solid var(--dsw-alias-border-l1)',
        boxShadow: '0 8px 24px rgba(0, 0, 0, .16)',
      },
      colorDot: {
        width: 20,
        height: 20,
        padding: 0,
        border: 'none',
        borderRadius: 7,
        cursor: 'pointer',
        boxShadow: '0 0 0 1px rgba(0, 0, 0, .12)',
      },
      groupTitle: { fontSize: 13.5, fontWeight: 600, letterSpacing: 0.2, color: 'var(--dsw-alias-label-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
      groupMeta: { fontSize: 10.5, color: 'var(--dsw-alias-label-secondary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', paddingLeft: 15 },
      groupActions: { display: 'flex', alignItems: 'center', gap: 2, flex: '0 0 auto', position: 'relative' },

      // ——— 条目：缩进行 + 斑马纹 + 发丝线。有分隔才看得出「一条一条」 ———
      itemRow: {
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        padding: '7px 8px 7px 18px',
        borderTop: '0.5px solid var(--dsw-alias-border-l1)',
        cursor: 'pointer',
        position: 'relative',
      },
      itemRowAlt: { background: 'var(--dsw-alias-bg-layer-2)' },
      itemRowSelected: {
        background: 'var(--dsw-alias-bg-layer-2)',
        boxShadow: 'inset 2px 0 0 0 var(--dsw-alias-brand-primary)',
      },
      dot: { width: 8, height: 8, borderRadius: '50%', flex: '0 0 auto', boxSizing: 'border-box' },
      itemName: { fontSize: 12.5, fontWeight: 500, color: 'var(--dsw-alias-label-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
      itemActions: { display: 'flex', alignItems: 'center', gap: 2, flex: '0 0 auto', position: 'relative' },

      // ——— ⋯ 菜单 ———
      menu: {
        // fixed 而不是 absolute：左栏是滚动容器，absolute 会被它裁掉。
        position: 'fixed',
        zIndex: 60,
        minWidth: 132,
        padding: 4,
        borderRadius: 8,
        border: '0.5px solid var(--dsw-alias-border-l1)',
        background: 'var(--dsw-alias-bg-overlay)',
        boxShadow: '0 6px 20px rgba(0, 0, 0, .14)',
        display: 'flex',
        flexDirection: 'column',
        gap: 1,
      },
      menuItem: {
        fontSize: 12,
        textAlign: 'left',
        padding: '6px 9px',
        borderRadius: 6,
        border: 'none',
        background: 'transparent',
        color: 'var(--dsw-alias-label-primary)',
        cursor: 'pointer',
        whiteSpace: 'nowrap',
      },
      menuItemDanger: { color: 'var(--dsw-alias-state-error-primary)' },
      menuSeparator: { height: 1, margin: '3px 4px', background: 'var(--dsw-alias-border-l1)' },

      emptyLine: { fontSize: 11.5, color: 'var(--dsw-alias-label-secondary)', padding: '7px 10px 7px 18px' },

      // ——— 右栏：详情头 + 日志 ———
      right: { flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column' },
      detail: { padding: '12px 16px 10px', borderBottom: '0.5px solid var(--dsw-alias-border-l1)', display: 'flex', flexDirection: 'column', gap: 5 },
      detailTop: { display: 'flex', alignItems: 'flex-start', gap: 10, flexWrap: 'wrap' },
      detailTitleRow: { display: 'flex', alignItems: 'center', gap: 7, minWidth: 0, flexWrap: 'wrap' },
      detailTitle: { fontSize: 14.5, fontWeight: 600, color: 'var(--dsw-alias-label-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
      detailSub: { fontSize: 10.5, color: 'var(--dsw-alias-label-secondary)', marginTop: 2 },
      detailActions: { display: 'flex', alignItems: 'center', gap: 6, marginLeft: 'auto', flexWrap: 'wrap' },
      detailLine: { display: 'flex', gap: 8, fontSize: 11.5, lineHeight: 1.6, alignItems: 'baseline', minWidth: 0 },
      detailLabel: { flex: '0 0 auto', width: 34, color: 'var(--dsw-alias-label-secondary)' },
      detailValue: { flex: 1, minWidth: 0, color: 'var(--dsw-alias-label-secondary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
      orphanBar: { display: 'flex', alignItems: 'center', gap: 6, padding: '6px 12px', background: 'var(--dsw-alias-bg-layer-2)', fontSize: 11.5, color: 'var(--dsw-alias-state-warn-primary)', flexWrap: 'wrap' },
      log: {
        flex: 1,
        minHeight: 0,
        overflow: 'auto',
        padding: '10px 14px 18px',
        fontSize: 12,
        lineHeight: 1.5,
        fontFamily: 'var(--dsw-font-mono, ui-monospace, SFMono-Regular, Menlo, monospace)',
        background: 'var(--dsw-alias-bg-base)',
        color: 'var(--dsw-alias-label-primary)',
      },
      hintBox: { padding: '16px 12px', fontSize: 12, color: 'var(--dsw-alias-label-secondary)', lineHeight: 1.9 },

      // ——— 右栏「运行日志」tab ———
      logTabRoot: { display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0, background: 'var(--dsw-alias-bg-base)' },
      logTabHead: { padding: '9px 10px 8px', borderBottom: '0.5px solid var(--dsw-alias-border-l1)', display: 'flex', flexDirection: 'column', gap: 6 },
      // 运行实例选择器：一条轨道 + 浮起当前项，而不是三个等重的描边盒子。
      segTrack: {
        display: 'flex',
        alignItems: 'center',
        gap: 2,
        padding: 2,
        borderRadius: 8,
        background: 'var(--dsw-alias-bg-layer-2)',
        overflowX: 'auto',
        overflowY: 'hidden',
        scrollbarWidth: 'none',
      },
      segItem: {
        flex: '0 0 auto',
        display: 'inline-flex',
        alignItems: 'center',
        gap: 5,
        maxWidth: 176,
        padding: '3px 9px',
        borderRadius: 6,
        border: 'none',
        background: 'transparent',
        color: 'var(--dsw-alias-label-secondary)',
        fontSize: 11.5,
        lineHeight: '18px',
        cursor: 'pointer',
        whiteSpace: 'nowrap',
      },
      segItemActive: {
        background: 'var(--dsw-alias-bg-base)',
        color: 'var(--dsw-alias-label-primary)',
        fontWeight: 600,
        boxShadow: '0 1px 2px rgba(0, 0, 0, .1)',
      },
      segLabel: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
      segId: { color: 'var(--dsw-alias-label-secondary)', fontSize: 10.5, fontFamily: 'var(--dsw-font-mono, ui-monospace, monospace)' },
      // 「跟随最新」用小胶囊开关，不用浏览器原生 checkbox。
      pillToggle: {
        flex: '0 0 auto',
        fontSize: 11,
        lineHeight: '18px',
        height: 22,
        padding: '0 9px',
        borderRadius: 11,
        border: '0.5px solid var(--dsw-alias-border-l1)',
        background: 'transparent',
        color: 'var(--dsw-alias-label-secondary)',
        cursor: 'pointer',
        whiteSpace: 'nowrap',
      },
      pillToggleOn: {
        background: 'var(--dsw-alias-bg-layer-2)',
        borderColor: 'transparent',
        color: 'var(--dsw-alias-label-primary)',
        fontWeight: 600,
      },
      logTabBodyWrap: { flex: 1, minHeight: 0, position: 'relative' },
      logTabBody: { position: 'absolute', inset: 0, overflow: 'auto', padding: '8px 10px 14px', lineHeight: 1.5, fontFamily: 'var(--dsw-font-mono, ui-monospace, monospace)', color: 'var(--dsw-alias-label-primary)' },
      logTabFoot: { display: 'flex', alignItems: 'center', gap: 6, padding: '7px 10px', borderTop: '0.5px solid var(--dsw-alias-border-l1)', flexWrap: 'wrap' },
      code: {
        margin: 0,
        padding: '8px 10px',
        fontSize: 11,
        lineHeight: 1.6,
        whiteSpace: 'pre-wrap',
        background: 'var(--dsw-alias-bg-layer-1)',
        borderRadius: 6,
        color: 'var(--dsw-alias-label-primary)',
        fontFamily: 'var(--dsw-font-mono, ui-monospace, monospace)',
      },

      // ——— 表单 ———
      form: { border: '0.5px solid var(--dsw-alias-border-l1)', borderRadius: 8, padding: 10, margin: '6px 10px 8px', background: 'var(--dsw-alias-bg-base)', display: 'flex', flexDirection: 'column', gap: 8 },
      field: { display: 'flex', flexDirection: 'column', gap: 4 },
      fieldLabel: { fontSize: 11, fontWeight: 600, color: 'var(--dsw-alias-label-secondary)' },
      fieldHint: { fontSize: 10.5, fontWeight: 400, color: 'var(--dsw-alias-label-secondary)', marginLeft: 6 },
      formActions: { display: 'flex', gap: 6 },
      kindRow: { display: 'flex', gap: 6 },
      kindButton: {
        fontSize: 11.5,
        height: 26,
        lineHeight: '24px',
        padding: '0 10px',
        borderRadius: 13,
        border: '0.5px solid var(--dsw-alias-border-l1)',
        background: 'transparent',
        color: 'var(--dsw-alias-label-secondary)',
        cursor: 'pointer',
        whiteSpace: 'nowrap',
      },
      kindButtonActive: {
        background: 'var(--dsw-alias-bg-layer-2)',
        borderColor: 'transparent',
        color: 'var(--dsw-alias-label-primary)',
        fontWeight: 600,
      },
    }

    /**
     * 一个表单字段（标签 + 控件）。
     *
     * @param {{ label: string, hint?: string, children: any }} props - 内容。
     * @returns {any} React 节点。
     */
    function Field({ label, hint, children }) {
      return h('label', { style: S.field },
        h('span', { style: S.fieldLabel }, label, hint === undefined ? null : h('span', { style: S.fieldHint }, hint)),
        children,
      )
    }

    /**
     * ⋯ 菜单：条目/分组的次要操作都收在这里，列表上只留「运行/停止」。
     *
     * @param {{ entries: Array<{ label: string, onClick: Function, danger?: boolean, separator?: boolean }>, onClose: Function }} props - 菜单项与关闭回调。
     * @returns {any} React 节点。
     */
    function MoreMenu({ entries, onClose, anchor }) {
      const position = menuPosition(anchor, entries.length)
      return h('div', {
        style: { ...S.menu, left: position.left, top: position.top },
        onMouseDown: event => event.stopPropagation(),
        onClick: event => event.stopPropagation(),
      }, entries.map((entry, index) => [
        entry.separator === true ? h('div', { key: `s${String(index)}`, style: S.menuSeparator }) : null,
        h('button', {
          key: `e${String(index)}`,
          style: entry.danger === true ? { ...S.menuItem, ...S.menuItemDanger } : S.menuItem,
          className: 'dsl-menu-item',
          onClick: () => {
            onClose()
            entry.onClick()
          },
        }, entry.label),
      ]))
    }

    /**
     * 新建 / 编辑分组的内联表单。
     *
     * @param {any} props - { initial, onSave, onCancel, pickDirectory, busy }。
     * @returns {any} React 节点。
     */
    function GroupForm(props) {
      const initial = props.initial ?? { name: '', dir: '' }
      const [name, setName] = React.useState(initial.name ?? '')
      const [dir, setDir] = React.useState(initial.dir ?? '')
      const [problem, setProblem] = React.useState('')
      const save = () => {
        if (name.trim() === '' && dir.trim() === '') {
          setProblem('名称和目录至少要填一个')
          return
        }
        props.onSave({ name: name.trim(), dir: dir.trim() })
      }
      return h('div', { style: S.form },
        h(Field, { label: '分组名称', hint: '例如项目名' },
          h('input', {
            style: S.input,
            value: name,
            placeholder: '例如：demo-api',
            spellCheck: false,
            onChange: event => setName(event.target.value),
          }),
        ),
        h(Field, { label: '默认工作目录', hint: '组内条目没写目录时用它；留空则用你的 home' },
          h('div', { style: { display: 'flex', gap: 6 } },
            h('input', {
              style: { ...S.input, flex: 1, minWidth: 0, ...S.mono },
              value: dir,
              placeholder: '~/work/demo-api',
              spellCheck: false,
              onChange: event => setDir(event.target.value),
            }),
            h('button', {
              style: S.button,
              disabled: props.busy === true,
              onClick: () => {
                const picker = props.pickDirectory
                if (typeof picker !== 'function') return
                Promise.resolve(picker()).then((picked) => {
                  if (typeof picked === 'string' && picked !== '') setDir(picked)
                }, () => {})
              },
            }, '选择…'),
          ),
        ),
        problem === '' ? null : h('div', { style: { fontSize: 11, color: TONE_COLOR.error } }, problem),
        h('div', { style: S.formActions },
          h('button', { style: { ...S.button, background: 'var(--dsw-alias-brand-primary)', borderColor: 'transparent', color: 'var(--dsw-alias-bg-base)' }, disabled: props.busy === true, onClick: save }, '保存'),
          h('button', { style: S.button, disabled: props.busy === true, onClick: props.onCancel }, '取消'),
        ),
      )
    }

    /**
     * 新建 / 编辑启动项的内联表单。
     *
     * @param {any} props - { initial, groupDir, onSave, onCancel, busy }。
     * @returns {any} React 节点。
     */
    function ItemForm(props) {
      const initial = props.initial ?? { name: '', command: '', cwd: '', env: {}, kind: 'service' }
      const [name, setName] = React.useState(initial.name ?? '')
      const [command, setCommand] = React.useState(initial.command ?? '')
      const [cwd, setCwd] = React.useState(initial.cwd ?? '')
      const [envText, setEnvText] = React.useState(envToText(initial.env))
      const [kind, setKind] = React.useState(initial.kind === 'task' ? 'task' : 'service')
      const [problem, setProblem] = React.useState('')
      const save = () => {
        if (command.trim() === '') {
          setProblem('命令行不能为空')
          return
        }
        props.onSave({ name: name.trim(), command, cwd: cwd.trim(), env: textToEnv(envText), kind })
      }
      return h('div', { style: S.form },
        h(Field, { label: '名称', hint: '留空就用命令行首行' },
          h('input', {
            style: S.input,
            value: name,
            placeholder: 'MQTT采集 MqttCollector',
            spellCheck: false,
            onChange: event => setName(event.target.value),
          }),
        ),
        h(Field, {
          label: '性质',
          hint: kind === 'task' ? '跑完就该结束，只看退出码' : '本该一直挂着，退出了会标黄提醒',
        },
          h('div', { style: S.kindRow },
            h('button', { style: kind === 'service' ? { ...S.kindButton, ...S.kindButtonActive } : S.kindButton, onClick: () => setKind('service') }, '常驻服务'),
            h('button', { style: kind === 'task' ? { ...S.kindButton, ...S.kindButtonActive } : S.kindButton, onClick: () => setKind('task') }, '一次性任务'),
          ),
        ),
        h(Field, { label: '命令行', hint: '在 zsh 里原样执行的这一行' },
          h('textarea', {
            style: { ...S.input, ...S.mono, minHeight: 54, resize: 'vertical' },
            value: command,
            placeholder: 'mvn -pl :admin-service spring-boot:run',
            spellCheck: false,
            onChange: event => setCommand(event.target.value),
          }),
        ),
        h(Field, { label: '工作目录', hint: props.groupDir === '' ? '留空则在 home 下执行' : `留空则用分组目录 ${props.groupDir}` },
          h('input', {
            style: { ...S.input, ...S.mono },
            value: cwd,
            placeholder: props.groupDir === '' ? '/path/to/project' : props.groupDir,
            spellCheck: false,
            onChange: event => setCwd(event.target.value),
          }),
        ),
        h(Field, { label: '环境变量', hint: '每行 KEY=VALUE，可留空' },
          h('textarea', {
            style: { ...S.input, ...S.mono, minHeight: 42, resize: 'vertical' },
            value: envText,
            placeholder: 'SPRING_PROFILES_ACTIVE=dev',
            spellCheck: false,
            onChange: event => setEnvText(event.target.value),
          }),
        ),
        problem === '' ? null : h('div', { style: { fontSize: 11, color: TONE_COLOR.error } }, problem),
        h('div', { style: S.formActions },
          h('button', { style: { ...S.button, background: 'var(--dsw-alias-brand-primary)', borderColor: 'transparent', color: 'var(--dsw-alias-bg-base)' }, disabled: props.busy === true, onClick: save }, '保存'),
          h('button', { style: S.button, disabled: props.busy === true, onClick: props.onCancel }, '取消'),
        ),
      )
    }

    /**
     * 渲染一条启动项：缩进行 + 斑马纹 + 发丝分隔线，常显只有「运行/停止」和「⋯」。
     *
     * @param {{
     *   group: any, item: any, index: number, run: any, busy: string, selected: boolean,
     *   menuOpen: boolean, editing: any, home: string, actions: Record<string, Function>,
     * }} input - 一行需要的全部信息。
     * @returns {any} React 节点。
     */
    function renderItem(input) {
      const { group, item, index, run, busy, selected, menuOpen, editing, drag = null, dropHint, dnd = NOOP_DND, home, actions } = input
      const draggedItem = drag !== null && drag.kind === 'item' && drag.itemId === item.id
      if (editing !== null && editing.kind === 'item-edit' && editing.itemId === item.id) {
        return h(ItemForm, {
          key: item.id,
          initial: item,
          groupDir: group.dir,
          busy: busy !== '',
          onCancel: actions.cancelEdit,
          onSave: values => actions.saveItem(group.id, item.id, values),
        })
      }
      const state = runState(run, item.kind)
      // 点只在两种情况下出现：还在跑（绿）、异常退出（红）。其余一律不画。
      const dotTone = run === undefined
        ? null
        : (LIVE.has(run.status) ? 'ok' : (state.tone === 'error' ? 'error' : null))
      const isLive = run !== undefined && LIVE.has(run.status)
      const starting = busy === `start:${group.id}:${item.id}`

      const entries = [
        { label: '编辑', onClick: () => actions.editItem(group.id, item.id) },
        { label: '复制命令', onClick: () => actions.copy(item.command) },
        { label: '上移', onClick: () => actions.moveItem(group.id, item.id, -1) },
        { label: '下移', onClick: () => actions.moveItem(group.id, item.id, 1) },
        { label: item.kind === 'task' ? '改成常驻服务' : '改成一次性任务', onClick: () => actions.setKind(group.id, item, item.kind === 'task' ? 'service' : 'task') },
        { label: '删除', danger: true, separator: true, onClick: () => actions.removeItem(group.id, item) },
      ]

      return h('div', {
        key: item.id,
        className: 'dsl-row',
        // 整行是拖拽把手：同组内排序，拖到别的分组里即换组。
        draggable: true,
        onDragStart: dnd.startDrag({ kind: 'item', groupId: group.id, itemId: item.id }),
        onDragOver: (event) => {
          if (dnd.overItem(group, item, index)(event) === true) {
            event.preventDefault()
            event.stopPropagation()
          }
        },
        onDrop: dnd.finishDrop,
        onDragEnd: dnd.cancelDrag,
        style: {
          ...S.itemRow,
          ...(index % 2 === 1 ? S.itemRowAlt : null),
          ...(selected ? S.itemRowSelected : null),
          borderLeft: index === 0 ? undefined : undefined,
          opacity: draggedItem ? 0.45 : 1,
        },
        onClick: () => actions.select(group.id, item.id),
      },
        dropHint === null ? null : insertLine(dropHint),
        // 状态只用一个圆点表达（颜色 + tooltip）：命令/目录/性质都在右栏详情里，
        // 列表里重复一遍只是噪音——用户明确要求"就名称就行"。
        // 状态点的规则是用户定的：**没在跑就没有点**（连空心都不画），
        // 在跑一个绿点，异常退出一个红点。不显示时留一个等宽占位，
        // 否则名称会随状态左右跳动。
        h('span', {
          style: dotTone === null
            ? { ...S.dot, visibility: 'hidden' }
            : { ...S.dot, background: TONE_COLOR[dotTone] },
          title: dotTone === null ? undefined : state.text,
        }),
        h('span', { style: { ...S.itemName, flex: 1, minWidth: 0 }, title: `${item.name}\n${item.command}\n${state.text}` }, item.name),
        h('div', { style: S.itemActions, onClick: event => event.stopPropagation() },
          h('button', {
            // 一个图标代替整颗按钮：列表里几十行，文字按钮太重。
            style: isLive ? { ...S.iconButton, color: TONE_COLOR.error } : { ...S.iconButton, color: TONE_COLOR.ok },
            className: 'dsl-ghost',
            disabled: busy !== '',
            title: isLive ? '停止（发 SIGINT）' : (starting ? '启动中…' : '运行'),
            'aria-label': isLive ? '停止' : '运行',
            onClick: () => (isLive ? actions.stop(run.id) : actions.start(group.id, item.id)),
          }, h(isLive ? StopIcon : RunIcon, { size: 13 })),
          h('button', {
            style: menuOpen ? { ...S.iconButton, background: 'var(--dsw-alias-bg-layer-2)' } : S.iconButton,
            className: 'dsl-ghost',
            title: '更多操作',
            onClick: event => actions.openMenu('item', group.id, item.id, event.currentTarget.getBoundingClientRect()),
          }, '⋯'),
        ),
      )
    }

    /**
     * 渲染一个分组：顶格章节头（项目色条 + 底纹 + 粘顶）与缩进的条目列表。
     *
     * @param {{
     *   group: any, items: any[], collapsed: boolean, runningCount: number, busy: string,
     *   selected: any, editing: any, menuOpen: boolean, home: string,
     *   actions: Record<string, Function>, pickDirectory: Function, latestRunOf: Function,
     * }} input - 分组与渲染所需的全部信息。
     * @returns {any} React 节点。
     */
    function renderGroup(input) {
      const {
        group, items, collapsed, runningCount, busy, selected, editing, groupMenuOpen, itemMenu,
        drag = null, dropHint, dropTarget, dnd = NOOP_DND, itemDropHint = () => null, home, actions,
      } = input
      const draggedGroup = drag !== null && drag.kind === 'group' && drag.groupId === group.id
      // 单独渲染分组（测试、或以后别处复用）时不该因为没有这个动作就崩
      const canColor = typeof actions.canColor === 'function' ? actions.canColor() : true
      const color = resolveGroupColor(group)
      const entries = [
        { label: '编辑分组', onClick: () => actions.editGroup(group) },
        { label: '上移', onClick: () => actions.moveGroup(group.id, -1) },
        { label: '下移', onClick: () => actions.moveGroup(group.id, 1) },
        { label: '删除分组', danger: true, separator: true, onClick: () => actions.removeGroup(group) },
      ]

      const children = [
        h('div', {
          key: 'head',
          // 整块标题是拖拽把手：拖动排序；松手位置决定插到哪个分组之前。
          draggable: true,
          onDragStart: dnd.startDrag({ kind: 'group', groupId: group.id }),
          onDragOver: (event) => {
            if (dnd.overGroupHeader(group)(event) === true) {
              event.preventDefault()
              // 不阻止冒泡的话，事件会继续冒到分组区域，把"放进该组最前面"改写成"追加到末尾"
              event.stopPropagation()
            }
          },
          onDrop: dnd.finishDrop,
          onDragEnd: dnd.cancelDrag,
          style: {
            ...S.groupHead,
            opacity: draggedGroup ? 0.45 : 1,
            ...(dropTarget === true ? { background: 'var(--dsw-alias-bg-layer-2)' } : {}),
          },
        },

          h('button', {
            style: S.groupToggle,
            className: 'dsl-hoverable',
            title: collapsed ? '点击展开' : '点击收起',
            'aria-expanded': collapsed ? 'false' : 'true',
            onClick: () => actions.toggle(group.id),
          },
            h('div', { style: S.groupTitleRow },
              // 色块本身就是改色入口：比在 ⋯ 菜单里藏一层更好找。
              h('button', {
                style: { ...S.swatch, background: color, ...(canColor ? {} : { opacity: 0.45, cursor: 'not-allowed' }) },
                className: canColor ? 'dsl-swatch' : undefined,
                // 旧宿主会静默忽略颜色字段，所以直接禁用并说明，而不是让你点了以为坏了
                title: canColor ? '分组颜色，点击修改' : '分组颜色需要重启 DSH 后才能修改',
                'aria-label': '修改分组颜色',
                disabled: !canColor,
                onClick: (event) => {
                  event.stopPropagation()
                  if (!canColor) {
                    if (typeof actions.warnColorUnsupported === 'function') actions.warnColorUnsupported()
                    return
                  }
                  actions.openColor(group.id, event.currentTarget.getBoundingClientRect())
                },
              }),
              h('span', { style: S.caret }, collapsed ? '▸' : '▾'),
              h('span', { style: S.groupTitle, title: group.name }, group.name),
              h('span', { style: S.chip }, `${String(group.items.length)} 条`),
              runningCount > 0 ? h('span', { style: { ...S.chip, ...TONE_CHIP.ok } }, `${String(runningCount)} 运行中`) : null,
            ),
            h('div', { style: S.groupMeta, title: group.dir === '' ? '未设置默认工作目录' : group.dir },
              group.dir === '' ? '默认工作目录未设置（用 home）' : shortenHome(group.dir, home),
            ),
          ),
          h('div', { style: S.groupActions },
            h('button', { style: S.ghostButton, className: 'dsl-ghost', disabled: busy !== '', title: '在这个分组里新建启动项', onClick: () => actions.newItem(group.id) }, '＋ 条目'),
            h('button', {
              // 只有「按下」高亮：菜单本身由面板根部渲染（见 LauncherPanel），
              // 放在行里会被 sticky 表头那类祖先的层叠上下文盖住。
              style: groupMenuOpen ? { ...S.iconButton, background: 'var(--dsw-alias-bg-layer-2)' } : S.iconButton,
              className: 'dsl-ghost',
              title: '分组操作',
              onClick: event => actions.openMenu('group', group.id, null, event.currentTarget.getBoundingClientRect()),
            }, '⋯'),

          ),
        ),
      ]

      if (editing !== null && editing.kind === 'group-edit' && editing.groupId === group.id) {
        children.push(h(GroupForm, {
          key: 'group-form',
          initial: { name: group.name, dir: group.dir },
          busy: busy !== '',
          pickDirectory: input.pickDirectory,
          onCancel: actions.cancelEdit,
          onSave: values => actions.saveGroup(group.id, values),
        }))
      }

      if (!collapsed) {
        if (items.length === 0) {
          children.push(h('div', { key: 'empty', style: S.emptyLine },
            group.items.length === 0 ? '这个分组还没有启动项' : '没有匹配的启动项'))
        }
        items.forEach((item, index) => {
          children.push(renderItem({
            group,
            item,
            index,
            run: input.latestRunOf(item.id),
            busy,
            selected: selected !== null && selected.groupId === group.id && selected.itemId === item.id,
            menuOpen: itemMenu !== null && itemMenu !== undefined && itemMenu.itemId === item.id,
            menuAnchor: itemMenu === null || itemMenu === undefined ? undefined : itemMenu.anchor,
            editing,
            drag,
            dropHint: itemDropHint(group, item, index),
            dnd,
            home,
            actions,
          }))
        })
        if (editing !== null && editing.kind === 'item-new' && editing.groupId === group.id) {
          children.push(h(ItemForm, {
            key: 'item-form',
            initial: { name: '', command: '', cwd: '', env: {}, kind: 'service' },
            groupDir: group.dir,
            busy: busy !== '',
            onCancel: actions.cancelEdit,
            onSave: values => actions.saveItem(group.id, null, values),
          }))
        }
      }

      return h('div', {
        key: group.id,
        style: { marginBottom: 4, position: 'relative' },
        onDragOver: (event) => {
          // 分组区域：分组拖拽按"整块区域"的上下半区判定，条目拖拽落到空白处则追加到末尾
          if (dnd.overGroupSection(group, input.index ?? 0)(event) === true) {
            event.preventDefault()
            event.stopPropagation()
            return
          }
          if (dnd.overGroupBody(group)(event) === true) {
            event.preventDefault()
            event.stopPropagation()
          }
        },
        onDrop: dnd.finishDrop,
      }, dropHint === null ? children : [insertLine(dropHint), ...children])
    }

    /**
     * 主面板：左栏大纲树（分组 → 条目）+ 右栏详情头与实时日志。
     *
     * @param {any} props - 注入的 props（pickDirectory）。
     * @returns {any} React 节点。
     */
    function LauncherPanel(props) {
      const [groups, setGroups] = React.useState([])
      const [shell, setShell] = React.useState(null)
      const [storeFile, setStoreFile] = React.useState('')
      const [runs, setRuns] = React.useState([])
      const [capabilities, setCapabilities] = React.useState(null)
      // 初始值取自上次的视图：切走再回来还停在原来那一条上。
      const initialView = React.useMemo(() => loadView(), [])
      const [selection, setSelection] = React.useState(initialView.selection)
      const [log, setLog] = React.useState({ runId: null, text: '', truncated: false })
      const [filter, setFilter] = React.useState(initialView.filter)
      const [collapsed, setCollapsed] = React.useState(initialView.collapsed)
      const [editing, setEditing] = React.useState(null)
      const [menu, setMenu] = React.useState(null)
      const [error, setError] = React.useState('')
      const [notice, setNotice] = React.useState('')
      const [busy, setBusy] = React.useState('')
      // 拖拽：drag = 正在拖的东西，dropAt = 松手会落到哪（用来画插入线）
      const [drag, setDrag] = React.useState(null)
      const [dropAt, setDropAt] = React.useState(null)
      // 分组改色面板（跟 ⋯ 菜单一样渲染在面板根部，免得被行里的层叠上下文盖住）
      const [colorPicker, setColorPicker] = React.useState(null)
      const [follow, setFollow] = React.useState(initialView.follow)
      const [logFontSize, setLogFontSize] = React.useState(clampLogFont(initialView.logFontSize))

      // 「要看哪条日志」直接由选中条目推出，不再单独存一个 activeRunId：
      // 之前那个 state 在「恢复选中项」的路径上是空的，日志根本不会被拉取。
      const watchedRunRef = React.useRef(null)
      const offsetRef = React.useRef({ runId: null, next: 0 })
      const logRef = React.useRef({ runId: null, text: '', truncated: false })
      const scrollRef = React.useRef(null)
      const mountedRef = React.useRef(true)

      /** 某个条目最近一次运行（没有就是 undefined）。 */
      const latestRunOf = React.useCallback(itemId => runs
        .filter(run => run.itemId === itemId)
        .sort((left, right) => right.startedAt - left.startedAt)[0], [runs])

      // 选中项 → 它最近一次运行 → 右栏要看的日志。这层派生必须在下面那些 effect 之前
      // 算出来：effect 的依赖数组在渲染期求值，放后面会踩 TDZ。
      // 统一用 undefined 表示「没有运行实例」：null 会漏过 `=== undefined` 的分支判断。
      const selectedGroup = selection === null ? null : groups.find(group => group.id === selection.groupId) ?? null
      const selectedItem = selectedGroup === null || selection === null
        ? null
        : selectedGroup.items.find(item => item.id === selection.itemId) ?? null
      const selectedRun = selectedItem === null ? undefined : latestRunOf(selectedItem.id)
      // 轮询读日志时需要「当前该看哪条」，用 ref 交给 useCallback 里的 loadLog。
      watchedRunRef.current = selectedRun === undefined ? null : selectedRun.id
      const watchedId = selectedRun === undefined ? null : selectedRun.id

      /**
       * 拉一次清单 + 运行列表。
       *
       * @returns {Promise<void>} 无。
       */
      const loadState = React.useCallback(async () => {
        try {
          const payload = await request(API.state)
          if (!mountedRef.current) return
          const problem = stateProblem(payload)
          if (problem !== '') {
            setError(problem)
            return
          }
          setGroups(payload.groups)
          setShell(payload.shell ?? null)
          setStoreFile(typeof payload.storeFile === 'string' ? payload.storeFile : '')
          setRuns(Array.isArray(payload.runs) ? payload.runs : [])
          setCapabilities(Array.isArray(payload.capabilities) ? payload.capabilities : [])
          setError('')
        } catch (failure) {
          if (mountedRef.current) setError(failure instanceof Error ? failure.message : String(failure))
        }
      }, [])

      /** 只刷新运行列表（不重读清单）。 */
      const loadRuns = React.useCallback(async () => {
        try {
          const payload = await request(API.runs)
          if (mountedRef.current) setRuns(Array.isArray(payload.runs) ? payload.runs : [])
        } catch {
          // 轮询失败不打断面板：下个周期会再来一次。
        }
      }, [])

      /**
       * 拉当前选中运行实例的日志增量。
       *
       * @returns {Promise<void>} 无。
       */
      const loadLog = React.useCallback(async () => {
        const runId = watchedRunRef.current
        if (runId === null || runId === undefined) return
        const current = offsetRef.current
        const from = current.runId === runId ? current.next : 0
        try {
          const payload = await request(`${API.log}?run=${encodeURIComponent(runId)}&from=${String(from)}`)
          if (!mountedRef.current) return
          const base = current.runId === runId && from > 0 ? logRef.current : { runId, text: '', truncated: false }
          const nextText = payload.truncated === true ? payload.text : `${base.text}${payload.text}`
          logRef.current = { runId, text: nextText, truncated: payload.truncated === true }
          offsetRef.current = { runId, next: payload.next }
          setLog(logRef.current)
        } catch {
          // 同上：瞬时失败留给下个周期。
        }
      }, [])

      React.useEffect(() => {
        mountedRef.current = true
        void loadState()
        return () => {
          mountedRef.current = false
        }
      }, [loadState])

      React.useEffect(() => {
        const timer = window.setInterval(() => {
          void loadRuns()
          void loadLog()
        }, POLL_MS)
        return () => window.clearInterval(timer)
      }, [loadRuns, loadLog])

      // 取色面板：点外部或 Esc 收起（面板自己 stopPropagation）。
      React.useEffect(() => {
        if (colorPicker === null) return undefined
        const close = () => setColorPicker(null)
        const onKey = (event) => {
          if (event.key === 'Escape') setColorPicker(null)
        }
        document.addEventListener('mousedown', close)
        document.addEventListener('keydown', onKey)
        return () => {
          document.removeEventListener('mousedown', close)
          document.removeEventListener('keydown', onKey)
        }
      }, [colorPicker])

      // 菜单：点面板任何地方都收起（菜单自己 stopPropagation），Esc 也收。
      React.useEffect(() => {
        if (menu === null) return undefined
        const close = () => setMenu(null)
        const onKey = (event) => {
          if (event.key === 'Escape') setMenu(null)
        }
        document.addEventListener('mousedown', close)
        document.addEventListener('keydown', onKey)
        return () => {
          document.removeEventListener('mousedown', close)
          document.removeEventListener('keydown', onKey)
        }
      }, [menu])

      React.useEffect(() => {
        const node = scrollRef.current
        if (node === null || !follow) return
        node.scrollTop = node.scrollHeight
      }, [log, follow])

      // 换了一条要看日志的运行实例：游标归零，从头拉（宿主保留完整环形缓冲）。
      React.useEffect(() => {
        offsetRef.current = { runId: null, next: 0 }
        logRef.current = { runId: watchedId, text: '', truncated: false }
        setLog(logRef.current)
      }, [watchedId])

      // 记住视图：切面板/刷新页面之后回到原处。
      React.useEffect(() => {
        saveView({ selection, collapsed, filter, follow, logFontSize })
      }, [selection, collapsed, filter, follow, logFontSize])

      // 记忆里的选中项可能已经不存在了（条目被删/换了清单）：退到最近一次失败的
      // 运行，没有就退到最新一次，再没有才清空。
      React.useEffect(() => {
        if (selection === null || groups.length === 0) return
        const group = groups.find(candidate => candidate.id === selection.groupId)
        const item = group === undefined ? undefined : group.items.find(candidate => candidate.id === selection.itemId)
        if (item !== undefined) return
        const candidates = runs
          .filter(run => run.itemId !== undefined && run.itemId !== '')
          .sort((left, right) => right.startedAt - left.startedAt)
        const fallback = candidates.find(run => run.status === 'failed' || (run.status === 'exited' && run.exitCode !== 0 && run.exitCode !== null)) ?? candidates[0]
        setSelection(fallback === undefined ? null : { groupId: fallback.groupId, itemId: fallback.itemId })
      }, [selection, groups, runs])

      /** 选中条目：右栏跟着切到它（日志游标由下面的 effect 复位）。 */
      const select = React.useCallback((groupId, itemId) => {
        setSelection({ groupId, itemId })
        setMenu(null)
        setFollow(true)
      }, [])

      /**
       * 跑一个动作并统一处理忙碌态与错误。
       *
       * @param {string} key - 忙碌标记。
       * @param {() => Promise<void>} action - 动作。
       * @returns {Promise<void>} 无。
       */
      const runAction = React.useCallback(async (key, action) => {
        setBusy(key)
        try {
          await action()
          setError('')
        } catch (failure) {
          setError(failure instanceof Error ? failure.message : String(failure))
        } finally {
          if (mountedRef.current) setBusy('')
        }
      }, [])

      /**
       * 调一个写接口并用返回的清单刷新左栏。
       *
       * @param {string} key - 忙碌标记。
       * @param {string} url - 接口路径。
       * @param {Record<string, unknown>} body - 请求体。
       * @returns {Promise<void>} 无。
       */
      const mutate = (key, url, body) => runAction(key, async () => {
        const payload = await postJson(url, body)
        if (Array.isArray(payload.groups)) setGroups(payload.groups)
        if (Array.isArray(payload.runs)) setRuns(payload.runs)
      })

      /** 复制文本到剪贴板。 */
      const copy = (value) => {
        const clipboard = typeof navigator === 'undefined' ? undefined : navigator.clipboard
        if (clipboard === undefined) return
        clipboard.writeText(value).then(() => setNotice('已复制到剪贴板'), () => setNotice(''))
      }

      /** 删除前确认。 */
      const confirm = (message) => {
        const ask = typeof window === 'undefined' ? undefined : window.confirm
        return typeof ask === 'function' ? ask(message) : true
      }

      /**
       * 启动一条启动项，并把右栏切到它。
       *
       * @param {string} groupId - 分组 id。
       * @param {string} itemId - 条目 id。
       * @returns {Promise<void>} 无。
       */
      const startItem = (groupId, itemId) => runAction(`start:${groupId}:${itemId}`, async () => {
        const payload = await postJson(API.start, { group: groupId, item: itemId })
        if (Array.isArray(payload.runs)) setRuns(payload.runs)
        if (payload.run !== undefined) {
          select(groupId, itemId)
          setNotice('')
        }
      })

      /**
       * 停止 / 强制结束一个运行实例。
       *
       * @param {string} runId - 运行 id。
       * @param {boolean} force - 是否整棵树终止。
       * @returns {Promise<void>} 无。
       */
      const stopRun = (runId, force) => runAction(`stop:${runId}`, async () => {
        const payload = await postJson(API.stop, { run: runId, force })
        if (Array.isArray(payload.runs)) setRuns(payload.runs)
      })

      /**
       * 把 ⋯ 菜单渲染在**面板根部**。
       *
       * 以前它挂在条目行/分组头里面：分组头是 `sticky + z-index`（自成层叠上下文），
       * 菜单自己的 z-index 被关在里面，于是后面的分组行把它盖住（"编辑分组"看不见）；
       * 而且行里渲染让「同时只有一个菜单」只能靠传参约束——那段传参错过一次，
       * 两个菜单就一起冒出来了。放在根部，这两件事都变成结构性保证。
       *
       * @param {any} target - { menuKind, groupId, itemId, anchor }。
       * @returns {any} React 节点。
       */
      const renderMenu = (target) => {
        const targetGroup = groups.find(candidate => candidate.id === target.groupId)
        if (targetGroup === undefined) return null
        const entries = target.menuKind === 'group'
          ? [
              { label: '编辑分组', onClick: () => actions.editGroup(targetGroup) },
              { label: '上移', onClick: () => actions.moveGroup(targetGroup.id, -1) },
              { label: '下移', onClick: () => actions.moveGroup(targetGroup.id, 1) },
              { label: '删除分组', danger: true, separator: true, onClick: () => actions.removeGroup(targetGroup) },
            ]
          : (() => {
              const item = targetGroup.items.find(candidate => candidate.id === target.itemId)
              if (item === undefined) return null
              return [
                { label: '编辑', onClick: () => actions.editItem(target.groupId, item.id) },
                { label: '复制命令', onClick: () => actions.copy(item.command) },
                { label: '上移', onClick: () => actions.moveItem(target.groupId, item.id, -1) },
                { label: '下移', onClick: () => actions.moveItem(target.groupId, item.id, 1) },
                { label: item.kind === 'task' ? '改成常驻服务' : '改成一次性任务', onClick: () => actions.setKind(target.groupId, item, item.kind === 'task' ? 'service' : 'todo') },
                { label: '删除', danger: true, separator: true, onClick: () => actions.removeItem(targetGroup, item) },
              ]
            })()
        if (entries === null || entries.length === 0) return null
        return h(MoreMenu, { entries, onClose: actions.closeMenu, anchor: target.anchor })
      }

      /**
       * 这个条目是不是它所在分组的最后一条。
       *
       * @param {string} groupId - 分组 id。
       * @param {string} itemId - 条目 id。
       * @returns {boolean} 是否最后一条。
       */
      const isLastItem = (groupId, itemId) => {
        const group = groups.find(candidate => candidate.id === groupId)
        if (group === undefined) return false
        return group.items[group.items.length - 1]?.id === itemId
      }

      /** 分组该不该画插入线（含"放到整张清单末尾"）。 */
      const groupDropHint = index => {
        if (dropAt === null || dropAt.type !== 'group') return null
        if (dropAt.beforeGroupId === groups[index]?.id) return 'before'
        if (dropAt.beforeGroupId === null && index === groups.length - 1) return 'after'
        return null
      }

      /** 条目行该不该画插入线（含"追加到末尾"画在最后一行下方）。 */
      const itemDropHint = (group, item, index) => {
        if (dropAt === null || dropAt.type !== 'item' || dropAt.groupId !== group.id) return null
        if (dropAt.beforeItemId === item.id) return 'before'
        if (dropAt.beforeItemId === null && index === group.items.length - 1) return 'after'
        return null
      }

      /** 分组头是不是"条目要落进来的目标"（拖条目到分组头上时给点反馈）。 */
      const groupDropTarget = groupId => dropAt !== null && dropAt.type === 'item' && dropAt.groupId === groupId

      /** 抓取一个分组 / 条目。 */
      const startDrag = payload => (event) => {
        setDrag(payload)
        setDropAt(null)
        try {
          event.dataTransfer.effectAllowed = 'move'
          event.dataTransfer.setData('text/plain', payload.itemId ?? payload.groupId)
        } catch {
          // 某些环境不给 dataTransfer，不影响内部状态驱动的拖拽。
        }
      }

      /**
       * 落到整个分组区域上（分组拖拽走这里）。
       *
       * 用**整个分组区域**的矩形而不是只有标题：标题只有四十来像素高，拖分组时
       * 指针几乎总是落在条目区，按标题判定会得到"没有落点"，看起来就是"拖不动"。
       *
       * @param {any} group - 分组。
       * @param {number} index - 它在清单里的下标。
       * @returns {(event: any) => boolean} 事件处理；返回 true 表示接受这次落下。
       */
      const overGroupSection = (group, index) => (event) => {
        if (drag === null || drag.kind !== 'group') return false
        const before = dropBefore(event.currentTarget.getBoundingClientRect(), event.clientY, group.id, groups[index + 1]?.id)
        setDropAt({ type: 'group', beforeGroupId: before })
        return true
      }

      /** 条目落到分组头上 = 放进该组最前面。 */
      const overGroupHeader = group => (event) => {
        if (drag === null || drag.kind !== 'item') return false
        const firstId = group.items[0]?.id ?? null
        setDropAt({ type: 'item', groupId: group.id, itemId: firstId, beforeItemId: firstId })
        return true
      }

      /** 条目落到分组空白处 = 追加到该组末尾。 */
      const overGroupBody = group => (event) => {
        if (drag === null || drag.kind !== 'item') return false
        setDropAt({ type: 'item', groupId: group.id, itemId: null, beforeItemId: null })
        return true
      }

      /**
       * 条目落到某一行的上/下半区。
       *
       * 只接受**条目**拖拽；分组拖拽交给外层区域处理（不接受就不 preventDefault，
       * 让事件继续冒泡，指针也才不会显示成"可以放"）。
       *
       * @param {any} group - 所属分组。
       * @param {any} item - 目标条目。
       * @param {number} index - 目标条目下标。
       * @returns {(event: any) => boolean} 事件处理；返回 true 表示接受。
       */
      const overItem = (group, item, index) => (event) => {
        if (drag === null || drag.kind !== 'item') return false
        const before = dropBefore(event.currentTarget.getBoundingClientRect(), event.clientY, item.id, group.items[index + 1]?.id)
        setDropAt({ type: 'item', groupId: group.id, itemId: item.id, beforeItemId: before })
        return true
      }

      /**
       * 松手：结算一次拖拽。
       *
       * @param {any} [event] - drop 事件。
       * @returns {Promise<void>} 无。
       */
      const finishDrop = async (event) => {
        if (event !== undefined && typeof event.preventDefault === 'function') event.preventDefault()
        const target = dropAt
        const dragged = drag
        setDrag(null)
        setDropAt(null)
        if (dragged === null || target === null) return
        await runAction('drag', async () => {
          if (dragged.kind === 'group') {
            if (target.type !== 'group') return
            if (target.beforeGroupId === dragged.groupId) return
            const payload = await postJson(API.groupMoveTo, { id: dragged.groupId, before: target.beforeGroupId })
            if (Array.isArray(payload.groups)) setGroups(payload.groups)
            return
          }
          if (target.type !== 'item') return
          // 拖到自己身上、或本来就已在末尾：不白跑接口
          if (target.groupId === dragged.groupId && (target.beforeItemId === dragged.itemId
            || (target.beforeItemId === null && isLastItem(target.groupId, dragged.itemId)))) return
          const payload = await postJson(API.itemMoveTo, {
            group: dragged.groupId, item: dragged.itemId, toGroup: target.groupId, before: target.beforeItemId,
          })
          if (Array.isArray(payload.groups)) setGroups(payload.groups)
        })
      }

      /** 拖拽被取消（按 Esc、拖到窗外）。 */
      const cancelDrag = () => {
        setDrag(null)
        setDropAt(null)
      }

      /**
       * 选中一个颜色（空串 = 回到自动派生色）。
       *
       * @param {string} groupId - 分组 id。
       * @param {string} color - `#rrggbb` 或空串。
       * @returns {Promise<void>} 无。
       */
      const pickColor = async (groupId, color) => {
        setColorPicker(null)
        await runAction('color', async () => {
          const payload = await postJson(API.groupUpdate, { id: groupId, color })
          if (Array.isArray(payload.groups)) setGroups(payload.groups)
        })
      }

      const actions = {
        select,
        canColor: () => supportsGroupColor(capabilities),
        warnColorUnsupported: () => setNotice('宿主半侧是旧版，分组颜色要重启 DSH 之后才能改'),
        openColor: (groupId, anchor) => setColorPicker(current => (current !== null && current.groupId === groupId ? null : { groupId, anchor })),
        toggle: groupId => setCollapsed(current => ({ ...current, [groupId]: current[groupId] !== true })),
        openMenu: (menuKind, groupId, itemId, anchor) => setMenu(current => (current !== null && current.menuKind === menuKind && current.itemId === itemId
          ? null
          : { menuKind, groupId, itemId, anchor })),
        closeMenu: () => setMenu(null),
        cancelEdit: () => setEditing(null),
        newGroup: () => setEditing({ kind: 'group-new' }),
        editGroup: group => setEditing({ kind: 'group-edit', groupId: group.id }),
        saveGroup: (groupId, values) => {
          setEditing(null)
          void mutate('group', groupId === null ? API.groupCreate : API.groupUpdate,
            groupId === null ? { name: values.name, dir: values.dir } : { id: groupId, name: values.name, dir: values.dir })
        },
        removeGroup: (group) => {
          if (!confirm(`删除分组「${group.name}」？\n只会删掉这份清单里的定义，正在跑的进程不受影响。`)) return
          void mutate(`group-remove:${group.id}`, API.groupRemove, { id: group.id })
        },
        moveGroup: (groupId, delta) => { void mutate('group-move', API.groupMove, { id: groupId, delta }) },
        newItem: groupId => setEditing({ kind: 'item-new', groupId }),
        editItem: (groupId, itemId) => setEditing({ kind: 'item-edit', groupId, itemId }),
        saveItem: (groupId, itemId, values) => {
          setEditing(null)
          void mutate('item', itemId === null ? API.itemCreate : API.itemUpdate,
            itemId === null ? { group: groupId, ...values } : { group: groupId, item: itemId, ...values })
        },
        setKind: (groupId, item, kind) => { void mutate('item-kind', API.itemUpdate, { group: groupId, item: item.id, kind }) },
        removeItem: (groupId, item) => {
          if (!confirm(`删除启动项「${item.name}」？\n只会删掉定义，正在跑的进程不受影响。`)) return
          void mutate(`item-remove:${item.id}`, API.itemRemove, { group: groupId, item: item.id })
        },
        moveItem: (groupId, itemId, delta) => { void mutate('item-move', API.itemMove, { group: groupId, item: itemId, delta }) },
        start: startItem,
        stop: runId => { void stopRun(runId, false) },
        copy,
      }

      const keyword = filter.trim().toLowerCase()
      const itemMatches = item => keyword === ''
        || item.name.toLowerCase().includes(keyword)
        || item.command.toLowerCase().includes(keyword)

      const home = homeFromStoreFile(storeFile)
      const itemCount = groups.reduce((sum, group) => sum + group.items.length, 0)
      const runningCount = runs.filter(run => LIVE.has(run.status)).length
      // 条目被删了、进程还在跑：不能让它消失在面板上。
      const orphans = runs.filter(run => !groups.some(group => group.items.some(item => item.id === run.itemId)))
      const visibleGroups = keyword === ''
        ? groups
        : groups.filter(group => group.items.some(itemMatches) || group.name.toLowerCase().includes(keyword))

      const headerMeta = [
        `${String(groups.length)} 个分组`,
        `${String(itemCount)} 个启动项`,
        runningCount > 0 ? `${String(runningCount)} 个运行中` : '',
        shell === null ? '' : `shell ${shell.path} ${(shell.args ?? []).join(' ')}`,
      ].filter(text => text !== '')

      const header = h('div', { style: S.header },
        h('div', { style: S.headerRow },
          h('div', { style: S.title }, PANEL_TITLE),
          h('div', { style: S.meta }, headerMeta.map((text, index) => h('span', { key: `m${String(index)}`, style: S.chip }, text))),
          h('div', { style: { marginLeft: 'auto', display: 'flex', gap: 6 } },
            h('button', { style: { ...S.button, background: 'var(--dsw-alias-brand-primary)', borderColor: 'transparent', color: 'var(--dsw-alias-bg-base)' }, disabled: busy !== '', onClick: () => actions.newGroup() }, '＋ 新建分组'),
            h('button', { style: S.button, disabled: busy !== '', onClick: () => { void runAction('reload', () => loadState()) } }, busy === 'reload' ? '刷新中…' : '刷新'),
          ),
        ),
        storeFile === ''
          ? null
          : h('div', { style: S.storeLine, title: storeFile }, `清单 ${shortenHome(storeFile, home)}（也可以直接手改它）`),
        error === '' ? null : h('div', { style: { fontSize: 11, color: TONE_COLOR.error } }, error),
        capabilityNotice(capabilities) === ''
          ? null
          : h('div', { style: { fontSize: 11, color: TONE_COLOR.warn } }, capabilityNotice(capabilities)),
        notice === '' || error !== '' ? null : h('div', { style: { fontSize: 11, color: TONE_COLOR.muted } }, notice),
      )

      const emptyHint = h('div', { style: S.hintBox },
        h('div', { style: { color: 'var(--dsw-alias-label-primary)', fontWeight: 600 } }, '还没有分组'),
        h('div', { style: { marginTop: 6 } }, '一个分组 = 一个项目，组里放启动项，每条就是「一条命令行 + 一个工作目录」。点右上角「＋ 新建分组」，把工作目录设成项目根，再往里加条目，例如'),
        h('pre', { style: S.code }, '名称：Admin Service\n性质：常驻服务\n命令：mvn -pl :admin-service spring-boot:run\n目录：backend'),
        h('div', { style: { marginTop: 8 } }, '点「运行」就用真 PTY 开一个 zsh 在对应目录执行它；点条目行，右侧显示它的命令、目录与实时日志。'),
        storeFile === '' ? null : h('div', { style: { marginTop: 8, color: TONE_COLOR.muted } }, `清单存在 ${shortenHome(storeFile, home)}，直接编辑那个文件同样生效。`),
      )

      const listPane = h('div', { style: S.list },
        editing !== null && editing.kind === 'group-new'
          ? h(GroupForm, {
              initial: { name: '', dir: '' },
              busy: busy !== '',
              pickDirectory: props.pickDirectory,
              onCancel: actions.cancelEdit,
              onSave: values => actions.saveGroup(null, values),
            })
          : null,
        groups.length === 0 && !(editing !== null && editing.kind === 'group-new')
          ? emptyHint
          : h('div', null,
              h('div', { key: 'filter', style: S.filterRow },
                h('input', {
                  style: { ...S.input, flex: 1, minWidth: 0 },
                  value: filter,
                  placeholder: '筛选（分组名 / 条目名 / 命令）',
                  spellCheck: false,
                  onChange: event => setFilter(event.target.value),
                }),
              ),

              visibleGroups.map((group, groupIndex) => renderGroup({
                group,
                // 用**全量**下标：筛选时 visibleGroups 是子集，拿它的下标去查 groups 会错位
                index: groups.findIndex(candidate => candidate.id === group.id),
                items: group.items.filter(itemMatches),
                collapsed: collapsed[group.id] === true,
                runningCount: group.items.filter(item => {
                  const run = latestRunOf(item.id)
                  return run !== undefined && LIVE.has(run.status)
                }).length,
                busy,
                selected: selection,
                editing,
                // 分开两个布尔量：给分组传「条目菜单」会让两个菜单同时冒出来（真发生过）。
                isLast: groupIndex === visibleGroups.length - 1,
                groupMenuOpen: menu !== null && menu.menuKind === 'group' && menu.groupId === group.id,
                itemMenu: menu !== null && menu.menuKind === 'item' && menu.groupId === group.id ? menu : null,
                menuAnchor: menu === null ? undefined : menu.anchor,
                drag,
                dropHint: groupDropHint(groups.findIndex(candidate => candidate.id === group.id)),
                dropTarget: groupDropTarget(group.id),
                dnd: { startDrag, overGroupSection, overGroupHeader, overGroupBody, overItem, finishDrop, cancelDrag },
                itemDropHint,
                home,
                actions,
                pickDirectory: props.pickDirectory,
                latestRunOf,
              })),
            ),
      )

      const detailPane = (() => {
        if (selectedItem !== null) {
          const state = runState(selectedRun, selectedItem.kind)
          const isLive = selectedRun !== undefined && LIVE.has(selectedRun.status)
          const effectiveDir = selectedItem.cwd !== '' ? selectedItem.cwd : selectedGroup.dir
          const envEntries = Object.entries(selectedItem.env ?? {})
          const dirText = effectiveDir === '' ? 'home' : shortenHome(effectiveDir, home)
          return h('div', { style: S.detail },
            h('div', { style: S.detailTop },
              h('div', { style: { minWidth: 0, flex: 1 } },
                h('div', { style: S.detailTitleRow },
                  h('span', { style: S.detailTitle, title: selectedItem.name }, selectedItem.name),
                  h('span', { style: { ...S.chip, ...TONE_CHIP[state.tone] } }, state.text),
                  h('span', { style: S.chip }, selectedItem.kind === 'task' ? '一次性任务' : '常驻服务'),
                ),
                h('div', { style: S.detailSub }, `${selectedGroup.name} · ${dirText}`),
              ),
              h('div', { style: S.detailActions },
                isLive
                  ? h('button', { style: S.stopButton, className: 'dsl-stop', disabled: busy !== '', onClick: () => { void stopRun(selectedRun.id, false) } }, '停止')
                  : h('button', { style: S.runButton, className: 'dsl-primary', disabled: busy !== '', onClick: () => { void startItem(selectedGroup.id, selectedItem.id) } }, busy === `start:${selectedGroup.id}:${selectedItem.id}` ? '启动中…' : '运行'),
                isLive
                  ? h('button', { style: S.ghostButton, className: 'dsl-ghost', disabled: busy !== '', onClick: () => { void stopRun(selectedRun.id, true) } }, '强制结束')
                  : null,
                h('button', { style: S.ghostButton, className: 'dsl-ghost', disabled: busy !== '', onClick: () => actions.editItem(selectedGroup.id, selectedItem.id) }, '编辑'),
                h('button', { style: S.ghostButton, className: 'dsl-ghost', onClick: () => copy(selectedItem.command) }, '复制命令'),
                isLive
                  ? h('button', { style: S.ghostButton, className: 'dsl-ghost', disabled: busy !== '', onClick: () => { void runAction(`clear:${selectedRun.id}`, async () => {
                      await postJson(API.clear, { run: selectedRun.id })
                      offsetRef.current = { runId: selectedRun.id, next: 0 }
                      logRef.current = { runId: selectedRun.id, text: '', truncated: false }
                      setLog(logRef.current)
                    }) } }, '清空日志')
                  : null,
              ),
            ),
            h('div', { style: S.detailLine },
              h('span', { style: S.detailLabel }, '命令'),
              h('span', { style: { ...S.detailValue, ...S.mono }, title: selectedItem.command }, selectedItem.command),
            ),
            h('div', { style: S.detailLine },
              h('span', { style: S.detailLabel }, '目录'),
              h('span', { style: { ...S.detailValue, ...S.mono }, title: effectiveDir }, dirText),
            ),
            envEntries.length === 0
              ? null
              : h('div', { style: S.detailLine },
                  h('span', { style: S.detailLabel }, '环境'),
                  h('span', { style: { ...S.detailValue, ...S.mono }, title: envToText(selectedItem.env).replace(/\n/g, '  ') },
                    envEntries.map(([key, value]) => `${key}=${value}`).join('  ')),
                ),
            selectedRun === undefined
              ? null
              : h('div', { style: S.detailLine },
                  h('span', { style: S.detailLabel }, '运行'),
                  h('span', { style: S.detailValue }, runFacts(selectedRun)),
                ),
            selectedRun === undefined || (selectedRun.logFile ?? '') === ''
              ? null
              : h('div', { style: S.detailLine },
                  h('span', { style: S.detailLabel }, '日志'),
                  h('span', { style: { ...S.detailValue, ...S.mono }, title: selectedRun.logFile }, shortenHome(selectedRun.logFile, home)),
                  h('button', { style: S.ghostButton, className: 'dsl-ghost', onClick: () => copy(selectedRun.logFile) }, '复制路径'),
                ),
          )
        }
        return h('div', { style: S.detail },
          h('div', { style: S.detailTitle }, '还没有选中启动项'),
          h('div', { style: { fontSize: 11.5, color: TONE_COLOR.muted, marginTop: 3 } }, '点左边任意一条，这里显示它的命令、目录、环境变量与实时日志。'),
        )
      })()

      const orphanBar = orphans.length === 0
        ? null
        : h('div', { style: S.orphanBar },
            h('span', null, `有 ${String(orphans.length)} 个进程的条目已被删除：${orphans.map(run => run.name).join('、')}`),
            orphans.map(run => h('button', {
              key: run.id,
              style: S.ghostButton,
              className: 'dsl-ghost',
              onClick: () => { void stopRun(run.id, true) },
            }, `结束 ${run.name}`)),
          )

      const logPane = h('div', { style: S.right },
        detailPane,
        orphanBar,
        h('div', {
          ref: scrollRef,
          style: { ...S.log, fontSize: logFontSize },
          onScroll: (event) => {
            const node = event.currentTarget
            setFollow(node.scrollHeight - node.scrollTop - node.clientHeight < 40)
          },
        },
          selectedRun === undefined
            ? h('div', { style: { fontFamily: 'inherit', textAlign: 'center', paddingTop: 52, color: TONE_COLOR.muted, lineHeight: 1.9 } },
                h('div', { style: { fontSize: 13, color: 'var(--dsw-alias-label-secondary)' } }, selectedItem === null ? '选中一条启动项' : '这条还没有跑过'),
                h('div', { style: { fontSize: 12 } }, selectedItem === null ? '左边点一条，再点「运行」。' : '点上面的「运行」，输出会实时出现在这里。'),
                h('div', { style: { fontSize: 11 } }, '停止 = Ctrl+C（SIGINT），「强制结束」才整棵进程树终止。'),
              )
            : h(LogBody, { text: log.runId === selectedRun.id ? log.text : '', truncated: log.truncated === true }),
        ),
        !follow && selectedRun !== undefined
          ? h('div', { style: { padding: '4px 12px', borderTop: '0.5px solid var(--dsw-alias-border-l1)' } },
              h('button', { style: S.button, onClick: () => setFollow(true) }, '回到底部'))
          : null,
      )

      return h('div', { style: S.root, 'data-dsh-launcher': '' },
        header,
        h('div', { style: S.body }, listPane, logPane),
        menu === null ? null : renderMenu(menu),
        colorPicker === null ? null : (() => {
          const target = groups.find(group => group.id === colorPicker.groupId)
          if (target === undefined) return null
          return h(GroupColorPicker, {
            anchor: colorPicker.anchor,
            current: resolveGroupColor(target),
            auto: groupColor(target.id),
            colors: GROUP_COLORS,
            onPick: color => { void pickColor(target.id, color) },
            onClose: () => setColorPicker(null),
          })
        })(),
      )
    }

    // #endregion


    // #region 右栏「运行日志」tab

    /** 右栏 tab 的类型 id（也是 body slot 的 key）。 */
    const LOG_TAB_ID = 'dsh-project-runner/log'
    /** tab.kind。 */
    const LOG_TAB_KIND = 'launcher-log'

    /**
     * 「运行日志」的图标：一页带行的文本。
     *
     * 原来没给 `icon`，侧栏只能拿默认兜底（一个方盒），跟"日志"毫无关系；
     * 这里自己画一个，不依赖 primitives 的美术件——第三方 bundle 去 require
     * 平台模块表里的东西有解析风险，而画一个 20×20 的图标不值得冒这个险。
     *
     * @param {{ size?: number }} [props] - 侧栏给的尺寸（可能不给）。
     * @returns {any} React 节点。
     */
    function LogTabIcon(props) {
      const edge = typeof props?.size === 'number' && props.size > 0 ? props.size : 18
      return h('svg', { width: edge, height: edge, viewBox: '0 0 20 20', fill: 'none', 'aria-hidden': 'true', style: { display: 'block' } },
        // 页面轮廓 + 右上折角 = 「一页文件」
        h('path', { d: 'M5.4 2.8h5.9l3.3 3.3v11.1H5.4z', stroke: 'var(--dsw-alias-brand-primary)', strokeWidth: 1.5, strokeLinejoin: 'round' }),
        h('path', { d: 'M11.3 2.8v3.3h3.3', stroke: 'var(--dsw-alias-brand-primary)', strokeWidth: 1.5, strokeLinejoin: 'round' }),
        // 三行长短不一的输出行 = 「日志」
        h('path', { d: 'M7.7 9.6h4.6M7.7 12h4.6M7.7 14.4h2.9', stroke: 'currentColor', strokeWidth: 1.4, strokeLinecap: 'round', opacity: 0.75 }),
      )
    }

    /**
     * 右栏日志 tab 的标题（图标 + 文字，和其他 tab 一致）。
     *
     * @returns {any} React 节点。
     */
    function LogTabTitle() {
      return h('span', { style: { display: 'inline-flex', alignItems: 'center', gap: 5 } },
        h(LogTabIcon, { size: 14 }),
        '运行日志',
      )
    }

    /**
     * 右栏「运行日志」tab：选中条目的实时日志，可滑选后把「引用」写进对话输入框。
     *
     * 为什么在右栏：`main` 是 keyed 单槽，启动器和对话都想要它，天生无法同屏；
     * 而右栏 tab body 是**能拿到 `inputActions` 的插槽**，所以「添加到对话」只有
     * 放在这里才成立（`inputActions.setDraft` 是唯一能写进输入框的公开 API）。
     *
     * @param {any} props - 标准 props（useInput / inputActions / sessionId …）。
     * @returns {any} React 节点。
     */
    function LogTab(props) {
      const initialView = React.useMemo(() => loadView(), [])
      const [runs, setRuns] = React.useState([])
      const [pinnedId, setPinnedId] = React.useState(null)
      const [followNewest, setFollowNewest] = React.useState(true)
      const [log, setLog] = React.useState({ runId: null, text: '', truncated: false })
      const [fontSize, setFontSize] = React.useState(clampLogFont(initialView.logFontSize))
      // 滑选之后浮在选区旁边的「添加到对话」；null 表示没在选。
      const [popover, setPopover] = React.useState(null)
      const [notice, setNotice] = React.useState('')
      const [busy, setBusy] = React.useState('')
      // 「面板里的日志被清空了」和「这条实例还没产出过」是两件事，界面要分开说。
      const [cleared, setCleared] = React.useState(false)

      const offsetRef = React.useRef({ runId: null, next: 0 })
      const logRef = React.useRef({ runId: null, text: '', truncated: false })
      const wantedRef = React.useRef(null)
      const scrollRef = React.useRef(null)
      const bodyRef = React.useRef(null)
      const mountedRef = React.useRef(true)

      // useInput 是这个插槽给的标准 hook；测试里传桩函数，真机上传真 hook。
      const useInputHook = typeof props.useInput === 'function' ? props.useInput : () => null
      const input = useInputHook(state => state)

      const newestFailed = React.useCallback((list) => {
        const sorted = [...list].sort((left, right) => right.startedAt - left.startedAt)
        return sorted.find(run => run.status === 'failed' || (run.status === 'exited' && run.exitCode !== 0 && run.exitCode !== null)) ?? sorted[0]
      }, [])

      const wanted = followNewest || pinnedId === null
        ? newestFailed(runs)
        : runs.find(run => run.id === pinnedId)
      wantedRef.current = wanted === undefined ? null : wanted.id
      const wantedId = wanted === undefined ? null : wanted.id

      const loadRuns = React.useCallback(async () => {
        try {
          const payload = await request(API.runs)
          if (mountedRef.current) setRuns(Array.isArray(payload.runs) ? payload.runs : [])
        } catch {
          // 轮询失败不打断面板。
        }
      }, [])

      const loadLog = React.useCallback(async () => {
        const runId = wantedRef.current
        if (runId === null) return
        const current = offsetRef.current
        const from = current.runId === runId ? current.next : 0
        try {
          const payload = await request(`${API.log}?run=${encodeURIComponent(runId)}&from=${String(from)}`)
          if (!mountedRef.current) return
          const base = current.runId === runId && from > 0 ? logRef.current : { runId, text: '', truncated: false }
          const nextText = payload.truncated === true ? payload.text : `${base.text}${payload.text}`
          logRef.current = { runId, text: nextText, truncated: payload.truncated === true }
          offsetRef.current = { runId, next: payload.next }
          setLog(logRef.current)
        } catch {
          // 同上。
        }
      }, [])

      React.useEffect(() => {
        mountedRef.current = true
        void loadRuns()
        void loadLog()
        const timer = window.setInterval(() => {
          void loadRuns()
          void loadLog()
        }, POLL_MS)
        return () => {
          mountedRef.current = false
          window.clearInterval(timer)
        }
      }, [loadRuns, loadLog])

      // 换了要看的那条：游标归零从头拉。
      React.useEffect(() => {
        offsetRef.current = { runId: null, next: 0 }
        logRef.current = { runId: wantedId, text: '', truncated: false }
        setLog(logRef.current)
        setPopover(null)
        setCleared(false)
      }, [wantedId])

      React.useEffect(() => {
        const node = scrollRef.current
        if (node !== null) node.scrollTop = node.scrollHeight
      }, [log])

      // 浮层的显隐交给「选择变化」而不是只看 mouseup：
      // 取消选择（点空白、按 Esc、用键盘选）都不会再触发 mouseup，
      // 光靠 mouseup 就会留下一个点不动的按钮。
      React.useEffect(() => {
        if (popover === null) return undefined
        if (typeof document === 'undefined') return undefined
        const onSelectionChange = () => {
          const selection = typeof window === 'undefined' ? null : window.getSelection()
          const host = bodyRef.current === null ? undefined : bodyRef.current.getBoundingClientRect()
          setPopover(current => nextPopover(current, selection, host))
        }
        const onKeyDown = (event) => {
          if (event.key === 'Escape') setPopover(null)
        }
        document.addEventListener('selectionchange', onSelectionChange)
        document.addEventListener('keydown', onKeyDown)
        return () => {
          document.removeEventListener('selectionchange', onSelectionChange)
          document.removeEventListener('keydown', onKeyDown)
        }
      }, [popover])

      // 字号沿用面板视图那份记忆：右栏和主面板的日志区一起变。
      React.useEffect(() => {
        saveView({ ...loadView(), logFontSize: fontSize })
      }, [fontSize])

      /**
       * 往对话输入框追加一句引用。
       *
       * @param {string} reference - 引用文本。
       * @returns {void}
       */
      const addToDraft = (reference) => {
        const actions = props.inputActions
        if (actions === undefined || typeof actions.setDraft !== 'function') {
          setNotice('这个位置拿不到对话输入框')
          return
        }
        actions.setDraft(appendReference(input === null || input === undefined ? '' : input.draft, reference))
        setNotice(reference)
      }

      /**
       * 在日志里滑选之后，把「添加到对话」浮到选区旁边。
       *
       * 不放在页脚是刻意的：这东西是**选区驱动的**，出现在你刚选完的地方才顺手；
       * 固定按钮既占地方，又要你先跑上去滑、再跑回下面点。
       *
       * @param {any} event - mouseup 事件。
       * @returns {void}
       */
      const onLogMouseUp = (event) => {
        if (wanted === undefined) return
        const selection = typeof window === 'undefined' ? null : window.getSelection()
        const host = event.currentTarget.getBoundingClientRect()
        setPopover(nextPopover({ from: 0, to: 0, left: 0, top: 0 }, selection, host))
      }

      /** 把当前选区的引用写进对话输入框，并收起浮层、清掉选区。 */
      const quoteSelection = () => {
        if (popover === null || wanted === undefined) return
        addToDraft(formatReference(wanted, { from: popover.from, to: popover.to }))
        setPopover(null)
        const selection = typeof window === 'undefined' ? null : window.getSelection()
        if (selection !== null && typeof selection.removeAllRanges === 'function') selection.removeAllRanges()
      }

      /**
       * 调一个写接口并立刻刷新运行列表。
       *
       * 停服务的动作必须在**看得见日志的地方**能做：你可能正是盯着一段卡住的
       * 输出才发现要停它，这时跑回启动器面板找那条条目是反向操作。
       *
       * @param {string} key - 忙碌标记。
       * @param {string} url - 接口路径。
       * @param {Record<string, unknown>} body - 请求体。
       * @param {string} done - 成功后的提示。
       * @returns {Promise<void>} 无。
       */
      const act = async (key, url, body, done) => {
        setBusy(key)
        try {
          const payload = await postJson(url, body)
          if (Array.isArray(payload.runs)) setRuns(payload.runs)
          setNotice(done)
          setTimeout(() => { void loadRuns() }, 60)
        } catch (error) {
          setNotice(error instanceof Error ? error.message : String(error))
        } finally {
          if (mountedRef.current) setBusy('')
        }
      }

      /** 复制日志文件路径（点标题里的路径即可）。 */
      const copyPath = (value) => {
        const clipboard = typeof navigator === 'undefined' ? undefined : navigator.clipboard
        if (clipboard === undefined) return
        clipboard.writeText(value).then(() => setNotice('已复制日志路径'), () => setNotice(''))
      }

      /** 调字号。 */
      const stepFont = (delta) => {
        setFontSize(current => Math.min(Math.max(clampLogFont(current) + delta, LOG_FONT_MIN), LOG_FONT_MAX))
      }

      // 同名运行实例重名时补一个 id 后缀，否则分段控件里两个一模一样的标签没法分辨。
      const nameCounts = {}
      for (const run of runs) nameCounts[run.name] = (nameCounts[run.name] ?? 0) + 1
      // 当前项右边已经挂了一个 id 标识，标签里就别再重复一次后缀。
      const runLabel = (run, active) => (nameCounts[run.name] > 1 && active !== true ? `${run.name} · ${run.id}` : run.name)

      // 「跟随最新」只在**有可跟的东西**时才出现：一个实例都没有（或只有一个）时，
      // 这个开关既没有作用也让人费解。
      const switcher = runs.length >= 2

      const header = h('div', { style: S.logTabHead },
        h('div', { style: { display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' } },
          h('span', { style: { fontSize: 12, fontWeight: 600, color: 'var(--dsw-alias-label-primary)' } }, '运行日志'),
          wanted === undefined
            ? null
            : h('span', { style: { ...S.chip, ...TONE_CHIP[runState(wanted, wanted.kind).tone] } }, runState(wanted, wanted.kind).text),
          switcher
            ? h('button', {
                style: followNewest ? { ...S.pillToggle, ...S.pillToggleOn } : S.pillToggle,
                className: 'dsl-ghost',
                title: '自动跟到最近一次失败的运行；关掉就钉在你看的那条上',
                onClick: () => setFollowNewest(current => !current),
              }, followNewest ? '跟随最新 ✓' : '已钉住')
            : null,
          wanted === undefined
            ? null
            : h('div', { style: { marginLeft: 'auto', display: 'flex', gap: 6, alignItems: 'center' } },
                LIVE.has(wanted.status)
                  ? h('button', {
                      style: S.stopButton,
                      className: 'dsl-stop',
                      disabled: busy !== '',
                      title: '发 SIGINT（等于 Ctrl+C），给它优雅退出的机会',
                      onClick: () => { void act(`stop:${wanted.id}`, API.stop, { run: wanted.id }, '已发送停止信号') },
                    }, busy === `stop:${wanted.id}` ? '停止中…' : '停止')
                  : null,
                LIVE.has(wanted.status)
                  ? h('button', {
                      style: { ...S.ghostButton, ...S.ghostDanger },
                      className: 'dsl-ghost',
                      disabled: busy !== '',
                      title: '整棵进程树 terminate（不给优雅退出机会）',
                      onClick: () => { void act(`kill:${wanted.id}`, API.stop, { run: wanted.id, force: true }, '已强制结束') },
                    }, '强制结束')
                  : null,
                h('button', {
                  // 「这屏太乱了先清一下、服务继续跑」是常见需求，所以在跑的实例也给这个按钮。
                  style: S.ghostButton,
                  className: 'dsl-ghost',
                  disabled: busy !== '',
                  title: '只清面板里的这份缓冲；磁盘上的日志文件不动',
                  onClick: () => {
                    // 关键：光请宿主清不够——本地还攥着那一整份文本，
                    // 不丢掉它，界面看起来就是「点了没反应」。
                    void act(`clear:${wanted.id}`, API.clear, { run: wanted.id }, '已清空面板里的日志').then(() => {
                      offsetRef.current = { runId: wanted.id, next: 0 }
                      logRef.current = { runId: wanted.id, text: '', truncated: false }
                      setLog(logRef.current)
                      setCleared(true)
                    })
                  },
                }, '清空日志'),
                LIVE.has(wanted.status)
                  ? null
                  : h('button', {
                      style: S.ghostButton,
                      className: 'dsl-ghost',
                      disabled: busy !== '',
                      title: '只从列表移除这条记录，日志文件仍在磁盘上',
                      onClick: () => {
                        void act(`remove:${wanted.id}`, API.remove, { run: wanted.id }, '已移除这条记录').then(() => {
                          setFollowNewest(true)
                          setPinnedId(null)
                        })
                      },
                    }, '移除'),
              ),
        ),
        wanted === undefined
          ? null
          : h('div', { style: { fontSize: 11.5, color: 'var(--dsw-alias-label-secondary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } },
              h('span', { style: { fontWeight: 600, color: 'var(--dsw-alias-label-primary)' } }, wanted.name),
              h('span', { style: { color: TONE_COLOR.muted } }, `　${wanted.groupTitle === '' ? '' : `${wanted.groupTitle} · `}${wanted.id}`),
            ),
        switcher
          ? h('div', { style: S.segTrack },
              runs.slice(0, 8).map((run) => {
                const active = run.id === wantedId
                const state = runState(run, run.kind)
                return h('button', {
                  key: run.id,
                  style: active ? { ...S.segItem, ...S.segItemActive } : S.segItem,
                  className: active ? undefined : 'dsl-ghost',
                  title: `${run.groupTitle === '' ? '' : `${run.groupTitle} · `}${run.name}\n${run.id}\n${run.command}`,
                  onClick: () => {
                    setFollowNewest(false)
                    setPinnedId(run.id)
                  },
                },
                  h('span', { style: { ...S.dot, width: 6, height: 6, borderRadius: '50%', background: TONE_COLOR[state.tone] } }),
                  h('span', { style: S.segLabel }, runLabel(run, active)),
                  active ? h('span', { style: S.segId }, run.id) : null,
                )
              }),
            )
          : null,
        wanted === undefined || (wanted.logFile ?? '') === ''
          ? null
          : h('div', {
              style: { fontSize: 10.5, color: TONE_COLOR.muted, cursor: 'pointer', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', borderTop: '0.5px solid var(--dsw-alias-border-l1)', paddingTop: 5 },
              title: `点击复制：${wanted.logFile}`,
              onClick: () => copyPath(wanted.logFile),
            }, `日志文件 ${wanted.logFile}`),
      )

      const body = h('div', { ref: bodyRef, style: S.logTabBodyWrap },
        h('div', {
          ref: scrollRef,
          style: { ...S.logTabBody, fontSize },
          onMouseUp: onLogMouseUp,
          onScroll: () => setPopover(null),
        },
          wanted === undefined
            ? h('div', { style: { padding: '18px 2px', lineHeight: 1.9 } },
                h('div', { style: { fontSize: 12, color: 'var(--dsw-alias-label-secondary)', fontWeight: 600 } }, '还没有运行实例'),
                h('div', { style: { fontSize: 11.5, color: TONE_COLOR.muted, marginTop: 4 } }, '在启动器里点「运行」之后，这里会显示它的实时日志。'),
                h('div', { style: { fontSize: 11.5, color: TONE_COLOR.muted } }, '滑选任意几行，可以把它引用到对话里让我去查。'),
              )
            : (cleared && (log.runId !== wantedId || log.text === '')
                ? h('div', { style: { color: TONE_COLOR.muted, fontSize: 11.5, padding: '12px 2px', lineHeight: 1.9 } },
                    h('div', null, '面板里的日志已清空。这条实例之后的新输出仍会出现在这里。'),
                    (wanted.logFile ?? '') === ''
                      ? null
                      : h('div', { style: { marginTop: 4 } }, '磁盘上的完整记录还在：', h('span', { style: S.mono }, wanted.logFile)),
                  )
                : h(LogBody, { text: log.runId === wantedId ? log.text : '', truncated: log.truncated === true, lineNumbers: true })),
        ),
        popover === null
          ? null
          : h('button', {
              style: { ...S.runButton, position: 'absolute', left: popover.left, top: popover.top, zIndex: 12, boxShadow: '0 4px 14px rgba(0, 0, 0, .2)' },
              className: 'dsl-primary',
              // 按下时别丢掉选区：否则 mouseup 一到，选区就没了；
              // 同时也别让点击冒泡到日志区再触发一次定位。
              onMouseDown: event => {
                event.preventDefault()
                event.stopPropagation()
              },
              onClick: quoteSelection,
            }, '添加到对话'),
      )

      const footer = h('div', { style: S.logTabFoot },
        h('span', { style: { fontSize: 11, color: TONE_COLOR.muted } }, '字号'),
        h('button', { style: S.iconButton, className: 'dsl-ghost', title: '调小', onClick: () => stepFont(-LOG_FONT_STEP) }, 'A-'),
        h('span', { style: { fontSize: 11, color: 'var(--dsw-alias-label-secondary)', minWidth: 30, textAlign: 'center' } }, `${String(fontSize)}px`),
        h('button', { style: S.iconButton, className: 'dsl-ghost', title: '调大', onClick: () => stepFont(LOG_FONT_STEP) }, 'A+'),
        notice === '' ? null : h('span', { style: { fontSize: 11, color: TONE_COLOR.muted, marginLeft: 'auto' } }, notice),
      )

      return h('div', { style: S.logTabRoot, 'data-dsh-launcher': '' }, header, body, footer)
    }

    // #endregion

    // #region 注入样式（只有伪类，布局仍走 inline style）

    /** 注入的 style 标签身份。 */
    const STYLE_TAG_ID = 'dsh-launcher/panel.css'

    /**
     * 面板的伪类样式。
     *
     * inline style 写不了 `:hover`，而「按下去有没有反应」正是手感的一半。
     */
    const PANEL_CSS = [
      '[data-dsh-launcher] button:disabled { opacity: .45; cursor: not-allowed }',
      '[data-dsh-launcher] .dsl-row:hover { background: var(--dsw-alias-bg-layer-2) }',
      '[data-dsh-launcher] .dsl-hoverable:hover { background: var(--dsw-alias-bg-layer-2) }',
      '[data-dsh-launcher] .dsl-ghost:hover:enabled { background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-primary) }',
      '[data-dsh-launcher] .dsl-primary:hover:enabled { filter: brightness(1.12) }',
      '[data-dsh-launcher] .dsl-stop:hover:enabled { filter: brightness(.94) }',
      '[data-dsh-launcher] .dsl-menu-item:hover { background: var(--dsw-alias-bg-layer-2) }',
    ].join('\n')

    /**
     * 注入一次面板 CSS（重复 apply 不会叠加）。
     *
     * @returns {void}
     */
    function injectStyles() {
      if (typeof document === 'undefined') return
      if (document.querySelector(`style[data-plugin-css="${STYLE_TAG_ID}"]`) !== null) return
      const tag = document.createElement('style')
      tag.dataset.pluginCss = STYLE_TAG_ID
      tag.textContent = PANEL_CSS
      document.head.appendChild(tag)
    }

    // #endregion

    /** 客户端需要等待的服务。 */
    const inject = ['slots', 'layout', 'uiWorkspace', 'sidebarRight', 'sidebarRightTabs']

    /**
     * 挂载浏览器半侧。
     *
     * @param {any} ctx - 客户端插件上下文。
     * @returns {void}
     */
    function apply(ctx) {
      injectStyles()
      const pickDirectory = () => {
        const workspace = ctx.get('uiWorkspace')
        if (workspace === undefined || typeof workspace.pickDirectory !== 'function') {
          return Promise.reject(new Error('当前客户端没有目录选择器'))
        }
        return workspace.pickDirectory()
      }

      // 主题方案：日志的 ANSI 颜色要跟着浅色/深色两套走。
      ctx.effect(() => {
        const theme = ctx.get('theme')
        if (theme === undefined || typeof theme.getTheme !== 'function') return undefined
        const sync = (snapshot) => {
          const active = snapshot === undefined ? theme.getTheme() : snapshot
          ansiTheme.set(active?.active?.colorScheme === 'dark' ? 'dark' : 'light')
        }
        sync(undefined)
        const off = typeof ctx.on === 'function' ? ctx.on('theme/change', sync) : undefined
        return () => {
          if (typeof off === 'function') off()
        }
      }, 'launcher: theme scheme')

      // 右栏 tab 类型：这样它会出现在右栏「＋」的类型清单里。
      ctx.effect(() => ctx.sidebarRightTabs.register({
        id: LOG_TAB_ID,
        kind: LOG_TAB_KIND,
        multiple: true,
        priority: 'builtin',
        title: () => '运行日志',
        guide: [{
          id: 'new',
          order: 30,
          title: () => '运行日志',
          description: () => '选中条目的实时日志；滑选后可把引用写进对话输入框',
          icon: LogTabIcon,
        }],
      }), 'launcher: log tab type')

      ctx.effect(() => ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register({
        name: 'sidebar.right.pane.tab',
        key: LOG_TAB_ID,
      }, LogTab)), 'launcher: log tab body')

      ctx.effect(() => ctx.slots.inject('sidebar.right.pane.tab.title', () => ctx.slots.register({
        name: 'sidebar.right.pane.tab.title',
        key: LOG_TAB_ID,
      }, LogTabTitle)), 'launcher: log tab title')

      ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
        name: 'sidebar.panellist',
        id: PANEL_ID,
        order: 40,
        // 中文写死：不走 locale（见文件头注释），免得侧栏再出现一个叫 Run 的面板。
        label: PANEL_TITLE,
      }, LauncherIcon))

      ctx.slots.inject('main', () => ctx.slots.register({
        name: 'main',
        key: PANEL_ID,
        inject: () => ({ pickDirectory }),
      }, LauncherPanel))
    }

    exports.apply = apply
    exports.inject = inject
    exports.PANEL_ID = PANEL_ID
    exports.PANEL_TITLE = PANEL_TITLE
    // 纯函数测试入口：没有 React 依赖的那部分单测直接调。
    exports.__internals = {
      parseAnsi, xterm256, styleToCss, LauncherPanel, LogBody, LauncherIcon, GroupForm, ItemForm, MoreMenu,
      runState, runFacts, envToText, textToEnv, shortenHome, relativeDir, homeFromStoreFile, groupColor,
      renderGroup, renderItem, stateProblem, capabilityNotice, supportsGroupColor, loadView, saveView, resolveGroupColor, GroupColorPicker,
      formatReference, appendReference, lineRangeFromSelection, popoverForSelection, nextPopover, menuPosition, dropBefore, GROUP_COLORS,
      LogTab, LogTabTitle, LogTabIcon, clampLogFont, RunIcon, StopIcon,
    }
    return module.exports
  },
})
