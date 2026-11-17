// 渲染冒烟测试：用真 React 把面板渲一遍（open=true + 假数据），确认压缩没把 UI 弄断。
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'

const reactDir = process.argv[2]
const requireFromReact = createRequire(path.join(reactDir, 'noop.js'))
const React = requireFromReact('react')
const { renderToStaticMarkup } = requireFromReact('react-dom/server')

const groupId = 'n3'
const fixture = {
  ok: true,
  active: { root: 'D:\\demo', graphFile: 'D:\\demo\\graph.json', updatedAt: 1, nodeCount: 2 },
  settings: { graphFile: 'D:\\demo\\graph.json', drawioFile: 'D:\\demo\\鱼功能设计.drawio' },
  nodes: [
    { path: 'a.js', name: 'a.js', dir: '', writes: 2, reads: 1, size: 100, ext: 'js' },
    { path: 'b.js', name: 'b.js', dir: '', writes: 0, reads: 3, size: 200, ext: 'js' },
  ],
  windows: [{ id: 'sess', index: 1, label: '输入窗口', group: '输入端口', writes: 1, reads: 2, inputs: [], outputs: [] }],
  sources: [{ key: 'MCP · bili', label: 'MCP · bili', count: 2 }],
  edges: [
    { from: 'file:a.js', to: 'file:b.js', kind: 'ref', evidence: { line: 1, snippet: "import b from './b.js'", role: 'import' } },
    { from: 'win:sess', to: 'file:a.js', kind: 'out' },
  ],
  flowNodes: [
    { id: 'n1', name: '启动脚本', kind: 'node' },
    { id: 'n2', name: 'main', kind: 'node' },
    { id: groupId, name: '节点组 1', kind: 'group' },
    { id: 'n4', name: 'main', kind: 'node' },
  ],
  flows: [
    { id: 'fe1', fromId: 'n1', toId: 'n2', fromPort: 0, toPort: 0, verb: '激活' },
    { id: 'fe2', fromId: 'n2', toId: groupId, fromPort: 0, toPort: 0, verb: '写入数值' },
  ],
  flowPositions: { n1: { x: 40, y: 40 }, n2: { x: 300, y: 40 }, [groupId]: { x: 560, y: 40 }, n4: { x: 300, y: 160 } },
  drags: {},
  nodeNotes: { main: '入口文件' },
  groups: {
    [groupId]: {
      id: groupId,
      name: '节点组 1',
      inputs: ['密度', '随机种'],
      outputs: ['网格'],
      nodes: [
        { id: 'gin', name: '组输入', kind: 'input', x: 0, y: 120, inputs: [], outputs: ['密度', '随机种'] },
        { id: 'gout', name: '组输出', kind: 'output', x: 620, y: 120, inputs: ['网格'], outputs: [] },
        { id: 'gn1', name: '分布点', kind: 'node', x: 260, y: 120, inputs: ['体积'], outputs: ['点'] },
      ],
      flows: [
        { id: 'ge1', fromId: 'gin', toId: 'gn1', fromPort: 1, toPort: 0, verb: '随机种' },
        { id: 'ge2', fromId: 'gn1', toId: 'gout', fromPort: 0, toPort: 0, verb: '点' },
      ],
      notes: {},
      view: {},
    },
  },
  positions: { 'file:a.js': { x: 10, y: 10 } },
  projects: [{ root: 'D:\\demo', graphFile: 'D:\\demo\\graph.json', nodeCount: 2 }],
}

const listeners = {}
global.window = {
  innerWidth: 1400,
  innerHeight: 900,
  addEventListener: (k, fn) => { listeners[k] = fn },
  removeEventListener: () => {},
  __FIXTURE__: fixture,
  __ModuleLoader__: {
    load(def) {
      global.__fgDef = def
    },
  },
}

const raw = fs.readFileSync(new URL('../client.js', import.meta.url), 'utf8')

