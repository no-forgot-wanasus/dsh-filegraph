// 用正在跑的宿主返回的真实数据渲一遍面板：确认线上 payload 能过前端（不 crash、节点/关系数对得上）。
// 用法：node tests/smoke-live.mjs "<react 所在 node_modules 目录>" [http://127.0.0.1:PORT]
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'

const reactDir = process.argv[2]
const base = process.argv[3] || 'http://127.0.0.1:63930'
const requireFromReact = createRequire(path.join(reactDir, 'noop.js'))
const React = requireFromReact('react')
const { renderToStaticMarkup } = requireFromReact('react-dom/server')

const res = await fetch(base + '/filegraph/data', { headers: { 'x-filegraph': '1' } })
const fixture = await res.json()
if (!fixture || fixture.ok !== true) throw new Error('宿主返回不 ok：' + JSON.stringify(fixture).slice(0, 200))
console.log('宿主数据：flowNodes', (fixture.flowNodes || []).length, 'flows', (fixture.flows || []).length, 'groups', Object.keys(fixture.groups || {}).length, 'drawio', fixture.settings && fixture.settings.drawioFile)

global.window = {
  innerWidth: 1400,
  innerHeight: 900,
  addEventListener: () => {},
  removeEventListener: () => {},
  __FIXTURE__: fixture,
  __ModuleLoader__: { load(def) { global.__fgDef = def } },
}

const raw = fs.readFileSync(new URL('../client.js', import.meta.url), 'utf8')
const src = raw
  .replace('      open: false,', '      open: true,')
  .replace('      data: null,', '      data: window.__FIXTURE__ || null,')
const fn = new Function('window', 'fetch', 'setTimeout', 'clearTimeout', src)
fn(global.window, () => Promise.resolve({ json: () => Promise.resolve(fixture) }), setTimeout, clearTimeout)
const mod = global.__fgDef.factory((name) => {
  if (name === 'react') return React
  throw new Error('unexpected require: ' + name)
})
const comps = {}
mod.apply({ effect: (f) => f(), slots: { inject: (n, f) => f(), register: (spec, c) => { comps[spec.id] = c } } })
const overlay = comps['dsh-filegraph:panel']
const html = renderToStaticMarkup(React.createElement(overlay, {}))

const firstNodes = (fixture.flowNodes || []).slice(0, 5).map((n) => n.name)
const missing = firstNodes.filter((name) => !html.includes(name))
console.log('渲染长度', html.length, '| <g>', (html.match(/<g transform="translate\(/g) || []).length)
console.log('前 5 个节点都渲染出来:', missing.length === 0, missing.length ? '缺 ' + missing.join(',') : '')
console.log('旧宿主提示条:', html.includes('宿主还是旧版本'))
console.log('详情占位:', html.includes('点一个节点看详情'))
