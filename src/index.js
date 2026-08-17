'use strict'
/**
 * dshd Green — 守护者 (guardian): DSH 的救生艇。
 *
 * Green 是一个独立项目: 使用它甚至不需要安装 DSH。
 *
 * 核心 = 一个救援 agent, 而不是一堆命令:
 *   `rescue` 用「极简模式」(从 DSH 源码 examples/jsonrpc-agent/minimal.cordis.yml 拆出,
 *   见 src/rescue.cordis.yml: shell + str_replace_editor 两个工具) 拉起一个**完全独立的
 *   DSH 进程** —— 独立安装(npx 或指定 CLI)、独立 DSH_HOME、独立会话、独立进程。
 *   它不依赖主 DSH 的任何一条代码/进程来运行: 主 DSH 完全坏了也能救。
 *   注入 RESCUE_SYSTEM_PROMPT + 预检发现 + 用户问题后, agent 自己检查/修复/报告,
 *   可适应任何故障, 无需为每种故障写代码。
 *
 * 辅助命令 (救援前的快速检查与材料): status / doctor / key / log / backup / list / restore / prompt
 *
 * 设计铁律: 仅用户触发; 只读优先; 最小改动 + 先备份; 零依赖; 零共享状态。
 * 所有命令支持 --json (供 dshd Red 界面结构化渲染)。
 */
const http = require('node:http')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { execFileSync, spawn } = require('node:child_process')

const VERSION = '0.3.0'
const DEFAULT_PORT = 3080

const C = {
  green: '\x1b[32m', red: '\x1b[31m', yellow: '\x1b[33m', dim: '\x1b[2m', reset: '\x1b[0m',
}
const OK = C.green + 'OK ' + C.reset
const WARN = C.yellow + 'WARN' + C.reset
const FAIL = C.red + 'FAIL' + C.reset

function parseArgs(argv) {
  const out = { cmd: null, port: DEFAULT_PORT, tail: 30, file: null, json: false, yes: false, latest: false, preset: 'minimal', extra: [] }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--port') out.port = Number(argv[++i]) || DEFAULT_PORT
    else if (a === '--tail') out.tail = Number(argv[++i]) || 30
    else if (a === '--file') out.file = argv[++i] || null
    else if (a === '--preset') out.preset = argv[++i] || 'minimal'
    else if (a === '--json') out.json = true
    else if (a === '--yes') out.yes = true
    else if (a === '--latest') out.latest = true
    else if (a === '--version' || a === '-v') out.cmd = 'version'
    else out.extra.push(a)
  }
  if (process.env.DSH_PORT) out.port = Number(process.env.DSH_PORT) || DEFAULT_PORT
  if (out.extra.length && !out.cmd) out.cmd = out.extra.shift()
  return out
}

/** 主 DSH 数据目录 (诊断/修复目标): 环境变量优先, 否则 ~/.dsh */
function dshHome() {
  return process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
}

/** Green 自己的数据根 (与主 DSH 无关) */
function greenRoot() {
  return process.env.DSH_GREEN_HOME || path.join(os.homedir(), '.dshd-green')
}

/** 备份根目录: Green 数据根/backups */
function backupRoot() {
  return path.join(greenRoot(), 'backups')
}

/** DSH HTTP JSON-RPC: POST /api/<method> (只读探测主 DSH; 失败静默) */
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

/** 输出: --json 时只打印一个 JSON 对象, 否则打印文本行 */
function emit(opts, lines, json) {
  if (opts.json) console.log(JSON.stringify(json))
  else console.log(lines.join('\n'))
}

// ===== status: 心跳 + 会话概览 =====

