// 冒烟测试：把全部路由打一遍，确认新模型（独立节点 id / 节点组 / 无框）没断。
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const T = path.join(os.tmpdir(), 'fg-smoke-' + Date.now())
fs.mkdirSync(T, { recursive: true })
process.env.DSH_HOME = path.join(T, 'dshhome')
fs.writeFileSync(path.join(T, 'a.js'), "import b from './b.js'\nexport const x = 1\n")
fs.writeFileSync(path.join(T, 'b.js'), 'export default 2\n')

const handlers = new Map()
const ctx = {
  effect: (fn) => fn(),
  on: () => {},
  webServer: { register: (r) => handlers.set(r.path, r.handler) },
  workingDirectory: { defaultDirectory: T, ensure: async () => T },
}

const mod = await import('../index.js')
mod.apply(ctx, {})

function makeReq(method, url, body) {
  const chunks = body === undefined ? [] : [Buffer.from(JSON.stringify(body))]
  return {
    method,
    url,
    headers: { 'x-filegraph': '1' },
    async *[Symbol.asyncIterator]() {
      for (const c of chunks) yield c
    },
  }
}

async function call(route, body, method = 'POST') {
  const handler = handlers.get(route)
  if (!handler) return { missing: route }
  let status = 0
  let text = ''
  const res = {
    writeHead: (s) => { status = s },
    end: (b) => { text = b || '' },
  }
  await handler(makeReq(method, route, body), res)
  let json = null
  try { json = JSON.parse(text) } catch { json = { raw: text.slice(0, 120) } }
  return { status, ok: json && json.ok, json, error: json && json.error }
}

const results = []
const step = async (label, route, body, method) => {
  try {
    const r = await call(route, body, method)
    results.push([label, r.status, r.ok === undefined ? 'n/a' : r.ok, r.error])
    return r
  } catch (error) {
    results.push([label, 'THROW', error.message])
    return { error: error.message }
  }
}
const assert = (label, condition, detail) => {
  if (!condition) results.push([label, 'ASSERT', 'FAIL', detail])
}

const data = async (root) => (await call('/filegraph/data' + (root ? '?root=' + encodeURIComponent(root) : ''), undefined, 'GET')).json

const drawio = path.join(T, '项目关系图.drawio')
await step('data', '/filegraph/data', undefined, 'GET')
await step('list', '/filegraph/list', undefined, 'GET')
await step('scan first', '/filegraph/scan', { root: T })
await step('new', '/filegraph/new', { path: drawio, overwrite: true })

const na = await step('node A', '/filegraph/node', { name: 'A' })
const idA = na.json && na.json.added
assert('node A id', typeof idA === 'string' && idA.length > 0, JSON.stringify(na.json && na.json.added))
const nb = await step('node B', '/filegraph/node', { name: 'B' })
const idB = nb.json && nb.json.added
const np = await step('node 定点', '/filegraph/node', { name: 'P1', x: 500, y: 400 })
const idP = np.json && np.json.added
let d = await data()
assert('定点坐标', d && d.flowPositions && d.flowPositions[idP] && d.flowPositions[idP].x === 500, JSON.stringify(d.flowPositions && d.flowPositions[idP]))

// 同名节点：再放一个 A，id 不同、名字相同
const dup = await step('duplicate', '/filegraph/duplicate', { id: idA })
const idA2 = dup.json && dup.json.copy
assert('同名节点独立 id', idA2 && idA2 !== idA, idA2)
d = await data()
const sameName = (d.flowNodes || []).filter((node) => node.name === 'A')
assert('同名节点数量', sameName.length === 2, JSON.stringify(sameName))

const e1 = await step('edge', '/filegraph/edge', { fromId: idA, toId: idB, verb: '写入' })
assert('edge added', e1.json && e1.json.added === true, JSON.stringify(e1.json && e1.json.added))
d = await data()
const flowAB = (d.flows || []).find((flow) => flow.fromId === idA && flow.toId === idB)
assert('flow 以 id 存', !!flowAB, JSON.stringify(d.flows))

