/**
 * 给模型用的五个工具：`launcher_status`、`launcher_log`，以及三个**动运行实例**的：
 * `launcher_run`、`launcher_stop`、`launcher_restart`。
 *
 * 存在的理由就是那个真实场景：人在启动器里看到服务炸了，切回对话想「接着聊这个
 * 问题」。与其让他把 11 万字符的日志粘进来（还占 token），不如让模型自己去读——
 * 他只需要说一句「启动器里那个 admin-service 为什么炸了」。
 *
 * 后三个工具解决的是另一半问题：**改完代码得重启才生效**，而重启不该让用户去点面板。
 * 它们与面板上的按钮走同一套运行器，不是另开一条路。`launcher_restart` 里那个「等落终态」
 * 是必须的：`stop` 只送 SIGINT，进程还在宽限期里活着，立刻重启会撞端口占用。
 *
 * 两条 token 纪律（用户在意额度，日志又天生巨大）：
 * - `launcher_status` 只回结构化的状态摘要，不回日志正文；
 * - `launcher_log` 默认只回**关键行**（`Caused by` / `ERROR` / `BUILD FAILURE` 之类），
 *   全量必须显式 `mode: "full"`，并且始终把日志文件路径一并给出——需要更多时
 *   模型可以用自己的文件工具去读，而不是把边界推给一次调用。
 *
 * @module dsh-launcher/lib/tool
 */

import {
  DEFAULT_SIGNAL_LIMIT, MAX_SIGNAL_LIMIT, extractSignals, isFailedRun, listLogFiles,
  parseRange, readLogTail, resolveRun, sliceLines, tailLines,
} from './logs.js'

/** 状态工具名。 */
export const STATUS_TOOL = 'launcher_status'

/** 日志工具名。 */
export const LOG_TOOL = 'launcher_log'

/** 启动工具名。 */
export const RUN_TOOL = 'launcher_run'

/** 停止工具名。 */
export const STOP_TOOL = 'launcher_stop'

/** 重启工具名。 */
export const RESTART_TOOL = 'launcher_restart'

/** 还活着的运行状态。 */
const LIVE_STATUS = new Set(['starting', 'running', 'stopping'])

/** 终态（运行器判定的可重启时机）。 */
const SETTLED_STATUS = new Set(['exited', 'failed', 'stopped'])

/**
 * 按名字模糊找一个启动项。
 *
 * 与 `launcher_log` 的解析口径一致：忽略大小写做子串匹配，`group` 只用来缩小范围。
 * 命中多个时**不猜**，把候选摊开让模型自己收窄 —— 启错服务的代价比多问一句大。
 *
 * @param {any} store - 启动项清单。
 * @param {{ item?: string, group?: string }} query - 查询条件。
 * @returns {{ group: any, item: any } | { error: string }} 命中的分组与条目，或错误文案。
 */
function findItem(store, query) {
  const wanted = typeof query.item === 'string' ? query.item.trim().toLowerCase() : ''
  const wantedGroup = typeof query.group === 'string' ? query.group.trim().toLowerCase() : ''
  if (wanted === '') return { error: '要指定启动项名字（item）' }
  const matches = []
  for (const group of store.list()) {
    if (wantedGroup !== '' && !group.name.toLowerCase().includes(wantedGroup)) continue
    for (const item of group.items) {
      if (item.name.toLowerCase().includes(wanted)) matches.push({ group, item })
    }
  }
  if (matches.length === 0) {
    const all = store.list().flatMap(group => group.items.map(item => `${group.name} · ${item.name}`))
    return { error: `清单里没有匹配「${query.item}」的启动项。现有：${all.join('、') || '（清单为空）'}` }
  }
  if (matches.length > 1) {
    return { error: `「${query.item}」命中了多个启动项：${matches.map(m => `${m.group.name} · ${m.item.name}`).join('、')}。请补 group 或写全名字。` }
  }
  return matches[0]
}

/**
 * 找运行实例：先按 id，再按启动项。
 *
 * @param {any[]} runs - 运行实例列表。
 * @param {{ run?: string, itemId?: string }} query - 查询条件。
 * @returns {any[]} 命中的运行实例（可能为空）。
 */