async function cmdStatus(opts) {
  const t0 = Date.now()
  const res = await rpc(opts.port, 'session.list', {})
  const ms = Date.now() - t0
  if (!res || !res.result || !res.result.ok) {
    const listening = await tcpCheck(opts.port)
    const json = {
      ok: false, online: false, ms, port: opts.port,
      listening, reason: listening ? '端口有监听但 API 无响应 (可能卡死)' : '端口无监听 (DSH 未启动)',
      total: 0, running: 0, titles: [],
    }
    emit(opts, [
      C.dim + 'dshd Green ' + VERSION + ' — status' + C.reset,
      C.dim + '  target: http://127.0.0.1:' + opts.port + C.reset,
      '  DSH 状态 : ' + C.red + '❌ 离线 / offline' + C.reset,
      '  端口 ' + opts.port + (listening ? C.yellow + ' : 有进程监听但 API 无响应 (可能卡死)' + C.reset : C.red + ' : 无监听 (DSH 未启动)' + C.reset),
    ], json)
    return 1
  }
  const items = (res.result.value && res.result.value.items) || []
  const running = items.filter((s) => s.running)
  const titles = running.slice(0, 5).map((s) => (s.projections && s.projections.values && s.projections.values.title) || s.cwd || s.sessionId)
  const json = { ok: true, online: true, ms, port: opts.port, total: items.length, running: running.length, titles }
  const lines = [
    C.dim + 'dshd Green ' + VERSION + ' — status' + C.reset,
    C.dim + '  target: http://127.0.0.1:' + opts.port + C.reset,
    '  DSH 状态 : ' + C.green + '✅ 在线 / online (' + ms + 'ms)' + C.reset,
    '  会话     : 共 ' + items.length + ' 个, 运行中 ' + running.length + ' 个',
  ]
  for (const t of titles) lines.push('    - ' + t)
  emit(opts, lines, json)
  return 0
}

// ===== key: 自动识别主 DSH 正在使用的 API key (只读) =====

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
  const found = findKey()
  const json = { found: !!found, masked: found ? maskKey(found.key) : '', source: found ? found.source : '', envName: found ? found.envName : '' }
  const lines = [C.dim + 'dshd Green ' + VERSION + ' — key' + C.reset]
  if (!found) {
    lines.push('  ' + C.yellow + '未找到主 DSH 的 API key' + C.reset)
    lines.push('  (检查 ' + path.join(dshHome(), 'settings.yaml') + ' 与 .credentials.yaml)')
    emit(opts, lines, json)
    return 1
  }
  lines.push('  ✅ 已识别: ' + C.green + maskKey(found.key) + C.reset)
  lines.push('  来源     : ' + found.source)
  lines.push('  环境变量 : ' + found.envName)
  lines.push(C.dim + '  提示: key 只在本地识别, 不落盘、不外发。' + C.reset)
  emit(opts, lines, json)
  return 0
}

// ===== doctor: 健康检查清单 =====

function checkFile(p) {
  try {
    const st = fs.statSync(p)
    return { exists: true, size: st.size }
  } catch (e) { return { exists: false } }
}

