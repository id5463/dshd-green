'use strict'
/**
 * dshd Green — 守护者 (guardian): DSH 的救生艇。
 *
 * 只读诊断工具 (Phase 1): 不修改任何配置, 不启动任何进程。
 *   status  主 DSH 心跳 + 会话概览
 *   doctor  配置/端口/进程/日志 健康检查清单
 *   log     查看主 DSH 日志 (尾部)
 *
 * 设计铁律: 仅用户触发; 零共享状态 (只读); 零依赖。
 */
const http = require('node:http')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { execFileSync } = require('node:child_process')

const VERSION = '0.1.0'
const DEFAULT_PORT = 3080

const C = {
  green: '\x1b[32m', red: '\x1b[31m', yellow: '\x1b[33m', dim: '\x1b[2m', reset: '\x1b[0m',
}
const OK = C.green + 'OK ' + C.reset
const WARN = C.yellow + 'WARN' + C.reset
const FAIL = C.red + 'FAIL' + C.reset

function parseArgs(argv) {
  const out = { cmd: null, port: DEFAULT_PORT, tail: 30, file: null }
  const rest = []
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--port') out.port = Number(argv[++i]) || DEFAULT_PORT
    else if (a === '--tail') out.tail = Number(argv[++i]) || 30
    else if (a === '--file') out.file = argv[++i] || null
    else if (a === '--version' || a === '-v') out.cmd = 'version'
    else rest.push(a)
  }
  if (process.env.DSH_PORT) out.port = Number(process.env.DSH_PORT) || DEFAULT_PORT
  if (rest.length) out.cmd = rest[0]
  return out
}

function dshHome() {
  return process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
}

/** DSH HTTP JSON-RPC: POST /api/<method> */
function rpc(port, method, payload) {
  return new Promise((resolve) => {
    const body = JSON.stringify({
      type: 'client-request', rpcId: 'dshd-green-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8),
      method, payload,
    })
    const req = http.request({
      hostname: '127.0.0.1', port, path: '/api/' + method, method: 'POST',
      headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) },
      timeout: 5000,
    }, (res) => {
      let d = ''
      res.on('data', (c) => { d += c; if (d.length > 4 * 1024 * 1024) res.destroy() })
      res.on('end', () => { try { resolve(JSON.parse(d)) } catch (e) { resolve(null) } })
    })
    req.on('error', () => resolve(null))
    req.on('timeout', () => { try { req.destroy() } catch (e) {} resolve(null) })
    req.end(body)
  })
}

/** 端口是否有东西在听 (TCP 连接试探) */
function tcpCheck(port) {
  return new Promise((resolve) => {
    const sock = require('node:net').connect({ host: '127.0.0.1', port, timeout: 2000 })
    const done = (ok) => { try { sock.destroy() } catch (e) {} resolve(ok) }
    sock.on('connect', () => done(true))
    sock.on('error', () => done(false))
    sock.on('timeout', () => done(false))
  })
}

/** 监听端口的进程 (Windows netstat, 尽力而为) */
function listenerPid(port) {
  try {
    if (process.platform !== 'win32') return null
    const out = execFileSync('netstat', ['-ano'], { encoding: 'utf8', timeout: 4000, stdio: ['ignore', 'pipe', 'ignore'] })
    for (const line of out.split(/\r?\n/)) {
      const m = line.trim().match(/TCP\s+127\.0\.0\.1:(\d+)\s+\S+\s+LISTENING\s+(\d+)/)
      if (m && Number(m[1]) === port) return Number(m[2])
    }
  } catch (e) { /* 尽力而为 */ }
  return null
}

function prettySessions(items) {
  const running = (items || []).filter((s) => s.running)
  const total = (items || []).length
  const list = running.slice(0, 5).map((s) => {
    const title = (s.projections && s.projections.values && s.projections.values.title) || s.cwd || s.sessionId
    return '    - ' + title
  })
  return { total, running: running.length, list }
}

