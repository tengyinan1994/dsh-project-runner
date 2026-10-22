/**
 * dsh-launcher —— 在 DeepSeek Harness 里做一个「一键起项目」的启动器。
 *
 * 它管的是一份**自己的启动项清单**（分组 + 条目），不解析 VSCode 的
 * `.vscode/launch.json`：那是 DAP 调试配置格式，run-only 翻译在 java / go /
 * 浏览器三类上注定别扭。清单里一条就是「一条命令行 + 一个工作目录」，存
 * `$DSH_HOME/launcher/items.json`；点一下就用真 PTY 跑起来，输出进有界环形日志。
 *
 * 两半：
 * - **宿主半侧**（这个文件）：清单存储、路由与 PTY 运行器；
 * - **浏览器半侧**（`client.js`）：左侧栏「启动器」入口 + 分组/条目/日志面板。
 *
 * 没有第三方依赖、没有构建步骤：宿主半侧是纯 ESM + Node 内置模块，浏览器半侧
 * 是手写的 `__ModuleLoader__` bundle（`require("react")` 从平台模块表解析）。
 * 这样它才能作为一个 link 到 profile 的外挂包，在任何官方 DSH 桌面端里加载。
 *
 * @module dsh-launcher
 */

import { resolveConfig, validateConfig } from './lib/config.js'
import { makeRoutes } from './lib/routes.js'
import { createStore, logDirPath, storeFilePath } from './lib/store.js'
import { createSupervisor } from './lib/supervisor.js'
import { registerLauncherTools } from './lib/tool.js'

/** Cordis 插件名，出现在加载器诊断里。 */
export const name = 'launcher'

/**
 * 硬依赖只有 webServer：没有它就没有给浏览器半侧的通道，插件没有意义。
 * `subprocess` 在真正启动时才解析，缺了它面板仍然能列出启动项并给出明确报错。
 */
export const inject = ['webServer']

/**
 * 挂载插件。
 *
 * @param {any} ctx - 插件上下文。
 * @param {Record<string, unknown> | undefined} config - 加载器传入的行配置。
 * @returns {void}
 */
export function apply(ctx, config) {
  // 一个拼错的键只告警、不抛错：配置问题不该让整个面板消失，而 loading 期
  // 抛错的表现恰好就是「插件看起来不在」。
  const check = validateConfig(config)
  if ('issues' in check) {
    for (const issue of check.issues) {
      ctx.logger?.warn?.(`launcher: 忽略无效配置 — ${issue.message}`)
    }
  }
  const resolved = resolveConfig(config)

  // 清单是宿主状态：面板刷新、换窗口、换会话看到的都是同一份。
  const store = createStore({
    filePath: resolved.storeFile === '' ? storeFilePath() : resolved.storeFile,
    logger: ctx.logger,
  })
  // 日志落盘目录：跑过的每个实例留一份可读的文本，跨重启还在，模型也能直接读。
  const runtime = { ...resolved, logDir: resolved.logDir === '' ? logDirPath() : resolved.logDir }
  const supervisor = createSupervisor({ ctx, config: runtime, logger: ctx.logger })
  const routes = makeRoutes({ config: runtime, supervisor, store, logger: ctx.logger })

  // 挂载即清一次旧日志：清理不该依赖「你恰好启动了某个实例」这件事。
  ctx.effect(() => {
    void supervisor.prune()
  }, 'launcher: prune logs')

  // agent 工具是可选的：没有 tools 服务的组合里，面板照常工作，只是模型读不到日志。
  ctx.inject(['tools'], (toolCtx) => {
    toolCtx.effect(
      () => registerLauncherTools(toolCtx, { supervisor, store, config: runtime, logger: ctx.logger }),
      'launcher: tools',
    )
  })

  ctx.effect(() => {
    const disposers = routes.map(route => ctx.webServer.register(route))
    return () => {
      for (const dispose of disposers) dispose()
    }
  }, 'launcher: routes')

  // 卸载 / 热重载时，先把还活着的 PTY 收掉再交还路由，避免留下孤儿进程。
  ctx.effect(() => () => {
    void supervisor.disposeAll()
    void store.dispose()
  }, 'launcher: runs')

  ctx.logger?.info?.(
    `launcher: 已挂载（shell ${runtime.shellPath} ${runtime.shellArgs.join(' ')}；清单 ${store.file()}；日志 ${runtime.logDir}）`,
  )
}
