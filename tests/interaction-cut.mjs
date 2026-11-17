// 交互测试（需要 jsdom）：Ctrl 剪刀
//   1) Ctrl + 点一条线 → POST /filegraph/remove-edge（只剪这条）
//   2) Ctrl + 从空白拖过两条线 → POST 一次带多条
// 用法：node tests/interaction-cut.mjs "<react 所在 node_modules 目录>"
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
  active: { root: 'D:\\demo', graphFile: 'D:\\demo\\graph.json', updatedAt: 1, nodeCount: 3 },
  settings: { graphFile: 'D:\\demo\\graph.json', drawioFile: 'D:\\demo\\x.drawio' },
  nodes: [],
  windows: [],
  sources: [],
  edges: [],
  flowNodes: [
    { id: 'n1', name: '启动脚本', kind: 'node' },
    { id: 'n2', name: 'main', kind: 'node' },
    { id: 'n3', name: '引擎', kind: 'node' },
  ],
  flows: [
    { id: 'fe1', fromId: 'n1', toId: 'n2', fromPort: 0, toPort: 0, verb: '' },
    { id: 'fe2', fromId: 'n2', toId: 'n3', fromPort: 0, toPort: 0, verb: '' },
  ],
  flowPositions: { n1: { x: 60, y: 60 }, n2: { x: 420, y: 60 }, n3: { x: 780, y: 60 } },
  drags: {},
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

// 命中线：stroke=transparent 的 path（剪刀/点选都靠它）
const hits = () => [...document.querySelectorAll('path[stroke="transparent"]')]
const svg = () => document.querySelector('svg')

/** viewBox → 局部坐标 ⇄ client 坐标（jsdom 里 getBoundingClientRect 全是 0，scale=1） */
function toClient(local) {
  const vb = svg().getAttribute('viewBox').split(' ').map(Number)
  return { x: local.x - vb[0], y: local.y - vb[1] }
}
function midOf(d) {
  const nums = (d.match(/-?\d+(\.\d+)?/g) || []).map(Number)
  const [x1, y1, c1x, c1y, c2x, c2y, x2, y2] = nums
  const t = 0.5
  const u = 1 - t
  return {
    x: u * u * u * x1 + 3 * u * u * t * c1x + 3 * u * t * t * c2x + t * t * t * x2,
    y: u * u * u * y1 + 3 * u * u * t * c1y + 3 * u * t * t * c2y + t * t * t * y2,
  }
}
const down = (el, pt, extra) => act(() => {
  el.dispatchEvent(new window.MouseEvent('pointerdown', { bubbles: true, cancelable: true, button: 0, clientX: pt.x, clientY: pt.y, ...extra }))
})
const move = (pt) => act(() => {
  window.dispatchEvent(new window.MouseEvent('pointermove', { bubbles: true, clientX: pt.x, clientY: pt.y }))
})
const up = (pt) => act(() => {
  window.dispatchEvent(new window.MouseEvent('pointerup', { bubbles: true, clientX: pt.x, clientY: pt.y }))
})
const settle = () => new Promise((r) => setTimeout(r, 40))

const lines = hits()
check('两条关系线都渲染出来了', lines.length === 2)

// 1) Ctrl + 点第一条线 → 只剪这条
const a = midOf(lines[0].getAttribute('d'))
const pa = toClient(a)
down(lines[0], pa, { ctrlKey: true })
up(pa)
await settle()
const cut1 = posts.filter((p) => p.url.includes('remove-edge'))
check('Ctrl+点线 → 发了 /filegraph/remove-edge', cut1.length === 1)
check('只带了这一条边 id（fe1）', cut1.length === 1 && JSON.stringify(cut1[0].body.edges) === JSON.stringify([{ id: 'fe1' }]))

// 2) Ctrl + 从空白拖过第二条线 → 剪掉划过的线
posts.length = 0
const b = midOf(hits()[1].getAttribute('d'))
const start = toClient({ x: b.x - 60, y: b.y + 90 })
const end = toClient({ x: b.x + 60, y: b.y - 90 })
down(svg(), start, { ctrlKey: true })
move(toClient({ x: b.x, y: b.y }))
move(end)
up(end)
await settle()
const cut2 = posts.filter((p) => p.url.includes('remove-edge'))
check('Ctrl+拖过线 → 发了 remove-edge', cut2.length === 1)
check('剪掉的是划过的那条（fe2）', cut2.length === 1 && JSON.stringify(cut2[0].body.edges) === JSON.stringify([{ id: 'fe2' }]))
check('拖拽期间画出了红色剪刀线', [...document.querySelectorAll('line')].some((l) => l.getAttribute('stroke') === '#ef4444'))

// 3) Ctrl + 什么都不划 → 不发请求、不剪错线
posts.length = 0
down(svg(), toClient({ x: 900, y: 900 }), { ctrlKey: true })
up(toClient({ x: 940, y: 940 }))
await settle()
check('空白处 Ctrl 拖拽不会剪线', posts.filter((p) => p.url.includes('remove-edge')).length === 0)

console.log(fail.length === 0 ? 'ALL OK' : 'FAILED: ' + fail.join(' / '))
process.exit(fail.length === 0 ? 0 : 1)
