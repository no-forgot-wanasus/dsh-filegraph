/**
 * dsh-filegraph · Host 半边（显示名「关系」）
 *
 * 三块数据：
 *   1) 关系画布：节点 / 关系 / 节点组 —— `.drawio` 是唯一真源，节点按 id 认，信息（备注）按名字存；
 *   2) AI 记录层：监听 `tools/result`，把 AI 读过/写过的文件、窗口、来源记成一张观察图；
 *   3) 节点组内部：存在 `.graph.json` 里（按组节点 id 关联），可以套组。
 *
 * 没有任何模拟量、没有轮询、没有后台任务：一次工具调用 = 一次记录。
 */import { promises as fsp } from 'node:fs'
import path from 'node:path'
import os from 'node:os'

export const name = 'filegraph'
export const inject = ['tools', 'webServer', 'workingDirectory']

const DATA_ROUTE = '/filegraph/data'
const SETTINGS_ROUTE = '/filegraph/settings'
const RESET_ROUTE = '/filegraph/reset'
const WINDOW_ROUTE = '/filegraph/window'
const SCAN_ROUTE = '/filegraph/scan'
const POSITION_ROUTE = '/filegraph/position'
const PRUNE_ROUTE = '/filegraph/prune'
const FLOW_ROUTE = '/filegraph/flow'
const IMPORT_ROUTE = '/filegraph/import'
const OPEN_ROUTE = '/filegraph/open'
const DRAG_ROUTE = '/filegraph/drag'
const EXPORT_ROUTE = '/filegraph/export'

const GRAPH_VERSION = 3
const DEFAULT_DIRNAME = '.filegraph'
const DEFAULT_FILENAME = 'graph.json'
const MAX_TEXT_BYTES = 512 * 1024
const MAX_REFS_PER_NODE = 240
const SAVE_DEBOUNCE_MS = 250
const SEQ_WINDOW_MS = 3 * 60 * 1000

// 扫描项目现有文件的边界（宁可少扫，不要把 node_modules 拖进来）。
const SCAN_MAX_FILES = 400
const SCAN_MAX_DEPTH = 7
const SCAN_CONTENT_BYTES = 128 * 1024
const SCAN_CONTENT_BUDGET = 320
const SCAN_SKIP_DIRS = new Set([
  'node_modules', '.git', '.dsh', '.filegraph', '.pnpm-store', 'dist', 'build', 'out',
  '.venv', 'venv', '__pycache__', '.next', '.cache', 'target', '.idea', '.gradle',
  'coverage', '.turbo', '.svelte-kit', 'Pods', '.DS_Store',
  'pylibs', 'site-packages', 'vendor', 'third_party', 'thirdparty', 'bower_components',
])

const WRITE_TOOLS = new Set(['write', 'edit'])
const READ_TOOLS = new Set(['read', 'read_image'])

/** 不是"文件"的数据来源（私信/弹幕/终端/网页…）按工具家族归成「其他来源」框。 */
function sourceKeyOf(toolName) {
  if (typeof toolName !== 'string' || !toolName) return undefined
  if (toolName.startsWith('mcp__')) {
    const family = toolName.split('__')[1]
    return family ? 'MCP · ' + family : 'MCP'
  }
  if (toolName === 'web_search') return '网络搜索'
  if (toolName === 'web_fetch') return '网页抓取'
  if (toolName === 'pwsh' || toolName === 'bash' || toolName.startsWith('terminal_')) return '终端'
  if (toolName === 'see_now') return '屏幕'
  if (toolName.startsWith('browser_')) return '浏览器'
  return undefined
}

const TEXT_EXT = new Set([
  'ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs', 'json', 'jsonc', 'md', 'mdx', 'markdown',
  'css', 'scss', 'sass', 'less', 'html', 'htm', 'vue', 'svelte', 'astro',
  'py', 'go', 'rs', 'java', 'kt', 'kts', 'swift', 'cs', 'cpp', 'cc', 'hpp',
  'sh', 'bash', 'zsh', 'ps1', 'yml', 'yaml', 'toml',
  'txt', 'sql', 'dio', 'drawio', 'svg', 'ipynb', 'xml', 'gradle',
])

