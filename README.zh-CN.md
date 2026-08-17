# dshd Green 🛟 — 守护者

[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（`dsh`）的救生艇。当你的 DSH 把自己玩坏时——配置损坏、agent 失控、进程卡死——dshd Green 会拉起一个**完全隔离的救援 agent** 去救它。

**使用 Green 甚至不需要安装 DSH。**

dshd 家族的一员：🟥 **Red**（桌面端）· 🟦 **Blue**（移动端）· 🟩 **Green**（守护者）。

> 社区项目，与 DeepSeek 无隶属关系，亦未获其认可。

[![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](LICENSE)
[![node](https://img.shields.io/badge/node-%3E%3D18-brightgreen.svg)](package.json)

## 它是怎么工作的

Green 的主体**不是一个命令清单，而是一个救援 agent**：

- **极简模式**（`src/rescue.cordis.yml`，从 DSH 源码 `examples/jsonrpc-agent/minimal.cordis.yml` 拆出）：模型只看到两个工具——**shell**（POSIX 持久 bash / win32 pwsh）和 **str_replace_editor**。
- **完全隔离**：`rescue` 拉起的不是主 DSH 进程里的会话，而是一个**全新的独立 DSH 进程**——独立安装（npx `@deepseek-ai/dsh`，或你指定的 CLI）、独立 `DSH_HOME`、独立会话目录。它不依赖主 DSH 的任何一条代码/进程来运行：主 DSH 完全坏了也能救。
- **让它工作**：注入救援系统提示词 + 只读预检发现 + 你描述的问题后，agent 自己检查、自己修复（改文件前先备份）、自己用平实语言报告。遇到新故障不需要为它写新代码——这就是扩展性和适应性。

## 设计铁律

1. **仅用户触发**——它自己不检测、不启动、不修复任何东西。每条命令都是你下的。
2. **只读优先**——救援 agent 先检查（配置/日志/进程），动手前先备份，只做最小改动，不修没坏的东西。
3. **零依赖**——纯 Node（≥18），标准库 + 系统工具。
4. **完全隔离**——救援进程与主 DSH 零共享运行状态。

## 安装

```bash
npm install -g dshd-green     # 全局命令
# 或不安装直接跑:
npx dshd-green status
```

## 用法

```bash
# 核心: 启动救援 agent (完全隔离的极简模式进程, 立即开始工作)
dshd-green rescue "DSH 打不开了, 帮我看一下"    # 带问题描述
dshd-green rescue                               # 只做一次只读健康检查

# 辅助: 救援前的快速检查与材料
dshd-green status                # 主 DSH 心跳 + 会话概览
dshd-green doctor                # 配置/端口/进程/日志/备份 健康检查
dshd-green key                   # 自动识别主 DSH 正在使用的 API key
dshd-green log [--tail 30]       # 查看日志尾部 (--file <path>)
dshd-green backup                # 备份关键配置 (settings/.credentials/profile, 含清单)
dshd-green list                  # 列出配置备份
dshd-green restore <dir|--latest> [--yes]   # 从备份恢复 (恢复前自动再备份一次)
dshd-green prompt                # 打印救援系统提示词
```

所有命令支持 `--json`（供 dshd Red 界面结构化渲染）。

### 救援 agent 用什么模型？

Green 只**读取**主 DSH 的 `settings.yaml`（`agent-default-model` + 供应商 `baseURL`）和 `.credentials.yaml`（API key），把它们作为数据注入救援进程。读取即用，不落盘、不外发；若主 DSH 的配置坏了，可以用环境变量直接指定：

```bash
DEEPSEEK_API_KEY=sk-... DEEPSEEK_BASE_URL=https://api.deepseek.com \
  DSH_MODEL=deepseek-v4-flash dshd-green rescue "帮我修复配置"
```

### 环境变量

| 变量 | 用途 |
|---|---|
| `DSH_HOME` | 主 DSH 数据目录（默认 `~/.dsh`；只读，救援目标） |
| `DSH_GREEN_DSH` | 指定救援用 dsh CLI（默认：本机 DSH 源码，否则 npx `@deepseek-ai/dsh`） |
| `DSH_GREEN_HOME` | Green 自己的数据根（默认 `~/.dshd-green`，含备份与隔离实例） |
| `DSH_GREEN_MODULES` | 额外包来源目录（供缺包的部署补齐极简组合） |
| `DSH_PORT` | 主 DSH 端口（默认 3080） |

## 与 dshd 家族的关系

`dshd` 是家族仓库：[dshd Red](https://github.com/id5463/dshd)（桌面端，内置 Green：侧栏 → 🛟 守护）、dshd Blue（Android 远程）、以及这个独立的 **dshd Green**。Green 作为独立项目发布，是为了保持"无聊、稳定、可单独发版"——而 Red/Blue 会内嵌它。

## 许可证

[MIT](LICENSE)。与 DeepSeek 无隶属关系，亦未获其认可。
