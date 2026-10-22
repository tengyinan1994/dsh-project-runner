/**
 * 运行器：一个启动项 = 一个真 PTY 里的 zsh 子进程，配一份有界环形日志。
 *
 * 为什么走 `ctx.subprocess.spawnTerminal` 而不是普通管道：用户的诉求是
 * 「点一下就像在终端里敲了这条命令」。PTY 让 npm / maven / spring-boot 认为
 * 自己在终端里跑，于是颜色、进度条、按宽度换行、以及对 stdin 的交互都是真的。
 *
 * 这个进程属于「人」，不属于 agent：它不受 agent 的沙箱模式与审批策略影响，
 * 以当前系统用户的权限运行——与内置用户终端的姿态一致。
 *
 * @module dsh-launcher/lib/supervisor
 */

import { createWriteStream } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'

import { enforceLogBudget, logFilePath, pruneLogs } from './logs.js'

/** 运行实例的终态。 */
const SETTLED = new Set(['exited', 'failed', 'stopped'])

/**
 * 非交互护栏：别让 shell 启动脚本的交互提问顶住 PTY（提问在等按键，命令就没执行）。
 *
 * 这两个是 oh-my-zsh 的官方开关（`DISABLE_AUTO_UPDATE` 关自动更新、`DISABLE_UPDATE_PROMPT`
 * 只关「问你要不要更新」）；设了它们，shell 仍然按用户的 `.zshrc` 加载环境，只是不再停下来问。
 */
const NON_INTERACTIVE_ENV = Object.freeze({
  DISABLE_AUTO_UPDATE: 'true',
  DISABLE_UPDATE_PROMPT: 'true',
})

/** `childEnv` 会拒收这个由 provider 独占的标记，继承父环境时必须摘掉。 */
const RESERVED_ENV_KEY = 'DSH_SUBPROCESS_CONTROL'

/**
 * 建一个运行器。
 *
 * @param {{
 *   ctx: any,
 *   config: { shellPath: string, shellArgs: string[], maxRuns: number, logMaxChars: number,
 *             stopGraceMs: number, inheritEnv: 'full' | 'scrubbed', cols: number, rows: number },
 *   logger?: { warn: (message: any) => void },
 * }} deps - 插件上下文、解析后的配置与日志器。
 * @returns {{
 *   list: () => Array<object>, start: (request: object) => Promise<object>,
 *   stop: (id: string, options?: { force?: boolean }) => Promise<object | undefined>,
 *   clear: (id: string) => object | undefined, remove: (id: string) => boolean,
 *   log: (id: string, from: number) => object | undefined, disposeAll: () => Promise<void>,
 * }} 运行器。
 */
