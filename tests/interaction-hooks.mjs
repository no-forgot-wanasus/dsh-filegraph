// 回归测试（需要 jsdom）：面板「关 → 开 → 关 → 开」不能变 hook 数量（React #310）
// 起因：往期历史的 ghostVersions 一开始写成 useMemo，却放在 `if (!current.open) return null` 之后，
// 面板第一次打开就报 "Rendered more hooks than during the previous render"。
// 用法：node tests/interaction-hooks.mjs "<react 所在 node_modules 目录>"
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
  active: { root: 'D:\\demo', graphFile: 'D:\\demo\\graph.json', updatedAt: 1, nodeCount: 2 },
  settings: { graphFile: 'D:\\demo\\graph.json', drawioFile: 'D:\\demo\\x.drawio' },
  nodes: [],
  windows: [],
  sources: [],
  edges: [],
  flowNodes: [{ id: 'a', name: '现状A', kind: 'node' }],
  flows: [],
  flowPositions: { a: { x: 40, y: 40 } },
  nodeNotes: {},
  groups: {},
  positions: {},
  projects: [],
  history: [{ n: 2, at: Date.now(), nodes: 1, edges: 0, groups: 0 }],
}

const fetchStub = (url, init) => {
  const body = init && init.body ? JSON.parse(init.body) : null
  if (String(url).includes('/filegraph/history') && body && body.action === 'show') {
    return Promise.resolve({ text: () => Promise.resolve(JSON.stringify({ ok: true, version: { n: 2, at: 1, flowNodes: [], flows: [], flowPositions: {}, groups: {} } })) })
  }
  return Promise.resolve({ text: () => Promise.resolve(JSON.stringify(fixture)) })
}
window.fetch = fetchStub
global.fetch = fetchStub

// 不打补丁：面板初始是关着的（open: false），靠点侧栏按钮打开 —— 和真实使用一致
const src = fs.readFileSync(new URL('../client.js', import.meta.url), 'utf8')
const factoryStore = {}
window.__ModuleLoader__ = { load: (def) => { factoryStore.def = def } }
new Function('window', 'fetch', src)(window, fetchStub)
const mod = factoryStore.def.factory((n) => {
  if (n === 'react') return React
  throw new Error('require ' + n)
})
const comps = {}
mod.apply({ effect: (f) => f(), slots: { inject: (n, f) => f(), register: (spec, c) => { comps[spec.id] = c } } })

function App() {
  return React.createElement('div', null,
    React.createElement(comps['dsh-filegraph:panel'], {}),
    React.createElement(comps['dsh-filegraph:button'], { wide: true }),
  )
}

const root = createRoot(document.getElementById('root'))
act(() => { root.render(React.createElement(App, {})) })

const fail = []
const check = (name, ok, detail) => { console.log((ok ? 'OK   ' : 'FAIL ') + name + (ok ? '' : '  ' + (detail || ''))); if (!ok) fail.push(name) }
const body = () => document.body.innerHTML
const toggle = () => [...document.querySelectorAll('button')].find((el) => el.getAttribute('title') === '关系')

check('面板初始是关的', !body().includes('关系面板报错') && !body().includes('历史') && !body().includes('关闭'), body().slice(0, 160))

for (let round = 1; round <= 3; round += 1) {
  act(() => { toggle().dispatchEvent(new window.MouseEvent('click', { bubbles: true })) })
  await act(async () => { await Promise.resolve(); await Promise.resolve() })
  check('第 ' + round + ' 次打开：面板正常渲染、不报 hook 错误',
    !body().includes('关系面板报错') && body().includes('历史') && body().includes('版本 2'),
    body().includes('关系面板报错') ? '出现「关系面板报错」' : body().slice(0, 120))
  act(() => { toggle().dispatchEvent(new window.MouseEvent('click', { bubbles: true })) })
  await act(async () => { await Promise.resolve() })
  check('第 ' + round + ' 次关闭：面板收起、不报错', !body().includes('关系面板报错'), '')
}

console.log(fail.length === 0 ? 'ALL OK' : 'FAILED: ' + fail.join(' / '))
process.exit(fail.length === 0 ? 0 : 1)
