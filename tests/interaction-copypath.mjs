// 交互测试（需要 jsdom）：工具条「复制文件地址」把当前 .drawio 的地址放进剪贴板
//   ① 普通路径 → 原样复制；② 路径带空格 → 复制成 @"..."（对话里能直接当文件引用）；
//   ③ 还没有文件 → 只提示，不写剪贴板。
// 用法：node tests/interaction-copypath.mjs "<react 所在 node_modules 目录>"
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

// 剪贴板替身：Clipboard API 走这里，记下最后复制的内容
let copied = null
Object.defineProperty(window.navigator, 'clipboard', {
  value: { writeText: (text) => { copied = text; return Promise.resolve() } },
  configurable: true,
})

const React = requireFrom('react')
const { createRoot } = requireFrom('react-dom/client')
const { act } = requireFrom('react-dom/test-utils')

const PLAIN = 'D:\\demo\\鱼功能设计.drawio'
const SPACED = 'D:\\demo\\世界演绎者 历史\\版本 2.drawio'

const fixture = {
  ok: true,
  active: { root: 'D:\\demo', graphFile: 'D:\\demo\\graph.json', updatedAt: 1, nodeCount: 1 },
  settings: { graphFile: 'D:\\demo\\graph.json', drawioFile: PLAIN },
  nodes: [],
  windows: [],
  sources: [],
  edges: [],
  flowNodes: [{ id: 'n1', name: 'A', kind: 'node' }],
  flows: [],
  flowPositions: { n1: { x: 80, y: 80 } },
  drags: {},
  nodeNotes: {},
  groups: {},
  positions: {},
  projects: [],
}

const fetchStub = (url, init) => {
  if (init && init.method === 'POST') return Promise.resolve({ json: () => Promise.resolve(fixture) })
  return Promise.resolve({ json: () => Promise.resolve({ ok: true, dir: 'D:\\demo', parent: 'D:\\', entries: [] }) })
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
const btn = (text) => [...document.querySelectorAll('button')].find((el) => el.textContent === text)
const bodyText = () => String(document.body.textContent || '')

const click = async (el) => {
  await act(async () => {
    el.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
}

check('工具条上有「复制文件地址」按钮', !!btn('复制文件地址'))

// ① 普通路径：原样复制
await click(btn('复制文件地址'))
check('普通路径被完整复制', copied === PLAIN)
check('复制后有提示「已复制文件地址」', bodyText().includes('已复制文件地址：'))

// ② 路径带空格：复制成 @"..."，粘到对话里就是一个文件引用
fixture.settings.drawioFile = SPACED
await click(btn('复制文件地址'))
check('带空格的路径复制成 @"..."', copied === '@"' + SPACED + '"')

// ③ 还没有落到文件：只提示，不动剪贴板
fixture.settings.drawioFile = ''
const before = copied
await click(btn('复制文件地址'))
check('没有文件时不写剪贴板', copied === before)
check('没有文件时提示先另存为', bodyText().includes('还没有落到文件'))

console.log(fail.length === 0 ? 'ALL OK' : 'FAILED: ' + fail.join(' / '))
process.exit(fail.length === 0 ? 0 : 1)
