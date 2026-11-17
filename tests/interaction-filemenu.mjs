// 交互测试（需要 jsdom）：文件对话框按动作换按钮名 + 自动补 .drawio
//   新建… → 按钮「新建」，路径默认带 .drawio 且不覆盖当前图
//   打开… → 按钮「打开」
//   另存为… → 按钮「另存为」
// 用法：node tests/interaction-filemenu.mjs "<react 所在 node_modules 目录>"
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
  settings: { graphFile: 'D:\\demo\\graph.json', drawioFile: 'D:\\demo\\鱼功能设计.drawio' },
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
  // 文件浏览器：给个空目录
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
const pathInput = () => [...document.querySelectorAll('input')].find((el) => /\.drawio$/.test(el.value) || el.value === '')

const openMenu = () => {
  if (btn('新建…') || btn('打开…')) return true
  const fileBtn = [...document.querySelectorAll('button')].find((el) => String(el.textContent).indexOf('文件') === 0)
  if (!fileBtn) return false
  act(() => { fileBtn.dispatchEvent(new window.MouseEvent('click', { bubbles: true })) })
  return !!btn('新建…')
}

const cases = [
  ['新建…', '新建'],
  ['打开…', '打开'],
  ['另存为…', '另存为'],
  ['保存副本…', '保存副本'],
]

for (const [menuLabel, expectLabel] of cases) {
  check('文件菜单能打开（' + menuLabel + '）', openMenu())
  const item = btn(menuLabel)
  check('菜单里有 ' + menuLabel, !!item)
  if (!item) continue
  act(() => { item.dispatchEvent(new window.MouseEvent('click', { bubbles: true })) })
  // 等文件列表加载
  const confirm = btn(expectLabel)
  check(menuLabel + ' → 确认按钮是「' + expectLabel + '」', !!confirm)
  check(menuLabel + ' → 没有错写成「打开」的按钮', !(expectLabel !== '打开' && btn('打开') && btn('打开') !== btn(expectLabel)))
  const input = pathInput()
  check(menuLabel + ' → 路径框带 .drawio', !!input && /\.drawio$/.test(input.value))
  if (menuLabel === '新建…') {
    check('新建的默认名字不是当前这张图（不会覆盖）', !!input && input.value !== fixture.settings.drawioFile)
  }
  if (btn('取消')) act(() => { btn('取消').dispatchEvent(new window.MouseEvent('click', { bubbles: true })) })
}

console.log(fail.length === 0 ? 'ALL OK' : 'FAILED: ' + fail.join(' / '))
process.exit(fail.length === 0 ? 0 : 1)
