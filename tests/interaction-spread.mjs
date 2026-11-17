// 交互测试（需要 jsdom）：组端口「一根线一个口」
//   老数据里几条线都没存端口（fromPort/toPort 缺省）时，画面上也必须摊到不同端口，不能挤在一个点。
// 用法：node tests/interaction-spread.mjs "<react 所在 node_modules 目录>"
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

const gid = 'g1'
const fixture = {
  ok: true,
  active: { root: 'D:\\demo', graphFile: 'D:\\demo\\graph.json', updatedAt: 1, nodeCount: 4 },
  settings: { graphFile: 'D:\\demo\\graph.json', drawioFile: 'D:\\demo\\x.drawio' },
  nodes: [],
  windows: [],
  sources: [],
  edges: [],
  flowNodes: [
    { id: 'a', name: 'A', kind: 'node' },
    { id: 'b', name: 'B', kind: 'node' },
    { id: gid, name: '节点组 1', kind: 'group' },
    { id: 'c', name: 'C', kind: 'node' },
  ],
  // 三条出边、两条入边都没写端口（老数据就是这样）
  flows: [
    { id: 'i1', fromId: 'a', toId: gid, verb: '' },
    { id: 'i2', fromId: 'b', toId: gid, verb: '' },
    { id: 'o1', fromId: gid, toId: 'c', verb: '' },
    { id: 'o2', fromId: gid, toId: 'c', verb: '' },
    { id: 'o3', fromId: gid, toId: 'a', verb: '' },
  ],
  flowPositions: { a: { x: 40, y: 0 }, b: { x: 40, y: 160 }, [gid]: { x: 380, y: 60 }, c: { x: 760, y: 60 } },
  nodeNotes: {},
  groups: {
    [gid]: {
      id: gid,
      name: '节点组 1',
      note: '',
      inputs: ['上一级输入端', '该级输入端', '输入 3'],
      outputs: ['输入线', '输出线', '输出 3'],
      nodes: [
        { id: 'gin', name: '组输入', kind: 'input', x: 0, y: 60, inputs: [], outputs: ['上一级输入端', '该级输入端', '输入 3'] },
        { id: 'gout', name: '组输出', kind: 'output', x: 620, y: 60, inputs: ['输入线', '输出线', '输出 3'], outputs: [] },
      ],
      flows: [],
      notes: {},
      view: {},
    },
  },
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

/** 取每条连线命中路径的起点/终点 y（d = "M x y C ..."） */
const ends = () => [...document.querySelectorAll('path[stroke="transparent"]')].map((el) => {
  const nums = (el.getAttribute('d').match(/-?\d+(\.\d+)?/g) || []).map(Number)
  return { x1: nums[0], y1: nums[1], x2: nums[6], y2: nums[7] }
}).filter((item) => item.y1 !== undefined)

const all = ends()
check('5 条关系都画出来了', all.length === 5, String(all.length))

// 从组出发的三条：起点 y 必须三个不同
const outs = all.filter((e) => Math.abs(e.x1 - 380 - 200) < 2) // 组 x=380 + 宽度 200
const outYs = new Set(outs.map((e) => Math.round(e.y1)))
check('组的三条出线起点各不相同', outYs.size === 3, JSON.stringify([...outYs]))

// 进组的两条：终点 y 也必须两个不同
const ins = all.filter((e) => Math.abs(e.x2 - 380) < 2)
const inYs = new Set(ins.map((e) => Math.round(e.y2)))
check('组的两条入线终点各不相同', inYs.size === 2, JSON.stringify([...inYs]))

console.log(fail.length === 0 ? 'ALL OK' : 'FAILED: ' + fail.join(' / '))
process.exit(fail.length === 0 ? 0 : 1)
