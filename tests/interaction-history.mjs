// 交互测试（需要 jsdom）：往期历史 —— 点版本叠对照 / 眼睛开关 / 回到此版本
// 用法：node tests/interaction-history.mjs "<react 所在 node_modules 目录>"
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
    { id: 'a', name: '现状A', kind: 'node' },
    { id: 'b', name: '现状B', kind: 'node' },
  ],
  flows: [{ id: 'e1', fromId: 'a', toId: 'b', verb: '送给' }],
  flowPositions: { a: { x: 40, y: 40 }, b: { x: 300, y: 40 } },
  nodeNotes: {},
  groups: {},
  positions: {},
  projects: [],
  history: [{ n: 4, at: 1763553600000, nodes: 2, edges: 1, groups: 0 }],
}

// 版本 4 的图：多一个现在没有的节点「旧节点」、少一条现在的线
const version = {
  n: 4,
  at: 1763553600000,
  flowNodes: [
    { id: 'a', name: '现状A', kind: 'node' },
    { id: 'x', name: '旧节点', kind: 'node' },
  ],
  flows: [],
  flowPositions: { a: { x: 40, y: 40 }, x: { x: 560, y: 120 } },
  groups: {},
  nodeNotes: {},
}

const posts = []
const fetchStub = (url, init) => {
  const body = init && init.body ? JSON.parse(init.body) : null
  if (init && init.method === 'POST') posts.push({ url, body })
  if (String(url).includes('/filegraph/history') && body && body.action === 'show') {
    return Promise.resolve({ text: () => Promise.resolve(JSON.stringify({ ok: true, version })) })
  }
  return Promise.resolve({ text: () => Promise.resolve(JSON.stringify(fixture)) })
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
const check = (name, ok, detail) => { console.log((ok ? 'OK   ' : 'FAIL ') + name + (ok ? '' : '  ' + (detail || ''))); if (!ok) fail.push(name) }
const btn = (text) => [...document.querySelectorAll('button')].find((el) => String(el.textContent).trim().replace(/^[✓ ]+/, '') === text)
const rowBtn = (n) => [...document.querySelectorAll('button')].find((el) => String(el.textContent).trim().startsWith('版本 ' + n))
const byTitle = (title) => document.querySelector('button[title="' + title + '"]')
const svgTexts = () => [...document.querySelectorAll('text')].map((el) => el.textContent)

check('右上窗口列出往期版本', !!rowBtn(4), JSON.stringify([...document.querySelectorAll('button')].map((el) => el.textContent).slice(-6)))

// 右侧窗口上下分区：上面历史（自己滚），下面详情
const scroller = [...document.querySelectorAll('div')].find((el) => el.style.overflowY === 'auto' && String(el.textContent).includes('版本 4'))
const column = scroller && scroller.parentElement && scroller.parentElement.parentElement
check('历史列表自己滚轮滑动', !!scroller, '')
check('历史在详情上面（同一个右栏，上下切开）', !!column && String(column.textContent).includes('点一个节点看详情') && column.innerHTML.indexOf('版本 4') < column.innerHTML.indexOf('点一个节点看详情'), '')
check('历史上方有独立的「保存快照」按钮', !!btn('保存快照'), JSON.stringify([...document.querySelectorAll('button')].map((el) => el.textContent).slice(-10)))
check('没选中行时没有删除按钮（得先选中）', !byTitle('删除快照'), '')

// 点版本行 = 只选中（出现删除按钮），不自动往画布上糊对照
act(() => { rowBtn(4).dispatchEvent(new window.MouseEvent('click', { bubbles: true })) })
await act(async () => { await Promise.resolve(); await Promise.resolve() })
check('点行只选中，不自动开对照', !!byTitle('删除快照') && !posts.some((p) => p.body && p.body.action === 'show'), JSON.stringify(posts))
check('没开眼睛时画布上没有虚线对照框', !svgTexts().includes('旧节点'), JSON.stringify(svgTexts()))

// 眼睛：打开才取版本内容并叠到画布（旧版本有、现在没有的节点画成虚线灰框）
act(() => { byTitle('对照显示').dispatchEvent(new window.MouseEvent('click', { bubbles: true })) })
await act(async () => { await Promise.resolve(); await Promise.resolve() })
check('开眼睛才向后端取那一版', posts.some((p) => p.url.includes('/filegraph/history') && p.body && p.body.action === 'show' && p.body.n === 4), JSON.stringify(posts))
check('对照叠出了旧节点', svgTexts().includes('旧节点'), JSON.stringify(svgTexts()))
const ghostRect = [...document.querySelectorAll('rect')].find((el) => el.getAttribute('stroke') === '#94a3b8' && el.getAttribute('stroke-dasharray'))
check('旧节点用虚线灰框（只读，不挡操作）', !!ghostRect, '')

// 眼睛关掉：对照消失；再开：用缓存，不再请求
act(() => { byTitle('对照显示').dispatchEvent(new window.MouseEvent('click', { bubbles: true })) })
await act(async () => { await Promise.resolve() })
check('关眼睛后对照消失', !svgTexts().includes('旧节点'), JSON.stringify(svgTexts()))
const showCount = posts.filter((p) => p.body && p.body.action === 'show').length
act(() => { byTitle('对照显示').dispatchEvent(new window.MouseEvent('click', { bubbles: true })) })
await act(async () => { await Promise.resolve(); await Promise.resolve() })
check('再开眼睛直接读缓存，不重复请求', posts.filter((p) => p.body && p.body.action === 'show').length === showCount, String(posts.length))

// 保存快照：与保存分开的独立动作
act(() => { btn('保存快照').dispatchEvent(new window.MouseEvent('click', { bubbles: true })) })
await act(async () => { await Promise.resolve(); await Promise.resolve() })
check('点「保存快照」会发 snapshot', posts.some((p) => p.url.includes('/filegraph/history') && p.body && p.body.action === 'snapshot'), JSON.stringify(posts))

// 删除快照：先选中才会出现按钮，点了才发 delete
act(() => { byTitle('删除快照').dispatchEvent(new window.MouseEvent('click', { bubbles: true })) })
await act(async () => { await Promise.resolve(); await Promise.resolve() })
check('点删除会发 delete（带这一行的版本号）', posts.some((p) => p.url.includes('/filegraph/history') && p.body && p.body.action === 'delete' && p.body.n === 4), JSON.stringify(posts))

// 回到此版本：发 restore，成功后清掉对照
act(() => { byTitle('回到此版本').dispatchEvent(new window.MouseEvent('click', { bubbles: true })) })
await act(async () => { await Promise.resolve(); await Promise.resolve() })
check('回到此版本会发 restore', posts.some((p) => p.url.includes('/filegraph/history') && p.body && p.body.action === 'restore' && p.body.n === 4), JSON.stringify(posts))
check('回到旧版本后对照自动清掉', !svgTexts().includes('旧节点'), JSON.stringify(svgTexts()))

console.log(fail.length === 0 ? 'ALL OK' : 'FAILED: ' + fail.join(' / '))
process.exit(fail.length === 0 ? 0 : 1)