function listBackups() {
  const root = backupRoot()
  const entries = []
  try {
    for (const name of fs.readdirSync(root)) {
      const dir = path.join(root, name)
      if (!fs.statSync(dir).isDirectory()) continue
      let manifest = null
      try { manifest = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8')) } catch (e) {}
      entries.push({
        dir: name,
        createdAt: manifest ? manifest.createdAt : null,
        files: manifest && manifest.files ? manifest.files.length : 0,
        sessionCount: manifest ? manifest.sessionCount : null,
        dshHome: manifest ? manifest.dshHome : null,
        version: manifest ? manifest.version : null,
      })
    }
  } catch (e) { /* 无备份 */ }
  entries.sort((a, b) => b.dir.localeCompare(a.dir))
  return entries
}

function discoverLogs(opts) {
  const candidates = []
  if (opts.file) candidates.push(opts.file)
  const home = dshHome()
  candidates.push(path.join(home, 'logs'))
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

async function cmdDoctor(opts) {
  const home = dshHome()
  const checks = []

  const res = await rpc(opts.port, 'session.list', {})
  const pid = listenerPid(opts.port)
  if (res && res.result && res.result.ok) {
    checks.push({ label: 'DSH API 在线 (127.0.0.1:' + opts.port + (pid ? ', PID ' + pid : '') + ')', level: 'ok' })
  } else {
    const listening = await tcpCheck(opts.port)
    checks.push(listening
      ? { label: '端口 ' + opts.port + ' 有监听但 API 无响应 — 疑似卡死', level: 'warn' }
      : { label: '端口 ' + opts.port + ' 无监听 — DSH 未启动', level: 'fail' })
  }

  const settings = path.join(home, 'settings.yaml')
  const sf = checkFile(settings)
  if (sf.exists) {
    const txt = fs.readFileSync(settings, 'utf8')
    const hasPi = /llm-pi-ai/.test(txt)
    const hasDefault = /agent-default-model/.test(txt)
    checks.push({ label: 'settings.yaml 存在 (' + sf.size + 'B' + (hasPi && hasDefault ? ', 含 llm-pi-ai + agent-default-model' : '') + ')', level: 'ok' })
    if (!hasPi) checks.push({ label: 'settings.yaml 缺少 llm-pi-ai 段 (模型供应商配置缺失)', level: 'warn' })
    if (!hasDefault) checks.push({ label: 'settings.yaml 缺少 agent-default-model 段 (默认模型未设置)', level: 'warn' })
  } else {
    checks.push({ label: 'settings.yaml 不存在 (' + settings + ')', level: 'fail' })
  }

  const creds = path.join(home, '.credentials.yaml')
  const cf = checkFile(creds)
  if (cf.exists) {
    const txt = fs.readFileSync(creds, 'utf8')
    const keys = (txt.match(/^[A-Za-z_][A-Za-z0-9_]*\s*:/gm) || []).length
    checks.push({ label: '.credentials.yaml 存在 (' + keys + ' 个凭证条目)', level: 'ok' })
  } else {
    checks.push({ label: '.credentials.yaml 缺失 — 没有 API key, 模型不可用', level: 'fail' })
  }

  const found = findKey()
  if (found) checks.push({ label: 'API key 已识别: ' + maskKey(found.key) + ' (' + found.source + ')', level: 'ok' })
  else checks.push({ label: '未识别到 API key (可运行 dshd-green key 查看)', level: 'warn' })

  try {
    const out = execFileSync(process.platform === 'win32' ? 'wmic' : 'ps',
      process.platform === 'win32' ? ['process', 'where', "name='node.exe'", 'get', 'ProcessId,CommandLine'] : ['-eo', 'pid,command'],
      { encoding: 'utf8', timeout: 4000, stdio: ['ignore', 'pipe', 'ignore'] })
    const dshProcs = out.split(/\r?\n/).filter((l) => /dsh|bin\.js|bin\.ts/.test(l) && !/dshd-green/.test(l))
    checks.push(dshProcs.length
      ? { label: 'dsh 进程: ' + dshProcs.length + ' 个', level: 'ok' }
      : { label: '未发现 dsh 进程 (可能由桌面端/容器管理)', level: 'warn' })
  } catch (e) {
    checks.push({ label: '无法枚举进程', level: 'warn' })
  }

  const logs = discoverLogs(opts)
  checks.push(logs.length
    ? { label: '日志: ' + logs.map((l) => path.basename(l)).join(', '), level: 'ok' }
    : { label: '未发现日志文件 (可用 dshd-green log --file <path>)', level: 'warn' })

  const backups = listBackups()
  checks.push(backups.length
    ? { label: '配置备份: ' + backups.length + ' 份, 最新 ' + backups[0].dir, level: 'ok' }
    : { label: '还没有配置备份 (建议先 dshd-green backup)', level: 'warn' })

  const lines = [C.dim + 'dshd Green ' + VERSION + ' — doctor' + C.reset, '  DSH_HOME : ' + home]
  for (const c of checks) {
    const tag = c.level === 'ok' ? OK : c.level === 'warn' ? WARN : FAIL
    lines.push('  [' + tag + '] ' + c.label)
  }
  lines.push(C.dim + '  需要修复? 先 dshd-green backup 备份, 再 dshd-green rescue \"描述问题\" 启动隔离救援 agent。' + C.reset)
  emit(opts, lines, { ok: true, home, checks, backups: backups.length })
  return 0
}

// ===== log: 日志尾部 =====

function cmdLog(opts) {
  const logs = discoverLogs(opts)
  if (!logs.length) {
    const json = { ok: false, error: '未找到日志文件。可用: dshd-green log --file <path>' }
    emit(opts, [json.error], json)
    return 1
  }
  const file = logs[0]
  const all = fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean)
  const tail = all.slice(-opts.tail)
  emit(opts,
    [C.dim + file + ' (共 ' + all.length + ' 行, 显示最后 ' + tail.length + ' 行)' + C.reset].concat(tail),
    { ok: true, file, total: all.length, tail: tail.length, lines: tail })
  return 0
}

// ===== backup / list / restore: 配置快照 + 一键回滚 =====

const BACKUP_RELS = [
  'settings.yaml',
  '.credentials.yaml',
  path.join('profiles', 'web', 'cordis.yml'),
  path.join('profiles', 'web', 'cordis.patch.yml'),
  path.join('profiles', 'web', 'package.json'),
]

function backupNow() {
  const home = dshHome()
  const root = backupRoot()
  const stamp = new Date().toISOString().replace(/[:T]/g, '-').replace(/\..+$/, '')
  const dir = path.join(root, stamp)
  fs.mkdirSync(dir, { recursive: true })
  const files = []
  for (const rel of BACKUP_RELS) {
    const src = path.join(home, rel)
    if (!fs.existsSync(src)) continue
    fs.copyFileSync(src, path.join(dir, rel.replace(/[/\\]/g, '__')))
    files.push({ rel, size: fs.statSync(src).size })
  }
  let sessionCount = null
  try { sessionCount = fs.readdirSync(path.join(home, 'sessions')).length } catch (e) {}
  const manifest = { version: VERSION, createdAt: new Date().toISOString(), dshHome: home, files, sessionCount }
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2))
  return { dir, stamp, files, sessionCount }
}