function findRuns(runs, query) {
  const wantedRun = typeof query.run === 'string' ? query.run.trim() : ''
  if (wantedRun !== '') {
    const exact = runs.find(run => run.id === wantedRun)
    if (exact !== undefined) return [exact]
    return runs.filter(run => run.id.startsWith(wantedRun))
  }
  return query.itemId === undefined ? [] : runs.filter(run => run.itemId === query.itemId)
}

/**
 * 等一组运行实例落终态。
 *
 * @param {() => any[]} list - 取当前运行实例。
 * @param {string[]} ids - 要等的实例 id。
 * @param {number} budgetMs - 最多等多久。
 * @returns {Promise<any[]>} 超时后仍未落终态的实例。
 */
async function waitSettled(list, ids, budgetMs) {
  const deadline = Date.now() + budgetMs
  for (;;) {
    const pending = list().filter(run => ids.includes(run.id) && !SETTLED_STATUS.has(run.status))
    if (pending.length === 0) return []
    if (Date.now() >= deadline) return pending
    await new Promise(resolve => setTimeout(resolve, 200))
  }
}

/** 运行实例的一行摘要。 */
function runLine(run) {
  const group = typeof run.groupTitle === 'string' ? run.groupTitle : ''
  return `${run.id}｜${group === '' ? '' : `${group} · `}${run.name}｜${describeRun(run)}`
}

/** 紧凑的一行状态文案（与服务/任务语义一致）。 */
function describeRun(run) {
  if (run.status === 'running') return '运行中'
  if (run.status === 'starting') return '启动中'
  if (run.status === 'stopping') return '停止中'
  if (run.status === 'stopped') return '已停止'
  if (run.status === 'failed') return '启动失败'
  const code = run.exitCode === null || run.exitCode === undefined ? '?' : String(run.exitCode)
  if (run.kind === 'task') return run.exitCode === 0 ? '已完成' : `失败（退出码 ${code}）`
  return run.exitCode === 0 ? '已退出（本该常驻）' : `异常退出（退出码 ${code}）`
}

/**
 * 注册两个启动器工具。
 *
 * @param {any} ctx - 承载 `tools` 的插件上下文。
 * @param {{
 *   supervisor: any, store: any, config: { logDir: string }, logger?: any,
 * }} deps - 运行器、清单与配置。
 * @returns {() => void} 注销函数。
 */
