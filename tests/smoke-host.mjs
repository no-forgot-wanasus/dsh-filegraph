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
// 说明必须落在 .drawio 里（UserObject 的 note 属性），不是只存 graph.json
const noteText = fs.readFileSync(drawio, 'utf8')
assert('说明写进了 .drawio', /<UserObject[^>]*note="备注内容"/.test(noteText), noteText.slice(0, 200))
await step('import again', '/filegraph/import', { path: drawio })
d = await data()
assert('重读 .drawio 后备注还在', d.nodeNotes && d.nodeNotes['A'] === '备注内容', JSON.stringify(d.nodeNotes))

await step('position', '/filegraph/position', { positions: { [idA]: { x: 40, y: 50 } } })
await step('drag', '/filegraph/drag', { entries: [{ id: idA, x: 210, y: 96 }] })
d = await data()
assert('手拖直接写绝对坐标（位置只存一份）', d.flowPositions && d.flowPositions[idA] && d.flowPositions[idA].x === 210 && d.flowPositions[idA].y === 96, JSON.stringify(d.flowPositions && d.flowPositions[idA]))
assert('没有 drags 这一层了', d.drags === undefined, '')

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
assert('wrap 输入端口来自入边（末尾多留一个空口）', wg && wg.inputs.join(',') === '送进去,输入 2', JSON.stringify(wg && wg.inputs))
assert('wrap 输出端口来自出边（末尾多留一个空口）', wg && wg.outputs.join(',') === '写出,输出 2', JSON.stringify(wg && wg.outputs))
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
assert('嵌套组端口保留', !!(innerGroupNode && innerGroupNode.inputs.join(',') === '送进去,输入 2'), JSON.stringify(innerGroupNode && innerGroupNode.inputs))
assert('原组数据还在', !!d.groups[wgid], '')

// 同一个组输入口被两条线接 → 自动拆开，并保持 n+1（多留一个空口）
const gNew = (await step('make group for ports', '/filegraph/group', { action: 'create', name: '端口组' })).json.created
const gpA = (await step('node for group port A', '/filegraph/node', { name: 'GPA' })).json.added
const gpB = (await step('node for group port B', '/filegraph/node', { name: 'GPB' })).json.added
await step('edge to group port 0', '/filegraph/edge', { fromId: gpA, toId: gNew, toPort: 0 })
await step('edge to group port 0 again', '/filegraph/edge', { fromId: gpB, toId: gNew, toPort: 0 })
await step('touch group', '/filegraph/group', { action: 'rename', id: gNew, name: '端口组2' })
d = await data()
const gpPorts = d.groups[gNew]
const inFlows = (d.flows || []).filter((f) => f.toId === gNew)
assert('同一个输入口的两条线被拆成两个口', new Set(inFlows.map((f) => f.toPort)).size === inFlows.length, JSON.stringify(inFlows.map((f) => f.toPort)))
assert('组输入保持 n+1（已接 + 一个空口）', gpPorts.inputs.length === inFlows.length + 1, JSON.stringify(gpPorts.inputs))
assert('组输出也留了空口', gpPorts.outputs.length === 1, JSON.stringify(gpPorts.outputs))

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

// Ctrl+Z：撤销新增节点、撤销剪切（含组内删线）
const beforeUndo = (await data()).flowNodes.length
await step('node for undo', '/filegraph/node', { name: 'UNDO1' })
assert('新增节点成功', (await data()).flowNodes.length === beforeUndo + 1, '')
await step('undo add', '/filegraph/undo', {})
assert('Ctrl+Z 撤回新增节点', (await data()).flowNodes.length === beforeUndo, '')

const u1 = (await step('undo node U1', '/filegraph/node', { name: 'U1' })).json.added
const u2 = (await step('undo node U2', '/filegraph/node', { name: 'U2' })).json.added
await step('undo edge U1U2', '/filegraph/edge', { fromId: u1, toId: u2, verb: '回退用' })
const beforeCutFlows = (await data()).flows.length
const cutTarget = (await data()).flows.find((f) => f.fromId === u1 && f.toId === u2)
await step('cut for undo', '/filegraph/remove-edge', { edges: [{ id: cutTarget.id }] })
assert('剪切生效', (await data()).flows.length === beforeCutFlows - 1, '')
await step('undo cut', '/filegraph/undo', {})
assert('Ctrl+Z 撤回剪切', (await data()).flows.length === beforeCutFlows, '')