function cmdBackup(opts) {
  const result = backupNow()
  const lines = [
    C.dim + 'dshd Green ' + VERSION + ' — backup' + C.reset,
    '  ✅ 已备份到 ' + C.green + result.dir + C.reset,
    '  文件     : ' + (result.files.map((f) => f.rel).join(', ') || '(空)'),
    '  会话目录 : ' + (result.sessionCount == null ? '不可读' : result.sessionCount + ' 个条目 (仅计数, 不复制)'),
    C.dim + '  恢复: dshd-green restore ' + result.stamp + '  (或 dshd-green restore --latest)' + C.reset,
  ]
  emit(opts, lines, { ok: true, dir: result.dir, stamp: result.stamp, files: result.files, sessionCount: result.sessionCount })
  return 0
}

function cmdList(opts) {
  const backups = listBackups()
  const lines = [C.dim + 'dshd Green ' + VERSION + ' — backups' + C.reset]
  if (!backups.length) {
    lines.push('  (还没有备份。运行 dshd-green backup 创建第一份。)')
    emit(opts, lines, { ok: true, backups: [] })
    return 0
  }
  for (const b of backups) {
    lines.push('  ' + (b.createdAt || b.dir) + '   ' + b.files + ' 个文件' + (b.sessionCount != null ? ' · 会话 ' + b.sessionCount : '') + C.dim + '  [' + b.dir + ']' + C.reset)
  }
  emit(opts, lines, { ok: true, backups })
  return 0
}