await step('rename-node', '/filegraph/rename-node', { id: idB, name: 'C' })
d = await data()
assert('节点改名只改实例', (d.flowNodes || []).filter((node) => node.name === 'C').length === 1, '')

// 长名字必须原样存回
const longVerb = '读入 配置：从 settings.json 取保存目录（长名不许被简化）'
await step('rename-edge 长名', '/filegraph/rename-edge', { id: flowAB.id, verb: longVerb })
d = await data()
const back = (d.flows || []).find((flow) => flow.id === flowAB.id)
assert('长动作词不截断', back && back.verb === longVerb, JSON.stringify(back && back.verb))

// 节点组：创建 / 存内部 / 加端口 / 改名 / 保留 id
const ng = await step('group create', '/filegraph/group', { action: 'create', name: '计算组' })
const gid = ng.json && ng.json.created
assert('group created', typeof gid === 'string', JSON.stringify(ng.json && ng.json.created))
d = await data()
const g0 = d.groups[gid]
assert('group gin/gout', g0 && g0.nodes.some((n) => n.id === 'gin') && g0.nodes.some((n) => n.id === 'gout'), '')
assert('group 默认端口', g0 && g0.inputs.length === 1 && g0.outputs.length === 1, JSON.stringify(g0 && [g0.inputs, g0.outputs]))

await step('group save', '/filegraph/group', {
  action: 'save',
  id: gid,
  data: {
    name: '计算组',
    inputs: ['密度', '随机种'],
    outputs: ['网格'],
    nodes: [
      { id: 'gn1', name: '分布点', kind: 'node', x: 200, y: 100, inputs: ['体积'], outputs: ['点'] },
    ],
    flows: [{ id: 'ge1', fromId: 'gn1', toId: 'gout', fromPort: 0, toPort: 0, verb: '点' }],
    notes: { '分布点': '把体积变成点' },
  },
})
d = await data()
const g1 = d.groups[gid]
assert('group 内部节点', g1 && g1.nodes.some((n) => n.name === '分布点'), '')
assert('group 端口同步到 gin', g1 && g1.nodes.find((n) => n.id === 'gin').outputs.join(',') === '密度,随机种', JSON.stringify(g1 && g1.nodes.find((n) => n.id === 'gin')))
assert('group 连线保留', g1 && g1.flows.length === 1, '')
assert('group 备注独立', g1 && g1.notes['分布点'] === '把体积变成点', '')

await step('group rename', '/filegraph/group', { action: 'rename', id: gid, name: '几何组' })
d = await data()
assert('组改名同步节点名', (d.flowNodes || []).find((node) => node.id === gid).name === '几何组', '')

// 主画布连到节点组
await step('edge to group', '/filegraph/edge', { fromId: idP, toId: gid, verb: '送进去' })
d = await data()
assert('连到节点组', (d.flows || []).some((flow) => flow.fromId === idP && flow.toId === gid), '')

