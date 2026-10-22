# dsh-project-runner (项目运行器)

[中文](README.zh.md) | **English**

A grouped run panel for **DeepSeek Harness** (`dsh`): every launch item is just *a command line +
a working directory*, and one click runs it in a **real PTY** — a real shell, your real environment,
your real colors — while the output streams into the panel and is written to disk.

It is deliberately **not** a debugger, and it does **not** read `.vscode/launch.json`.

```
 Left sidebar「启动器」 ──▶ Main panel
┌────────────────────────────┬────────────────────────────────────────────┐
│ ▾ demo-api   3 items       │ Admin Service            ● running   [■]   │
│   ~/work/demo-api          │ mvn -pl :admin-service spring-boot:run     │
│   ● Admin Service   ▶ ⋯    │ dir ~/work/demo-api/backend                │
│   ● HTTP collector  ▶ ⋯    │ ────────────────────────────────────────── │
│   ○ build all   task   ▶ ⋯ │ 12:01:03 INFO  Started AdminApplication    │
│ ▾ demo-web   2 items       │ 12:01:04 INFO  Tomcat started on :8080     │
│   ~/work/demo-web          │ ...                                        │
│   ○ Vite dev        ▶ ⋯    │                                            │
└────────────────────────────┴────────────────────────────────────────────┘
```

## Why it does not parse launch.json

`launch.json` is the **DAP debug configuration** format: `type`, `request`, `classPaths`, `program`
all exist for a debugger. Java's `$Auto`, Go's `dlv`, or `pwa-chrome`'s `url` only mean something
once an extension translates them. A run-only translation is therefore awkward in exactly the cases
you care about (Java, Go, browsers) — the first version of this plugin did that, and every Java entry
of a real project came out greyed out.

So the source of truth is the plugin's own list: **you write a command, it runs that command.**

## Why a global panel with groups

The tool answers "what do I have running right now?", which is a question that spans projects and
sessions, not one that belongs to a single conversation. So it is a **global** sidebar panel, and
items are organised into **groups** — one group per project (or per deployment of one project), each
with its own color.

## Install

Requires `dsh` **>= 0.2.1-rc.2**. The package ships its own `dsh.bundle.patch`, so installing is
enough — there is no second edit to your profile's `cordis.patch.yml`.

```sh
# from GitHub (plain JS, no build step, no build approval needed)
dsh plugin --profile desktop add github:tengyinan1994/dsh-project-runner

# or from a local checkout, for development
dsh plugin --profile desktop add link:/path/to/dsh-project-runner
```

Then **restart DSH** — the host half registers its routes and the PTY supervisor at boot.

> Editing `index.js` / `lib/*.js` always needs a restart: Node's ESM cache is process-wide, so
> disabling and re-enabling the bundle does not re-import it. `client.js` alone does not need a
> restart (the client bundle is served by mtime-derived revision).

## First run

1. Left sidebar → **启动器** → **＋ 新建分组**: a group name (e.g. the project name) and its default
   working directory.