function cmdRestore(opts) {
  const home = dshHome()
  const backups = listBackups()
  if (!backups.length) {
    const json = { ok: false, error: '没有可用备份。先运行 dshd-green backup。' }
    emit(opts, [json.error], json)
    return 1
  }
  let target = null
  if (opts.extra.length) {
    target = backups.find((b) => b.dir === opts.extra[0])
    if (!target) {
      const json = { ok: false, error: '找不到备份 ' + opts.extra[0] + ' (可用: ' + backups.map((b) => b.dir).join(', ') + ')' }
      emit(opts, [json.error], json)
      return 1
    }
  } else if (opts.latest) {
    target = backups[0]
  } else {
    const json = { ok: false, error: '请指定备份目录 (dshd-green list 查看) 或 --latest' }
    emit(opts, [json.error], json)
    return 1
  }
  const dir = path.join(backupRoot(), target.dir)
  let manifest
  try { manifest = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8')) } catch (e) {
    const json = { ok: false, error: '备份 ' + target.dir + ' 缺少有效 manifest.json' }
    emit(opts, [json.error], json)
    return 1
  }
  const plan = (manifest.files || []).map((f) => f.rel)
  if (!opts.yes) {
    const json = { ok: false, needConfirm: true, error: '将恢复 ' + plan.length + ' 个文件。确认请加 --yes (Red 界面会先弹确认框)。' }
    emit(opts, ['  将恢复 ' + plan.length + ' 个文件:', '    ' + plan.join('\n    '), '', '  确认请加 --yes'], json)
    return 1
  }
  // 危险操作前自动做一次安全快照
  const safety = backupNow()
  const restored = []
  const failed = []
  for (const f of manifest.files || []) {
    const src = path.join(dir, f.rel.replace(/[/\\]/g, '__'))
    const dst = path.join(home, f.rel)
    try {
      fs.mkdirSync(path.dirname(dst), { recursive: true })
      fs.copyFileSync(src, dst)
      restored.push(f.rel)
    } catch (e) {
      failed.push({ rel: f.rel, error: e.message })
    }
  }
  const lines = [
    C.dim + 'dshd Green ' + VERSION + ' — restore' + C.reset,
    '  ✅ 已恢复 ' + restored.length + ' 个文件 (来自 ' + target.dir + ')',
    '  🛡 恢复前已自动备份当前配置到 ' + C.green + safety.dir + C.reset,
    '  ⚠ 建议重启 DSH 使配置生效 (Red 侧栏 → 重启 DSH)',
  ]
  if (failed.length) {
    lines.push('  ❌ 失败 ' + failed.length + ' 个: ' + failed.map((f) => f.rel + '(' + f.error + ')').join('; '))
  }
  emit(opts, lines, { ok: failed.length === 0, dir: target.dir, restored, failed, safetyDir: safety.dir, needRestart: true })
  return failed.length ? 1 : 0
}

// ===== rescue: 极简模式套一个完全独立的 agent, 让它去干活 (核心) =====

/**
 * 解析主 DSH 的模型路由 (只读): 默认供应商 + 模型 + baseURL + key。
 * 这些只作为数据注入救援进程的环境变量; Green 的运行不依赖主 DSH 的任何代码。
 */
