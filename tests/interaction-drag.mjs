// 交互测试（需要 jsdom）：拖动只存一份绝对坐标
//   拖完 POST /filegraph/drag 带 {id,x,y}（绝对），不再有 dx/dy 的矢量层。
// 用法：node tests/interaction-drag.mjs "<react 所在 node_modules 目录>"
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

const fixture = {
  ok: true,
  active: { root: 'D:\\demo', graphFile: 'D:\\demo\\graph.json', updatedAt: 1, nodeCount: 1 },
  settings: { graphFile: 'D:\\demo\\graph.json', drawioFile: 'D:\\demo\\x.drawio' },
  nodes: [],
  windows: [],
  sources: [],
  edges: [],
  flowNodes: [{ id: 'n1', name: '启动脚本', kind: 'node' }],
  flows: [],
  flowPositions: { n1: { x: 60, y: 60 } },
  nodeNotes: {},
  groups: {},
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

const nodeG = [...document.querySelectorAll('text')].find((el) => el.textContent === '启动脚本').closest('g')
check('节点渲染出来了', !!nodeG)

posts.length = 0
act(() => { nodeG.dispatchEvent(new window.MouseEvent('pointerdown', { bubbles: true, cancelable: true, button: 0, clientX: 100, clientY: 100 })) })
act(() => { window.dispatchEvent(new window.MouseEvent('pointermove', { bubbles: true, clientX: 150, clientY: 130 })) })
act(() => { window.dispatchEvent(new window.MouseEvent('pointerup', { bubbles: true, clientX: 150, clientY: 130 })) })
await new Promise((r) => setTimeout(r, 40))

const drag = posts.filter((p) => p.url.includes('/filegraph/drag'))
check('拖完发了 /filegraph/drag', drag.length === 1)
const item = drag.length ? drag[0].body.entries[0] : null
check('带的是绝对坐标 {id,x,y}', !!item && item.id === 'n1' && typeof item.x === 'number' && typeof item.y === 'number')
check('没有 dx/dy 矢量层', !!item && item.dx === undefined && item.dy === undefined)
check('坐标 = 原位置 + 拖动距离', !!item && item.x === 110 && item.y === 90)
check('拖动不发「打开文件」之类别的请求', posts.every((p) => p.url.includes('/filegraph/drag')))

// 松手后节点必须停在新位置（不能弹回去 = "拖不动"）
const after = [...document.querySelectorAll('text')].find((el) => el.textContent === '启动脚本').closest('g')
check('松手后节点画在新位置 translate(110 90)', !!after && after.getAttribute('transform') === 'translate(110 90)', after ? after.getAttribute('transform') : '没有节点')

console.log(fail.length === 0 ? 'ALL OK' : 'FAILED: ' + fail.join(' / '))
process.exit(fail.length === 0 ? 0 : 1)
