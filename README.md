# dshd Green 🛟 — the guardian

A lifeboat for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (`dsh`). When your DSH kills itself — config corruption, a runaway agent, a hung process — dshd Green is the small, isolated, always-available rescue tool that only **you** can invoke.

Part of the **dshd** family: 🟥 **Red** (desktop) · 🟦 **Blue** (mobile) · 🟩 **Green** (guardian).

> A community project, not affiliated with or endorsed by DeepSeek.

[![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](LICENSE)
[![node](https://img.shields.io/badge/node-%3E%3D18-brightgreen.svg)](package.json)

## Design principles

1. **User-triggered only** — it detects nothing, starts nothing, fixes nothing on its own. Every command is you.
2. **Read-only (Phase 1)** — `status` / `doctor` / `log` never modify a file or spawn a process.
3. **Zero shared state** — it only *reads* your DSH (config, port, logs). It shares nothing but the files you point it at.
4. **Zero dependencies** — pure Node, works anywhere Node 18+ runs.

## Install

```bash
npm install -g dshd-green     # global command
# or without installing:
npx dshd-green status
```

## Usage

```bash
dshd-green status                # DSH heartbeat + session overview
dshd-green doctor                # config / port / process / log health checklist
dshd-green log [--tail 30]       # tail DSH logs (--file <path> to point at a log)
```

Options: `--port <n>` (default 3080, or env `DSH_PORT`) · env `DSH_HOME` (default `~/.dsh`)

Example:

```
$ dshd-green status
  DSH 状态 : ✅ 在线 / online (195ms)
  会话     : 共 25 个, 运行中 1 个
    - 这是一个长程开发任务，在完 (6)

$ dshd-green doctor
  DSH_HOME : I:\dsh-home
  [OK ] DSH API 在线 (127.0.0.1:3080, PID 23132)
  [OK ] settings.yaml 存在 (875B, 含 llm-pi-ai + agent-default-model)
  [OK ] .credentials.yaml 存在 (1 个凭证条目)
  [OK ] dsh 进程: 4 个
  [WARN] 未发现日志文件 (可用 dshd-green log --file <path>)
```

## Roadmap

- [x] **Phase 1 — read-only diagnostics**: `status` / `doctor` / `log`
- [ ] **Phase 2 — rescue**: spawn an isolated minimal-mode rescue instance (own `DSH_HOME`, own port, the Minimal tool pair only, sharing nothing but your API key)
- [ ] **Phase 3 — recover**: config snapshots + one-click rollback (`settings.yaml` / `.credentials.yaml` backups before risky operations)
- [ ] **Phase 4 — repair wizard**: guided recovery ("what broke → suggested action → you confirm")
- [ ] **Integration**: embedded into dshd Red (menu/tray "🛟 救援模式") and usable from dshd Blue via the desktop

## Relationship to the dshd family

`dshd` is the family repository: [dshd Red](https://github.com/id5463/dshd) (desktop GUI), dshd Blue (Android remote), and this standalone **dshd Green** guardian. Green lives here as its own project so it can stay boring, stable and independently releaseable — while Red/Blue embed it.

## License

[MIT](LICENSE). Not affiliated with or endorsed by DeepSeek.
