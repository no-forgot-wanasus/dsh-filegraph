// 交互测试（需要 jsdom）：真 DOM + 真 React，验证
//   1) Shift + 点关系 → 改名条 → 回车 → POST /filegraph/rename-edge
//   2) 右键节点组 → 菜单里有「打开节点组」→ 点击后进入组内（面包屑 + 组输入/组输出）
// 用法：node tests/interaction-client.mjs "<react 所在 node_modules 目录>"
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

const groupId = 'n3'
const fixture = {
  ok: true,
  active: { root: 'D:\\demo', graphFile: 'D:\\demo\\graph.json', updatedAt: 1, nodeCount: 3 },
  settings: { graphFile: 'D:\\demo\\graph.json', drawioFile: 'D:\\demo\\x.drawio' },
  nodes: [],
  windows: [],
  sources: [],
  edges: [],
  flowNodes: [
    { id: 'n1', name: '看', kind: 'node' },
    { id: 'n2', name: '打开 .drawio', kind: 'node' },
    { id: groupId, name: '节点组 1', kind: 'group' },
  ],
  flows: [
    { id: 'fe1', fromId: 'n1', toId: 'n2', fromPort: 0, toPort: 0, verb: '' },
    { id: 'fe2', fromId: 'n1', toId: groupId, fromPort: 0, toPort: 0, verb: '接着' },
  ],
  flowPositions: { n1: { x: 60, y: 194 }, n2: { x: 290, y: 40 }, [groupId]: { x: 290, y: 160 } },
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
        { id: 'gin', name: '组输入', kind: 'input', x: 0, y: 120, inputs: [], outputs: ['输入'] },
        { id: 'gout', name: '组输出', kind: 'output', x: 620, y: 120, inputs: ['输出'], outputs: [] },
      ],
      flows: [],
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

const text = () => document.body.textContent
console.log('面板标题/节点渲染:', text().includes('关系'), text().includes('节点组 1'), '| path 数', document.querySelectorAll('path').length)

// 1) Shift + 点关系 → 改名条
const hit = document.querySelector('path[stroke="transparent"]')
console.log('隐形命中线存在:', !!hit)
if (hit) {
  act(() => {
    hit.dispatchEvent(new window.MouseEvent('pointerdown', { bubbles: true, shiftKey: true, clientX: 200, clientY: 200, button: 0 }))
  })
}
const bar = document.querySelector('input')
console.log('Shift+点线后出现改名条:', text().includes('动作词'), '| 输入框:', !!bar)
if (bar) {
  act(() => {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
    setter.call(bar, '命名测试')
    bar.dispatchEvent(new window.Event('input', { bubbles: true }))
  })
  act(() => {
    bar.dispatchEvent(new window.KeyboardEvent('keydown', { bubbles: true, key: 'Enter' }))
  })
}
await new Promise((r) => setTimeout(r, 60))
console.log('改名 POST:', JSON.stringify(posts.filter((p) => p.url.includes('rename'))))

// 2) 右键节点组 → 打开节点组
posts.length = 0
const groupText = [...document.querySelectorAll('text')].find((el) => el.textContent === '节点组 1')
const groupG = groupText && groupText.closest('g')
console.log('找到节点组节点:', !!groupG)
if (groupG) {
  act(() => {
    groupG.dispatchEvent(new window.MouseEvent('contextmenu', { bubbles: true, clientX: 300, clientY: 200 }))
  })
}
console.log('右键菜单出现:', text().includes('打开节点组'))
const openBtn = [...document.querySelectorAll('button')].find((el) => el.textContent === '打开节点组')
if (openBtn) act(() => { openBtn.dispatchEvent(new window.MouseEvent('click', { bubbles: true })) })
console.log('进入节点组:', text().includes('组输入') && text().includes('组输出'), '| 面包屑含组名:', text().includes('节点组 1'))
console.log('有返回按钮:', !!([...document.querySelectorAll('button')].find((el) => el.textContent === '返回')))

if (process.exitCode) console.log('FAILED')
process.exit(0)
