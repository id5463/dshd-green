# dshd Green 🛟 — the Guardian

A lifeboat for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (`dsh`). When your DSH breaks itself — corrupted config, runaway agent, stuck process — dshd Green launches a **fully isolated rescue agent** to fix it.

**Using Green does not require installing DSH.**

A member of the dshd family: 🟥 **Red** (desktop) · 🟦 **Blue** (mobile) · 🟩 **Green** (guardian).

> Community project, not affiliated with or endorsed by DeepSeek.

[![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](LICENSE)
[![node](https://img.shields.io/badge/node-%3E%3D18-brightgreen.svg)](package.json)

## How it works

Green's core is **not a command checklist — it is a rescue agent**:

- **Minimal mode** (`src/rescue.cordis.yml`, extracted from DSH's own `examples/jsonrpc-agent/minimal.cordis.yml`): the model sees exactly two tools — **shell** (persistent bash on POSIX / pwsh on win32) and **str_replace_editor**.
- **Fully isolated**: `rescue` does not open a session inside the main DSH process. It launches a **brand-new independent DSH process** — independent install (`npx @deepseek-ai/dsh`, or a CLI you specify), independent `DSH_HOME`, independent session directory. It does not rely on any code or process of the main DSH to run: the main DSH can be completely broken and rescue still works.
- **Let it work**: after injecting the rescue system prompt + a read-only preflight summary + the problem you describe, the agent inspects, repairs (backing up before editing), and reports in plain language by itself. New kinds of failures need no new code — that is the extensibility and adaptability.

## Design rules

1. **User-triggered only** — it never detects, starts, or fixes anything on its own. Every command is yours.
2. **Read-only first** — the rescue agent inspects (config/logs/processes) first, backs up before touching anything, makes the smallest change, and does not fix what is not broken.
3. **Zero dependencies** — plain Node (≥18), standard library + system tools.
4. **Fully isolated** — the rescue process shares zero runtime state with the main DSH.

## Install

```bash
npm install -g dshd-green     # global command
# or run without installing:
npx dshd-green status
```

## Usage

```bash
# Core: launch the rescue agent (fully isolated minimal-mode process, starts working immediately)
dshd-green rescue "DSH won't start, please look"   # with a problem description
dshd-green rescue                                   # read-only health check only

# Helpers: quick checks and materials before rescue
dshd-green status                # main DSH heartbeat + session overview
dshd-green doctor                # config/port/process/log/backup health checklist
dshd-green key                   # auto-detect the API key the main DSH uses
dshd-green log [--tail 30]       # tail the DSH log (--file <path>)
dshd-green backup                # snapshot critical config (settings/.credentials/profile, with manifest)
dshd-green list                  # list config backups
dshd-green restore <dir|--latest> [--yes]   # restore from a backup (auto-backup again first)
dshd-green prompt                # print the rescue system prompt
```

Every command supports `--json` (for structured rendering in the dshd Red UI).

### Which model does the rescue agent use?

Green only **reads** the main DSH's `settings.yaml` (`agent-default-model` + provider `baseURL`) and `.credentials.yaml` (API key), then injects them as data into the rescue process. Nothing is persisted or sent anywhere. If the main DSH config is broken, pass them directly:

```bash
DEEPSEEK_API_KEY=sk-... DEEPSEEK_BASE_URL=https://api.deepseek.com \
  DSH_MODEL=deepseek-v4-flash dshd-green rescue "fix my config"
```

### Environment

| Variable | Purpose |
|---|---|
| `DSH_HOME` | main DSH data directory (default `~/.dsh`; read-only, the rescue target) |
| `DSH_GREEN_DSH` | rescue dsh CLI (default: local DSH source, else npx `@deepseek-ai/dsh`) |
| `DSH_GREEN_HOME` | Green's own data root (default `~/.dshd-green`: backups + isolated instances) |
| `DSH_GREEN_MODULES` | extra package-root directory (for deployments missing packages) |
| `DSH_PORT` | main DSH port (default 3080) |

## Relationship to the dshd family

`dshd` is the family repo: [dshd Red](https://github.com/id5463/dshd) (desktop, embeds Green: sidebar → 🛟 Guardian), dshd Blue (Android remote), and this standalone **dshd Green**. Green ships as an independent project to stay "boring, stable, releasable on its own" — while Red/Blue embed it.

## License

[MIT](LICENSE). Not affiliated with or endorsed by DeepSeek.