async function cmdStatus(opts) {
  console.log(C.dim + 'dshd Green ' + VERSION + ' — status' + C.reset)
  console.log(C.dim + '  target: http://127.0.0.1:' + opts.port + C.reset)
  const t0 = Date.now()
  const res = await rpc(opts.port, 'session.list', {})
  const ms = Date.now() - t0
  if (!res || !res.result || !res.result.ok) {
    console.log('  DSH 状态 : ' + C.red + '❌ 离线 / offline' + C.reset)
    const listening = await tcpCheck(opts.port)
    console.log('  端口 ' + opts.port + (listening ? C.yellow + ' : 有进程监听但 API 无响应 (可能卡死)' + C.reset
      : C.red + ' : 无监听 (DSH 未启动)' + C.reset))
    return 1
  }
  const items = res.result.value && res.result.value.items || []
  const s = prettySessions(items)
  console.log('  DSH 状态 : ' + C.green + '✅ 在线 / online (' + ms + 'ms)' + C.reset)
  console.log('  会话     : 共 ' + s.total + ' 个, 运行中 ' + s.running + ' 个')
  if (s.list.length) console.log(s.list.join('\n'))
  return 0
}

function checkFile(p) {
  try {
    const st = fs.statSync(p)
    return { exists: true, size: st.size, mtime: st.mtime }
  } catch (e) { return { exists: false } }
}

