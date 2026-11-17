// 交互测试（需要 jsdom）：在节点组内右键空白处 → 菜单要出来，且底部有「退出节点组」
// 用法：node tests/interaction-blankmenu.mjs "<react 所在 node_modules 目录>"
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
  flowNodes: [{ id: groupId, name: '节点组 1', kind: 'group' }],
  flows: [],
  flowPositions: { [groupId]: { x: 60, y: 60 } },
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
        { id: 'a', name: 'A', kind: 'node', x: 260, y: 40, inputs: ['输入'], outputs: ['输出'] },
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

const fail = []
const check = (name, ok) => { console.log((ok ? 'OK   ' : 'FAIL ') + name); if (!ok) fail.push(name) }
const byText = (tag, text) => [...document.querySelectorAll(tag)].find((el) => el.textContent === text)
const menuTexts = () => [...document.querySelectorAll('button')].map((el) => el.textContent)

const canvasSvg = () => document.querySelector('svg[viewBox]')

// 先确认主画布空白右键是好的
act(() => { canvasSvg().dispatchEvent(new window.MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 500, clientY: 300 })) })
check('主画布空白右键有菜单（添加节点）', menuTexts().includes('添加节点'))

// 进组
act(() => { byText('text', '节点组 1').closest('g').dispatchEvent(new window.MouseEvent('contextmenu', { bubbles: true, clientX: 200, clientY: 150 })) })
const enter = [...document.querySelectorAll('button')].find((el) => el.textContent === '打开节点组')
check('组节点右键有「打开节点组」', !!enter)
if (enter) act(() => { enter.dispatchEvent(new window.MouseEvent('click', { bubbles: true })) })
check('已进组（看得到 组输入）', !!byText('text', '组输入'))

// 组内右键空白处
act(() => { canvasSvg().dispatchEvent(new window.MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 520, clientY: 320 })) })
check('组内空白右键弹出菜单', menuTexts().includes('添加节点'))
check('菜单底部有「退出节点组」', menuTexts().includes('退出节点组'))

const back = [...document.querySelectorAll('button')].find((el) => el.textContent === '退出节点组')
if (back) act(() => { back.dispatchEvent(new window.MouseEvent('click', { bubbles: true })) })
check('点了能退出到上一层', !byText('text', '组输入') && !!byText('text', '节点组 1'))

console.log(fail.length === 0 ? 'ALL OK' : 'FAILED: ' + fail.join(' / '))
process.exit(fail.length === 0 ? 0 : 1)
