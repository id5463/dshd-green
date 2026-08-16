# dshd Green 🛟 — 守护者

[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（`dsh`）的救生艇。当你的 DSH 把自己玩坏时——配置损坏、agent 失控、进程卡死——dshd Green 是一个小巧、隔离、永远可用的救援工具，而且**只有你能触发它**。

dshd 家族的一员：🟥 **Red**（桌面端）· 🟦 **Blue**（移动端）· 🟩 **Green**（守护者）。

> 社区项目，与 DeepSeek 无隶属关系，亦未获其认可。

[![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](LICENSE)
[![node](https://img.shields.io/badge/node-%3E%3D18-brightgreen.svg)](package.json)

## 设计铁律

1. **仅用户触发**——它自己不检测、不启动、不修复任何东西。每条命令都是你下的。
2. **只读（Phase 1）**——`status` / `doctor` / `log` 绝不修改文件、绝不拉起进程。
3. **零共享状态**——它只*读取*你的 DSH（配置、端口、日志），不与之共享任何运行时状态。
4. **零依赖**——纯 Node，任何 Node 18+ 环境开箱即用。

## 安装

```bash
npm install -g dshd-green     # 全局命令
# 或不安装直接跑:
npx dshd-green status
```

## 用法

```bash
dshd-green status                # 主 DSH 心跳 + 会话概览
dshd-green doctor                # 配置/端口/进程/日志 健康检查清单
dshd-green log [--tail 30]       # 查看 DSH 日志尾部 (--file <path> 指定日志文件)
```

选项：`--port <n>`（默认 3080，或环境变量 `DSH_PORT`）· 环境变量 `DSH_HOME`（默认 `~/.dsh`）

示例：

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

## 路线图

- [x] **Phase 1 — 只读诊断**：`status` / `doctor` / `log`
- [ ] **Phase 2 — 救援**：拉起隔离的极简模式救援实例（独立 `DSH_HOME`、独立端口、只有 Minimal 工具对，除 API key 外不共享任何东西）
- [ ] **Phase 3 — 恢复**：配置快照 + 一键回滚（危险操作前自动备份 `settings.yaml` / `.credentials.yaml`）
- [ ] **Phase 4 — 修复向导**：引导式恢复（"哪里坏了 → 建议动作 → 你确认"）
- [ ] **集成**：内嵌进 dshd Red（菜单/托盘"🛟 救援模式"），dshd Blue 经桌面端间接使用

## 与 dshd 家族的关系

`dshd` 是家族仓库：[dshd Red](https://github.com/id5463/dshd)（桌面端）、dshd Blue（Android 远程）、以及这个独立的 **dshd Green** 守护者。Green 作为独立项目发布，是为了保持"无聊、稳定、可单独发版"——而 Red/Blue 会内嵌它。

## 许可证

[MIT](LICENSE)。与 DeepSeek 无隶属关系，亦未获其认可。