/** 自动识别 DSH 正在使用的 API key (只读): 默认供应商 apiKeyEnv → credentials → 环境变量 */
function findKey() {
  const home = dshHome()
  let settingsText = ''
  let credsText = ''
  try { settingsText = fs.readFileSync(path.join(home, 'settings.yaml'), 'utf8') } catch (e) {}
  try { credsText = fs.readFileSync(path.join(home, '.credentials.yaml'), 'utf8') } catch (e) {}
  const creds = {}
  for (const m of credsText.matchAll(/^([A-Za-z_][A-Za-z0-9_]*)\s*:\s*(.+?)\s*$/gm)) {
    creds[m[1]] = String(m[2]).replace(/^["']|["']$/g, '')
  }
  const dm = settingsText.match(/agent-default-model:\s*\n\s*provider:\s*(\S+)/)
  if (dm) {
    const provId = dm[1]
    const provM = settingsText.match(new RegExp('\\n\\s{2,}' + provId + ':\\s*\\n([\\s\\S]*?)(?=\\n\\s{2}\\S+:\\s|\\n\\S)', 'm'))
    const envM = (provM ? provM[1] : '').match(/apiKeyEnv:\s*(\S+)/)
    const env = envM && envM[1]
    if (env && creds[env]) return { key: creds[env], envName: env, source: '默认供应商 ' + provId + ' (.credentials.yaml)' }
    if (env && process.env[env]) return { key: process.env[env], envName: env, source: '默认供应商 ' + provId + ' (环境变量)' }
  }
  for (const env of ['DEEPSEEK_API_KEY', 'DSH_API_KEY']) {
    if (creds[env]) return { key: creds[env], envName: env, source: '.credentials.yaml' }
    if (process.env[env]) return { key: process.env[env], envName: env, source: '环境变量' }
  }
  const first = Object.entries(creds)[0]
  if (first) return { key: first[1], envName: first[0], source: '.credentials.yaml 第一条' }
  for (const [k, v] of Object.entries(process.env)) {
    if (/^[A-Z0-9_]*API_KEY$/.test(k) && v) return { key: v, envName: k, source: '环境变量' }
  }
  return null
}

function maskKey(k) {
  if (!k) return ''
  return k.length <= 8 ? '****' : k.slice(0, 4) + '…' + k.slice(-4)
}

function cmdKey(opts) {
  console.log(C.dim + 'dshd Green ' + VERSION + ' — key' + C.reset)
  const found = findKey()
  if (!found) {
    console.log('  ' + C.yellow + '未找到 DSH 的 API key' + C.reset)
    console.log('  (检查 ' + path.join(dshHome(), 'settings.yaml') + ' 与 .credentials.yaml)')
    return 1
  }
  console.log('  ✅ 已识别: ' + C.green + maskKey(found.key) + C.reset)
  console.log('  来源     : ' + found.source)
  console.log('  环境变量 : ' + found.envName)
  console.log(C.dim + '  提示: key 只在本地识别, 不落盘、不外发。' + C.reset)
  return 0
}

async function cmdDoctor(opts) {
  console.log(C.dim + 'dshd Green ' + VERSION + ' — doctor' + C.reset)
  const home = dshHome()
  console.log('  DSH_HOME : ' + home)

  // 1. 端口 / API
  const res = await rpc(opts.port, 'session.list', {})
  const pid = listenerPid(opts.port)
  if (res && res.result && res.result.ok) {
    console.log('  [' + OK + '] DSH API 在线 (127.0.0.1:' + opts.port + (pid ? ', PID ' + pid : '') + ')')
  } else {
    const listening = await tcpCheck(opts.port)
    if (listening) console.log('  [' + WARN + '] 端口 ' + opts.port + ' 有监听但 API 无响应 — 疑似卡死')
    else console.log('  [' + FAIL + '] 端口 ' + opts.port + ' 无监听 — DSH 未启动')
  }

  // 2. settings.yaml
  const settings = path.join(home, 'settings.yaml')
  const sf = checkFile(settings)
  if (sf.exists) {
    const txt = fs.readFileSync(settings, 'utf8')
    const hasPi = /llm-pi-ai/.test(txt)
    const hasDefault = /agent-default-model/.test(txt)
    console.log('  [' + OK + '] settings.yaml 存在 (' + sf.size + 'B' + (hasPi && hasDefault ? ', 含 llm-pi-ai + agent-default-model' : '') + ')')
    if (!hasPi) console.log('  [' + WARN + '] settings.yaml 缺少 llm-pi-ai 段 (模型供应商配置缺失)')
    if (!hasDefault) console.log('  [' + WARN + '] settings.yaml 缺少 agent-default-model 段 (默认模型未设置)')
  } else {
    console.log('  [' + FAIL + '] settings.yaml 不存在 (' + settings + ')')
  }

  // 3. .credentials.yaml
  const creds = path.join(home, '.credentials.yaml')
  const cf = checkFile(creds)
  if (cf.exists) {
    const txt = fs.readFileSync(creds, 'utf8')
    const keys = (txt.match(/^[A-Za-z_][A-Za-z0-9_]*\s*:/gm) || []).length
    console.log('  [' + OK + '] .credentials.yaml 存在 (' + keys + ' 个凭证条目)')
  } else {
    console.log('  [' + FAIL + '] .credentials.yaml 缺失 — 没有 API key, 模型不可用')
  }

  // 3.5 API key 自动识别
  const found = findKey()
  if (found) console.log('  [' + OK + '] API key 已识别: ' + maskKey(found.key) + ' (' + found.source + ')')
  else console.log('  [' + WARN + '] 未识别到 API key (可运行 dshd-green key 查看)')

  // 4. dsh 进程
  try {
    const out = execFileSync(process.platform === 'win32' ? 'wmic' : 'ps',
      process.platform === 'win32' ? ['process', 'where', "name='node.exe'", 'get', 'ProcessId,CommandLine'] : ['-eo', 'pid,command'],
      { encoding: 'utf8', timeout: 4000, stdio: ['ignore', 'pipe', 'ignore'] })
    const dshProcs = out.split(/\r?\n/).filter((l) => /dsh|bin\.js|bin\.ts/.test(l) && !/dshd-green/.test(l))
    console.log('  [' + (dshProcs.length ? OK : WARN) + '] dsh 进程: ' + (dshProcs.length ? dshProcs.length + ' 个' : '未发现 (可能由桌面端/容器管理)'))
  } catch (e) {
    console.log('  [' + WARN + '] 无法枚举进程')
  }

  // 5. 日志可用性
  const logs = discoverLogs(opts)
  if (logs.length) console.log('  [' + OK + '] 日志: ' + logs.map((l) => path.basename(l)).join(', '))
  else console.log('  [' + WARN + '] 未发现日志文件 (可用 dshd-green log --file <path>)')

  console.log(C.dim + '  提示: 诊断只读, 不修改任何内容。修复请期待后续版本 (rescue/recover)。' + C.reset)
  return 0
}

function discoverLogs(opts) {
  const candidates = []
  if (opts.file) candidates.push(opts.file)
  const home = dshHome()
  candidates.push(path.join(home, 'logs'))
  // 桌面端 (dshd Red) 可能的日志位置
  for (const name of ['dshd Red', 'dshd-red', 'dsh-desktop']) {
    candidates.push(path.join(process.env.APPDATA || '', name))
  }
  const found = []
  for (const c of candidates) {
    try {
      const st = fs.statSync(c)
      if (st.isFile()) { found.push(c); continue }
      if (st.isDirectory()) {
        for (const f of fs.readdirSync(c)) {
          if (/\.(log|err)$/i.test(f)) found.push(path.join(c, f))
        }
      }
    } catch (e) { /* 跳过 */ }
  }
  return found.slice(0, 5)
}

function cmdLog(opts) {
  const logs = discoverLogs(opts)
  if (!logs.length) {
    console.error('未找到日志文件。可用: dshd-green log --file <path>')
    return 1
  }
  const file = logs[0]
  const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean)
  const tail = lines.slice(-opts.tail)
  console.log(C.dim + file + ' (共 ' + lines.length + ' 行, 显示最后 ' + tail.length + ' 行)' + C.reset)
  console.log(tail.join('\n'))
  return 0
}

function usage() {
  console.log(
    'dshd Green ' + VERSION + ' — 守护者 / the guardian\n' +
    'DSH (DeepSeek Harness) 的救生艇: 只读诊断, 仅用户触发。\n' +
    '\n' +
    '用法 / usage:\n' +
    '  dshd-green status            主 DSH 心跳 + 会话概览\n' +
    '  dshd-green doctor            配置/端口/进程/日志 健康检查\n' +
    '  dshd-green key               自动识别 DSH 正在使用的 API key\n' +
    '  dshd-green log [--tail 30]   查看日志尾部 (可 --file <path>)\n' +
    '  dshd-green prompt            打印救援实例默认系统提示词 (Phase 2 启用)\n' +
    '\n' +
    '选项 / options:\n' +
    '  --port <n>    DSH 端口 (默认 3080, 或环境变量 DSH_PORT)\n' +
    '  --version     \n' +
    '\n' +
    '环境 / env: DSH_HOME (默认 ~/.dsh) · DSH_PORT\n' +
    '设计铁律: 只读 · 零依赖 · 绝不自动启动任何东西 — 一切由用户决定。\n'
  )
  return 0
}

function cmdPrompt() {
  const { RESCUE_SYSTEM_PROMPT } = require('./prompt.js')
  console.log(RESCUE_SYSTEM_PROMPT)
  return 0
}

async function run(argv) {
  const opts = parseArgs(argv)
  try {
    switch (opts.cmd) {
      case 'version': console.log('dshd-green ' + VERSION); return 0
      case 'status': return await cmdStatus(opts)
      case 'doctor': return await cmdDoctor(opts)
      case 'key': return cmdKey(opts)
      case 'log': return cmdLog(opts)
      case 'prompt': return cmdPrompt()
      case 'help':
      case null:
      default: return usage()
    }
  } catch (e) {
    console.error('dshd Green 异常:', e.message)
    return 1
  }
}

module.exports = { run, VERSION }