const EXT_ALTERNATION = [...TEXT_EXT].sort((a, b) => b.length - a.length).join('|')
const FILE_TOKEN_RE = new RegExp(
  '([A-Za-z0-9_@$~][\\w@$.\\-]*(?:[/\\\\][\\w@$.\\-]+)*\\.(?:' + EXT_ALTERNATION + '))(?![\\w])',
  'g',
)
const IMPORT_TOKEN_RE =
  /(?:from\s+|import\s*\(\s*|import\s+|require\s*\(\s*)['"]([^'"\n\r]{1,160})['"]/g

/* ------------------------------------------------------------------ 小工具 */

function messageOf(error) {
  return error instanceof Error ? error.message : String(error)
}

function toPosix(p) {
  return p.split('\\').join('/')
}

function extOf(file) {
  const dot = file.lastIndexOf('.')
  return dot < 0 ? '' : file.slice(dot + 1).toLowerCase()
}

function stemOf(name) {
  const dot = name.lastIndexOf('.')
  return (dot <= 0 ? name : name.slice(0, dot)).toLowerCase()
}

function dshHome() {
  const fromEnv = process.env.DSH_HOME
  return fromEnv && fromEnv.trim() ? fromEnv : path.join(os.homedir(), '.dsh')
}

function stateFile() {
  return path.join(dshHome(), 'storages', 'filegraph', 'settings.json')
}

async function writeJsonAtomic(file, value) {
  await fsp.mkdir(path.dirname(file), { recursive: true })
  // 临时名必须唯一：两次并发写共用同一个 tmp 会在 rename 时 EPERM。
  const tmp = file + '.tmp-' + process.pid + '-' + Math.random().toString(36).slice(2, 8)
  await fsp.writeFile(tmp, JSON.stringify(value, null, 2), 'utf8')
  // 照 Blender 的 .blend1 思路：覆盖前先留一份上一版，写坏了还能回退。
  try {
    const info = await fsp.stat(file)
    if (info.size > 0) await fsp.copyFile(file, file + '.bak1')
  } catch {}
  // Windows 上目标文件被短暂占用时 rename 会 EPERM（杀软/另一个写者），重试几次再报错。
  for (let attempt = 0; ; attempt += 1) {
    try {
      await fsp.rename(tmp, file)
      break
    } catch (error) {
      if (attempt >= 4) {
        await fsp.rm(tmp, { force: true }).catch(() => {})
        throw error
      }
      await new Promise((resolve) => setTimeout(resolve, 25 * (attempt + 1)))
    }
  }
}

/* ------------------------------------------------------------ 插件内状态 */

/** @type {{ graphFile: string, projects: Record<string, { graphFile: string, updatedAt: number, nodeCount: number }> } | null} */
let state = null
const graphs = new Map() // graphFile -> { graph, timer, loading }
const lastWrite = new Map() // graphFile -> { rel, at, session }

async function ensureState() {
  if (state) return state
  try {
    const raw = JSON.parse(await fsp.readFile(stateFile(), 'utf8'))
    state = {
      graphFile: typeof raw.graphFile === 'string' ? raw.graphFile : '',
      drawioFile: typeof raw.drawioFile === 'string' ? raw.drawioFile : '',
      projects: raw.projects && typeof raw.projects === 'object' ? raw.projects : {},
    }
  } catch {
    state = { graphFile: '', drawioFile: '', projects: {} }
  }
  return state
}

function scheduleStateSave() {
  ensureState()
    .then(() => writeJsonAtomic(stateFile(), state))
    .catch(() => {})
}

function emptyGraph(root) {
  return {
    version: GRAPH_VERSION,
    root,
    updatedAt: 0,
    seq: 0,
    flowSeq: 0,
    edgeSeq: 0,
    nodes: {},
    windows: {},
    sources: {},
    positions: {},
    // 画布层：节点各自有独立 id；节点信息（备注）按名字存。
    flowNodes: [],
    flowPositions: {},
    drags: {},
    nodeNotes: {},
    groups: {},
    flows: [],
  }
}

async function graphFor(graphFile, root) {
  const existing = graphs.get(graphFile)
  if (existing && existing.graph) return existing
  const entry = existing ?? { graph: null, timer: null, loading: null }
  graphs.set(graphFile, entry)
  if (entry.graph) return entry
  if (!entry.loading) {
    entry.loading = (async () => {
      try {
        const parsed = JSON.parse(await fsp.readFile(graphFile, 'utf8'))
        if (!parsed || typeof parsed !== 'object' || typeof parsed.nodes !== 'object') {
          throw new Error('not a filegraph document')
        }
        // 老图（v1 的 node.writers）升到 node.actors，老数据不丢。
        for (const node of Object.values(parsed.nodes)) {
          if (!node || typeof node !== 'object') continue
          if (!node.actors && node.writers && typeof node.writers === 'object') {
            node.actors = {}
            for (const [sid, writer] of Object.entries(node.writers)) {
              node.actors[sid] = { read: 0, write: writer?.count ?? 0, lastAt: writer?.lastAt ?? 0 }
            }
            delete node.writers
          }
        }
        entry.graph = {
          version: GRAPH_VERSION,
          root: typeof parsed.root === 'string' && parsed.root ? parsed.root : root,
          updatedAt: Number(parsed.updatedAt) || 0,
          seq: Number(parsed.seq) || 0,
          flowSeq: Number(parsed.flowSeq) || 0,
          edgeSeq: Number(parsed.edgeSeq) || 0,
          nodes: parsed.nodes,
          windows: parsed.windows && typeof parsed.windows === 'object' ? parsed.windows : {},
          sources: parsed.sources && typeof parsed.sources === 'object' ? parsed.sources : {},
          positions: parsed.positions && typeof parsed.positions === 'object' ? parsed.positions : {},
          flows: Array.isArray(parsed.flows) ? parsed.flows.filter((f) => f && f.fromId && f.toId) : [],
          flowNodes: Array.isArray(parsed.flowNodes) ? parsed.flowNodes.filter((n) => n && typeof n === 'object' && n.id) : [],
          flowPositions: parsed.flowPositions && typeof parsed.flowPositions === 'object' ? parsed.flowPositions : {},
          drags: parsed.drags && typeof parsed.drags === 'object' ? parsed.drags : {},
          nodeNotes: parsed.nodeNotes && typeof parsed.nodeNotes === 'object' ? parsed.nodeNotes : {},
          groups: parsed.groups && typeof parsed.groups === 'object' ? parsed.groups : {},
        }
        // 老模型（名字当 id 的 v2 画布、框、分身）→ 新模型：清掉画布层，等 .drawio 重新导入一次。
        if (!Array.isArray(parsed.flowNodes) || (parsed.flowNodes[0] && typeof parsed.flowNodes[0] === 'string')) {
          entry.graph.flowNodes = []
          entry.graph.flows = []
          entry.graph.flowPositions = {}
          // 手拖矢量是"相对画布"的，按名字先存着：.drawio 导入后由 reconcileCanvas 接回新 id
          const legacyDrags = {}
          for (const [id, delta] of Object.entries(entry.graph.drags)) {
            if (id.indexOf('f:') === 0 && delta) legacyDrags[id.slice(2)] = delta
          }
          entry.graph.drags = legacyDrags
          entry.graph.legacyDrags = true
        }
        delete entry.graph.frames
        delete entry.graph.nodeFrame
        delete entry.graph.ghosts
        delete entry.graph.ghostEdges
      } catch (error) {
        if (error && error.code !== 'ENOENT') {
          // 坏文件不覆盖：改名留档，重新开始，免得把用户的历史图毁了。
          try {
            await fsp.rename(graphFile, graphFile + '.broken-' + Date.now())
          } catch {}
        }
        entry.graph = emptyGraph(root)
      }
      entry.loading = null
      return entry
    })()
  }
  await entry.loading
  return entry
}

function scheduleGraphSave(entry, graphFile) {
  if (entry.timer) return
  entry.timer = setTimeout(() => {
    entry.timer = null
    if (!entry.graph) return
    writeJsonAtomic(graphFile, entry.graph).catch(() => {})
  }, SAVE_DEBOUNCE_MS)
  if (typeof entry.timer.unref === 'function') entry.timer.unref()
}

async function flushGraph(entry, graphFile) {
  if (entry.timer) {
    clearTimeout(entry.timer)
    entry.timer = null
  }
  if (!entry.graph) return
  try {
    await writeJsonAtomic(graphFile, entry.graph)
  } catch {}
}

/* ---------------------------------------------------------- 关系抽取 */

function lineStarts(text) {
  const starts = [0]
  for (let i = 0; i < text.length; i += 1) if (text.charCodeAt(i) === 10) starts.push(i + 1)
  return starts
}

function lineOf(starts, index) {
  let lo = 0
  let hi = starts.length - 1
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1
    if (starts[mid] <= index) lo = mid
    else hi = mid - 1
  }
  return lo + 1
}

/** 这条引用"起什么作用"：import/require 是代码依赖，markdown 链接是文档引用，其余算提及。 */
function roleOf(snippet) {
  if (/\b(import|from|require|include|using|#include)\b/.test(snippet)) return 'import'
  if (/\[[^\]]*\]\([^)]*\)/.test(snippet)) return 'link'
  return 'mention'
}

function extractRefs(text, selfPath) {
  const refs = []
  const seen = new Set()
  const selfName = path.posix.basename(selfPath).toLowerCase()
  const starts = lineStarts(text)
  const push = (raw, index) => {
    if (!raw || refs.length >= MAX_REFS_PER_NODE) return
    let token = raw.trim()
    if (!token || token.length < 2 || token.length > 200) return
    if (token.includes('://') || token.includes(':') || token.startsWith('data:')) return
    token = token.replace(/[?#].*$/, '')
    token = toPosix(token).replace(/^\.\//, '')
    if (!token || token === selfPath) return
    if (token.toLowerCase() === selfName) return
    if (seen.has(token)) return
    seen.add(token)
    const line = lineOf(starts, index)
    const lineStart = starts[line - 1] ?? 0
    const lineEnd = text.indexOf('\n', index)
    const snippet = text.slice(lineStart, lineEnd < 0 ? text.length : lineEnd).trim().slice(0, 160)
    refs.push({ t: token, l: line, s: snippet, r: roleOf(snippet) })
  }
  FILE_TOKEN_RE.lastIndex = 0
  IMPORT_TOKEN_RE.lastIndex = 0
  let match
  while ((match = FILE_TOKEN_RE.exec(text)) !== null) push(match[1], match.index)
  while ((match = IMPORT_TOKEN_RE.exec(text)) !== null) push(match[1], match.index)
  return refs
}

/** 老的图里 refs 还是纯字符串。 */
function refToken(ref) {
  if (typeof ref === 'string') return ref
  return ref && typeof ref === 'object' && typeof ref.t === 'string' ? ref.t : undefined
}

function resolveRef(token, fromPath, nodes) {
  const normalized = token.toLowerCase().replace(/^\/+/, '')
  const base = normalized.split('/').pop() ?? normalized
  const stem = base.includes('.') ? base.slice(0, base.lastIndexOf('.')) : base
  const fromDir = fromPath.includes('/') ? fromPath.slice(0, fromPath.lastIndexOf('/')) : ''

  const hits = []
  for (const node of nodes) {
    if (node.path === fromPath) continue
    const p = node.path.toLowerCase()
    const name = node.name.toLowerCase()
    const nodeStem = stemOf(name)
    const exact = p === normalized || p.endsWith('/' + normalized)
    const byName = name === base
    const byStem = nodeStem === stem
    if (exact || byName || byStem) {
      const nodeDir = p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : ''
      // 同目录/同后缀的优先；同分的歧义就不连（宁可少连，也不要画错）。
      let score = exact ? 4 : byName ? 3 : 1
      if (p.endsWith('/' + normalized) || p === normalized) score += 2
      if (nodeDir === fromDir) score += 2
      hits.push({ path: node.path, score })
    }
  }
  if (hits.length === 0) return undefined
  hits.sort((a, b) => b.score - a.score)
  if (hits.length > 1 && hits[0].score === hits[1].score) return undefined
  return hits[0].path
}

function deriveEdges(graph) {
  const nodes = Object.values(graph.nodes)
  const edges = []
  const seen = new Set()
  const add = (from, to, kind, evidence) => {
    if (!from || !to || from === to) return
    const key = from + '\u0000' + to + '\u0000' + kind
    if (seen.has(key)) return
    seen.add(key)
    edges.push(evidence ? { from, to, kind, evidence } : { from, to, kind })
  }
  for (const node of nodes) {
    for (const ref of node.refs ?? []) {
      const token = refToken(ref)
      if (!token) continue
      const target = resolveRef(token, node.path, nodes)
      if (!target) continue
      // 把"在哪一行、那句话、起什么作用"一起带出去，图上的灰线才有意义。
      const evidence =
        typeof ref === 'string'
          ? undefined
          : { token, line: ref.l, snippet: ref.s, role: ref.r || 'mention' }
      add('file:' + node.path, 'file:' + target, 'ref', evidence)
    }
    if (node.after && graph.nodes[node.after]) add('file:' + node.after, 'file:' + node.path, 'seq')
    // 窗口的输入/输出：a文件 --读入--> 窗口 --写出--> b文件
    for (const [sid, actor] of Object.entries(node.actors ?? {})) {
      if ((actor.read ?? 0) > 0) add('file:' + node.path, 'win:' + sid, 'in')
      if ((actor.write ?? 0) > 0) add('win:' + sid, 'file:' + node.path, 'out')
    }
  }
  // 其他来源（私信/弹幕/终端/网页…）：来源 --取数--> 窗口
  for (const source of Object.values(graph.sources ?? {})) {
    for (const sid of Object.keys(source.actors ?? {})) add('src:' + source.key, 'win:' + sid, 'src')
  }
  return edges.length > 6000 ? edges.slice(0, 6000) : edges
}

/* ---------------------------------------------------------- 记录一次写入 */

function pickToolPath(args) {
  if (!args || typeof args !== 'object') return undefined
  const candidates = [args.file_path, args.path, args.filePath, args.file]
  for (const value of candidates) {
    if (typeof value === 'string' && value.trim()) return value.trim()
  }
  return undefined
}

async function workingDirOf(ctx, agent) {
  const fallback = (() => {
    try {
      return ctx.workingDirectory.defaultDirectory
    } catch {
      return process.cwd()
    }
  })()
  if (!agent) return fallback
  try {
    const dir = await ctx.workingDirectory.ensure(agent)
    return dir || fallback
  } catch {
    return fallback
  }
}

function isDirectoryish(target) {
  return target.endsWith(path.sep) || target.endsWith('/') || target.endsWith('\\') || extOf(target) === ''
}

/** 同一个保存目录里按项目分文件：D:\文件关系\ + dsh_use.graph.json / b站鱼包间.graph.json */
function projectSlug(root) {
  const base = path.basename(root || '') || 'project'
  const safe = base.replace(/[\\/:*?"<>|\s]+/g, '_').replace(/^_+|_+$/g, '')
  return safe || 'project'
}

function resolveGraphTarget(projectRoot, configured) {
  if (configured && configured.trim()) {
    let target = configured.trim().replace(/^~(?=$|[\\/])/, os.homedir())
    if (!path.isAbsolute(target)) target = path.resolve(projectRoot, target)
    if (isDirectoryish(target)) {
      target = path.join(target, projectSlug(projectRoot) + '.graph.json')
    }
    return path.normalize(target)
  }
  return path.join(projectRoot, DEFAULT_DIRNAME, DEFAULT_FILENAME)
}

async function recordEvent(ctx, agent, toolName, args) {
  const sourceKey = sourceKeyOf(toolName)
  if (sourceKey) {
    await recordSource(ctx, agent, sourceKey)
    return
  }
  const kind = WRITE_TOOLS.has(toolName) ? 'write' : READ_TOOLS.has(toolName) ? 'read' : undefined
  if (!kind) return
  const rawPath = pickToolPath(args)
  if (!rawPath) return
  const projectRoot = await workingDirOf(ctx, agent)
  const absolute = path.isAbsolute(rawPath)
    ? path.normalize(rawPath)
    : path.resolve(projectRoot, rawPath)

  const current = await ensureState()
  const graphFile = resolveGraphTarget(projectRoot, current.graphFile)
  const entry = await graphFor(graphFile, projectRoot)
  const graph = entry.graph

  const relRaw = path.relative(graph.root, absolute)
  const inside = !relRaw.startsWith('..') && !path.isAbsolute(relRaw)
  const rel = inside ? toPosix(relRaw) : toPosix(absolute)
  if (!rel) return

  const now = Date.now()
  let size = 0
  let mtime = now
  let text = ''
  try {
    const info = await fsp.stat(absolute)
    if (!info.isFile()) return
    size = info.size
    mtime = info.mtimeMs
    if (kind === 'write' && size <= MAX_TEXT_BYTES && TEXT_EXT.has(extOf(absolute))) {
      text = await fsp.readFile(absolute, 'utf8')
    }
  } catch {
    return // 文件没落地就不记
  }

  const name = path.posix.basename(rel)
  const node = graph.nodes[rel] ?? { path: rel, name, dir: '', firstAt: now, writes: 0, reads: 0, refs: [], actors: {} }
  const slash = rel.lastIndexOf('/')
  node.dir = slash > 0 ? rel.slice(0, slash) : ''
  node.name = name
  node.ext = extOf(name)
  node.reads = node.reads ?? 0
  node.actors = node.actors ?? {}
  node.size = size
  node.mtime = mtime
  node.lastAt = now
  node.lastTool = toolName
  if (kind === 'write') {
    node.writes = (node.writes ?? 0) + 1
    node.seq = ++graph.seq
    if (agent && typeof agent.id === 'string') node.session = agent.id
    if (text) node.refs = extractRefs(text, rel)
  } else {
    node.reads += 1
  }

  // AI 窗口实例：文件侧记「哪条窗口读/写了我」，窗口侧记分工（组/名字）+ 读多少写多少。
  const sessionId = agent && typeof agent.id === 'string' ? agent.id : undefined
  if (sessionId) {
    graph.windows = graph.windows ?? {}
    const win = graph.windows[sessionId] ?? {
      id: sessionId,
      index: Object.keys(graph.windows).length + 1,
      label: '',
      group: '',
      firstAt: now,
      writes: 0,
      reads: 0,
    }
    win.label = win.label ?? ''
    win.group = win.group ?? ''
    win.writes = win.writes ?? 0
    win.reads = win.reads ?? 0
    if (kind === 'write') {
      win.writes += 1
      win.lastWriteFile = rel
    } else {
      win.reads += 1
      win.lastReadFile = rel
    }
    win.lastAt = now
    graph.windows[sessionId] = win

    const actor = node.actors[sessionId] ?? { read: 0, write: 0, lastAt: now }
    actor.read = actor.read ?? 0
    actor.write = actor.write ?? 0
    if (kind === 'write') actor.write += 1
    else actor.read += 1
    actor.lastAt = now
    node.actors[sessionId] = actor
  }

  if (kind === 'write') {
    const previous = lastWrite.get(graphFile)
    if (
      previous &&
      previous.rel !== rel &&
      now - previous.at <= SEQ_WINDOW_MS &&
      (!previous.session || !node.session || previous.session === node.session) &&
      graph.nodes[previous.rel]
    ) {
      node.after = previous.rel
    } else {
      delete node.after
    }
    lastWrite.set(graphFile, { rel, at: now, session: node.session })
  }

  graph.nodes[rel] = node
  graph.updatedAt = now
  pruneIsolated(graph)

  current.projects[graph.root] = {
    graphFile,
    updatedAt: now,
    nodeCount: Object.keys(graph.nodes).length,
  }
  scheduleGraphSave(entry, graphFile)
  scheduleStateSave()
}

/** 非文件来源（私信/弹幕/终端/网页…）：只记「哪条窗口从哪取过数」，不碰文件节点。 */
async function recordSource(ctx, agent, sourceKey) {
  const sessionId = agent && typeof agent.id === 'string' ? agent.id : undefined
  const projectRoot = await workingDirOf(ctx, agent)
  const current = await ensureState()
  const graphFile = resolveGraphTarget(projectRoot, current.graphFile)
  const entry = await graphFor(graphFile, projectRoot)
  const graph = entry.graph
  const now = Date.now()

  graph.sources = graph.sources ?? {}
  const source = graph.sources[sourceKey] ?? {
    key: sourceKey,
    label: sourceKey,
    firstAt: now,
    count: 0,
    actors: {},
  }
  source.count = (source.count ?? 0) + 1
  source.lastAt = now
  source.actors = source.actors ?? {}
  if (sessionId) source.actors[sessionId] = (source.actors[sessionId] ?? 0) + 1
  graph.sources[sourceKey] = source
  graph.updatedAt = now

  if (sessionId) {
    graph.windows = graph.windows ?? {}
    const win = graph.windows[sessionId] ?? {
      id: sessionId,
      index: Object.keys(graph.windows).length + 1,
      label: '',
      group: '',
      firstAt: now,
      writes: 0,
      reads: 0,
    }
    win.writes = win.writes ?? 0
    win.reads = win.reads ?? 0
    win.sources = win.sources ?? {}
    win.sources[sourceKey] = (win.sources[sourceKey] ?? 0) + 1
    win.lastAt = now
    graph.windows[sessionId] = win
  }

  scheduleGraphSave(entry, graphFile)
}

/* -------------------------------------------------------------- HTTP */

function sendJson(res, status, value) {
  const body = JSON.stringify(value)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
  })
  res.end(body)
}

/** 400/403 这种「直接回一句错」的短路：返回 false，让 editGraph 别再继续落盘。 */
function fail(res, error, status = 400) {
  sendJson(res, status, { ok: false, error })
  return false
}

async function readJsonBody(req) {
  const chunks = []
  let total = 0
  for await (const chunk of req) {
    total += chunk.length
    if (total > 64 * 1024) throw new Error('body too large')
    chunks.push(chunk)
  }
  if (chunks.length === 0) return {}
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}

/** 注册一个 JSON 路由：统一管 method / x-filegraph / 读 body / 错误兜底。
 *  method GET 也放行 HEAD；any 表示不校验（/filegraph/list 这种只读目录接口）。 */
function routeOf(ctx, path, handler, options) {
  const method = (options && options.method) || 'POST'
  const any = !!(options && options.any)
  const readBody = !(options && options.body === false)
  ctx.effect(() =>
    ctx.webServer.register({
      kind: 'exact',
      path,
      handler: async (req, res) => {
        try {
          if (!any && req.method !== method && !(method === 'GET' && req.method === 'HEAD')) return fail(res, method + ' only', 405)
          if (!any && method === 'POST' && req.headers['x-filegraph'] !== '1') return fail(res, 'missing x-filegraph header', 403)
          await handler(req, res, readBody ? await readJsonBody(req) : {})
        } catch (error) {
          sendJson(res, 500, { ok: false, error: messageOf(error) })
        }
      },
    }),
  )
}

function projectRows(current) {
  return Object.entries(current.projects)
    .map(([root, info]) => ({
      root,
      graphFile: info.graphFile,
      updatedAt: info.updatedAt ?? 0,
      nodeCount: info.nodeCount ?? 0,
      label: path.basename(root) || root,
    }))
    .sort((a, b) => b.updatedAt - a.updatedAt)
}

/** AI 窗口实例清单：会话 → 分工（组/名字）+ 读写计数 + 它读/写/取数的对象。 */
function windowsPayload(graph) {
  const windows = new Map()
  const ensure = (id) => {
    if (!windows.has(id)) {
      const stored = (graph.windows ?? {})[id] ?? {}
      windows.set(id, {
        id,
        index: stored.index ?? 0,
        label: stored.label ?? '',
        group: stored.group ?? '',
        writes: stored.writes ?? 0,
        reads: stored.reads ?? 0,
        firstAt: stored.firstAt ?? 0,
        lastAt: stored.lastAt ?? 0,
        lastWriteFile: stored.lastWriteFile ?? '',
        inputs: [],
        outputs: [],
        sources: [],
      })
    }
    return windows.get(id)
  }
  for (const [id, win] of Object.entries(graph.windows ?? {})) {
    ensure(id)
    const row = windows.get(id)
    row.index = win.index ?? row.index
    row.label = win.label ?? row.label
    row.group = win.group ?? row.group
    row.writes = win.writes ?? row.writes
    row.reads = win.reads ?? row.reads
    row.firstAt = win.firstAt ?? row.firstAt
    row.lastAt = win.lastAt ?? row.lastAt
  }
  for (const node of Object.values(graph.nodes)) {
    for (const [id, actor] of Object.entries(node.actors ?? {})) {
      const row = ensure(id)
      if ((actor.read ?? 0) > 0) row.inputs.push(node.path)
      if ((actor.write ?? 0) > 0) row.outputs.push(node.path)
      row.lastAt = Math.max(row.lastAt, actor.lastAt ?? 0)
    }
  }
  for (const source of Object.values(graph.sources ?? {})) {
    for (const id of Object.keys(source.actors ?? {})) {
      const row = ensure(id)
      if (!row.sources.includes(source.key)) row.sources.push(source.key)
    }
  }
  const list = [...windows.values()].sort((a, b) => (a.index || 999) - (b.index || 999))
  let cursor = 0
  for (const row of list) {
    if (!row.index) row.index = ++cursor
    else cursor = Math.max(cursor, row.index)
  }
  return list
}

function sourcesPayload(graph) {
  return Object.values(graph.sources ?? {})
    .map((source) => ({
      key: source.key,
      label: source.label || source.key,
      count: source.count ?? 0,
      firstAt: source.firstAt ?? 0,
      lastAt: source.lastAt ?? 0,
      windows: Object.keys(source.actors ?? {}),
    }))
    .sort((a, b) => (a.firstAt ?? 0) - (b.firstAt ?? 0))
}

/** 把项目里**现有**的代码/文本文件扫进图（节点 + 抽引用），不然没被 AI 碰过的项目永远是空图。 */
async function scanProject(entry, graphFile) {
  const graph = entry.graph
  const root = graph.root
  const now = Date.now()
  const queue = [{ dir: root, depth: 0 }]
  let added = 0
  let seen = 0
  let contentBudget = SCAN_CONTENT_BUDGET

  while (queue.length > 0 && seen < SCAN_MAX_FILES) {
    const current = queue.shift()
    let entries
    try {
      entries = await fsp.readdir(current.dir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const dirent of entries) {
      if (seen >= SCAN_MAX_FILES) break
      const absolute = path.join(current.dir, dirent.name)
      if (dirent.isDirectory()) {
        if (current.depth + 1 > SCAN_MAX_DEPTH) continue
        if (SCAN_SKIP_DIRS.has(dirent.name)) continue
        if (dirent.name.startsWith('.') && dirent.name.length > 1) continue
        queue.push({ dir: absolute, depth: current.depth + 1 })
        continue
      }
      if (!dirent.isFile()) continue
      const ext = extOf(dirent.name)
      if (!TEXT_EXT.has(ext)) continue
      const relRaw = path.relative(root, absolute)
      if (relRaw.startsWith('..') || path.isAbsolute(relRaw)) continue
      const rel = toPosix(relRaw)
      if (!rel) continue
      seen += 1
      let size = 0
      try {
        const info = await fsp.stat(absolute)
        if (!info.isFile()) continue
        size = info.size
      } catch {
        continue
      }
      const fresh = graph.nodes[rel] === undefined
      const node = graph.nodes[rel] ?? {
        path: rel,
        name: dirent.name,
        dir: '',
        ext,
        writes: 0,
        reads: 0,
        refs: [],
        actors: {},
        firstAt: now,
        lastAt: now,
        scanned: true,
      }
      if (fresh) added += 1
      const slash = rel.lastIndexOf('/')
      node.dir = slash > 0 ? rel.slice(0, slash) : ''
      node.name = dirent.name
      node.ext = ext
      node.size = size
      node.lastAt = node.lastAt ?? now
      const refs = node.refs ?? []
      // 每次扫描都重抽一遍：老图里的 refs 只是字符串（没有行号/原句），重抽后灰线才有"证据"。
      if (contentBudget > 0 && size <= SCAN_CONTENT_BYTES) {
        try {
          const text = await fsp.readFile(absolute, 'utf8')
          node.refs = extractRefs(text, rel)
          contentBudget -= 1
        } catch {}
      } else if (refs.length === 0) {
        node.refs = refs
      }
      graph.nodes[rel] = node
    }
  }

  graph.updatedAt = now
  const removed = pruneIsolated(graph)
  await flushGraph(entry, graphFile)
  return { added, seen, removed, nodes: Object.keys(graph.nodes).length }
}

/** 一条边都没有的节点：扫进来的垃圾，直接从图文件里删掉（touched=true 才连 AI 碰过的也删）。 */
function pruneIsolated(graph, options = {}) {
  const includeTouched = options.includeTouched === true
  const nodes = Object.values(graph.nodes)
  const linked = new Set()
  for (const node of nodes) {
    for (const ref of node.refs ?? []) {
      const token = refToken(ref)
      if (!token) continue
      const target = resolveRef(token, node.path, nodes)
      if (target) {
        linked.add('file:' + node.path)
        linked.add('file:' + target)
      }
    }
    if (node.after && graph.nodes[node.after]) {
      linked.add('file:' + node.path)
      linked.add('file:' + node.after)
    }
    for (const [sid, actor] of Object.entries(node.actors ?? {})) {
      if ((actor.read ?? 0) > 0 || (actor.write ?? 0) > 0) {
        linked.add('file:' + node.path)
        linked.add('win:' + sid)
      }
    }
  }
  for (const [key, source] of Object.entries(graph.sources ?? {})) {
    for (const sid of Object.keys(source.actors ?? {})) {
      linked.add('src:' + key)
      linked.add('win:' + sid)
    }
  }

  let removed = 0
  for (const [rel, node] of Object.entries(graph.nodes)) {
    if (linked.has('file:' + rel)) continue
    const touched = (node.writes ?? 0) > 0 || (node.reads ?? 0) > 0
    if (touched && !includeTouched) continue
    delete graph.nodes[rel]
    if (graph.positions) delete graph.positions['file:' + rel]
    removed += 1
  }
  for (const [key] of Object.entries(graph.sources ?? {})) {
    if (!linked.has('src:' + key)) delete graph.sources[key]
  }
  for (const [id] of Object.entries(graph.windows ?? {})) {
    if (!linked.has('win:' + id)) {
      delete graph.windows[id]
      if (graph.positions) delete graph.positions['win:' + id]
    }
  }
  return removed
}

/** 把当前关系图导出成标准 .drawio（能被 drawio / drawai 直接打开）。
 *  节点按 id 落盘（id 是身份），名字只是标签 —— 同名节点可以有好几个。 */
function buildDrawio(flowNodes, flows, knownPositions, groups) {
  const nodes = []
  const ids = new Set()
  for (const node of Array.isArray(flowNodes) ? flowNodes : []) {
    if (!node || !node.id || ids.has(node.id)) continue
    ids.add(node.id)
    nodes.push({ id: node.id, name: String(node.name || node.id), kind: node.kind === 'group' ? 'group' : 'node' })
  }
  const edges = []
  for (const flow of Array.isArray(flows) ? flows : []) {
    if (!flow || !flow.fromId || !flow.toId) continue
    if (!ids.has(flow.fromId) || !ids.has(flow.toId)) continue
    edges.push(flow)
  }
  const incoming = new Map()
  const outgoing = new Map()
  for (const edge of edges) {
    if (!incoming.has(edge.toId)) incoming.set(edge.toId, [])
    incoming.get(edge.toId).push(edge.fromId)
    if (!outgoing.has(edge.fromId)) outgoing.set(edge.fromId, [])
    outgoing.get(edge.fromId).push(edge.toId)
  }
  const level = new Map()
  let frontier = nodes.map((n) => n.id).filter((id) => (incoming.get(id) || []).length === 0)
  for (const id of frontier) level.set(id, 0)
  let depth = 0
  while (frontier.length > 0 && depth < 12) {
    depth += 1
    const next = []
    for (const id of frontier) {
      for (const child of outgoing.get(id) || []) {
        if (level.has(child)) continue
        level.set(child, depth)
        next.push(child)
      }
    }
    frontier = next
  }
  const columns = new Map()
  for (const node of nodes) {
    const lv = level.get(node.id) ?? 0
    if (!columns.has(lv)) columns.set(lv, [])
    columns.get(lv).push(node.id)
  }
  const positions = new Map()
  for (const [lv, list] of columns) list.forEach((id, row) => positions.set(id, { x: lv * 250, y: row * 90 }))
  // 有现成坐标就用现成的（编辑后不要把人摆好的位置重排掉）
  if (knownPositions && typeof knownPositions === 'object') {
    for (const [id, pos] of Object.entries(knownPositions)) {
      if (!ids.has(id) || !pos || !Number.isFinite(pos.x) || !Number.isFinite(pos.y)) continue
      positions.set(id, { x: Math.round(pos.x), y: Math.round(pos.y) })
    }
  }

  const esc = (s) =>
    String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
  const heightOf = (node) => {
    if (node.kind !== 'group' || !groups || !groups[node.id]) return 48
    const group = groups[node.id]
    const rows = Math.max((group.inputs || []).length, (group.outputs || []).length, 1)
    return 30 + rows * 18
  }
  const cells = ['<mxCell id="0"/>', '<mxCell id="1" parent="0"/>']
  for (const node of nodes) {
    const pos = positions.get(node.id) || { x: 0, y: 0 }
    const style =
      node.kind === 'group'
        ? 'rounded=1;whiteSpace=wrap;html=1;fillColor=#1d4ed8;fontColor=#ffffff;strokeColor=#1d4ed8;'
        : 'rounded=1;whiteSpace=wrap;html=1;'
    cells.push(
      '<mxCell id="' + esc(node.id) + '" value="' + esc(node.name) + '" style="' + style + '" vertex="1" parent="1">' +
        '<mxGeometry x="' + pos.x + '" y="' + pos.y + '" width="170" height="' + heightOf(node) + '" as="geometry"/></mxCell>',
    )
  }
  edges.forEach((edge, index) => {
    const edgeId = edge.id ? String(edge.id) : 'fe' + (index + 1)
    cells.push(
      '<mxCell id="' + esc(edgeId) + '" value="' + esc(edge.verb || '') + '" style="endArrow=classic;html=1;rounded=0;" edge="1" parent="1" source="' + esc(edge.fromId) + '" target="' + esc(edge.toId) + '">' +
        '<mxGeometry relative="1" as="geometry"/></mxCell>',
    )
  })
  return (
    '<?xml version="1.0" encoding="UTF-8"?>\n' +
    '<mxfile host="filegraph"><diagram id="fg" name="关系">' +
    '<mxGraphModel dx="1200" dy="900" grid="1" gridSize="10" guides="1" tooltips="1" connect="1" arrows="1" fold="1" page="1" pageScale="1" pageWidth="1600" pageHeight="1200" math="0" shadow="0"><root>\n' +
    cells.join('\n') +
    '\n</root></mxGraphModel></diagram></mxfile>\n'
  )
}

/** 把 .drawio 画布翻译成 节点（id/名字）+ 连线（按 id） + 每个节点的画布坐标。
 *  名字不截断：用户明确要求长名字原样保留。 */
function parseDrawio(text) {
  const blocks = text.split(/<mxCell\b/).slice(1)
  const attr = (tag, name) => {
    const m = tag.match(new RegExp(name + '="([^"]*)"'))
    return m ? m[1] : ''
  }
  const decode = (s) =>
    s
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#10;/g, '\n')
      .replace(/&#xa;/gi, '\n')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/&amp;/g, '&')
  const strip = (s) => s.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()

  const vertices = new Map()
  const positions = {}
  const nodes = []
  const edges = []
  for (const block of blocks) {
    const open = block.slice(0, block.indexOf('>') + 1)
    const id = attr(open, 'id')
    if (!id) continue
    if (/vertex="1"/.test(open)) {
      const label = strip(decode(attr(open, 'value')).split('\n')[0])
      const name = label.slice(0, 300) || id
      const style = attr(open, 'style')
      const kind = /fillColor=#1d4ed8/i.test(style) ? 'group' : 'node'
      vertices.set(id, { id, name, kind })
      nodes.push({ id, name, kind })
      const geo = block.match(/<mxGeometry[^>]*x="([^"]+)"[^>]*y="([^"]+)"[^>]*\/?>/)
      if (geo) {
        const x = Number(geo[1])
        const y = Number(geo[2])
        if (Number.isFinite(x) && Number.isFinite(y)) positions[id] = { x: Math.round(x), y: Math.round(y) }
      }
    }
    if (/edge="1"/.test(open)) {
      edges.push({
        id: attr(open, 'id'),
        source: attr(open, 'source'),
        target: attr(open, 'target'),
        verb: strip(decode(attr(open, 'value'))),
      })
    }
  }
  const flows = []
  for (const edge of edges) {
    if (!vertices.has(edge.source) || !vertices.has(edge.target)) continue
    flows.push({ id: edge.id || undefined, fromId: edge.source, toId: edge.target, verb: edge.verb })
  }
  return { nodes, flows, positions, nodeCount: vertices.size, edgeCount: flows.length }
}

/** 画布重读后对齐内存模型：位置以画布为准；手拖矢量按节点 id 留着，
 *  id 变了（外部编辑器重建）就按名字接回去。节点组按 id 保留，消失的组一起清掉。 */
function reconcileCanvas(graph, parsed) {
  const prevNodes = Array.isArray(graph.flowNodes) ? graph.flowNodes : []
  const prevNameById = new Map(prevNodes.map((node) => [node.id, node.name]))
  const prevDrags = graph.drags && typeof graph.drags === 'object' ? graph.drags : {}
  const dragByName = new Map()
  for (const [id, delta] of Object.entries(prevDrags)) {
    const name = prevNameById.get(id)
    if (name && delta) dragByName.set(name, delta)
  }
  const groups = graph.groups && typeof graph.groups === 'object' ? graph.groups : {}
  const nodes = (parsed.nodes || []).map((node) => ({
    id: node.id,
    name: node.name,
    kind: groups[node.id] || node.kind === 'group' ? 'group' : 'node',
  }))
  // 画布上标成节点组、但内部数据丢了（比如只留下 .drawio）：补一个空组，右键还能打开
  for (const node of nodes) {
    if (node.kind === 'group' && !groups[node.id]) {
      groups[node.id] = {
        id: node.id,
        name: node.name,
        note: '',
        inputs: ['输入'],
        outputs: ['输出'],
        nodes: [
          { id: 'gin', name: '组输入', kind: 'input', x: -80, y: 120, inputs: [], outputs: ['输入'] },
          { id: 'gout', name: '组输出', kind: 'output', x: 620, y: 120, inputs: ['输出'], outputs: [] },
        ],
        flows: [],
        notes: {},
        view: {},
      }
    }
  }
  const ids = new Set(nodes.map((node) => node.id))
  for (const id of Object.keys(groups)) if (!ids.has(id)) delete groups[id]
  // v2 迁过来的手拖矢量是按名字存的（旧图没有 id），这里按名字接回新 id
  const legacyDrags = graph.legacyDrags ? prevDrags : null
  const drags = {}
  for (const node of nodes) {
    const delta = prevDrags[node.id] || dragByName.get(node.name) || (legacyDrags && legacyDrags[node.name])
    if (delta) drags[node.id] = delta
  }
  delete graph.legacyDrags
  graph.drags = drags
  graph.flowNodes = nodes
  graph.flowPositions = parsed.positions || {}
  graph.flows = (parsed.flows || []).slice(-600)
  graph.groups = groups
}

async function syncDrawio(current) {
  const rows = projectRows(current)
  const target = rows[0]
  if (!target) return
  const filePath = current.drawioFile && current.drawioFile.trim()
    ? current.drawioFile.trim()
    : path.join(target.root, '项目关系图.drawio')
  let info
  try {
    info = await fsp.stat(filePath)
  } catch {
    return
  }
  const entry = await graphFor(target.graphFile, target.root)
  const graph = entry.graph
  if (graph.drawioMtime === info.mtimeMs) return
  let text = ''
  try {
    text = await fsp.readFile(filePath, 'utf8')
  } catch {
    return
  }
  const parsed = parseDrawio(text)
  // 空文件是合法状态（新建的图就是空的）：只有连 mxCell 都没有时才当成解析失败、保留旧数据
  if (parsed.flows.length === 0 && !/<mxCell/.test(text)) return
  reconcileCanvas(graph, parsed)
  graph.drawioMtime = info.mtimeMs
  graph.updatedAt = Date.now()
  await flushGraph(entry, target.graphFile)
  return parsed
}

async function payloadFor(current, root) {
  const rows = projectRows(current)
  const active = root ? rows.find((row) => row.root === root) ?? rows[0] : rows[0]
  if (!active) {
    return {
      ok: true,
      now: Date.now(),
      projects: [],
      active: null,
      nodes: [],
      edges: [],
      windows: [],
      sources: [],
      settings: { graphFile: current.graphFile, drawioFile: current.drawioFile ?? '' },
    }
  }
  const entry = await graphFor(active.graphFile, active.root)
  const graph = entry.graph
  const nodes = Object.values(graph.nodes).sort((a, b) => (a.firstAt ?? 0) - (b.firstAt ?? 0))
  return {
    ok: true,
    now: Date.now(),
    projects: rows,
    active: { root: graph.root, graphFile: active.graphFile },
    nodes,
    edges: deriveEdges(graph),
    windows: windowsPayload(graph),
    sources: sourcesPayload(graph),
    positions: graph.positions ?? {},
    // 画布层：节点有独立 id；信息（备注）按名字存，同名节点共用同一份。
    flowNodes: graph.flowNodes ?? [],
    flows: graph.flows ?? [],
    flowPositions: graph.flowPositions ?? {},
    drags: graph.drags ?? {},
    nodeNames: (graph.flowNodes ?? []).map((node) => node.name),
    nodeNotes: graph.nodeNotes ?? {},
    groups: graph.groups ?? {},
    settings: { graphFile: current.graphFile, drawioFile: current.drawioFile ?? '' },
  }
}

/* --------------------------------------------------------------- apply */

export function apply(ctx, config = {}) {
  void config

  ctx.on('tools/result', (exec, result) => {
    if (!exec || result?.isError) return
    const toolName = exec.name
    if (!WRITE_TOOLS.has(toolName) && !READ_TOOLS.has(toolName) && !sourceKeyOf(toolName)) return
    void recordEvent(ctx, exec.agent, toolName, exec.arguments).catch(() => {})
  })

  /** 改当前项目的图：自动取活动项目 + 落盘 + 回全量 payload；回调返回的字段并进响应。 */
  const editGraph = async (res, fn) => {
    const current = await ensureState()
    const active = projectRows(current)[0]
    if (!active) return fail(res, 'no project recorded yet', 404)
    const entry = await graphFor(active.graphFile, active.root)
    const extra = await fn(entry.graph, { current, active, entry })
    if (extra === false) return
    await flushGraph(entry, active.graphFile)
    sendJson(res, 200, { ok: true, ...(extra || {}), ...(await payloadFor(current, active.root)) })
  }

  const postRoute = (path, handler, options) => routeOf(ctx, path, handler, options)
  const getRoute = (path, handler, options) => routeOf(ctx, path, handler, { ...options, method: 'GET' })
  const anyRoute = (path, handler, options) => routeOf(ctx, path, handler, { ...options, any: true })

  getRoute(DATA_ROUTE, async (req, res) => {
    const url = new URL(req.url ?? DATA_ROUTE, 'http://127.0.0.1')
    const current = await ensureState()
    await syncDrawio(current)
    sendJson(res, 200, await payloadFor(current, url.searchParams.get('root') ?? undefined))
  })

  postRoute(SETTINGS_ROUTE, async (req, res, body) => {
    const current = await ensureState()
    if (typeof body.graphFile === 'string') {
      current.graphFile = body.graphFile.trim()
      // 换位置 = 把当前这张图搬过去（目标已存在就不覆盖，那是旧历史），
      // 之后写进新文件；改回默认也一样把图带回来。
      const rows = projectRows(current)
      const active = rows[0]
      if (active) {
        const target = resolveGraphTarget(active.root, current.graphFile)
        if (target !== active.graphFile) {
          const exists = await fsp
            .stat(target)
            .then(() => true)
            .catch(() => false)
          if (!exists) {
            const entry = await graphFor(active.graphFile, active.root)
            await flushGraph(entry, active.graphFile)
            await writeJsonAtomic(target, entry.graph)
          }
          current.projects[active.root] = {
            graphFile: target,
            updatedAt: Date.now(),
            nodeCount: active.nodeCount,
          }
        }
      }
      scheduleStateSave()
    }
    await writeJsonAtomic(stateFile(), current)
    sendJson(res, 200, { ok: true, settings: { graphFile: current.graphFile, drawioFile: current.drawioFile ?? '' } })
  })

  postRoute(RESET_ROUTE, async (req, res, body) => {
    const current = await ensureState()
    const rows = projectRows(current)
    const target = typeof body.root === 'string' && body.root
      ? rows.find((row) => row.root === body.root)
      : rows[0]
    if (!target) {
      sendJson(res, 200, { ok: true, cleared: false })
      return
    }
    const entry = await graphFor(target.graphFile, target.root)
    entry.graph.nodes = {}
    entry.graph.windows = {}
    entry.graph.sources = {}
    entry.graph.positions = {}
    entry.graph.flows = []
    entry.graph.flowNodes = []
    entry.graph.flowPositions = {}
    entry.graph.drags = {}
    entry.graph.nodeNotes = {}
    entry.graph.groups = {}
    entry.graph.seq = 0
    entry.graph.flowSeq = 0
    entry.graph.edgeSeq = 0
    entry.graph.drawioMtime = 0
    entry.graph.updatedAt = Date.now()
    lastWrite.delete(target.graphFile)
    await flushGraph(entry, target.graphFile)
    // 画布文件也清空：否则下次读盘会把旧 .drawio 又导回来
    await writeCanvas(entry.graph, current, target)
    current.projects[target.root] = {
      graphFile: target.graphFile,
      updatedAt: entry.graph.updatedAt,
      nodeCount: 0,
    }
    await writeJsonAtomic(stateFile(), current)
    sendJson(res, 200, { ok: true, cleared: true, ...(await payloadFor(current, target.root)) })
  })

  // 扫描项目现有文件（面板「扫描」按钮 / 空图时自动跑一次）。
  postRoute(SCAN_ROUTE, async (req, res, body) => {
    const current = await ensureState()
    const rows = projectRows(current)
    const wanted = typeof body.root === 'string' ? body.root.trim() : ''
    let target
    if (wanted && !rows.some((row) => row.root === wanted)) {
      // 面板里手填的目录 = 新项目：给它建一条记录 + 自己的图文件，然后扫。
      const dir = path.resolve(wanted)
      const info = await fsp.stat(dir).catch(() => null)
      if (!info || !info.isDirectory()) return fail(res, '不是目录：' + dir)
      target = {
        root: dir,
        graphFile: resolveGraphTarget(dir, current.graphFile),
        updatedAt: Date.now(),
        nodeCount: 0,
      }
      current.projects[dir] = {
        graphFile: target.graphFile,
        updatedAt: target.updatedAt,
        nodeCount: 0,
      }
    } else {
      target = wanted ? rows.find((row) => row.root === wanted) ?? rows[0] : rows[0]
    }
    if (!target) {
      sendJson(res, 200, { ok: true, added: 0, seen: 0, nodes: 0 })
      return
    }
    const entry = await graphFor(target.graphFile, target.root)
    const result = await scanProject(entry, target.graphFile)
    current.projects[target.root] = {
      graphFile: target.graphFile,
      updatedAt: Date.now(),
      nodeCount: result.nodes,
    }
    scheduleStateSave()
    sendJson(res, 200, { ok: true, ...result, ...(await payloadFor(current, target.root)) })
  })

  // 给某条 AI 窗口起个人话名字（「陪看窗口」「轮窗口」…）。
  postRoute(WINDOW_ROUTE, async (req, res, body) => {
    const id = typeof body.id === 'string' ? body.id.trim() : ''
    if (!id) return fail(res, 'id required')
    const current = await ensureState()
    const rows = projectRows(current)
    const target = typeof body.root === 'string' && body.root ? rows.find((row) => row.root === body.root) : rows[0]
    if (!target) return fail(res, 'no project recorded yet', 404)
    const entry = await graphFor(target.graphFile, target.root)
    const graph = entry.graph
    graph.windows = graph.windows ?? {}
    const win = graph.windows[id] ?? { id, index: Object.keys(graph.windows).length + 1, firstAt: Date.now(), writes: 0, reads: 0, label: '', group: '' }
    if (typeof body.label === 'string') win.label = body.label.trim().slice(0, 40)
    if (typeof body.group === 'string') win.group = body.group.trim().slice(0, 24)
    win.label = win.label ?? ''
    win.group = win.group ?? ''
    graph.windows[id] = win
    graph.updatedAt = Date.now()
    await flushGraph(entry, target.graphFile)
    sendJson(res, 200, { ok: true, window: { id, label: win.label, group: win.group }, windows: windowsPayload(graph), edges: deriveEdges(graph) })
  })

  // 手动摆过的节点位置（拖完就存进图文件），reset=重排。
  postRoute(POSITION_ROUTE, async (req, res, body) => {
    const current = await ensureState()
    const rows = projectRows(current)
    const target = typeof body.root === 'string' && body.root ? rows.find((row) => row.root === body.root) : rows[0]
    if (!target) {
      sendJson(res, 200, { ok: true, positions: {} })
      return
    }
    const entry = await graphFor(target.graphFile, target.root)
    const graph = entry.graph
    graph.positions = graph.positions ?? {}
    if (body.reset === true) {
      graph.positions = {}
    } else if (body.positions && typeof body.positions === 'object') {
      // 批量（拖整个文件夹时一次提交）
      for (const [id, pos] of Object.entries(body.positions)) {
        const x = Number(pos && pos.x)
        const y = Number(pos && pos.y)
        if (!id || !Number.isFinite(x) || !Number.isFinite(y)) continue
        graph.positions[id] = { x: Math.round(x), y: Math.round(y) }
      }
    } else if (typeof body.id === 'string' && body.id) {
      const x = Number(body.x)
      const y = Number(body.y)
      if (!Number.isFinite(x) || !Number.isFinite(y)) return fail(res, 'x/y must be numbers')
      graph.positions[body.id] = { x: Math.round(x), y: Math.round(y) }
    }
    graph.updatedAt = Date.now()
    await flushGraph(entry, target.graphFile)
    sendJson(res, 200, { ok: true, positions: graph.positions })
  })

  // 手动清理孤立节点（连 AI 碰过的也一起删）；扫描时已自动清"扫出来的孤点"。
  postRoute(PRUNE_ROUTE, async (req, res, body) => {
    const current = await ensureState()
    const rows = projectRows(current)
    const target = typeof body.root === 'string' && body.root ? rows.find((row) => row.root === body.root) : rows[0]
    if (!target) {
      sendJson(res, 200, { ok: true, removed: 0 })
      return
    }
    const entry = await graphFor(target.graphFile, target.root)
    const graph = entry.graph
    const removed = pruneIsolated(graph, { includeTouched: body.all === true })
    graph.updatedAt = Date.now()
    await flushGraph(entry, target.graphFile)
    current.projects[target.root] = {
      graphFile: target.graphFile,
      updatedAt: graph.updatedAt,
      nodeCount: Object.keys(graph.nodes).length,
    }
    sendJson(res, 200, { ok: true, removed, ...(await payloadFor(current, target.root)) })
  })

  // 新建一个空的关系文件（.drawio），并把它设为当前文件。
  postRoute('/filegraph/new', async (req, res, body) => {
    const target = String(body.path || '').trim()
    if (!target) return fail(res, 'path required')
    const exists = await fsp.stat(target).then(() => true).catch(() => false)
    if (exists && body.overwrite !== true) return fail(res, '文件已存在', 409)
    const empty =
      '<?xml version="1.0" encoding="UTF-8"?>\n' +
      '<mxfile host="filegraph" agent="filegraph" type="device"><diagram id="fg" name="运行关系">' +
      '<mxGraphModel dx="900" dy="600" grid="1" gridSize="10" guides="1" tooltips="1" connect="1" arrows="1" fold="1" page="1" pageScale="1" pageWidth="1600" pageHeight="1200" math="0" shadow="0"><root>\n' +
      '<mxCell id="0"/>\n<mxCell id="1" parent="0"/>\n' +
      '</root></mxGraphModel></diagram></mxfile>\n'
    await fsp.mkdir(path.dirname(target), { recursive: true })
    await fsp.writeFile(target, empty, 'utf8')
    const current = await ensureState()
    current.drawioFile = target
    const rows = projectRows(current)
    if (rows[0]) {
      const entry = await graphFor(rows[0].graphFile, rows[0].root)
      entry.graph.flows = []
      entry.graph.flowNodes = []
      entry.graph.flowPositions = {}
      entry.graph.drags = {}
      entry.graph.groups = {}
      entry.graph.drawioMtime = 0
      await flushGraph(entry, rows[0].graphFile)
    }
    await syncDrawio(current)
    await writeJsonAtomic(stateFile(), current)
    sendJson(res, 200, { ok: true, created: target, ...(await payloadFor(current, rows[0] ? rows[0].root : undefined)) })
  })

  /* --------------------------------------------- 画布：节点 / 关系 / 节点组 */
  const drawioHistory = new Map()

  async function pushHistory(file) {
    try {
      const text = await fsp.readFile(file, 'utf8')
      const stack = drawioHistory.get(file) || []
      stack.push(text)
      while (stack.length > 60) stack.shift()
      drawioHistory.set(file, stack)
    } catch {}
  }

  function currentDrawioPath(current, root) {
    return current.drawioFile && current.drawioFile.trim()
      ? current.drawioFile.trim()
      : path.join(root, '项目关系图.drawio')
  }

  /** 把内存里的画布写回 .drawio（这是"这份图"的文件）。 */
  async function writeCanvas(graph, current, active) {
    const file = currentDrawioPath(current, active.root)
    await fsp.mkdir(path.dirname(file), { recursive: true })
    await pushHistory(file)
    await fsp.writeFile(file, buildDrawio(graph.flowNodes || [], graph.flows || [], graph.flowPositions || {}, graph.groups || {}), 'utf8')
    current.drawioFile = file
    try {
      const info = await fsp.stat(file)
      graph.drawioMtime = info.mtimeMs
    } catch {
      graph.drawioMtime = 0
    }
  }

  function nodeIds(graph) {
    return new Set((graph.flowNodes || []).map((node) => node.id))
  }

  function nextNodeId(graph) {
    const used = nodeIds(graph)
    let seq = Number(graph.flowSeq) || 0
    let id
    do {
      seq += 1
      id = 'n' + seq
    } while (used.has(id))
    graph.flowSeq = seq
    return id
  }

  function nextEdgeId(graph) {
    let seq = Number(graph.edgeSeq) || 0
    let id
    do {
      seq += 1
      id = 'fe' + seq
    } while ((graph.flows || []).some((flow) => flow.id === id))
    graph.edgeSeq = seq
    return id
  }

  /** 干净的节点 id：前端可能带 f: 前缀，统一剥掉。 */
  function bareId(value) {
    const id = String(value || '')
    return id.indexOf('f:') === 0 ? id.slice(2) : id
  }

  function resolveNode(graph, body) {
    const id = bareId(body && body.id)
    if (id) return (graph.flowNodes || []).find((node) => node.id === id) || null
    const name = String((body && body.name) || '').trim()
    if (!name) return null
    return (graph.flowNodes || []).find((node) => node.name === name) || null
  }

  function freeSpot(graph, w, h) {
    const taken = Object.values(graph.flowPositions || {}).filter(Boolean)
    const width = w || 170
    const height = h || 60
    const free = (x, y) => !taken.some((pos) => Math.abs(pos.x - x) < width && Math.abs(pos.y - y) < height)
    for (let row = 0; row < 40; row += 1) {
      for (let col = 0; col < 12; col += 1) {
        const x = 60 + col * 220
        const y = 60 + row * 90
        if (free(x, y)) return { x, y }
      }
    }
    return { x: 60 + taken.length * 24, y: 60 + taken.length * 24 }
  }

  function ensureCanvas(graph) {
    if (!Array.isArray(graph.flowNodes)) graph.flowNodes = []
    if (!Array.isArray(graph.flows)) graph.flows = []
    if (!graph.flowPositions || typeof graph.flowPositions !== 'object') graph.flowPositions = {}
    if (!graph.drags || typeof graph.drags !== 'object') graph.drags = {}
    if (!graph.nodeNotes || typeof graph.nodeNotes !== 'object') graph.nodeNotes = {}
    if (!graph.groups || typeof graph.groups !== 'object') graph.groups = {}
  }

  /** 端口名：数组 → 去空、截断；不是数组就空。 */
  function cleanPorts(value) {
    if (!Array.isArray(value)) return []
    const out = []
    for (const item of value) {
      const label = String(item ?? '').trim().slice(0, 60)
      out.push(label)
    }
    return out.slice(0, 24)
  }

  /** 节点组内部数据清洗（客户端是内部编辑的唯一作者，这里只做结构兜底）。 */
  function cleanGroup(raw, id, fallbackName) {
    const source = raw && typeof raw === 'object' ? raw : {}
    const inputs = cleanPorts(source.inputs)
    const outputs = cleanPorts(source.outputs)
    const nodeMap = new Map()
    for (const node of Array.isArray(source.nodes) ? source.nodes : []) {
      if (!node || typeof node !== 'object') continue
      const nodeId = String(node.id || '').trim()
      if (!nodeId || nodeMap.has(nodeId)) continue
      const kind = node.kind === 'input' || node.kind === 'output' || node.kind === 'group' ? node.kind : 'node'
      nodeMap.set(nodeId, {
        id: nodeId,
        name: String(node.name || nodeId).slice(0, 300),
        kind,
        x: Math.round(Number(node.x) || 0),
        y: Math.round(Number(node.y) || 0),
        inputs: kind === 'input' ? [] : cleanPorts(node.inputs),
        outputs: kind === 'output' ? [] : cleanPorts(node.outputs),
      })
    }
    // 组输入/组输出是保留节点：端口跟着组外部端口走。
    const prevIn = nodeMap.get('gin') || {}
    const prevOut = nodeMap.get('gout') || {}
    nodeMap.set('gin', { id: 'gin', name: '组输入', kind: 'input', x: prevIn.x ?? -80, y: prevIn.y ?? 120, inputs: [], outputs: inputs.slice() })
    nodeMap.set('gout', { id: 'gout', name: '组输出', kind: 'output', x: prevOut.x ?? 620, y: prevOut.y ?? 120, inputs: outputs.slice(), outputs: [] })
    const nodes = [...nodeMap.values()]
    const ids = new Set(nodes.map((node) => node.id))
    const flows = []
    for (const flow of Array.isArray(source.flows) ? source.flows : []) {
      if (!flow || !flow.fromId || !flow.toId) continue
      if (!ids.has(String(flow.fromId)) || !ids.has(String(flow.toId))) continue
      flows.push({
        id: String(flow.id || 'ge' + flows.length).slice(0, 60),
        fromId: String(flow.fromId),
        toId: String(flow.toId),
        fromPort: Math.max(0, Math.round(Number(flow.fromPort) || 0)),
        toPort: Math.max(0, Math.round(Number(flow.toPort) || 0)),
        verb: String(flow.verb || '').slice(0, 120),
      })
    }
    const notes = {}
    for (const [name, text] of Object.entries(source.notes && typeof source.notes === 'object' ? source.notes : {})) {
      if (String(text || '').trim()) notes[String(name).slice(0, 300)] = String(text)
    }
    const view = {}
    if (source.view && typeof source.view === 'object') {
      view.x = Math.round(Number(source.view.x) || 0)
      view.y = Math.round(Number(source.view.y) || 0)
      view.k = Math.min(4, Math.max(0.15, Number(source.view.k) || 1))
    }
    // 节点组自己的备注（和组内节点、和外部同名节点都不互通）
    const note = String(source.note || '').slice(0, 4000)
    return { id, name: String(source.name || fallbackName || '节点组').slice(0, 300), note, inputs, outputs, nodes, flows, notes, view }
  }

  /** 删节点组：画板上、各级组里、连线里都要清掉。 */
  function dropGroupEverywhere(graph, id) {
    delete graph.groups[id]
    graph.flowNodes = (graph.flowNodes || []).filter((node) => node.id !== id)
    graph.flows = (graph.flows || []).filter((flow) => flow.fromId !== id && flow.toId !== id)
    if (graph.flowPositions) delete graph.flowPositions[id]
    if (graph.drags) delete graph.drags[id]
    for (const group of Object.values(graph.groups || {})) {
      group.nodes = (group.nodes || []).filter((node) => !(node.kind === 'group' && node.id === id))
      group.flows = (group.flows || []).filter((flow) => flow.fromId !== id && flow.toId !== id)
    }
  }

  function renameGroupEverywhere(graph, id, name) {
    const node = (graph.flowNodes || []).find((item) => item.id === id)
    if (node) node.name = name
    const group = graph.groups[id]
    if (group) group.name = name
    for (const other of Object.values(graph.groups)) {
      for (const inner of other.nodes || []) if (inner.kind === 'group' && inner.id === id) inner.name = name
    }
  }

  /** 框选几个节点 → 收进一个节点组：节点移进组里，跨边界的线自动变成组的输入/输出端口。
   *  parentId 为空 = 在主画布上收；填了 = 在那一级组里收成子组。 */
  function wrapSelection(graph, parentId, ids, name, wantX, wantY) {
    ensureCanvas(graph)
    const parent = parentId && graph.groups[parentId] ? graph.groups[parentId] : null
    const scopeNodes = parent ? parent.nodes : graph.flowNodes
    const scopeFlows = parent ? parent.flows : graph.flows
    const selected = new Set((Array.isArray(ids) ? ids : []).map(bareId).filter(Boolean))
    const reserved = new Set(['gin', 'gout'])
    const moving = scopeNodes.filter((node) => selected.has(node.id) && !reserved.has(node.id))
    if (moving.length === 0) return null
    const movingIds = new Set(moving.map((node) => node.id))
    const posOf = (node) => parent ? { x: Number(node.x) || 0, y: Number(node.y) || 0 } : (graph.flowPositions[node.id] || { x: 80, y: 80 })

    let minX = Infinity
    let minY = Infinity
    let maxX = -Infinity
    let maxY = -Infinity
    for (const node of moving) {
      const pos = posOf(node)
      minX = Math.min(minX, pos.x)
      minY = Math.min(minY, pos.y)
      maxX = Math.max(maxX, pos.x + 200)
      maxY = Math.max(maxY, pos.y + 60)
    }

    let groupName = String(name || '').trim().slice(0, 300)
    if (!groupName) {
      let index = Object.keys(graph.groups).length + 1
      while (Object.values(graph.groups).some((group) => group.name === '节点组 ' + index)) index += 1
      groupName = '节点组 ' + index
    }
    const gid = nextNodeId(graph)
    const groupX = Number.isFinite(Number(wantX)) ? Math.round(Number(wantX)) : Math.round(minX)
    const groupY = Number.isFinite(Number(wantY)) ? Math.round(Number(wantY)) : Math.round(minY)

    const inputs = []
    const outputs = []
    const internalFlows = []
    const externalFlows = []
    let seq = 0
    const newEdgeId = () => 'ge' + Date.now().toString(36) + (seq++)
    const nameOf = (id) => (scopeNodes.find((node) => node.id === id) || {}).name || ''

    for (const flow of scopeFlows || []) {
      const fromIn = movingIds.has(flow.fromId)
      const toIn = movingIds.has(flow.toId)
      if (fromIn && toIn) {
        internalFlows.push({ ...flow })
        continue
      }
      if (!fromIn && !toIn) {
        externalFlows.push(flow)
        continue
      }
      const verb = String(flow.verb || '')
      if (toIn) {
        // 外 → 里：变成组的一个输入端口
        const label = (verb || nameOf(flow.fromId) || '输入').slice(0, 60)
        let index = inputs.indexOf(label)
        if (index < 0) {
          inputs.push(label)
          index = inputs.length - 1
        }
        internalFlows.push({ id: newEdgeId(), fromId: 'gin', fromPort: index, toId: flow.toId, toPort: Math.max(0, Number(flow.toPort) || 0), verb })
        externalFlows.push({ id: flow.id, fromId: flow.fromId, fromPort: Math.max(0, Number(flow.fromPort) || 0), toId: gid, toPort: index, verb })
      } else {
        // 里 → 外：变成组的一个输出端口
        const label = (verb || nameOf(flow.toId) || '输出').slice(0, 60)
        let index = outputs.indexOf(label)
        if (index < 0) {
          outputs.push(label)
          index = outputs.length - 1
        }
        internalFlows.push({ id: newEdgeId(), fromId: flow.fromId, fromPort: Math.max(0, Number(flow.fromPort) || 0), toId: 'gout', toPort: index, verb })
        externalFlows.push({ id: flow.id, fromId: gid, fromPort: index, toId: flow.toId, toPort: Math.max(0, Number(flow.toPort) || 0), verb })
      }
    }

    const inPorts = inputs.length > 0 ? inputs : ['输入']
    const outPorts = outputs.length > 0 ? outputs : ['输出']
    const innerNodes = moving.map((node) => {
      const pos = posOf(node)
      const kind = node.kind === 'group' ? 'group' : 'node'
      // 节点组节点：端口以它自己的组定义为准（顶层节点记录里不带 ports）
      const def = kind === 'group' ? graph.groups[node.id] : null
      return {
        id: node.id,
        name: node.name,
        kind,
        x: Math.round(pos.x - groupX),
        y: Math.round(pos.y - groupY),
        inputs: Array.isArray(node.inputs) ? node.inputs : (def && Array.isArray(def.inputs) ? def.inputs : ['输入']),
        outputs: Array.isArray(node.outputs) ? node.outputs : (def && Array.isArray(def.outputs) ? def.outputs : ['输出']),
      }
    })

    graph.groups[gid] = {
      id: gid,
      name: groupName,
      note: '',
      inputs: inPorts,
      outputs: outPorts,
      nodes: [
        { id: 'gin', name: '组输入', kind: 'input', x: -240, y: 0, inputs: [], outputs: inPorts.slice() },
        { id: 'gout', name: '组输出', kind: 'output', x: Math.round(maxX - groupX + 120), y: 0, inputs: outPorts.slice(), outputs: [] },
        ...innerNodes,
      ],
      flows: internalFlows,
      notes: {},
      view: {},
    }

    if (parent) {
      parent.nodes = parent.nodes.filter((node) => !movingIds.has(node.id))
      parent.nodes.push({ id: gid, name: groupName, kind: 'group', x: groupX, y: groupY, inputs: inPorts.slice(), outputs: outPorts.slice() })
      parent.flows = externalFlows
    } else {
      graph.flowNodes = graph.flowNodes.filter((node) => !movingIds.has(node.id))
      graph.flowNodes.push({ id: gid, name: groupName, kind: 'group' })
      graph.flowPositions[gid] = { x: groupX, y: groupY }
      graph.flows = externalFlows
      for (const id of movingIds) {
        delete graph.flowPositions[id]
        delete graph.drags[id]
      }
    }
    return gid
  }

  /** 解散节点组：组内节点放回上一层，跨边界的线按端口接回外部，组数据删掉。 */
  function ungroupNode(graph, groupId) {
    ensureCanvas(graph)
    const group = graph.groups[groupId]
    if (!group) return null
    // 找到它所在的作用域：顶层画布，或某个父组
    let parent = null
    for (const other of Object.values(graph.groups)) {
      if (other.id === groupId) continue
      if ((other.nodes || []).some((node) => node.kind === 'group' && node.id === groupId)) {
        parent = other
        break
      }
    }
    const scopeNodes = parent ? parent.nodes : graph.flowNodes
    const scopeFlows = parent ? parent.flows : graph.flows
    const groupNode = scopeNodes.find((node) => node.id === groupId)
    if (!groupNode) return null
    const basePos = parent
      ? { x: Number(groupNode.x) || 0, y: Number(groupNode.y) || 0 }
      : (() => {
          const base = graph.flowPositions[groupId] || { x: 80, y: 80 }
          const delta = graph.drags[groupId] || { dx: 0, dy: 0 }
          return { x: base.x + (delta.dx || 0), y: base.y + (delta.dy || 0) }
        })()

    const inEdges = new Map()
    const outEdges = new Map()
    const keepFlows = []
    for (const flow of scopeFlows || []) {
      if (flow.toId === groupId) {
        const list = inEdges.get(Number(flow.toPort) || 0) || []
        list.push(flow)
        inEdges.set(Number(flow.toPort) || 0, list)
      } else if (flow.fromId === groupId) {
        const list = outEdges.get(Number(flow.fromPort) || 0) || []
        list.push(flow)
        outEdges.set(Number(flow.fromPort) || 0, list)
      } else {
        keepFlows.push(flow)
      }
    }

    let seq = 0
    const newEdgeId = () =>
      parent ? 'ge' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6) + seq++ : nextEdgeId(graph)
    const added = []
    for (const flow of group.flows || []) {
      if (flow.fromId === 'gin') {
        for (const outer of inEdges.get(Number(flow.fromPort) || 0) || []) {
          added.push({
            id: newEdgeId(),
            fromId: outer.fromId,
            fromPort: Math.max(0, Number(outer.fromPort) || 0),
            toId: flow.toId,
            toPort: Math.max(0, Number(flow.toPort) || 0),
            verb: outer.verb || flow.verb || '',
          })
        }
      } else if (flow.toId === 'gout') {
        for (const outer of outEdges.get(Number(flow.toPort) || 0) || []) {
          added.push({
            id: newEdgeId(),
            fromId: flow.fromId,
            fromPort: Math.max(0, Number(flow.fromPort) || 0),
            toId: outer.toId,
            toPort: Math.max(0, Number(outer.toPort) || 0),
            verb: outer.verb || flow.verb || '',
          })
        }
      } else {
        added.push({ ...flow })
      }
    }

    const inner = (group.nodes || []).filter((node) => node.id !== 'gin' && node.id !== 'gout')
    if (parent) {
      parent.nodes = scopeNodes
        .filter((node) => node.id !== groupId)
        .concat(inner.map((node) => ({
          ...node,
          x: Math.round(basePos.x + (Number(node.x) || 0)),
          y: Math.round(basePos.y + (Number(node.y) || 0)),
        })))
      parent.flows = keepFlows.concat(added)
    } else {
      graph.flowNodes = scopeNodes.filter((node) => node.id !== groupId)
      for (const node of inner) {
        graph.flowNodes.push({ id: node.id, name: node.name, kind: node.kind === 'group' ? 'group' : 'node' })
        graph.flowPositions[node.id] = {
          x: Math.round(basePos.x + (Number(node.x) || 0)),
          y: Math.round(basePos.y + (Number(node.y) || 0)),
        }
        delete graph.drags[node.id]
      }
      delete graph.flowPositions[groupId]
      delete graph.drags[groupId]
      graph.flows = keepFlows.concat(added)
    }
    delete graph.groups[groupId]
    return { nodes: inner.length, edges: added.length }
  }

  // 新建节点（同名节点可以有很多个，各自有 id；备注按名字共用）
  postRoute('/filegraph/node', async (req, res, body) => {
    await editGraph(res, async (graph, { current, active, entry }) => {
      ensureCanvas(graph)
      let name = String(body.name || '').trim().slice(0, 300)
      if (!name) {
        let index = (graph.flowNodes || []).length + 1
        while (graph.flowNodes.some((node) => node.name === '节点 ' + index)) index += 1
        name = '节点 ' + index
      }
      const id = nextNodeId(graph)
      graph.flowNodes.push({ id, name, kind: 'node' })
      const x = Number(body.x)
      const y = Number(body.y)
      graph.flowPositions[id] = Number.isFinite(x) && Number.isFinite(y) ? { x: Math.round(x), y: Math.round(y) } : freeSpot(graph)
      graph.updatedAt = Date.now()
      await flushGraph(entry, active.graphFile)
      await writeCanvas(graph, current, active)
      return { added: id, addedName: name }
    })
  })

  // 节点组：创建 / 保存内部 / 改名 / 删除
  postRoute('/filegraph/group', async (req, res, body) => {
    const action = String(body.action || '')
    await editGraph(res, async (graph, { current, active, entry }) => {
      ensureCanvas(graph)
      if (action === 'wrap') {
        // 框选若干节点 → 收进一个节点组（边界线自动变成组端口）
        const gid = wrapSelection(graph, String(body.parent || ''), body.ids, body.name, body.x, body.y)
        if (!gid) return fail(res, '没有可收进组里的节点')
        graph.updatedAt = Date.now()
        await flushGraph(entry, active.graphFile)
        await writeCanvas(graph, current, active)
        return { created: gid, createdName: graph.groups[gid].name, wrapped: (body.ids || []).length }
      }
      if (action === 'create') {
        let name = String(body.name || '').trim().slice(0, 300)
        if (!name) {
          let index = Object.keys(graph.groups).length + 1
          while (Object.values(graph.groups).some((group) => group.name === '节点组 ' + index)) index += 1
          name = '节点组 ' + index
        }
        const id = nextNodeId(graph)
        const parentId = String(body.parent || '')
        const x = Number(body.x)
        const y = Number(body.y)
        if (parentId && graph.groups[parentId]) {
          // 嵌套节点组：节点落在父组内部，内部数据仍然按自己的 id 存
          graph.groups[parentId].nodes.push({
            id,
            name,
            kind: 'group',
            x: Math.round(x) || 240,
            y: Math.round(y) || 60,
            inputs: ['输入'],
            outputs: ['输出'],
          })
        } else {
          graph.flowNodes.push({ id, name, kind: 'group' })
          graph.flowPositions[id] = Number.isFinite(x) && Number.isFinite(y) ? { x: Math.round(x), y: Math.round(y) } : freeSpot(graph, 200, 120)
        }
        graph.groups[id] = cleanGroup({ name, inputs: ['输入'], outputs: ['输出'] }, id, name)
        graph.updatedAt = Date.now()
        await flushGraph(entry, active.graphFile)
        await writeCanvas(graph, current, active)
        return { created: id, createdName: name }
      }
      if (action === 'ungroup') {
        const targetId = bareId(body.id)
        if (!targetId) return fail(res, 'id required')
        const result = ungroupNode(graph, targetId)
        if (!result) return fail(res, '节点组不存在：' + targetId, 404)
        graph.updatedAt = Date.now()
        await flushGraph(entry, active.graphFile)
        await writeCanvas(graph, current, active)
        return { ungrouped: result.nodes, ungroupedEdges: result.edges }
      }
      const id = bareId(body.id)
      if (!id) return fail(res, 'id required')
      if (action === 'save') {
        if (!graph.groups[id]) return fail(res, '节点组不存在：' + id, 404)
        const node = (graph.flowNodes || []).find((item) => item.id === id)
        graph.groups[id] = cleanGroup({ ...body.data, name: (body.data && body.data.name) || (node && node.name) }, id, node && node.name)
        if (node) node.name = graph.groups[id].name
        // 嵌在别的组里时，外层那个"节点组节点"的端口也要跟着改
        for (const other of Object.values(graph.groups)) {
          for (const inner of other.nodes || []) {
            if (inner.kind === 'group' && inner.id === id) {
              inner.inputs = (graph.groups[id].inputs || []).slice()
              inner.outputs = (graph.groups[id].outputs || []).slice()
            }
          }
        }
        graph.updatedAt = Date.now()
        await flushGraph(entry, active.graphFile)
        return { group: id }
      }
      if (action === 'rename') {
        const name = String(body.name || '').trim().slice(0, 300)
        if (!name) return fail(res, 'name required')
        renameGroupEverywhere(graph, id, name)
        graph.updatedAt = Date.now()
        await flushGraph(entry, active.graphFile)
        await writeCanvas(graph, current, active)
        return {}
      }
      if (action === 'delete') {
        dropGroupEverywhere(graph, id)
        graph.updatedAt = Date.now()
        await flushGraph(entry, active.graphFile)
        await writeCanvas(graph, current, active)
        return { deleted: id }
      }
      return fail(res, 'unknown action: ' + action)
    })
  })

  // 加一条关系：两端用节点 id 认，动作由人写。
  postRoute('/filegraph/edge', async (req, res, body) => {
    await editGraph(res, async (graph, { current, active, entry }) => {
      ensureCanvas(graph)
      const fromId = bareId(body.fromId) || (resolveNode(graph, { name: body.from }) || {}).id
      const toId = bareId(body.toId) || (resolveNode(graph, { name: body.to }) || {}).id
      if (!fromId || !toId) return fail(res, '两端都要有节点')
      const ids = nodeIds(graph)
      if (!ids.has(fromId) || !ids.has(toId)) return fail(res, '节点不存在', 404)
      const verb = String(body.verb || '').trim().slice(0, 120)
      const allowDup = body.allowDuplicate === true
      const dup = !allowDup && graph.flows.some((flow) => flow.fromId === fromId && flow.toId === toId && (flow.verb || '') === verb)
      if (!dup) {
        graph.flows.push({ id: nextEdgeId(graph), fromId, toId, fromPort: Math.max(0, Number(body.fromPort) || 0), toPort: Math.max(0, Number(body.toPort) || 0), verb })
        graph.flows = graph.flows.slice(-600)
      }
      graph.updatedAt = Date.now()
      await flushGraph(entry, active.graphFile)
      await writeCanvas(graph, current, active)
      return { added: !dup }
    })
  })

  postRoute('/filegraph/save', async (req, res) => {
    const current = await ensureState()
    const rows = projectRows(current)
    if (!rows[0]) {
      sendJson(res, 200, { ok: true, saved: 0 })
      return
    }
    const entry = await graphFor(rows[0].graphFile, rows[0].root)
    await flushGraph(entry, rows[0].graphFile)
    await writeJsonAtomic(stateFile(), current)
    sendJson(res, 200, { ok: true, savedAt: Date.now() })
  })

  postRoute('/filegraph/undo', async (req, res) => {
    const current = await ensureState()
    const rows = projectRows(current)
    if (!rows[0]) return fail(res, 'no active project')
    const file = currentDrawioPath(current, rows[0].root)
    const stack = drawioHistory.get(file) || []
    if (stack.length === 0) {
      sendJson(res, 200, { ok: false, error: '没有可回退的操作' })
      return
    }
    const previous = stack.pop()
    await fsp.writeFile(file, previous, 'utf8')
    const entry = await graphFor(rows[0].graphFile, rows[0].root)
    entry.graph.drawioMtime = 0
    await syncDrawio(current)
    await flushGraph(entry, rows[0].graphFile)
    sendJson(res, 200, { ok: true, undone: true, ...(await payloadFor(current, rows[0].root)) })
  })

  // 剪刀：按 id（或两端）删掉关系
  postRoute('/filegraph/remove-edge', async (req, res, body) => {
    const wanted = Array.isArray(body.edges) ? body.edges : []
    await editGraph(res, async (graph, { current, active, entry }) => {
      const before = (graph.flows || []).length
      graph.flows = (graph.flows || []).filter((flow) => {
        return !wanted.some((item) => {
          if (!item) return false
          if (item.id && flow.id) return item.id === flow.id
          const fromId = bareId(item.fromId)
          const toId = bareId(item.toId)
          if (fromId && toId) {
            if (flow.fromId !== fromId || flow.toId !== toId) return false
            const verb = String(item.verb || '')
            return verb ? verb === (flow.verb || '') : true
          }
          return false
        })
      })
      const removed = before - graph.flows.length
      graph.updatedAt = Date.now()
      await flushGraph(entry, active.graphFile)
      if (removed > 0) await writeCanvas(graph, current, active)
      return { removed }
    })
  })

  // 给关系改名（动作词）；verb 存原样，空 = 没名字
  postRoute('/filegraph/rename-edge', async (req, res, body) => {
    await editGraph(res, async (graph, { current, active, entry }) => {
      const verb = String(body.verb || '').trim().slice(0, 120)
      const id = String(body.id || '')
      const fromId = bareId(body.fromId)
      const toId = bareId(body.toId)
      const oldVerb = String(body.oldVerb || '')
      let hit = 0
      graph.flows = (graph.flows || []).map((flow) => {
        if (id) {
          if (flow.id !== id) return flow
        } else if (flow.fromId !== fromId || flow.toId !== toId) return flow
        if (!id && oldVerb && (flow.verb || '') !== oldVerb) return flow
        hit += 1
        return { ...flow, verb }
      })
      if (hit === 0) return fail(res, '没有匹配到这条关系', 404)
      graph.updatedAt = Date.now()
      await flushGraph(entry, active.graphFile)
      await writeCanvas(graph, current, active)
      return { renamed: hit }
    })
  })

  // 重命名节点：只改这个节点实例的名字；备注等数据按名字存，所以同名节点共享同一份
  postRoute('/filegraph/rename-node', async (req, res, body) => {
    const id = bareId(body.id)
    const name = String(body.name || body.to || '').trim().slice(0, 300)
    if (!name) return fail(res, '新名字不能为空')
    await editGraph(res, async (graph, { current, active, entry }) => {
      ensureCanvas(graph)
      let hit = 0
      if (id) {
        const node = graph.flowNodes.find((item) => item.id === id)
        if (!node) return fail(res, '节点不存在', 404)
        node.name = name
        hit = 1
      } else {
        const from = String(body.from || '')
        for (const node of graph.flowNodes) {
          if (node.name === from) {
            node.name = name
            hit += 1
          }
        }
      }
      if (hit === 0) return fail(res, '没有匹配到节点', 404)
      graph.updatedAt = Date.now()
      await flushGraph(entry, active.graphFile)
      await writeCanvas(graph, current, active)
      return { renamed: hit }
    })
  })

  // 删除节点：连带删掉它的所有连线
  postRoute('/filegraph/remove-node', async (req, res, body) => {
    await editGraph(res, async (graph, { current, active, entry }) => {
      ensureCanvas(graph)
      const id = bareId(body.id)
      const name = String(body.name || '').trim()
      const targets = id
        ? graph.flowNodes.filter((node) => node.id === id)
        : graph.flowNodes.filter((node) => node.name === name)
      if (targets.length === 0) return fail(res, '节点不存在', 404)
      for (const node of targets) {
        if (node.kind === 'group') dropGroupEverywhere(graph, node.id)
      }
      const gone = new Set(targets.map((node) => node.id))
      graph.flowNodes = graph.flowNodes.filter((node) => !gone.has(node.id))
      graph.flows = graph.flows.filter((flow) => !gone.has(flow.fromId) && !gone.has(flow.toId))
      for (const nodeId of gone) {
        delete graph.flowPositions[nodeId]
        delete graph.drags[nodeId]
      }
      graph.updatedAt = Date.now()
      await flushGraph(entry, active.graphFile)
      await writeCanvas(graph, current, active)
      return { removed: gone.size }
    })
  })

  // 节点备注：这个节点是干什么用的（按名字存，同名节点看到的是同一份）
  postRoute('/filegraph/note', async (req, res, body) => {
    const name = String(body.name || '').trim()
    if (!name) return fail(res, 'name required')
    await editGraph(res, async (graph, { entry, active }) => {
      ensureCanvas(graph)
      const text = String(body.text || '').trim()
      if (text) graph.nodeNotes[name] = text
      else delete graph.nodeNotes[name]
      graph.updatedAt = Date.now()
      await flushGraph(entry, active.graphFile)
      return {}
    })
  })

  // 复制节点：同名的第二个落点（数据按名字共用，但各有各的 id 和连线）
  postRoute('/filegraph/duplicate', async (req, res, body) => {
    await editGraph(res, async (graph, { current, active, entry }) => {
      ensureCanvas(graph)
      const source = resolveNode(graph, body)
      if (!source) return fail(res, '节点不存在', 404)
      const id = nextNodeId(graph)
      graph.flowNodes.push({ id, name: source.name, kind: source.kind || 'node' })
      const base = (graph.flowPositions || {})[source.id] || { x: 80, y: 80 }
      graph.flowPositions[id] = { x: base.x + 50, y: base.y + 50 }
      if (source.kind === 'group' && graph.groups[source.id]) {
        const copy = JSON.parse(JSON.stringify(graph.groups[source.id]))
        copy.id = id
        graph.groups[id] = copy
      }
      graph.updatedAt = Date.now()
      await flushGraph(entry, active.graphFile)
      await writeCanvas(graph, current, active)
      return { copy: id, copyName: source.name }
    })
  })

  // 用插件自己把"图上的关系"写成一份文档（写法与画布一致：A --动作--> B）
  function buildRelationDoc(graph, drawioPath) {
    const nodes = graph.flowNodes || []
    const byId = new Map(nodes.map((node) => [node.id, node]))
    const flows = graph.flows || []
    const groups = graph.groups || {}
    const notes = graph.nodeNotes || {}
    const nameOf = (id, ports, index) => {
      const node = byId.get(id)
      if (!node) return id
      const list = ports === 'in' ? groups[id] && groups[id].inputs : ports === 'out' ? groups[id] && groups[id].outputs : null
      const label = list && list[index]
      return node.name + (label !== undefined && label !== '' ? '.' + label : '')
    }
    const out = []
    out.push('# 关系')
    out.push('')
    out.push('> 由关系插件自动生成，写法与画布一致：`A --动作--> B`。')
    out.push('> 源文件：' + (drawioPath || '(未指定)'))
    out.push('> 生成时间：' + new Date().toLocaleString('zh-CN'))
    out.push('')
    out.push('## 关系')
    out.push('')
    if (flows.length === 0) out.push('（还没有关系）')
    else {
      for (const flow of flows) {
        const from = byId.get(flow.fromId)
        const to = byId.get(flow.toId)
        if (!from || !to) continue
        out.push('    ' + nameOf(flow.fromId, 'out', flow.fromPort || 0) + ' --' + (flow.verb || '') + '--> ' + nameOf(flow.toId, 'in', flow.toPort || 0))
      }
    }
    out.push('')
    const groupIds = Object.keys(groups)
    if (groupIds.length > 0) {
      out.push('## 节点组')
      out.push('')
      for (const id of groupIds) {
        const group = groups[id]
        const node = byId.get(id)
        out.push('### ' + (group.name || (node && node.name) || id))
        out.push('')
        out.push('- 输入：' + ((group.inputs || []).length ? group.inputs.join('、') : '（无）'))
        out.push('- 输出：' + ((group.outputs || []).length ? group.outputs.join('、') : '（无）'))
        out.push('- 内部节点：' + (group.nodes || []).map((item) => item.name).join('、'))
        for (const flow of group.flows || []) {
          const from = (group.nodes || []).find((item) => item.id === flow.fromId)
          const to = (group.nodes || []).find((item) => item.id === flow.toId)
          if (!from || !to) continue
          out.push('    ' + from.name + ' --' + (flow.verb || '') + '--> ' + to.name)
        }
        out.push('')
      }
    }
    const noteKeys = Object.keys(notes).filter((key) => String(notes[key] || '').trim())
    if (noteKeys.length > 0) {
      out.push('## 节点说明')
      out.push('')
      for (const key of noteKeys) {
        out.push('### ' + key)
        out.push('')
        out.push(String(notes[key]).trim())
        out.push('')
      }
    }
    return out.join('\n')
  }

  postRoute('/filegraph/export-md', async (req, res, body) => {
    const current = await ensureState()
    const rows = projectRows(current)
    if (!rows[0]) return fail(res, 'no active project')
    const entry = await graphFor(rows[0].graphFile, rows[0].root)
    const drawioPath = currentDrawioPath(current, rows[0].root)
    const outPath = String(body.path || '').trim() || path.join(path.dirname(drawioPath), '关系.md')
    const text = buildRelationDoc(entry.graph, drawioPath)
    await fsp.mkdir(path.dirname(outPath), { recursive: true })
    await fsp.writeFile(outPath, text, 'utf8')
    sendJson(res, 200, { ok: true, exported: outPath, lines: text.split('\n').length })
  })
  // 运行关系：脚本→(激活)→main→(写入数值)→a文件 —— 带动作的边由人/模型标出来，不靠猜。
  postRoute(FLOW_ROUTE, async (req, res, body) => {
    const current = await ensureState()
    const rows = projectRows(current)
    const target = typeof body.root === 'string' && body.root ? rows.find((row) => row.root === body.root) : rows[0]
    if (!target) {
      sendJson(res, 200, { ok: true, flows: [] })
      return
    }
    const entry = await graphFor(target.graphFile, target.root)
    const graph = entry.graph
    ensureCanvas(graph)
    const incoming = []
    for (const raw of Array.isArray(body.flows) ? body.flows : []) {
      const fromId = raw && typeof raw.fromId === 'string' ? bareId(raw.fromId) : (resolveNode(graph, { name: raw && raw.from }) || {}).id
      const toId = raw && typeof raw.toId === 'string' ? bareId(raw.toId) : (resolveNode(graph, { name: raw && raw.to }) || {}).id
      const verb = raw && typeof raw.verb === 'string' ? raw.verb.trim() : ''
      if (!fromId || !toId) continue
      incoming.push({ id: nextEdgeId(graph), fromId, toId, fromPort: 0, toPort: 0, verb })
    }
    const base = body.replace === true ? [] : graph.flows ?? []
    const seen = new Set()
    const flows = []
    for (const flow of [...base, ...incoming]) {
      const key = flow.fromId + '|' + flow.toId + '|' + (flow.verb || '')
      if (seen.has(key)) continue
      seen.add(key)
      flows.push(flow)
    }
    graph.flows = flows.slice(-600)
    graph.updatedAt = Date.now()
    await flushGraph(entry, target.graphFile)
    await writeCanvas(graph, current, target)
    current.projects[target.root] = {
      graphFile: target.graphFile,
      updatedAt: graph.updatedAt,
      nodeCount: Object.keys(graph.nodes).length,
    }
    scheduleStateSave()
    sendJson(res, 200, { ok: true, flows: graph.flows, ...(await payloadFor(current, target.root)) })
  })

  // 从 .drawio 导入运行关系（显式动作：画布改了不会自动同步）。
  postRoute(IMPORT_ROUTE, async (req, res, body) => {
    const current = await ensureState()
    const rows = projectRows(current)
    const target = typeof body.root === 'string' && body.root ? rows.find((row) => row.root === body.root) : rows[0]
    if (!target) return fail(res, '还没有项目记录')
    const filePath = typeof body.path === 'string' && body.path.trim() ? body.path.trim() : ''
    if (!filePath) return fail(res, 'path required')
    let text = ''
    try {
      text = await fsp.readFile(filePath, 'utf8')
    } catch (error) {
      sendJson(res, 400, { ok: false, error: '读不到文件：' + messageOf(error) })
      return
    }
    const parsed = parseDrawio(text)
    if (parsed.flows.length === 0 && !/<mxCell/.test(text)) return fail(res, '这个 .drawio 里没解析出带两端的连线')
    const entry = await graphFor(target.graphFile, target.root)
    const graph = entry.graph
    reconcileCanvas(graph, parsed)
    graph.updatedAt = Date.now()
    await flushGraph(entry, target.graphFile)
    current.projects[target.root] = {
      graphFile: target.graphFile,
      updatedAt: graph.updatedAt,
      nodeCount: Object.keys(graph.nodes).length,
    }
    scheduleStateSave()
    sendJson(res, 200, {
      ok: true,
      imported: parsed.flows.length,
      nodeCount: parsed.nodeCount,
      ...(await payloadFor(current, target.root)),
    })
  })

  // 打开对话框用的目录浏览：返回子目录 + .drawio（模仿 Blender 的文件浏览）。
  anyRoute('/filegraph/list', async (req, res) => {
    const current = await ensureState()
    const rows = projectRows(current)
    const fallback = rows[0] ? rows[0].root : process.cwd()
    const url = new URL(req.url ?? '/filegraph/list', 'http://127.0.0.1')
    const requested = url.searchParams.get('path')
    const dir = requested && requested.trim() ? path.resolve(requested.trim()) : fallback
    let entries = []
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true })
    } catch {
      entries = []
    }
    const dirs = []
    const files = []
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        dirs.push({ name: entry.name, path: full, isDir: true, mtime: 0, size: 0 })
        continue
      }
      // 只列当前动作需要的类型：打开/另存为 → .drawio；导出关系文档 → .md
      const wantExt = (url.searchParams.get('ext') || 'drawio').toLowerCase()
      const fileExt = (entry.name.split('.').pop() || '').toLowerCase()
      if (fileExt !== wantExt) continue
      let mtime = 0
      let size = 0
      try {
        const info = await fsp.stat(full)
        mtime = info.mtimeMs
        size = info.size
      } catch {}
      files.push({ name: entry.name, path: full, isDir: false, mtime, size })
    }
    dirs.sort((a, b) => a.name.localeCompare(b.name))
    files.sort((a, b) => b.mtime - a.mtime)
    sendJson(res, 200, {
      ok: true,
      dir,
      parent: path.dirname(dir),
      entries: [...dirs.slice(0, 200), ...files.slice(0, 200)],
    })
  })

  // 手拖只存"相对画布的矢量"，画布重排后再叠加也不跑偏。
  postRoute(DRAG_ROUTE, async (req, res, body) => {
    const current = await ensureState()
    const rows = projectRows(current)
    const active = rows[0]
    if (!active) return fail(res, 'no active project')
    const entry = await graphFor(active.graphFile, active.root)
    const graph = entry.graph
    if (!graph.drags || typeof graph.drags !== 'object') graph.drags = {}
    if (body.reset === true) {
      graph.drags = {}
    } else {
      const list = Array.isArray(body.entries) ? body.entries : body.id ? [body] : []
      for (const item of list) {
        if (!item || typeof item.id !== 'string') continue
        const dx = Math.round(Number(item.dx) || 0)
        const dy = Math.round(Number(item.dy) || 0)
        if (dx === 0 && dy === 0) delete graph.drags[item.id]
        else graph.drags[item.id] = { dx, dy }
      }
    }
    graph.updatedAt = Date.now()
    await flushGraph(entry, active.graphFile)
    sendJson(res, 200, { ok: true, drags: graph.drags })
  })

  // 文件菜单：打开 / 恢复 / 另存为 / 保存副本（借 Blender 的"文档即文件"用法）
  postRoute(OPEN_ROUTE, async (req, res, body) => {
    const target = String(body.path || '').trim()
    if (!target) return fail(res, 'path required')
    const current = await ensureState()
    const exists = await fsp.stat(target).then(() => true).catch(() => false)
    if (!exists) return fail(res, '文件不存在：' + target, 404)
    current.drawioFile = target
    const rows = projectRows(current)
    if (rows[0]) {
      const entry = await graphFor(rows[0].graphFile, rows[0].root)
      entry.graph.drawioMtime = 0
    }
    await syncDrawio(current)
    await writeJsonAtomic(stateFile(), current)
    sendJson(res, 200, { ok: true, opened: target, warning: (((await payloadFor(current, rows[0] ? rows[0].root : undefined)).flows || []).length === 0 ? '这个文件里还没有关系' : ''), ...(await payloadFor(current, rows[0] ? rows[0].root : undefined)) })
  })

  postRoute(EXPORT_ROUTE, async (req, res, body) => {
    const outPath = String(body.path || '').trim()
    if (!outPath) return fail(res, 'path required')
    const current = await ensureState()
    const rows = projectRows(current)
    const active = rows[0]
    const entry = active ? await graphFor(active.graphFile, active.root) : null
    if (!entry) return fail(res, '还没有项目记录')
    ensureCanvas(entry.graph)
    if ((entry.graph.flowNodes || []).length === 0) return fail(res, '当前还没有节点可导出')
    await fsp.writeFile(outPath, buildDrawio(entry.graph.flowNodes, entry.graph.flows, entry.graph.flowPositions, entry.graph.groups), 'utf8')
    if (body.switchTo === true) {
      current.drawioFile = outPath
      entry.graph.drawioMtime = 0
      await syncDrawio(current)
      await writeJsonAtomic(stateFile(), current)
    }
    sendJson(res, 200, { ok: true, exported: outPath, nodes: entry.graph.flowNodes.length, flows: (entry.graph.flows || []).length })
  })
  // 卸载时把还没落盘的图写完，别丢最后几次写入。
  ctx.effect(() => () => {
    for (const [file, entry] of graphs) void flushGraph(entry, file)
  })
}