function findModelConfig() {
  const home = dshHome()
  let s = ''
  try { s = fs.readFileSync(path.join(home, 'settings.yaml'), 'utf8') } catch (e) {}
  const dm = s.match(/agent-default-model:\s*\n\s*provider:\s*(\S+)\s*\n\s*model:\s*(\S+)/)
  const provId = dm && dm[1]
  const model = (dm && dm[2]) || process.env.DSH_MODEL || 'deepseek-v4-flash'
  let baseURL = ''
  if (provId) {
    const pm = s.match(new RegExp('\\n\\s{2,}' + provId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ':\\s*\\n([\\s\\S]*?)(?=\\n\\s{2}\\S+:\\s|\\n\\S)', 'm'))
    const seg = pm ? pm[1] : ''
    const b = seg.match(/baseURL:\s*(\S+)/)
    if (b) baseURL = b[1].replace(/["']/g, '')
  }
  const key = findKey()
  return { provId: provId || 'deepseek-official', model, baseURL, key: key ? key.key : null }
}

/** 解析独立的 dsh CLI: 显式指定 > 本机 DSH 源码(开发) > npx 独立安装(不要求装 DSH) */
function resolveDshCli() {
  if (process.env.DSH_GREEN_DSH) {
    const parts = String(process.env.DSH_GREEN_DSH).split(' ')
    return { argv: parts, note: 'DSH_GREEN_DSH 指定', shell: false }
  }
  const dev = [
    path.join(__dirname, '..', '..', '..', 'apps', 'cli', 'lib', 'bin.js'),   // Red 内置 (apps/electron-dsh/src/guardian → 仓库根)
    path.join(__dirname, '..', '..', '..', '..', 'deepseek-harness', 'apps', 'cli', 'lib', 'bin.js'), // 独立仓库旁的源码
  ]
  for (const p of dev) {
    if (fs.existsSync(p)) return { argv: ['node', p], note: '本地 DSH 源码 (开发)', shell: false }
  }
  return { argv: ['npx', '-y', '@deepseek-ai/dsh'], note: 'npx 独立安装 @deepseek-ai/dsh (使用绿不需要安装 DSH)', shell: process.platform === 'win32' }
}

/** 只读预检: 把 DSH 在线/配置/key/备份概况抓给救援 agent, 省它一轮探索 (失败静默) */
async function preflightSummary(port) {
  const parts = []
  try {
    const res = await rpc(port, 'session.list', {})
    if (res && res.result && res.result.ok) {
      const items = (res.result.value && res.result.value.items) || []
      const running = items.filter((s) => s.running)
      parts.push('DSH API: 在线, 共 ' + items.length + ' 个会话, 运行中 ' + running.length + ' 个')
    } else {
      parts.push('DSH API: 无响应 (主 DSH 可能已停止 — 救援 agent 独立运行, 不受影响)')
    }
  } catch (e) { parts.push('DSH API: 检查失败') }
  const found = findKey()
  parts.push(found ? ('API key: 已识别 ' + maskKey(found.key) + ' (' + found.source + ')') : 'API key: 未识别')
  const home = dshHome()
  const sf = checkFile(path.join(home, 'settings.yaml'))
  const cf = checkFile(path.join(home, '.credentials.yaml'))
  parts.push('主 DSH_HOME: ' + home + ' · settings.yaml: ' + (sf.exists ? sf.size + 'B' : '缺失') + ' · .credentials.yaml: ' + (cf.exists ? '存在' : '缺失'))
  const backups = listBackups()
  parts.push('配置备份: ' + (backups.length ? backups.length + ' 份 (最新 ' + backups[0].dir + ')' : '无 (先 dshd-green backup)'))
  return parts
}

/** 生成隔离实例: Green 数据根/instances/<ts>/home (独立 DSH_HOME + green profile) */
function materializeRescueInstance() {
  const root = path.join(greenRoot(), 'instances')
  const stamp = new Date().toISOString().replace(/[:T]/g, '-').replace(/\..+$/, '')
  const inst = path.join(root, stamp)
  const home = path.join(inst, 'home')
  const profileDir = path.join(home, 'profiles', 'green')
  fs.mkdirSync(profileDir, { recursive: true })
  fs.mkdirSync(path.join(inst, 'sessions'), { recursive: true })
  fs.writeFileSync(path.join(profileDir, 'package.json'), JSON.stringify({
    name: 'dsh-profile-green', private: true, dependencies: {},
    dsh: { profile: { bundles: [] } },
  }, null, 2))
  const patch = fs.readFileSync(path.join(__dirname, 'rescue.cordis.yml'), 'utf8')
  fs.writeFileSync(path.join(profileDir, 'cordis.patch.yml'), patch)
  healRescueFallback(home)
  return { home, sessions: path.join(inst, 'sessions'), stamp }
}

/**
 * 把极简组合需要的包补进隔离实例的 profiles/node_modules (DSH 会 heal 它自己依赖的包,
 * 但组合里的个别包 — 如 dsh-agent-spine-demo — 不在 dsh CLI 的依赖里, 需要 Green 补齐)。
 * 来源优先级: 本机 DSH 源码 node_modules > examples/node_modules > Green 自己的 node_modules。
 */
function healRescueFallback(home) {
  const fallback = path.join(home, 'profiles', 'node_modules')
  fs.mkdirSync(fallback, { recursive: true })
  const patchText = (() => { try { return fs.readFileSync(path.join(__dirname, 'rescue.cordis.yml'), 'utf8') } catch (e) { return '' } })()
  const names = [...patchText.matchAll(/name:\s*'(@deepseek-ai\/dsh-[^']+)'/g)].map((m) => m[1])
  const sources = []
  if (process.env.DSH_GREEN_MODULES) sources.push(process.env.DSH_GREEN_MODULES)
  // Red 内置位置: apps/electron-dsh/src/guardian → 向上 4 级 = 仓库根
  sources.push(path.join(__dirname, '..', '..', '..', '..', 'node_modules'))
  sources.push(path.join(__dirname, '..', '..', '..', '..', 'examples', 'node_modules'))
  // Green 独立仓库自己的 node_modules
  sources.push(path.join(__dirname, '..', 'node_modules'))
  for (const name of new Set(names)) {
    const link = path.join(fallback, ...name.split('/'))
    if (fs.existsSync(link)) continue
    for (const srcRoot of sources) {
      const src = path.join(srcRoot, ...name.split('/'))
      if (!fs.existsSync(src)) continue
      try {
        fs.mkdirSync(path.dirname(link), { recursive: true })
        try { fs.symlinkSync(src, link, 'junction') } catch (e) { fs.cpSync(src, link, { recursive: true }) }
        break
      } catch (e) { /* 换下一个来源 */ }
    }
  }
}

async function cmdRescue(opts) {
  const description = opts.extra.join(' ').trim()
  const lines = [C.dim + 'dshd Green ' + VERSION + ' — rescue' + C.reset]

  // 1. 模型路由 (只读主 DSH 配置)
  const mc = findModelConfig()
  if (!mc.key) {
    const json = { ok: false, error: '未识别到 API key, 救援 agent 无法调用模型。先修好主 DSH 的 .credentials.yaml (可 dshd-green key 查看)。' }
    lines.push('  ' + C.red + '❌ ' + json.error + C.reset)
    emit(opts, lines, json)
    return 1
  }
  if (!mc.baseURL) {
    const json = { ok: false, error: '未识别到模型供应商 baseURL (settings.yaml 的 agent-default-model 或 llm-pi-ai.providers)。' }
    lines.push('  ' + C.red + '❌ ' + json.error + C.reset)
    emit(opts, lines, json)
    return 1
  }

  // 2. 独立 dsh CLI
  const cli = resolveDshCli()
  lines.push('  运行时   : ' + cli.note + ' (' + cli.argv.join(' ') + ')')
  lines.push('  模型     : ' + mc.model + ' @ ' + mc.baseURL + ' (key ' + maskKey(mc.key) + ')')

  // 3. 隔离实例 (独立 DSH_HOME + green profile + 独立会话目录)
  const inst = materializeRescueInstance()

  // 4. 任务 = 救援提示词 + 预检 + 用户问题
  const { RESCUE_SYSTEM_PROMPT } = require('./prompt.js')
  const preflight = (await preflightSummary(opts.port)).join('\n')
  const systemPrompt = RESCUE_SYSTEM_PROMPT
    + '\n\n=== 预检发现 (dshd Green 只读检查, 仅供参考) ===\n' + preflight
    + '\n\n=== 你的救援目标 ===\n'
    + '主 DSH 数据目录: ' + dshHome() + ' (先在只读模式下检查它)\n'
    + '=== 用户报告的问题 ===\n' + (description || '（等待用户描述问题。若暂无问题, 做一次只读检查后报告结论即可。）')
  const task = description || '做一次只读健康检查并报告结论。'

  // 5. 拉起完全独立的救援进程
  const env = {
    ...process.env,
    DSH_HOME: inst.home,
    DSH_SESSION_ROOT: inst.sessions,
    DSH_CWD: dshHome(),
    DSH_MODEL: mc.model,
    DEEPSEEK_API_KEY: mc.key,
    DEEPSEEK_BASE_URL: mc.baseURL,
    DSH_SYSTEM_PROMPT: systemPrompt,
    DSH_CONTEXT_WINDOW: '1000000',
  }
  lines.push('  隔离实例 : ' + inst.home)
  lines.push('  → 启动救援 agent (极简模式: shell + 文件编辑, 与主 DSH 完全隔离)…')
  if (!opts.json) console.log(lines.join('\n'))

  const spawned = await new Promise((resolve) => {
    const child = spawn(cli.argv[0], [...cli.argv.slice(1), '--profile', 'green', task], {
      env, cwd: dshHome(), shell: cli.shell, stdio: ['ignore', 'pipe', 'pipe'],
    })
    let out = ''
    const push = (t) => {
      out += t
      if (!opts.json) process.stdout.write(t)
    }
    child.stdout.on('data', (d) => push(d.toString()))
    child.stderr.on('data', (d) => push(d.toString()))
    child.on('error', (e) => resolve({ ok: false, code: 1, error: e.message, output: out }))
    child.on('exit', (code) => resolve({ ok: code === 0, code, output: out }))
  })

  const answer = spawned.output.trim().split(/\r?\n/).filter(Boolean).slice(-6).join('\n')
  const json = {
    ok: spawned.ok, exitCode: spawned.code,
    model: mc.model, baseURL: mc.baseURL, keyMasked: maskKey(mc.key),
    instanceDir: inst.home, dshCli: cli.note,
    error: spawned.error || undefined,
    answer,
    note: '救援 agent = 极简模式 (shell + str_replace_editor), 独立进程/独立 DSH_HOME, 不依赖主 DSH 运行; 只读优先/最小改动/改文件前先备份。',
  }
  if (!opts.json) {
    process.stdout.write('\n' + C.dim + '=== 救援 agent 报告 (最后几行) ===' + C.reset + '\n' + answer + '\n')
    if (!spawned.ok) process.stdout.write(C.red + '救援进程退出码 ' + spawned.code + (spawned.error ? ' (' + spawned.error + ')' : '') + C.reset + '\n')
  } else {
    console.log(JSON.stringify(json))
  }
  return spawned.ok ? 0 : 1
}

// ===== prompt: 打印救援系统提示词 =====

function cmdPrompt() {
  const { RESCUE_SYSTEM_PROMPT } = require('./prompt.js')
  console.log(RESCUE_SYSTEM_PROMPT)
  return 0
}

function usage() {
  console.log(
    'dshd Green ' + VERSION + ' — 守护者 / the guardian\n' +
    'DSH 的救生艇。独立项目: 使用它甚至不需要安装 DSH。\n' +
    '主体不是命令, 而是一个救援 agent: 用「极简模式」(src/rescue.cordis.yml, 从 DSH\n' +
    '源码 minimal.cordis.yml 拆出: shell + str_replace_editor) 拉起一个**完全独立**的\n' +
    'DSH 进程 —— 独立安装/独立 DSH_HOME/独立会话, 不依赖主 DSH 的任何代码来运行。\n' +
    '注入救援提示词 + 预检发现后, agent 自己去检查/修复/报告, 可适应任何故障。\n' +
    '\n' +
    '核心 / core:\n' +
    '  dshd-green rescue [问题描述]   启动救援 agent (完全隔离的极简模式进程)\n' +
    '\n' +
    '辅助 / helpers (救援前的快速检查与材料):\n' +
    '  dshd-green status             主 DSH 心跳 + 会话概览\n' +
    '  dshd-green doctor             配置/端口/进程/日志/备份 健康检查\n' +
    '  dshd-green key                自动识别主 DSH 正在使用的 API key\n' +
    '  dshd-green log [--tail 30]    查看日志尾部 (可 --file <path>)\n' +
    '  dshd-green backup             备份关键配置 (settings/.credentials/profile, 含清单)\n' +
    '  dshd-green list               列出配置备份\n' +
    '  dshd-green restore <dir|--latest> [--yes]   从备份恢复 (恢复前自动再备份一次)\n' +
    '  dshd-green prompt             打印救援系统提示词\n' +
    '\n' +
    '选项 / options:\n' +
    '  --port <n>    DSH 端口 (默认 3080, 或环境变量 DSH_PORT)\n' +
    '  --json        输出 JSON (供 dshd Red 界面渲染)\n' +
    '  --yes         restore 跳过确认\n' +
    '  --version\n' +
    '\n' +
    '环境 / env:\n' +
    '  DSH_HOME          主 DSH 数据目录 (默认 ~/.dsh; 只读, 救援目标)\n' +
    '  DSH_GREEN_DSH     指定救援用 dsh CLI (默认: 本机 DSH 源码, 否则 npx @deepseek-ai/dsh)\n' +
    '  DSH_GREEN_HOME    Green 自己的数据根 (默认 ~/.dshd-green)\n' +
    '  DSH_PORT          主 DSH 端口 (默认 3080)\n' +
    '设计铁律: 仅用户触发 · 只读优先 · 最小改动 + 先备份 · 零依赖 · 救援进程与主 DSH 完全隔离。\n'
  )
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
      case 'backup': return cmdBackup(opts)
      case 'list': return cmdList(opts)
      case 'restore': return cmdRestore(opts)
      case 'rescue': return await cmdRescue(opts)
      case 'prompt': return cmdPrompt()
      case 'help':
      case null:
      default: return usage()
    }
  } catch (e) {
    const msg = 'dshd Green 异常: ' + e.message
    if (opts.json) console.log(JSON.stringify({ ok: false, error: msg }))
    else console.error(msg)
    return 1
  }
}

module.exports = { run, VERSION }