export function createSupervisor({ ctx, config, logger }) {
  /** @type {Map<string, any>} */
  const runs = new Map()
  let sequence = 0
  /** 保留期清理只在一个进程里做一次。 */
  let pruned = false

  /**
   * 打开一个运行实例的日志文件。
   *
   * 写失败不能拖垮运行：日志落盘是「留存」，不是「运行」的前提，所以这里
   * 出错只告警并把 run.logFile 置空，进程照跑。
   *
   * @param {any} run - 运行记录。
   * @returns {Promise<void>} 无。
   */
  const openLogFile = async (run) => {
    if (config.logDir === '') return
    try {
      const path = logFilePath(config.logDir, run)
      await mkdir(dirname(path), { recursive: true })
      const stream = createWriteStream(path, { flags: 'a' })
      stream.on('error', (error) => {
        logger?.warn?.(`launcher: 日志文件写入失败 ${path} — ${error instanceof Error ? error.message : String(error)}`)
        run.logFile = ''
        run.logStream = undefined
      })
      run.logFile = path
      run.logStream = stream
      run.logBytes = 0
    } catch (error) {
      logger?.warn?.(`launcher: 建日志文件失败 — ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  /**
   * 把一段输出追加到日志文件（超过单文件上限就停写，但内存环形缓冲继续）。
   *
   * @param {any} run - 运行记录。
   * @param {string} text - 输出。
   * @returns {void}
   */
  const writeLogFile = (run, text) => {
    const stream = run.logStream
    if (stream === undefined || text === '') return
    if (run.logBytes !== undefined && run.logBytes >= config.logFileMaxBytes) {
      if (run.logTruncated !== true) {
        run.logTruncated = true
        stream.write(`\n[launcher] 日志超过单文件上限 ${String(config.logFileMaxBytes)} 字节，后续输出不再落盘（面板里仍可看）\n`)
      }
      return
    }
    run.logBytes = (run.logBytes ?? 0) + Buffer.byteLength(text, 'utf8')
    stream.write(text)
  }

  /**
   * 关掉日志文件流。
   *
   * @param {any} run - 运行记录。
   * @returns {void}
   */
  const closeLogFile = (run) => {
    const stream = run.logStream
    run.logStream = undefined
    if (stream === undefined) return
    try {
      stream.end()
    } catch (error) {
      logger?.warn?.(`launcher: 关闭日志文件失败 ${String(error)}`)
    }
  }

  /**
   * 首次启动时清理过期日志目录。
   *
   * @returns {Promise<void>} 无。
   */
  const pruneOnce = async () => {
    if (pruned || config.logDir === '') return
    pruned = true
    try {
      const result = await pruneLogs(config.logDir, config.logRetentionDays)
      if (result.removedDirs.length > 0) {
        logger?.info?.(`launcher: 清理了 ${String(result.removedDirs.length)} 个过期日志目录`)
      }
      // 光按天数不够：某天起二十个实例、单文件各接近上限，一天就能堆出几百 MB。
      const budget = await enforceLogBudget(config.logDir, config.logMaxTotalBytes, message => logger?.warn?.(message))
      if (budget.removedFiles.length > 0) {
        logger?.info?.(`launcher: 日志总量超限，删了 ${String(budget.removedFiles.length)} 个最旧的文件，释放 ${String(Math.round(budget.freedBytes / 1024 / 1024))} MB`)
      }
    } catch (error) {
      logger?.warn?.(`launcher: 清理旧日志失败 ${String(error)}`)
    }
  }

  const subprocessOf = () => {
    const service = ctx.get('subprocess')
    if (service === undefined) {
      throw new Error('当前组合没有加载 subprocess provider，无法启动进程')
    }
    return service
  }

  /**
   * 组装子进程环境。
   *
   * DSH 的 subprocess 层默认剔除 `*KEY*`/`*TOKEN*`/`*SECRET*` 与 `DSH_*`，
   * 这对 agent 起的进程是对的，但对「人自己的终端」不是：前端项目常常依赖
   * 自己的 `VITE_*_KEY` 之类变量。`inheritEnv: 'full'` 就把当前进程的环境
   * 显式带回去（显式 env 在剔除之后合并），`scrubbed` 则维持内置终端的姿态。
   *
   * @param {Record<string, string>} extra - 启动项自己的 env / envFile。
   * @returns {Record<string, string>} 交给 PTY 的环境变量。
   */
  /**
   * 拼子进程环境：继承的宿主环境 → **非交互护栏** → 启动项自己的 env（优先级从低到高）。
   *
   * 护栏存在的理由是真事：`zsh -lic` 会跑用户的 `.zshrc`，而 oh-my-zsh 的自动更新检查会
   * 打印 `[oh-my-zsh] Would you like to update? [Y/n]` 并**等一次按键** —— 没人按键时 PTY 就
   * 卡在那里，命令行根本没执行，面板上看着「运行中」其实什么也没跑（踩过：run-12）。
   * 启动项自己配了同名变量时以它的为准。
   *
   * @param {Record<string, string>} extra - 启动项自己的环境变量。
   * @returns {Record<string, string>} 交给 PTY 的环境。
   */
  const buildEnv = (extra) => {
    const base = {}
    if (config.inheritEnv === 'full') {
      for (const [key, value] of Object.entries(process.env)) {
        if (value === undefined || key === RESERVED_ENV_KEY) continue
        base[key] = value
      }
    }
    return { ...base, ...NON_INTERACTIVE_ENV, ...extra }
  }

  /**
   * 往环形日志尾巴里追加文本，超出上限时从头丢弃。
   *
   * @param {any} run - 运行记录。
   * @param {string} text - 新到的输出。
   * @returns {void}
   */
  const push = (run, text) => {
    if (text === '') return
    // 首字节耗时：`zsh -lic` 要加载 .zprofile + .zshrc（gitstatus/nvm/pyenv 这类
    // 初始化都在里面），本机实测 1.6–2.4s，而 `-lc` 只要 0.12s。这个数字直接给
    // 面板看，用户才知道那两秒花在哪、以及要不要把 shellArgs 换成 -lc。
    if (run.firstOutputMs === undefined) run.firstOutputMs = Date.now() - run.startedAt
    writeLogFile(run, text)
    run.chunks.push({ offset: run.total, text })
    run.total += text.length
    let overflow = run.total - run.headOffset - config.logMaxChars
    while (overflow > 0 && run.chunks.length > 0) {
      const first = run.chunks[0]
      if (first.text.length <= overflow) {
        run.chunks.shift()
        run.headOffset += first.text.length
        overflow -= first.text.length
        continue
      }
      run.chunks[0] = { offset: first.offset + overflow, text: first.text.slice(overflow) }
      run.headOffset += overflow
      overflow = 0
    }
  }

  /**
   * 读一段日志：按绝对偏移取增量，永不消费。
   *
   * @param {any} run - 运行记录。
   * @param {number} from - 客户端已拿到的绝对偏移。
   * @returns {{ text: string, from: number, next: number, truncated: boolean }} 增量。
   */
  const readLog = (run, from) => {
    const requested = Number.isSafeInteger(from) && from >= 0 ? from : 0
    const start = Math.max(requested, run.headOffset)
    let text = ''
    for (const chunk of run.chunks) {
      const end = chunk.offset + chunk.text.length
      if (end <= start) continue
      text += chunk.offset >= start ? chunk.text : chunk.text.slice(start - chunk.offset)
    }
    return { text, from: start, next: run.total, truncated: start > requested }
  }

  /**
   * 结构快照：日志本体不在里面，避免每次轮询都搬几 MB。
   *
   * @param {any} run - 运行记录。
   * @returns {object} 客户端可见的运行视图。
   */
  const view = (run) => ({
    id: run.id,
    name: run.name,
    groupId: run.groupId,
    groupTitle: run.groupTitle,
    itemId: run.itemId ?? '',
    command: run.command,
    cwd: run.cwd,
    status: run.status,
    pid: run.pid ?? null,
    startedAt: run.startedAt,
    endedAt: run.endedAt ?? null,
    exitCode: run.exitCode ?? null,
    signal: run.signal ?? null,
    error: run.error ?? null,
    firstOutputMs: run.firstOutputMs ?? null,
    logFile: run.logFile ?? '',
    logTruncated: run.logTruncated === true,
    bytes: run.total,
    droppedBytes: run.headOffset,
  })

  /**
   * 正在运行的实例数（历史记录不算 —— 它们不该占用"同时在跑"的额度）。
   *
   * @returns {number} 处于启动中 / 运行中 / 停止中的实例数。
   */
  const liveRunCount = () => {
    let count = 0
    for (const run of runs.values()) if (!SETTLED.has(run.status)) count += 1
    return count
  }

  /**
   * 淘汰最旧的终态记录：历史不该无限攒着（日志另有按体积的清理）。
   *
   * @returns {void}
   */
  const pruneSettled = () => {
    const settled = [...runs.values()].filter(run => SETTLED.has(run.status))
    const excess = settled.length - config.maxRuns
    if (excess <= 0) return
    settled.sort((left, right) => (left.endedAt ?? left.startedAt ?? 0) - (right.endedAt ?? right.startedAt ?? 0))
    for (const run of settled.slice(0, excess)) runs.delete(run.id)
  }

  /**
   * 标记一个运行进入终态。
   *
   * @param {any} run - 运行记录。
   * @param {'exited' | 'failed' | 'stopped'} status - 终态。
   * @param {{ exitCode?: number | null, signal?: string | null, error?: string }} [detail] - 细节。
   * @returns {void}
   */
  const settle = (run, status, detail = {}) => {
    if (SETTLED.has(run.status) && run.settled === true) return
    run.status = status
    run.settled = true
    run.endedAt = Date.now()
    run.exitCode = detail.exitCode ?? null
    run.signal = detail.signal ?? null
    if (detail.error !== undefined) run.error = detail.error
    if (run.stopTimer !== undefined) clearTimeout(run.stopTimer)
    run.stopTimer = undefined
    run.terminal = undefined
    closeLogFile(run)
    pruneSettled()
  }

  /**
   * 启动一个启动项。
   *
   * @param {{
   *   item: { id: string, name: string, command: string, env: Record<string, string> },
   *   cwd: string,
   *   groupId: string,
   *   groupTitle?: string,
   * }} request - 清单里的一条启动项、解析好的工作目录与所属分组（运行实例要能自报家门）。
   * @returns {Promise<object>} 运行视图。
   */
  const start = async ({ item, cwd, groupId, groupTitle = '' }) => {
    const subprocess = subprocessOf()
    if (liveRunCount() >= config.maxRuns) {
      throw new Error(`同时在跑的实例已达上限 ${config.maxRuns} 个，先停掉几个再启动`)
    }
    if (typeof item.command !== 'string' || item.command === '') {
      throw new Error('这个启动项没有可执行的命令行')
    }

    sequence += 1
    const run = {
      id: `run-${sequence}`,
      name: item.name,
      groupId,
      groupTitle,
      itemId: item.id,
      command: item.command,
      cwd,
      status: 'starting',
      settled: false,
      chunks: [],
      headOffset: 0,
      total: 0,
      startedAt: Date.now(),
      decoder: new TextDecoder('utf-8'),
    }
    runs.set(run.id, run)
    await pruneOnce()
    await openLogFile(run)

    const argv = [config.shellPath, ...config.shellArgs, item.command]
    try {
      const terminal = await subprocess.spawnTerminal({
        argv,
        cwd,
        env: buildEnv(item.env ?? {}),
        cols: config.cols,
        rows: config.rows,
        terminalType: 'xterm-256color',
        graceMs: Math.max(config.stopGraceMs, 1000),
      })
      run.terminal = terminal
      run.pid = terminal.pid
      run.status = 'running'

      terminal.output.on('data', (chunk) => {
        push(run, run.decoder.decode(chunk, { stream: true }))
      })
      terminal.output.on('end', () => {
        push(run, run.decoder.decode())
      })
      terminal.output.on('error', (error) => {
        push(run, `\n[launcher] PTY 输出异常：${error instanceof Error ? error.message : String(error)}\n`)
      })

      terminal.done.then(
        (outcome) => {
          push(run, run.decoder.decode())
          settle(run, run.interruptRequested === true ? 'stopped' : 'exited', {
            exitCode: outcome?.exitCode ?? null,
            signal: outcome?.signal ?? null,
          })
        },
        (error) => {
          push(run, `\n[launcher] 进程异常结束：${error instanceof Error ? error.message : String(error)}\n`)
          settle(run, 'failed', { error: error instanceof Error ? error.message : String(error) })
        },
      )
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      push(run, `[launcher] 启动失败：${message}\n`)
      settle(run, 'failed', { error: message })
    }

    return view(run)
  }

  /**
   * 停止一个运行：先 SIGINT（等价于终端里 Ctrl+C），宽限期后整棵树 terminate。
   *
   * @param {string} id - 运行 id。
   * @param {{ force?: boolean }} [options] - force 表示直接整棵树终止。
   * @returns {Promise<object | undefined>} 运行视图。
   */
  const stop = async (id, options = {}) => {
    const run = runs.get(id)
    if (run === undefined) return undefined
    const terminal = run.terminal
    if (terminal === undefined || SETTLED.has(run.status)) return view(run)

    run.interruptRequested = true
    run.status = 'stopping'
    if (options.force === true) {
      await terminal.terminate().catch(error => logger?.warn?.(`launcher: terminate 失败 ${String(error)}`))
      return view(run)
    }
    try {
      await terminal.signalForeground('SIGINT')
    } catch (error) {
      logger?.warn?.(`launcher: SIGINT 未送达（${error instanceof Error ? error.message : String(error)}），直接终止`)
      await terminal.terminate().catch(() => {})
      return view(run)
    }
    run.stopTimer = setTimeout(() => {
      if (SETTLED.has(run.status)) return
      terminal.terminate().catch(error => logger?.warn?.(`launcher: terminate 失败 ${String(error)}`))
    }, config.stopGraceMs)
    if (typeof run.stopTimer.unref === 'function') run.stopTimer.unref()
    return view(run)
  }

  /**
   * 丢弃某个运行已保留的日志（不动进程）。
   *
   * @param {string} id - 运行 id。
   * @returns {object | undefined} 运行视图。
   */
  const clear = (id) => {
    const run = runs.get(id)
    if (run === undefined) return undefined
    run.chunks = []
    run.headOffset = run.total
    return view(run)
  }

  /**
   * 从列表里移除一个已结算的运行。
   *
   * @param {string} id - 运行 id。
   * @returns {boolean} 是否删掉了一个。
   */
  const remove = (id) => {
    const run = runs.get(id)
    if (run === undefined) return false
    if (!SETTLED.has(run.status)) return false
    runs.delete(id)
    return true
  }

  /**
   * 列出全部运行，最新在前。
   *
   * @returns {Array<object>} 运行视图列表。
   */
  const list = () => [...runs.values()].map(view).reverse()

  /**
   * 读日志增量。
   *
   * @param {string} id - 运行 id。
   * @param {number} from - 客户端已拿到的绝对偏移。
   * @returns {{ run: object, text: string, from: number, next: number, truncated: boolean } | undefined} 结果。
   */
  const log = (id, from) => {
    const run = runs.get(id)
    if (run === undefined) return undefined
    return { run: view(run), ...readLog(run, from) }
  }

  /**
   * 插件卸载时收尾：终止所有还活着的进程。
   *
   * @returns {Promise<void>} 全部终止完成。
   */
  const disposeAll = async () => {
    for (const run of runs.values()) closeLogFile(run)
    const live = [...runs.values()].filter(run => run.terminal !== undefined && !SETTLED.has(run.status))
    await Promise.allSettled(
      live.map(async (run) => {
        try {
          await run.terminal.terminate()
        } catch (error) {
          logger?.warn?.(`launcher: 卸载时终止 ${run.id} 失败 ${String(error)}`)
        }
      }),
    )
  }

  return { list, start, stop, clear, remove, log, disposeAll, view, prune: pruneOnce }
}