// 画布写回与重读：.drawio 里节点 id 不丢
const text = fs.readFileSync(drawio, 'utf8')
assert('drawio 写了节点 id', text.includes('id="' + idA + '"') && text.includes('id="' + gid + '"'), '')
assert('drawio 写了组样式', /fillColor=#1d4ed8/i.test(text), '')
await step('import', '/filegraph/import', { path: drawio })
d = await data()
assert('重读后节点还在', (d.flowNodes || []).length >= 5, String((d.flowNodes || []).length))
assert('重读后组还在', !!d.groups[gid], '')
const gBack = d.groups[gid]
assert('重读后组内部还在', gBack && gBack.nodes.some((n) => n.name === '分布点'), '')

await step('note', '/filegraph/note', { name: 'A', text: '备注内容' })
d = await data()
assert('备注按名字存', d.nodeNotes && d.nodeNotes['A'] === '备注内容', '')

await step('position', '/filegraph/position', { positions: { [idA]: { x: 40, y: 50 } } })
await step('drag', '/filegraph/drag', { entries: [{ id: idA, dx: 10, dy: 12 }] })
d = await data()
assert('拖动矢量按 id 存', d.drags && d.drags[idA] && d.drags[idA].dx === 10, JSON.stringify(d.drags))

// 旧的“框”必须彻底没了
assert('frame 路由已删除', handlers.get('/filegraph/frame') === undefined, '')
assert('ghost 路由已删除', handlers.get('/filegraph/ghost') === undefined && handlers.get('/filegraph/ghost-edge') === undefined, '')
d = await data()
assert('payload 没有 frames', d.frames === undefined && d.nodeFrame === undefined, '')

await step('flow-add', '/filegraph/flow', { flows: [{ from: 'A', to: 'C', verb: '读取' }] })
await step('flow-list', '/filegraph/flow', {})
await step('scan', '/filegraph/scan', { root: T })
await step('window', '/filegraph/window', { id: 'sess1', group: '前端', name: '输入窗口' })
await step('settings', '/filegraph/settings', { graphFile: path.join(T, 'graph.json') })
await step('import again', '/filegraph/import', { path: drawio })
await step('open', '/filegraph/open', { path: drawio })
await step('export', '/filegraph/export', { path: path.join(T, '副本.drawio'), switchTo: false })
await step('export-md', '/filegraph/export-md', { path: path.join(T, '关系.md') })
const md = fs.readFileSync(path.join(T, '关系.md'), 'utf8')
assert('导出文档含节点组', md.includes('## 节点组') && md.includes('几何组'), '')

await step('prune', '/filegraph/prune', {})
d = await data()
const flowId = (d.flows && d.flows[0] && d.flows[0].id) || ''
await step('remove-edge', '/filegraph/remove-edge', { edges: [{ id: flowId }] })
d = await data()
assert('按 id 删边', !(d.flows || []).some((flow) => flow.id === flowId), '')
await step('remove-node', '/filegraph/remove-node', { id: idA })
d = await data()
assert('删节点', !(d.flowNodes || []).some((node) => node.id === idA), '')

await step('group delete', '/filegraph/group', { action: 'delete', id: gid })
d = await data()
assert('删组', !d.groups[gid] && !(d.flowNodes || []).some((node) => node.id === gid), '')

// 框选几个节点 → 收进节点组（跨边界的线自动变成组端口）
await step('reset before wrap', '/filegraph/reset', {})
const wx = (await step('wrap node X', '/filegraph/node', { name: 'X', x: 100, y: 100 })).json.added
const wy = (await step('wrap node Y', '/filegraph/node', { name: 'Y', x: 340, y: 100 })).json.added
const wz = (await step('wrap node Z', '/filegraph/node', { name: 'Z', x: 600, y: 100 })).json.added
const ww = (await step('wrap node W', '/filegraph/node', { name: 'W', x: 600, y: 300 })).json.added
await step('wrap edge XY', '/filegraph/edge', { fromId: wx, toId: wy, verb: '激活' })
await step('wrap edge ZX', '/filegraph/edge', { fromId: wz, toId: wx, verb: '送进去' })
await step('wrap edge YW', '/filegraph/edge', { fromId: wy, toId: ww, verb: '写出' })
const wrapped = await step('wrap selection', '/filegraph/group', { action: 'wrap', ids: [wx, wy] })
const wgid = wrapped.json && wrapped.json.created
assert('wrap 生成组', typeof wgid === 'string', JSON.stringify(wrapped.json && wrapped.json.created))
d = await data()
const wg = d.groups[wgid]
assert('wrap 节点移进组里', wg && wg.nodes.some((n) => n.id === wx) && wg.nodes.some((n) => n.id === wy), '')
assert('wrap 顶层不再有原节点', !(d.flowNodes || []).some((n) => n.id === wx || n.id === wy), '')
assert('wrap 输入端口来自入边', wg && wg.inputs.join(',') === '送进去', JSON.stringify(wg && wg.inputs))
assert('wrap 输出端口来自出边', wg && wg.outputs.join(',') === '写出', JSON.stringify(wg && wg.outputs))
assert('wrap 内部保留 XY 边', wg && wg.flows.some((f) => f.fromId === wx && f.toId === wy), '')
assert('wrap 内部接上 gin', wg && wg.flows.some((f) => f.fromId === 'gin' && f.toId === wx), '')
assert('wrap 内部接上 gout', wg && wg.flows.some((f) => f.fromId === wy && f.toId === 'gout'), '')
assert('wrap 外部边改指组', (d.flows || []).some((f) => f.fromId === wz && f.toId === wgid), '')
assert('wrap 组出边从组出发', (d.flows || []).some((f) => f.fromId === wgid && f.toId === ww), '')

// 节点组也能被收进另一个节点组（端口要跟过去）
const wrapped2 = await step('wrap with group node', '/filegraph/group', { action: 'wrap', ids: [wgid, wz] })
const outerId = wrapped2.json && wrapped2.json.created
d = await data()
const innerGroupNode = outerId && (d.groups[outerId].nodes || []).find((n) => n.id === wgid)
assert('节点组可以放进节点组', !!(innerGroupNode && innerGroupNode.kind === 'group'), '')
assert('嵌套组端口保留', !!(innerGroupNode && innerGroupNode.inputs.join(',') === '送进去'), JSON.stringify(innerGroupNode && innerGroupNode.inputs))
assert('原组数据还在', !!d.groups[wgid], '')

// 解散节点组（嵌套）：外层组解散 → 里面的节点组回到顶层，组数据还在
await step('ungroup outer', '/filegraph/group', { action: 'ungroup', id: outerId })
d = await data()
assert('解散外层组：组节点回到顶层', (d.flowNodes || []).some((n) => n.id === wgid && n.kind === 'group'), '')
assert('解散后原组数据还在', !!d.groups[wgid], '')
assert('解散后外层组已删除', !d.groups[outerId], '')

// 解散节点组（顶层）：跨边界的线按端口接回外部
await step('reset before ungroup', '/filegraph/reset', {})
const up = (await step('ungroup node P', '/filegraph/node', { name: 'P', x: 100, y: 100 })).json.added
const uq = (await step('ungroup node Q', '/filegraph/node', { name: 'Q', x: 340, y: 100 })).json.added
const ur = (await step('ungroup node R', '/filegraph/node', { name: 'R', x: 600, y: 100 })).json.added
await step('ungroup edge PQ', '/filegraph/edge', { fromId: up, toId: uq, verb: '送入' })
await step('ungroup edge QR', '/filegraph/edge', { fromId: uq, toId: ur, verb: '产出' })
const wrappedQ = await step('wrap Q', '/filegraph/group', { action: 'wrap', ids: [uq] })
const ugid = wrappedQ.json && wrappedQ.json.created
await step('ungroup Q group', '/filegraph/group', { action: 'ungroup', id: ugid })
d = await data()
assert('解散后节点回到顶层', (d.flowNodes || []).some((n) => n.id === uq), '')
assert('解散后组没了', !d.groups[ugid], '')
assert('解散后入边接回外部', (d.flows || []).some((f) => f.fromId === up && f.toId === uq), JSON.stringify(d.flows))
assert('解散后出边接回外部', (d.flows || []).some((f) => f.fromId === uq && f.toId === ur), '')
assert('解散后没有残留组端口边', !(d.flows || []).some((f) => f.fromId === ugid || f.toId === ugid), '')

await step('undo', '/filegraph/undo', {})
await step('save', '/filegraph/save', {})
await step('reset', '/filegraph/reset', {})
d = await data()
assert('清空后无画布', (d.flowNodes || []).length === 0 && (d.flows || []).length === 0 && Object.keys(d.groups || {}).length === 0, '')

const bad = results.filter((r) => r[2] !== true && r[2] !== 'n/a')
console.log('routes registered:', handlers.size)
for (const r of results) console.log(String(r[0]).padEnd(22), String(r[1]).padEnd(6), String(r[2]).padEnd(6), r[3] || '')
console.log(bad.length === 0 ? 'ALL OK' : 'FAILED: ' + JSON.stringify(bad))
console.log('files:', fs.readdirSync(T).join(' '))
fs.rmSync(T, { recursive: true, force: true })
