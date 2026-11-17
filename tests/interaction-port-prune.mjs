// 交互测试（需要 jsdom）：端口规则里的「没线接入 → 端口清除」
//   1) 空着的多余端口会被删掉，有线的不动，且序号不乱
//   2) 端口全空时留一个空口（外面要能拉线）
// 用法：node tests/interaction-port-prune.mjs "<react 所在 node_modules 目录>"
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
  active: { root: 'D:\\demo', graphFile: 'D:\\demo\\graph.json', updatedAt: 1, nodeCount: 1 },
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
      inputs: ['输入', '输入 2'],
      outputs: ['输出', '输出 2'],
      nodes: [
        { id: 'gin', name: '组输入', kind: 'input', x: 0, y: 60, inputs: [], outputs: ['输入', '输入 2'] },
        { id: 'gout', name: '组输出', kind: 'output', x: 620, y: 60, inputs: ['输出', '输出 2'], outputs: [] },
        { id: 'a', name: 'A', kind: 'node', x: 240, y: 20, inputs: ['输入'], outputs: ['输出'] },
        { id: 'b', name: 'B', kind: 'node', x: 240, y: 140, inputs: ['输入'], outputs: ['输出'] },
      ],
      // 只有口 0 有线，口 1 是空的 → 应该被清掉
      flows: [
        { id: 'g1', fromId: 'gin', fromPort: 0, toId: 'a', toPort: 0, verb: '' },
        { id: 'g2', fromId: 'b', fromPort: 0, toId: 'gout', toPort: 0, verb: '' },
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
const menuItem = () => [...document.querySelectorAll('button')].find((el) => el.textContent === '每个关系一个端口')

act(() => { byText('text', '节点组 1').closest('g').dispatchEvent(new window.MouseEvent('contextmenu', { bubbles: true, clientX: 200, clientY: 150 })) })
const enter = [...document.querySelectorAll('button')].find((el) => el.textContent === '打开节点组')
if (enter) act(() => { enter.dispatchEvent(new window.MouseEvent('click', { bubbles: true })) })

posts.length = 0
act(() => { byText('text', '组输入').closest('g').dispatchEvent(new window.MouseEvent('contextmenu', { bubbles: true, clientX: 200, clientY: 150 })) })
if (menuItem()) act(() => { menuItem().dispatchEvent(new window.MouseEvent('click', { bubbles: true })) })

const saved = posts.filter((p) => p.url.includes('/filegraph/group') && p.body && p.body.action === 'save')
const draft = saved.length ? saved[saved.length - 1].body.data : null
check('存过一次组数据', !!draft)
check('空着的输入口被清掉，只留 1 条已接 + 1 个空口（n+1）', !!draft && draft.inputs.length === 2)
check('留下的是有线的那个口，且改名成上一节点名', !!draft && draft.inputs[0] === '灰线功能')
check('空着的输出口同样整理成 n+1', !!draft && draft.outputs.length === 2)
check('有线关系没被删', !!draft && draft.flows.length === 2)

console.log(fail.length === 0 ? 'ALL OK' : 'FAILED: ' + fail.join(' / '))
process.exit(fail.length === 0 ? 0 : 1)