// 组内删线也能回退（组数据只在 graph.json 里，原来回退不了就是这个原因）
const gd = (await step('undo group', '/filegraph/group', { action: 'create', name: '回退组' })).json.created
const gFlowEdge = await step('undo group edge', '/filegraph/edge', { fromId: u1, toId: gd, verb: '进组' })
assert('建组内边', gFlowEdge.json && gFlowEdge.json.added === true, '')
const groupFlowsBefore = (await data()).groups[gd].flows.length
await step('cut in group', '/filegraph/group', { action: 'save', id: gd, data: { ...(await data()).groups[gd], flows: [] } })
assert('组内删线生效', (await data()).groups[gd].flows.length === 0, '')
await step('undo group cut', '/filegraph/undo', {})
assert('Ctrl+Z 撤回组内删线', (await data()).groups[gd].flows.length === groupFlowsBefore, '')

// 回退步数：范围 10~1000、默认 30；超出步数的旧快照不保存（文件不会越滚越大）
let st = await step('set depth 5', '/filegraph/settings', { undoDepth: 5 })
assert('步数下限夹到 10', st.json && st.json.settings.undoDepth === 10, JSON.stringify(st.json && st.json.settings))
st = await step('set depth 5000', '/filegraph/settings', { undoDepth: 5000 })
assert('步数上限夹到 1000', st.json && st.json.settings.undoDepth === 1000, JSON.stringify(st.json && st.json.settings))
await step('set depth 10', '/filegraph/settings', { undoDepth: 10 })
const depthEcho = await step('read depth', '/filegraph/settings', {})
assert('步数设置为 10 生效', depthEcho.json && depthEcho.json.settings.undoDepth === 10, JSON.stringify(depthEcho.json && depthEcho.json.settings))
for (let i = 0; i < 14; i += 1) await step('mut ' + i, '/filegraph/node', { name: 'UD' + i })
await new Promise((r) => setTimeout(r, 1600))
const activeGraphFile = (await data()).active.graphFile
const undoPath = activeGraphFile + '.undo.json'
const undoFile = fs.existsSync(undoPath) ? JSON.parse(fs.readFileSync(undoPath, 'utf8')) : null
assert('回退栈落盘了', Array.isArray(undoFile) && undoFile.length > 0, undoPath)
assert('超出 10 步的旧快照不保存', Array.isArray(undoFile) && undoFile.length <= 10, undoFile ? String(undoFile.length) : 'no file')
assert('落盘的快照带版本号（往期历史要按编号排）', undoFile && undoFile.every((item) => item && Number(item.n) > 0 && typeof item.graph === 'string'), JSON.stringify(undoFile && undoFile[0] && Object.keys(undoFile[0])))

// 往期历史 = 手动文件快照（每点一次新增一份「版本 N」；真源不做自动保存）
const drawioNow = (await data()).settings.drawioFile
const histDir = path.join(path.dirname(drawioNow), path.basename(drawioNow).replace(/\.[^.]+$/, '') + ' 历史')
const emptyHist = await step('history list', '/filegraph/history', { action: 'list' })
assert('还没存快照时列表为空', ((emptyHist.json && emptyHist.json.history) || []).length === 0, JSON.stringify(emptyHist.json))
const nodesAtSnap1 = (await data()).flowNodes.length
const snap1 = await step('history snapshot 1', '/filegraph/history', { action: 'snapshot' })
assert('手动快照 1：版本 1', snap1.json && snap1.json.snapshot && snap1.json.snapshot.n === 1, JSON.stringify(snap1.json && snap1.json.snapshot))
assert('快照是真文件：版本 1.drawio + 版本 1.graph.json',
  fs.existsSync(path.join(histDir, '版本 1.drawio')) && fs.existsSync(path.join(histDir, '版本 1.graph.json')),
  fs.existsSync(histDir) ? fs.readdirSync(histDir).join(' ') : 'no dir')
await step('add node after snapshot', '/filegraph/node', { name: '快照后新增' })
const snap2 = await step('history snapshot 2', '/filegraph/history', { action: 'snapshot' })
assert('再点保存快照 = 新增版本 2（不覆盖）',
  snap2.json && (snap2.json.history || []).length === 2 && snap2.json.snapshot.n === 2,
  JSON.stringify(snap2.json && snap2.json.snapshot))
assert('两个手动快照文件都在', fs.existsSync(path.join(histDir, '版本 2.drawio')), fs.readdirSync(histDir).join(' '))

// 普通「保存」只写正在用的 .drawio，不再自动生成快照
await step('save once', '/filegraph/save', {})
const afterSave = await data()
assert('保存不会自动新增快照（真源不自动快照）', (afterSave.history || []).length === 2, JSON.stringify((afterSave.history || []).map((v) => v.n)))

