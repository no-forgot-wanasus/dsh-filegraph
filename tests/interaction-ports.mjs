// 交互测试（需要 jsdom）：组输入一个端口只走一条关系
//   组输入上挂了两条关系 → 右键「每个关系一个端口」→ 端口加一个（名字=对端节点名），
//   第二条关系的 fromPort 挪到新端口；原来那个端口（外面灰线的位置）名字不动。
// 用法：node tests/interaction-ports.mjs "<react 所在 node_modules 目录>"
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'

const reactDir = process.argv[2]
const requireFrom = createRequire(path.join(reactDir, 'noop.js'))
const { JSDOM } = requireFrom('jsdom')

const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { pretendToBeVisual: true })
const { window } = dom
global.window = window
global.document = window.document
Object.defineProperty(global, 'navigator', { value: window.navigator, configurable: true })
global.HTMLElement = window.HTMLElement
global.Element = window.Element
global.Node = window.Node
global.SVGElement = window.SVGElement
global.Event = window.Event
global.MouseEvent = window.MouseEvent
global.KeyboardEvent = window.KeyboardEvent

const React = requireFrom('react')
const { createRoot } = requireFrom('react-dom/client')
const { act } = requireFrom('react-dom/test-utils')

const groupId = 'n9'
const fixture = {
  ok: true,
  active: { root: 'D:\\demo', graphFile: 'D:\\demo\\graph.json', updatedAt: 1, nodeCount: 2 },
  settings: { graphFile: 'D:\\demo\\graph.json', drawioFile: 'D:\\demo\\x.drawio' },
  nodes: [],
  windows: [],
  sources: [],
  edges: [],
  flowNodes: [{ id: 'n0', name: '灰线功能', kind: 'node' }, { id: groupId, name: '节点组 1', kind: 'group' }],
  flows: [{ id: 'x1', fromId: 'n0', fromPort: 0, toId: groupId, toPort: 0, verb: '' }],
  flowPositions: { n0: { x: 0, y: 80 }, [groupId]: { x: 260, y: 80 } },
  drags: {},
  nodeNotes: {},
  groups: {
    [groupId]: {
      id: groupId,
      name: '节点组 1',
      note: '',
      inputs: ['输入'],
      outputs: ['输出'],
      nodes: [
        { id: 'gin', name: '组输入', kind: 'input', x: 0, y: 60, inputs: [], outputs: ['输入'] },
        { id: 'gout', name: '组输出', kind: 'output', x: 620, y: 60, inputs: ['输出'], outputs: [] },
        { id: 'a', name: '是否看懂ai写的报告', kind: 'node', x: 260, y: 20, inputs: ['输入'], outputs: ['输出'] },
        { id: 'b', name: '你是否因为ai听不懂话而烦恼', kind: 'node', x: 260, y: 140, inputs: ['输入'], outputs: ['输出'] },
      ],
      flows: [
        { id: 'g1', fromId: 'gin', fromPort: 0, toId: 'a', toPort: 0, verb: '' },
        { id: 'g2', fromId: 'gin', fromPort: 0, toId: 'b', toPort: 0, verb: '' },
      ],
      notes: {},
      view: {},
    },
  },
  positions: {},
  projects: [],
}

const posts = []
const fetchStub = (url, init) => {
  const body = init && init.body ? JSON.parse(init.body) : null
  if (init && init.method === 'POST') posts.push({ url, body })
  return Promise.resolve({ json: () => Promise.resolve(fixture) })
}
window.fetch = fetchStub
global.fetch = fetchStub
window.__FIXTURE__ = fixture

const src = fs.readFileSync(new URL('../client.js', import.meta.url), 'utf8')
  .replace('      open: false,', '      open: true,')
  .replace('      data: null,', '      data: window.__FIXTURE__ || null,')
const factoryStore = {}
window.__ModuleLoader__ = { load: (def) => { factoryStore.def = def } }
new Function('window', 'fetch', src)(window, fetchStub)
const mod = factoryStore.def.factory((n) => {
  if (n === 'react') return React
  throw new Error('require ' + n)
})
const comps = {}
mod.apply({ effect: (f) => f(), slots: { inject: (n, f) => f(), register: (spec, c) => { comps[spec.id] = c } } })

const root = createRoot(document.getElementById('root'))
act(() => { root.render(React.createElement(comps['dsh-filegraph:panel'], {})) })

const fail = []
const check = (name, ok) => { console.log((ok ? 'OK   ' : 'FAIL ') + name); if (!ok) fail.push(name) }
const byText = (tag, text) => [...document.querySelectorAll(tag)].find((el) => el.textContent === text)
const menu = () => [...document.querySelectorAll('button')].find((el) => el.textContent === '每个关系一个端口')

// 进组：右键组节点 → 打开节点组
act(() => { byText('text', '节点组 1').closest('g').dispatchEvent(new window.MouseEvent('contextmenu', { bubbles: true, clientX: 200, clientY: 150 })) })
const enter = [...document.querySelectorAll('button')].find((el) => el.textContent === '打开节点组')
check('组节点的右键菜单有「打开节点组」', !!enter)
if (enter) act(() => { enter.dispatchEvent(new window.MouseEvent('click', { bubbles: true })) })
check('进组后看到 组输入', !!byText('text', '组输入'))

// 组输入右键 → 每个关系一个端口
posts.length = 0
act(() => { byText('text', '组输入').closest('g').dispatchEvent(new window.MouseEvent('contextmenu', { bubbles: true, clientX: 200, clientY: 150 })) })
check('组输入右键有「每个关系一个端口」', !!menu())
if (menu()) act(() => { menu().dispatchEvent(new window.MouseEvent('click', { bubbles: true })) })

const saved = posts.filter((p) => p.url.includes('/filegraph/group') && p.body && p.body.action === 'save')
check('保存了一次组数据', saved.length >= 1)
const draft = saved.length ? saved[saved.length - 1].body.data : null
check('组输入端口 = 2 条已接 + 1 个空口（n+1）', !!draft && draft.inputs.length === 3)
check('原端口名补成上一节点名（灰线功能）', !!draft && draft.inputs[0] === '灰线功能')
check('新端口跟原端口同名（同一根输入，多点接）', !!draft && draft.inputs[1] === '灰线功能')
check('组输入的输出端口也是 n+1（3 个）', !!draft && draft.nodes.find((n) => n.id === 'gin').outputs.length === 3)
check('第二条关系挪到了新端口', !!draft && draft.flows.find((f) => f.id === 'g2').fromPort === 1)
check('第一条关系仍在原端口', !!draft && draft.flows.find((f) => f.id === 'g1').fromPort === 0)

console.log(fail.length === 0 ? 'ALL OK' : 'FAILED: ' + fail.join(' / '))
process.exit(fail.length === 0 ? 0 : 1)