2. Inside the group → **＋ 条目**: name, **kind**, command line, working directory (empty = the
   group's directory), environment variables (one `KEY=VALUE` per line). An empty name falls back to
   the first line of the command.
3. Click the item's row → the right pane shows its command, directory and environment. Press **▶** to
   run it.

## Item kinds: long-running service vs one-shot task

| Kind | What the panel says when it exits |
|---|---|
| **Service** (default) | `已退出（本该常驻）` amber — a collector that quietly died is an incident, so it must be visible |
| **Task** | exit 0 → `已完成` green; non-zero → `失败（退出码 N）` red |

Use **Task** for things like "build everything"; keep services as **Service**.

## Status dot

No dot means "not running". Only two states draw a dot:

| Dot | Meaning |
|---|---|
| green | running (including starting / stopping) |
| red | abnormal exit / failed to start |

The exact status text (with exit code) is on the dot's tooltip; when there is no dot it is on the
name's tooltip instead. An equal-width placeholder is kept when nothing is drawn, so names do not
shift left and right.

## Interactions

- **Drag & drop**: a group header is a drag handle (reorder groups); an item row is a drag handle
  (reorder inside the group, or drop it into another group to move it). A 3px insertion line shows
  where it will land — including "at the end" (drawn under the last group / last row).
- **⋯ menu**: edit, copy command, move up/down, switch kind, delete. The menu is rendered at the panel
  root with `position: fixed`, so the scroll container cannot clip it.
- **Filter**: matches group name, item name and command.
- **Collapse**: the whole group header is the hit area, not a tiny triangle.

## Logs are the point

Each run gets a plain-text log on disk:

```
$DSH_HOME/launcher/logs/<date>/<group>__<item>__<runN>.log
```

They survive a DSH restart, the panel shows the path (click to copy), and **an agent can read the file
directly**. Two gates keep the directory small:

| Gate | Default | Behaviour |
|---|---|---|
| Retention | 7 days | date directories older than that are removed wholesale |
| Total size | 512 MB | the oldest files are deleted until it fits (empty date dirs removed too) |

Cleanup runs when the plugin mounts and when a run starts. A single file is capped at 20 MB — past
that it stops writing to disk only (the panel still shows the in-memory ring buffer).

### Log panel and chat, on one screen

`main` is a single keyed slot, so the panel and the conversation can never be visible together. The
log view therefore lives in the **right sidebar** as a「运行日志」tab: the conversation stays in the
middle, the log on the right.

- The run switcher is a segmented control with a status dot per run; 「跟随最新」 follows the most
  recent **failed** run.
- Stop (`SIGINT`, same as Ctrl+C) / kill / clear / remove are all available there — you are usually
  watching a stuck log when you decide to stop it.
- **Select lines in the log** and a small「添加到对话」button pops up next to the selection. It writes a
  *reference* into the composer, not the log text:

  ```
  【启动器日志 run-4 · Admin Service 第 12~45 行】
  ```

  That keeps a 100k-character log out of the conversation while still telling the model exactly which
  lines to read.

### Five agent tools

Two are read-only, three take over run instances — so the model can "restart that service after
editing the code" without sending you back to the panel to click a button.

| Tool | Purpose |
|---|---|
| `launcher_status` | Groups, items and run instances with status / exit code / pid / command / cwd / log path. Status only, never log bodies. |
| `launcher_log` | Reads a run's output. Default is **signal lines only** (`Caused by`, `ERROR`, `Exception`, `BUILD FAILURE`, `ClassNotFound` … capped at 120 lines) plus the file path; `range:"12~45"`, `range:"signal"`, `range:"tail200"`, `mode:"tail"`, `mode:"full"` and `grep` are opt-in. With no selector it picks the most recent **failed** run. |
| `launcher_run` | Starts an item (same as clicking run): fuzzy `item` match, `group` to narrow. Refuses to start an item that already has a live run and points at `launcher_restart` instead. |
| `launcher_stop` | Stops a live run: by `run` id or `item`/`group`; `SIGINT` plus the grace period by default, `force: true` to terminate immediately. Only touches live runs. |
| `launcher_restart` | Stop (optionally `force`), **wait until the process has actually settled**, then start the same definition again — a restart right after `stop` would hit a taken port. Reports honestly when a process refuses to die. |

So the real workflow is: a service fails in the panel → back in the chat, say "why did admin-service fail in
the launcher" → the agent reads the log itself, cheaply.

## Configuration

Override by row id `launcher` in your profile's `cordis.patch.yml` (a patch replaces the whole
`config`, so restate every field you want to keep). All fields are documented inline in
[`cordis.patch.yml`](cordis.patch.yml); the important ones:

| Field | Default | Meaning |
|---|---|---|
| `shellPath` / `shellArgs` | `$SHELL` → `/bin/zsh` → …, `['-lic']` | How a run's shell is started. `-lic` loads your login files (PATH, nvm, pyenv…) at the cost of some first-byte latency; `-lc` skips `.zshrc`; `-c` is fastest |
| `inheritEnv` | `full` | `full` inherits your whole environment (including `*_KEY`), like a real terminal; `scrubbed` strips sensitive names like DSH's built-in terminal |
| `maxRuns` | 12 | Concurrent run instances kept (shared by all groups) |
| `logMaxChars` | 400000 | In-memory ring buffer per run |
| `stopGraceMs` | 3000 | After `SIGINT`, how long before the whole process tree is terminated |
| `storeFile` | `$DSH_HOME/launcher/items.json` | Where the list lives |
| `logDir` / `logRetentionDays` / `logMaxTotalBytes` / `logFileMaxBytes` | see above | Log persistence policy |

## What it touches on your machine

Public plugins should say this plainly:

| Behaviour | Detail |
|---|---|
| Processes | Starts a **real PTY** with `ctx.subprocess.spawnTerminal`, running **as you, with your permissions**. Commands come only from your own list; the plugin never composes a command for you |
| Environment | Default `inheritEnv: full` passes your whole environment to the child — **including** `*_KEY` / `*_TOKEN` / `*_SECRET` (otherwise a Vite project cannot see `VITE_*_KEY`). Set `inheritEnv: scrubbed` if you do not want that |
| Files | Writes only under `$DSH_HOME/launcher/`: `items.json` and `logs/`. Never touches your project directories |
| Network | **No outbound requests**, no telemetry. The HTTP surface is registered on DSH's own web server only (same-origin, loopback-only; non-loopback sources get 403) |
| Dependencies | Zero runtime dependencies |
| Deletion | Removing a group, an item or a run record never kills a running process; only stop / force-kill does |

## HTTP surface

17 exact routes under `/api/dsh-launcher`, same-origin and loopback-only. User mistakes return 400,
host bugs 500 with a stack — the two are never conflated. Write routes return the resulting list, so
the client never needs a second round trip.

| Route | Purpose |
|---|---|
| `GET /state` | list + runs + shell + store path + `capabilities` |
| `GET /runs` | runs only (polling) |
| `GET /log?run=&from=` | incremental log by absolute offset (reads are non-consuming) |
| `POST /start` `{group,item}` · `/stop` `{run,force?}` · `/clear` `{run}` · `/remove` `{run}` | run control |
| `POST /group/{create,update,remove,move,move-to}` | groups (`move` is ±1 for the menu, `move-to` is for drag & drop) |
| `POST /item/{create,update,remove,move,move-to}` | items |

Logs are read by **offset polling** (600 ms) rather than SSE: it behaves identically over Electron's
IPC bridge and plain HTTP.

## Known limits

- A run is **one command line with no interactive input**: you cannot type into the program's stdin.
  Use your terminal for things that need a TTY conversation.
- No debugger, no breakpoints, no launch.json translation — by design.
- Deleting an item that is still running leaves the process alive (deliberately); the panel shows an
  orphan bar so you can still stop it.
- `capabilities` in `/state` exists so the client can tell an old host from a new one; a field an old
  host does not know would otherwise be ignored **silently**.

## Development

```sh
npm test    # 132 tests: ANSI parsing, store, routes, supervisor, tools, client rendering
```

The plugin is zero-build and zero-dependency: the host half is plain ESM (`index.js` + `lib/*.js`),
the client half is a hand-written `window.__ModuleLoader__.load({ id, factory })` bundle that takes
`react` from the platform module table.

```
index.js              host entry: store + supervisor + routes + agent tools
lib/config.js         field table, defaults, lenient validation
lib/store.js          the list (items.json): groups, items, atomic writes, legacy migration
lib/supervisor.js     PTY runner, ring buffer, log files, stop ladder
lib/routes.js         /api/dsh-launcher/*, loopback fence, 400/500 split
lib/logs.js           log file names, signal extraction, size/age cleanup
lib/tool.js           launcher_status / launcher_log / launcher_run / launcher_stop / launcher_restart
client.js             sidebar entry + main panel + right-sidebar log tab
cordis.patch.yml      the bundle patch (documented config)
```

## License

MIT