const shown = await step('history show', '/filegraph/history', { action: 'show', n: 1 })
assert('能取到手动快照里的图（对照用）', shown.json && Array.isArray(shown.json.version.flowNodes) && typeof shown.json.version.flowPositions === 'object', JSON.stringify(shown.json && shown.json.version && Object.keys(shown.json.version)))
const restored = await step('history restore', '/filegraph/history', { action: 'restore', n: 1 })
assert('能回到这份快照', restored.json && restored.json.ok === true, JSON.stringify(restored.json && restored.json.error))
assert('回滚后节点数等于快照时的数量', (await data()).flowNodes.length === nodesAtSnap1, JSON.stringify({ now: (await data()).flowNodes.length, want: nodesAtSnap1 }))
const beforeDeleteCount = ((await data()).history || []).length
const del = await step('history delete', '/filegraph/history', { action: 'delete', n: 1 })
assert('能删除快照', del.json && del.json.ok === true && (del.json.history || []).length === beforeDeleteCount - 1, JSON.stringify(del.json && del.json.error))
assert('删除后快照文件也删了', !fs.existsSync(path.join(histDir, '版本 1.drawio')) && !fs.existsSync(path.join(histDir, '版本 1.graph.json')), '')
const snap3 = await step('history snapshot after delete', '/filegraph/history', { action: 'snapshot' })
assert('删掉后编号继续往上、不复用旧号', snap3.json && snap3.json.snapshot.n === 3, JSON.stringify(snap3.json && snap3.json.snapshot))
await step('history delete 2', '/filegraph/history', { action: 'delete', n: 2 })
await step('history delete 3', '/filegraph/history', { action: 'delete', n: 3 })

// 工作流预设：一键画模板（主干一条线 + 侧枝）
await step('reset before preset', '/filegraph/reset', {})
const presetList = await step('preset list', '/filegraph/preset', { action: 'list' })
assert('能列出预设', presetList.json && Array.isArray(presetList.json.presets) && presetList.json.presets.length > 0, JSON.stringify(presetList.json))
const applied = await step('preset apply', '/filegraph/preset', { action: 'apply' })
assert('预设返回的节点/边数是数字（不和 payload 的 nodes/edges 撞名）',
  applied.json && applied.json.presetNodes === 8 && applied.json.presetEdges === 7,
  JSON.stringify({ presetNodes: applied.json && applied.json.presetNodes, presetEdges: applied.json && applied.json.presetEdges }))
d = await data()
const mainNames = ['需求', '设计', '制作', '检查', '交付']
const mainIds = mainNames.map((name) => ((d.flowNodes || []).find((n) => n.name === name) || {}).id)
assert('主干五个节点都在', mainIds.every(Boolean), JSON.stringify(mainIds))
const mainYs = new Set(mainIds.map((id) => d.flowPositions[id].y))
const mainXs = mainIds.map((id) => d.flowPositions[id].x)
assert('主干排成一条横线（y 相同、x 递增）', mainYs.size === 1 && mainXs.every((x, i) => i === 0 || x > mainXs[i - 1]), JSON.stringify(mainXs))
const chainOk = mainIds.slice(1).map((id, i) => (d.flows || []).some((f) => f.fromId === mainIds[i] && f.toId === id))
assert('主干按顺序连成线', chainOk.every(Boolean), JSON.stringify(chainOk))
const sideNames = ['参考素材', 'AI 生成', '修订']
const sideIds = sideNames.map((name) => ((d.flowNodes || []).find((n) => n.name === name) || {}).id)
assert('侧枝挂在主干下面（y 更低）', sideIds.every((id) => id && d.flowPositions[id].y > d.flowPositions[mainIds[0]].y), JSON.stringify(sideIds.map((id) => id && d.flowPositions[id])))
assert('侧枝各有一条线进来', sideIds.every((id) => (d.flows || []).some((f) => f.toId === id)), '')
assert('预设里没有回环', (d.flows || []).every((f) => f.fromId !== f.toId), '')

await step('reset', '/filegraph/reset', {})
d = await data()
assert('清空后无画布', (d.flowNodes || []).length === 0 && (d.flows || []).length === 0 && Object.keys(d.groups || {}).length === 0, '')

const bad = results.filter((r) => r[2] !== true && r[2] !== 'n/a')
console.log('routes registered:', handlers.size)
for (const r of results) console.log(String(r[0]).padEnd(22), String(r[1]).padEnd(6), String(r[2]).padEnd(6), r[3] || '')
console.log(bad.length === 0 ? 'ALL OK' : 'FAILED: ' + JSON.stringify(bad))
console.log('files:', fs.readdirSync(T).join(' '))
fs.rmSync(T, { recursive: true, force: true })