export function registerLauncherTools(ctx, deps) {
  const statusDisposer = ctx.tools.register({
    name: STATUS_TOOL,
    description: [
      'List the DSH launcher\'s groups, launch items and run instances (the "启动器" panel), with each run\'s status, exit code, pid, working directory, command and log file path.',
      'Use it when the user refers to something they started from the launcher — e.g. "启动器里那个服务为什么起不来", "看下我挂着哪些服务" — before reaching for ' + LOG_TOOL + '.',
      'It returns status only and never log bodies, so it is cheap to call.',
    ].join(' '),
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        running_only: {
          type: 'boolean',
          description: 'Only report runs that are still live (starting/running/stopping). Defaults to false.',
        },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['runs'],
        properties: {
          runs: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['id', 'name', 'status'],
              properties: {
                id: { type: 'string' },
                name: { type: 'string' },
                group: { type: 'string' },
                status: { type: 'string' },
                summary: { type: 'string' },
                exitCode: { type: 'integer' },
                pid: { type: 'integer' },
                command: { type: 'string' },
                cwd: { type: 'string' },
                logFile: { type: 'string' },
                bytes: { type: 'integer' },
              },
            },
          },
          groups: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['name', 'items'],
              properties: {
                name: { type: 'string' },
                dir: { type: 'string' },
                items: {
                  type: 'array',
                  items: {
                    type: 'object',
                    additionalProperties: false,
                    required: ['name', 'kind', 'command'],
                    properties: {
                      name: { type: 'string' },
                      kind: { type: 'string' },
                      command: { type: 'string' },
                      cwd: { type: 'string' },
                    },
                  },
                },
              },
            },
          },
        },
      },
      render(_args, value) {
        const runs = Array.isArray(value?.runs) ? value.runs : []
        const groups = Array.isArray(value?.groups) ? value.groups : []
        const lines = []
        lines.push(runs.length === 0 ? '运行实例：无' : `运行实例（${String(runs.length)}）：`)
        for (const run of runs) {
          lines.push(`- ${run.group === '' ? '' : `${run.group} · `}${run.name}｜${run.summary}｜${run.id}${run.pid === undefined ? '' : `｜pid ${String(run.pid)}`}`)
          lines.push(`  命令 ${run.command}`)
          lines.push(`  目录 ${run.cwd === '' ? '(home)' : run.cwd}`)
          if (typeof run.logFile === 'string' && run.logFile !== '') lines.push(`  日志 ${run.logFile}`)
        }
        lines.push('', `清单（${String(groups.length)} 个分组）：`)
        for (const group of groups) {
          lines.push(`- ${group.name}${group.dir === '' ? '' : `（${group.dir}）`}：${String(group.items.length)} 条`)
          for (const item of group.items) lines.push(`    · [${item.kind === 'task' ? '任务' : '服务'}] ${item.name} → ${item.command}`)
        }
        return [{ type: 'text', text: lines.join('\n') }]
      },
    },
    async execute(args) {
      const runningOnly = args?.running_only === true
      const all = deps.supervisor.list()
      const runs = (runningOnly ? all.filter(run => run.status === 'starting' || run.status === 'running' || run.status === 'stopping') : all)
        .map(run => ({
          id: run.id,
          name: run.name,
          group: run.groupTitle ?? '',
          status: run.status,
          summary: describeRun(run),
          ...(run.exitCode === null || run.exitCode === undefined ? {} : { exitCode: run.exitCode }),
          ...(run.pid === null || run.pid === undefined ? {} : { pid: run.pid }),
          command: run.command,
          cwd: run.cwd ?? '',
          logFile: run.logFile ?? '',
          bytes: run.bytes ?? 0,
        }))
      const groups = deps.store.list().map(group => ({
        name: group.name,
        dir: group.dir,
        items: group.items.map(item => ({
          name: item.name,
          kind: item.kind ?? 'service',
          command: item.command,
          cwd: item.cwd ?? '',
        })),
      }))
      return { runs, groups }
    },
  })

  const logDisposer = ctx.tools.register({
    name: LOG_TOOL,
    description: [
      'Read a run instance\'s output from the DSH launcher (the "启动器" panel).',
      'Default mode is "summary": only the lines that matter for troubleshooting (Caused by / ERROR / Exception / BUILD FAILURE / ClassNotFound …), capped, plus the log file path — this is what you want when the user says "启动器里那个报错了，看看".',
      'Use mode "tail" for the last N lines, and mode "full" only when the summary genuinely is not enough: full output can be enormous and expensive.',
      'When no run matches (e.g. after a DSH restart) it falls back to the newest log file on disk. The returned log_file path can be read directly with your own file tools when you need more than one call should carry.',
      'The launcher panel can insert a SHORT REFERENCE into the user\'s message instead of pasting log text — it looks like 【启动器日志 run-4 · Admin Service 第 12~45 行】 or 【启动器日志 run-4 · … 关键行】. When you see one, call this tool with that run id and the same range (range: "12~45" or range: "signal") to read exactly those lines.',
      `Resolve a run by \`run\` id, or by \`item\`/\`group\` name (fuzzy). With no selector it picks the most recent failed run, else the most recent run.`,
    ].join(' '),
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        run: { type: 'string', description: 'Run instance id, e.g. run-4. Partial ids match.' },
        item: { type: 'string', description: 'Launch item name (fuzzy), e.g. "admin-service" or "Admin Service".' },
        group: { type: 'string', description: 'Group name (fuzzy) to narrow the item search.' },
        mode: { type: 'string', enum: ['summary', 'tail', 'full'], description: 'summary (default, signal lines only), tail (last N lines), full (everything — expensive).' },
        grep: { type: 'string', description: 'Substring filter; when set, only lines containing it are returned (implies summary-style filtering).' },
        range: { type: 'string', description: 'Line range to return: "12-45" / "12~45" (1-based inclusive), a bare line number, "signal" for the key lines only, or "tail200" for the last 200 lines. This is how a 【启动器日志 run-4 · … 第 12~45 行】 reference in the user\'s message is resolved.' },
        lines: { type: 'integer', minimum: 1, maximum: MAX_SIGNAL_LIMIT, description: `How many lines to return (default ${String(DEFAULT_SIGNAL_LIMIT)}; capped at ${String(MAX_SIGNAL_LIMIT)}).` },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['text'],
        properties: {
          text: { type: 'string' },
          mode: { type: 'string' },
          run: { type: 'string' },
          name: { type: 'string' },
          status: { type: 'string' },
          command: { type: 'string' },
          cwd: { type: 'string' },
          log_file: { type: 'string' },
          matched: { type: 'integer' },
          total_lines: { type: 'integer' },
          truncated: { type: 'boolean' },
          note: { type: 'string' },
        },
      },
      render(_args, value) {
        return [{ type: 'text', text: typeof value?.text === 'string' ? value.text : '(无日志)' }]
      },
    },
    async execute(args) {
      const mode = args?.mode === 'tail' || args?.mode === 'full' ? args.mode : 'summary'
      const lines = Number.isInteger(args?.lines) ? args.lines : DEFAULT_SIGNAL_LIMIT
      const grep = typeof args?.grep === 'string' && args.grep.trim() !== '' ? args.grep.trim() : ''
      const rangeSpec = typeof args?.range === 'string' ? args.range.trim() : ''
      const run = resolveRun(deps.supervisor.list(), { run: args?.run, group: args?.group, item: args?.item })

      let text = ''
      let logFile = ''
      let source = ''
      let truncated = false
      if (run !== undefined) {
        logFile = run.logFile ?? ''
        const ring = deps.supervisor.log(run.id, 0)
        text = ring === undefined ? '' : ring.text
        source = '运行实例的内存缓冲'
        if (mode === 'full' && logFile !== '') {
          try {
            const file = await readLogTail(logFile)
            if (file.text.length > text.length) {
              text = file.text
              source = '日志文件'
              truncated = file.truncated
            }
          } catch (error) {
            deps.logger?.warn?.(`launcher: 读日志文件失败 ${String(error)}`)
          }
        }
      } else {
        // 没有运行实例（多半是 DSH 重启过了）：退回到磁盘上最新的日志文件。
        const files = await listLogFiles(deps.config.logDir, { group: args?.group, item: args?.item, limit: 1 })
        if (files.length > 0) {
          const file = await readLogTail(files[0].path)
          text = file.text
          logFile = files[0].path
          source = '磁盘上的日志文件'
          truncated = file.truncated
        }
      }

      if (text === '' && logFile === '') {
        const files = await listLogFiles(deps.config.logDir, { group: args?.group, item: args?.item, limit: 5 })
        return {
          text: files.length === 0
            ? '启动器里没有可读的日志：既没有运行实例，日志目录里也没有匹配的文件。'
            : `没有匹配的运行实例。磁盘上有这些日志文件：\n${files.map(file => `- ${file.path}`).join('\n')}`,
          mode,
          log_file: files[0]?.path ?? '',
          note: 'no-run',
        }
      }

      const header = [
        run === undefined ? '（没有匹配的运行实例，读的是磁盘上的日志文件）' : `${run.groupTitle === '' ? '' : `${run.groupTitle} · `}${run.name}`,
        run === undefined ? '' : `状态 ${describeRun(run)}`,
        run === undefined ? '' : `命令 ${run.command}`,
        run === undefined ? '' : `目录 ${run.cwd === '' ? '(home)' : run.cwd}`,
        logFile === '' ? '' : `日志文件 ${logFile}`,
      ].filter(line => line !== '')

      let body = ''
      let matched = 0
      let totalLines = 0
      const total = text === '' ? 0 : text.split(/\r?\n/).length
      const range = rangeSpec === '' ? undefined : parseRange(rangeSpec, total)
      if (rangeSpec !== '' && range === undefined) {
        return {
          text: `认不出这个行范围：「${rangeSpec}」。支持 "12-45"、"12~45"、单行号、"signal"（关键行）、"tail200"（末尾 200 行）。`,
          mode,
          run: run?.id ?? '',
          log_file: logFile,
          note: 'bad-range',
        }
      }
      if (range?.kind === 'range') {
        const slice = sliceLines(text, range.from, range.to)
        totalLines = slice.total
        matched = slice.lines.length
        body = slice.lines.map((line, index) => `${String(slice.from + index)}\t${line}`).join('\n')
      } else if (range?.kind === 'tail') {
        const tail = tailLines(text, range.tail)
        totalLines = tail.total
        matched = tail.lines.length
        body = tail.lines.map((line, index) => `${String(tail.total - tail.lines.length + index + 1)}\t${line}`).join('\n')
      } else if (range?.kind === 'signal') {
        const signals = extractSignals(text, { grep, limit: lines })
        totalLines = signals.total
        matched = signals.matched
        body = signals.lines.length === 0 ? '（没有匹配到关键行）' : signals.lines.join('\n')
      } else if (mode === 'full') {
        const all = text.split(/\r?\n/)
        totalLines = all.length
        const kept = all.length > MAX_SIGNAL_LIMIT && grep === '' ? all.slice(-MAX_SIGNAL_LIMIT) : all
        body = kept.join('\n')
        matched = kept.length
        if (kept.length < all.length) truncated = true
      } else if (mode === 'tail') {
        const tail = tailLines(text, lines)
        totalLines = tail.total
        matched = tail.lines.length
        body = tail.lines.join('\n')
      } else {
        const signals = extractSignals(text, { grep, limit: lines })
        totalLines = signals.total
        matched = signals.matched
        body = signals.lines.length === 0
          ? (grep === '' ? '（没有匹配到关键行；用 mode:"tail" 看结尾，或 mode:"full" 看全部）' : `（没有包含「${grep}」的行）`)
          : signals.lines.join('\n')
      }

      const footer = [
        `来源：${source}${truncated ? '（已截断）' : ''}`,
        mode === 'summary' && grep === ''
          ? `共 ${String(totalLines)} 行，命中关键行 ${String(matched)} 行（只回关键行；需要更多用 mode:"tail"/"full"）`
          : `共 ${String(totalLines)} 行，返回 ${String(matched)} 行`,
      ]
      return {
        text: [...header, '', body, '', ...footer].join('\n'),
        mode,
        run: run?.id ?? '',
        name: run?.name ?? '',
        status: run?.status ?? '',
        command: run?.command ?? '',
        cwd: run?.cwd ?? '',
        log_file: logFile,
        matched,
        total_lines: totalLines,
        truncated,
      }
    },
  })

  const runDisposer = ctx.tools.register({
    name: RUN_TOOL,
    description: [
      'Start a launch item from the DSH launcher (the same action as clicking run in the "启动器" panel).',
      'Use it when the user asks you to bring a service up — e.g. "把 admin-service 起起来", "启动 launcher 里那条服务" — instead of telling them to click it themselves.',
      'Pass `item` with the launch item name (fuzzy substring; e.g. "admin-service" or "Admin Service") and `group` to narrow it when several items share a name.',
      'It refuses to start an item that already has a live run (that would usually fail on a taken port) and points at ' + RESTART_TOOL + ' instead. After it starts, read output with ' + LOG_TOOL + '.',
    ].join(' '),
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['item'],
      properties: {
        item: { type: 'string', description: 'Launch item name (fuzzy substring), e.g. "admin-service".' },
        group: { type: 'string', description: 'Group name (fuzzy) to narrow the item search.' },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['text'],
        properties: {
          text: { type: 'string' },
          run: { type: 'string' },
          name: { type: 'string' },
          status: { type: 'string' },
          command: { type: 'string' },
          cwd: { type: 'string' },
          log_file: { type: 'string' },
          note: { type: 'string' },
        },
      },
      render(_args, value) {
        return [{ type: 'text', text: typeof value?.text === 'string' ? value.text : '(无结果)' }]
      },
    },
    async execute(args) {
      const found = findItem(deps.store, { item: args?.item, group: args?.group })
      if ('error' in found) return { text: found.error, note: 'no-item' }
      const { group, item } = found
      const live = findRuns(deps.supervisor.list(), { itemId: item.id }).filter(run => LIVE_STATUS.has(run.status))
      if (live.length > 0) {
        return {
          text: `${group.name} · ${item.name} 已经在运行中：${live.map(runLine).join('；')}。要重启用 ${RESTART_TOOL}，要看输出用 ${LOG_TOOL}。`,
          run: live[0].id,
          name: item.name,
          status: live[0].status,
          note: 'already-running',
        }
      }
      try {
        const run = await deps.supervisor.start({
          item,
          cwd: item.cwd !== undefined && item.cwd !== '' ? item.cwd : group.dir,
          groupId: group.id,
          groupTitle: group.name,
        })
        return {
          text: `已启动 ${group.name} · ${item.name}：${runLine(run)}\n命令 ${run.command}\n目录 ${run.cwd === '' ? '(home)' : run.cwd}\n（下一步用 ${LOG_TOOL} 看输出）`,
          run: run.id,
          name: run.name,
          status: run.status,
          command: run.command,
          cwd: run.cwd,
          log_file: run.logFile ?? '',
        }
      } catch (error) {
        return { text: `启动失败：${error instanceof Error ? error.message : String(error)}`, name: item.name, note: 'start-failed' }
      }
    },
  })

  const stopDisposer = ctx.tools.register({
    name: STOP_TOOL,
    description: [
      'Stop a run instance in the DSH launcher (the same action as the panel\'s stop button).',
      'Identify it by `run` id (e.g. run-4, partial matches allowed) or by launch item name via `item` (+ optional `group`).',
      'By default it sends SIGINT and lets the grace period do the rest; pass `force: true` to terminate immediately.',
      'It only stops things that are still live; when nothing matches it says so instead of guessing.',
    ].join(' '),
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        run: { type: 'string', description: 'Run instance id, e.g. run-4. Partial ids match.' },
        item: { type: 'string', description: 'Launch item name (fuzzy substring) whose live run should stop.' },
        group: { type: 'string', description: 'Group name (fuzzy) to narrow the item search.' },
        force: { type: 'boolean', description: 'Terminate immediately instead of waiting for the grace period. Defaults to false.' },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['text'],
        properties: {
          text: { type: 'string' },
          run: { type: 'string' },
          name: { type: 'string' },
          status: { type: 'string' },
          command: { type: 'string' },
          cwd: { type: 'string' },
          log_file: { type: 'string' },
          note: { type: 'string' },
        },
      },
      render(_args, value) {
        return [{ type: 'text', text: typeof value?.text === 'string' ? value.text : '(无结果)' }]
      },
    },
    async execute(args) {
      const runs = deps.supervisor.list()
      const wantedRun = typeof args?.run === 'string' ? args.run.trim() : ''
      let targets = findRuns(runs, { run: args?.run }).filter(run => LIVE_STATUS.has(run.status))
      if (wantedRun === '') {
        const found = findItem(deps.store, { item: args?.item, group: args?.group })
        if ('error' in found) return { text: found.error, note: 'no-item' }
        targets = findRuns(runs, { itemId: found.item.id }).filter(run => LIVE_STATUS.has(run.status))
        if (targets.length === 0) {
          return { text: `${found.group.name} · ${found.item.name} 现在没有在运行。`, name: found.item.name, note: 'not-running' }
        }
      }
      if (targets.length === 0) {
        const live = runs.filter(run => LIVE_STATUS.has(run.status)).map(runLine)
        return {
          text: wantedRun === '' ? '没有匹配到可停止的运行实例。' : `没有匹配「${wantedRun}」的运行实例。`,
          note: 'no-run',
          ...(live.length === 0 ? {} : { status: 'live' }),
        }
      }
      const stopped = []
      for (const target of targets) {
        const run = await deps.supervisor.stop(target.id, { force: args?.force === true })
        stopped.push(run ?? target)
      }
      const lines = stopped.map(run => runLine(run))
      const stillStopping = stopped.filter(run => !SETTLED_STATUS.has(run.status))
      return {
        text: [
          `已停止：${lines.join('；')}`,
          stillStopping.length === 0 ? '' : `（还在宽限期里收尾：${stillStopping.map(run => run.id).join('、')}；要立刻杀用 force: true）`,
        ].filter(line => line !== '').join('\n'),
        run: stopped[0]?.id ?? '',
        name: stopped[0]?.name ?? '',
        status: stopped[0]?.status ?? '',
      }
    },
  })

  const restartDisposer = ctx.tools.register({
    name: RESTART_TOOL,
    description: [
      'Restart a launch item in the DSH launcher: stop its live run(s), wait until the process has actually exited, then start it again.',
      'This is the tool for "改完代码要重启才生效" — e.g. after editing a plugin or backend service, restart the run the user has going instead of asking them to click stop/run.',
      'Pass `item` (fuzzy substring) and `group` when several items share a name; `force: true` terminates instead of waiting for the grace period.',
      'It waits for the port/PTY to be released before starting again (the launcher stops with SIGINT, so an immediate restart would hit a taken port), and reports when a run refuses to die.',
    ].join(' '),
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['item'],
      properties: {
        item: { type: 'string', description: 'Launch item name (fuzzy substring) to restart.' },
        group: { type: 'string', description: 'Group name (fuzzy) to narrow the item search.' },
        force: { type: 'boolean', description: 'Terminate immediately instead of waiting for the grace period.' },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['text'],
        properties: {
          text: { type: 'string' },
          run: { type: 'string' },
          name: { type: 'string' },
          status: { type: 'string' },
          command: { type: 'string' },
          cwd: { type: 'string' },
          log_file: { type: 'string' },
          note: { type: 'string' },
        },
      },
      render(_args, value) {
        return [{ type: 'text', text: typeof value?.text === 'string' ? value.text : '(无结果)' }]
      },
    },
    async execute(args) {
      const found = findItem(deps.store, { item: args?.item, group: args?.group })
      if ('error' in found) return { text: found.error, note: 'no-item' }
      const { group, item } = found
      const list = () => deps.supervisor.list()
      const live = findRuns(list(), { itemId: item.id }).filter(run => LIVE_STATUS.has(run.status))
      const stoppedIds = []
      for (const target of live) {
        await deps.supervisor.stop(target.id, { force: args?.force === true })
        stoppedIds.push(target.id)
      }
      // 先等它真的落终态：stop 只送 SIGINT，端口通常要等进程退出才放开。
      let stuck = []
      if (stoppedIds.length > 0) {
        const budget = Math.max(Number(deps.config?.stopGraceMs ?? 5000) + 5000, 8000)
        stuck = await waitSettled(list, stoppedIds, Math.min(budget, 30000))
      }
      if (stuck.length > 0) {
        for (const run of stuck) await deps.supervisor.stop(run.id, { force: true })
        stuck = await waitSettled(list, stuck.map(run => run.id), 8000)
      }
      if (stuck.length > 0) {
        return {
          text: `${stuck.map(run => run.id).join('、')} 停了但没退出（可能忽略了 SIGINT/SIGTERM）。先手动处理它，再重启。`,
          run: stuck[0].id,
          name: item.name,
          status: stuck[0].status,
          note: 'stuck',
        }
      }
      try {
        const run = await deps.supervisor.start({
          item,
          cwd: item.cwd !== undefined && item.cwd !== '' ? item.cwd : group.dir,
          groupId: group.id,
          groupTitle: group.name,
        })
        const prefix = stoppedIds.length === 0
          ? `（它本来没在运行，直接启动）`
          : `（已停 ${stoppedIds.join('、')} 并等它退出）`
        return {
          text: `已重启 ${group.name} · ${item.name} ${prefix}：${runLine(run)}\n命令 ${run.command}\n目录 ${run.cwd === '' ? '(home)' : run.cwd}\n（下一步用 ${LOG_TOOL} 看启动日志）`,
          run: run.id,
          name: run.name,
          status: run.status,
          command: run.command,
          cwd: run.cwd,
          log_file: run.logFile ?? '',
        }
      } catch (error) {
        return { text: `停止成功但启动失败：${error instanceof Error ? error.message : String(error)}`, name: item.name, note: 'start-failed' }
      }
    },
  })

  return () => {
    statusDisposer()
    logDisposer()
    runDisposer()
    stopDisposer()
    restartDisposer()
  }
}

/** 供单测复用：紧凑状态文案与解析辅助。 */
export const __testing = { describeRun, isFailedRun }