function render(extraPatch, label) {
  let src = raw
    .replace('      open: false,', '      open: true,')
    .replace('      data: null,', '      data: window.__FIXTURE__ || null,')
  if (extraPatch) src = extraPatch(src)
  if (!src.includes('open: true')) throw new Error('patch 失败：找不到 open: false')
  const fn = new Function('window', 'fetch', 'setTimeout', 'clearTimeout', src)
  fn(global.window, () => Promise.resolve({ json: () => Promise.resolve(fixture) }), setTimeout, clearTimeout)
  const def = global.__fgDef
  if (!def || typeof def.factory !== 'function') throw new Error('模块没加载')
  const mod = def.factory((name) => {
    if (name === 'react') return React
    throw new Error('unexpected require: ' + name)
  })
  const ctx = {
    effect: (f) => f(),
    slots: {
      inject: (n, f) => f(),
      register: (spec, comp) => { global['__comp_' + spec.id] = comp },
    },
  }
  mod.apply(ctx)
  const overlay = global['__comp_dsh-filegraph:panel']
  if (!overlay) throw new Error('面板没注册')
  const html = renderToStaticMarkup(React.createElement(overlay, {}))
  const btn = renderToStaticMarkup(React.createElement(global['__comp_dsh-filegraph:button'], { wide: true }))
  if (process.env.FG_SNAPSHOT) {
    fs.mkdirSync(process.env.FG_SNAPSHOT, { recursive: true })
    fs.writeFileSync(path.join(process.env.FG_SNAPSHOT, label + '.html'), html + '\n=====' + btn, 'utf8')
  }
  console.log(label, '| html', html.length, '| button', btn.length, '| <g>', (html.match(/<g transform="translate\(/g) || []).length)
  return html
}

const problems = []
const check = (html, label, must) => {
  for (const t of must) if (!html.includes(t)) problems.push(label + ' 缺：' + t)
}

const base = render(null, '关系画布')
check(base, '关系画布', ['关系', '文件 ▾', '关系 ▾', '⋯', '说明', '刷新', '关闭', '启动脚本', 'main', '节点组 1', '激活'])

const inGroup = render((s) => s.replace('      groupStack: [],', "      groupStack: ['" + groupId + "'],"), '节点组内部')
check(inGroup, '节点组内部', ['节点组 1', '组输入', '组输出', '分布点', '密度', '网格', '返回', '＋ 节点'])

const sel = render((s) => s.replace('      selected: null,', "      selected: 'f:n2',"), '选中节点（详情栏）')
check(sel, '选中节点', ['这个节点是干什么用的', '入口文件'])

const all = render((s) => s.replace("      viewMode: 'flow',", "      viewMode: 'all',"), '全部视图')
check(all, '全部视图', ['全部 ▾', 'a.js', 'b.js'])

const menus = render((s) =>
  s.replace('      fileMenu: false,', '      fileMenu: true,')
   .replace('      viewMenu: false,', '      viewMenu: true,')
   .replace('      moreMenu: false,', '      moreMenu: true,'), '三个菜单都展开')
check(menus, '菜单', ['新建…', '恢复', '导出关系文档…', '添加节点组', '此节点链路', '清空这张图'])

const prompt = render((s) => s.replace('      fileMenu: false,', '      fileMenu: true,').replace("      filePrompt: '',", "      filePrompt: 'open',"), '文件浏览器')
check(prompt, '文件浏览器', ['打开', '取消'])

const ctx = render((s) => s.replace('      ctxMenu: null,', "      ctxMenu: { x: 10, y: 10, title: '节点组 1', items: [{ label: '打开节点组', onClick: () => {} }] },"), '右键菜单')
check(ctx, '右键菜单', ['打开节点组', '取消'])

const legacy = render((s) => s.replace('      hostLegacy: false,', '      hostLegacy: true,'), '旧宿主提示')
check(legacy, '旧宿主提示', ['宿主还是旧版本', '完全退出 DSH'])

const picked = render((s) => s.replace('      picked: [],', "      picked: ['f:n1'],"), '框选高亮')
check(picked, '框选高亮', ['stroke-dasharray="5 3"'])

const help = render((s) => s.replace('      helpOpen: false,', '      helpOpen: true,'), '操作说明弹窗')
check(help, '操作说明弹窗', ['Shift+A', '收进节点组', 'Ctrl+Z', '右键 节点/线/空白', '关闭'])

console.log(problems.length === 0 ? 'ALL OK' : 'FAILED:\n' + problems.join('\n'))
