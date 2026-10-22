# dsh-project-runner

[中文](README.zh.md) | **English**

Start your project's services from inside DeepSeek Harness: one click runs them in a **real
terminal**, the output streams into the panel, and every run is saved to disk — so "why did it fail?"
can be asked in the chat instead of digging through terminal tabs.

## What it does

- **Grouped list**: one group per project, one item per command + working directory
- **Real terminal**: a real shell with your PATH / nvm / pyenv, colors exactly like your terminal
- **One-click run / stop**: each item keeps its own live log and follows the latest output
- **Logs on disk**: runs survive a DSH restart; old logs are cleaned up automatically (7 days / 512 MB)
- **Next to the chat**: the right-sidebar「运行日志」tab sits beside the conversation — **select a few
  lines and insert them into the message** (a line reference, not a 100k-character paste)
- **The agent can help**: it can check status, read the important log lines, and run / stop / restart
  items — no clicking back and forth
- Drag & drop ordering, cross-group moves, per-group colors, light/dark theme

## Install

```sh
dsh plugin --profile desktop add github:tengyinan1994/dsh-project-runner
```

Restart DSH afterwards. Requires dsh ≥ 0.2.1-rc.2.

## Use it

1. Left sidebar **启动器** → **＋ 新建分组**: a project name and a default directory
2. **＋ 条目** inside the group: name, command line, working directory (empty = the group's)
3. Press **▶** on the row to run it; click the row to see its command and live log
4. Drag to reorder, or drag an item into another group to move it

**Two kinds**: a long-running service (default — you get told if it exits) and a one-shot task
(e.g. a build, shows「已完成」when done). Switch in the item's ⋯ menu.

## Configuration (optional)

The defaults are usually fine. To change the shell, its flags, or the log retention, override the
`launcher` row in your profile's `cordis.patch.yml` — every field is commented there.

## Notes

- The panel UI is in Chinese.
- An item is one command line with **no interactive input** (you cannot type into the program), and
  there is no debugger.
- **Deleting a group or item never kills a running process** — use stop for that.
- The child shell inherits your full environment by default, like a real terminal; set
  `inheritEnv: scrubbed` if you do not want `*_KEY`-style variables passed through.

## Platform

macOS, Linux and Windows. The shell is detected automatically — `$SHELL` / zsh / bash / sh on
macOS and Linux, `pwsh` → `powershell` → `cmd.exe` on Windows — and the launch flags follow the
detected shell (`-lic` for bash/zsh, `/d /s /c` for cmd, `-NoLogo -Command` for PowerShell).
Windows works through these defaults but has not been exercised on real Windows hardware, so bug
reports are welcome.

## License

MIT
