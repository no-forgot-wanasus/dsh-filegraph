// 交互测试（需要 jsdom）：「此节点关系 / 此节点链路」筛选
// 用法：node tests/interaction-scope.mjs "<react 所在 node_modules 目录>"
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
  active: { root: 'D:\\demo', graphFile: 'D:\\demo\\graph.json', updatedAt: 1, nodeCount: 5 },
  settings: { graphFile: 'D:\\demo\\graph.json', drawioFile: 'D:\\demo\\x.drawio' },
  nodes: [],
  windows: [],
  sources: [],
  edges: [],
  flowNodes: [
    { id: 'a', name: 'A', kind: 'node' },
    { id: 'b', name: 'B', kind: 'node' },
    { id: 'c', name: 'C', kind: 'node' },
    { id: 'd', name: 'D', kind: 'node' },
  ],
  flows: [
    { id: 'e1', fromId: 'a', toId: 'b', verb: '' },
    { id: 'e2', fromId: 'b', toId: 'c', verb: '' },
    { id: 'e3', fromId: 'd', toId: 'a', verb: '' },
  ],
  flowPositions: { a: { x: 40, y: 40 }, b: { x: 300, y: 40 }, c: { x: 560, y: 40 }, d: { x: 40, y: 180 } },
  nodeNotes: {},
  groups: {},
  positions: {},
  projects: [],
}

const fetchStub = () => Promise.resolve({ json: () => Promise.resolve(fixture) })
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
const check = (name, ok, detail) => { console.log((ok ? 'OK   ' : 'FAIL ') + name + (ok ? '' : '  ' + (detail || ''))); if (!ok) fail.push(name) }
const btn = (text) => [...document.querySelectorAll('button')].find((el) => String(el.textContent).trim().replace(/^[✓ ]+/, '') === text)
const nodeLabels = () => [...document.querySelectorAll('text')].map((el) => el.textContent).filter((t) => ['A', 'B', 'C', 'D'].includes(t))

// 选中 B（点节点）
const bText = [...document.querySelectorAll('text')].find((el) => el.textContent === 'B')
act(() => { bText.closest('g').dispatchEvent(new window.MouseEvent('pointerdown', { bubbles: true, cancelable: true, button: 0, clientX: 320, clientY: 60 })) })
act(() => { window.dispatchEvent(new window.MouseEvent('pointerup', { bubbles: true, clientX: 320, clientY: 60 })) })
check('详情栏出现三个筛选按钮', !!(btn('此节点关系') && btn('此节点链路')), JSON.stringify([...(document.querySelectorAll('button'))].map((el) => el.textContent).slice(-8)))

// 此节点关系：B + 直接上游 A + 直接下游 C（D 是 A 的上游，不该出现）
if (btn('此节点关系')) act(() => { btn('此节点关系').dispatchEvent(new window.MouseEvent('click', { bubbles: true })) })
const ego = nodeLabels()
check('此节点关系只留 A/B/C', ego.includes('A') && ego.includes('B') && ego.includes('C') && !ego.includes('D'), JSON.stringify(ego))

// 拖着画布平移不应退出「此节点关系」
const canvas = document.querySelector('svg[viewBox]')
act(() => { canvas.dispatchEvent(new window.MouseEvent('pointerdown', { bubbles: true, cancelable: true, button: 0, clientX: 820, clientY: 700 })) })
act(() => { window.dispatchEvent(new window.MouseEvent('pointermove', { bubbles: true, clientX: 760, clientY: 660 })) })
act(() => { window.dispatchEvent(new window.MouseEvent('pointerup', { bubbles: true, clientX: 760, clientY: 660 })) })
check('拖画布平移后仍保持此节点关系（没被清选中）', nodeLabels().sort().join('') === 'ABC', JSON.stringify(nodeLabels()))

// 此节点链路：整条上游链 + 一级下游
if (btn('此节点链路')) act(() => { btn('此节点链路').dispatchEvent(new window.MouseEvent('click', { bubbles: true })) })
const chain = nodeLabels()
check('此节点链路带上上游 D', chain.includes('D') && chain.includes('A') && chain.includes('B') && chain.includes('C'), JSON.stringify(chain))

// 横向排布：上游在左、下游在右
const posOf = (label) => {
  const el = [...document.querySelectorAll('text')].find((t) => t.textContent === label)
  const tr = el && el.closest('g').getAttribute('transform')
  const nums = tr ? (tr.match(/-?\d+(\.\d+)?/g) || []).map(Number) : null
  return nums ? { x: nums[0], y: nums[1] } : null
}
if (btn('此节点链路')) act(() => { btn('此节点链路').dispatchEvent(new window.MouseEvent('click', { bubbles: true })) })
const pa = posOf('A'); const pb = posOf('B'); const pc = posOf('C'); const pd = posOf('D')
check('链路横向排：D 在 A 左边、A 在 B 左边、B 在 C 左边',
  !!pa && !!pb && !!pc && !!pd && pd.x < pa.x && pa.x < pb.x && pb.x < pc.x,
  JSON.stringify({ pa, pb, pc, pd }))

// 回到全部
if (btn('全部')) act(() => { btn('全部').dispatchEvent(new window.MouseEvent('click', { bubbles: true })) })
check('点全部恢复正常', nodeLabels().length === 4, JSON.stringify(nodeLabels()))

console.log(fail.length === 0 ? 'ALL OK' : 'FAILED: ' + fail.join(' / '))
process.exit(fail.length === 0 ? 0 : 1)
