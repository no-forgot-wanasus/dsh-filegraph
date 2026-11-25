/**
 * `relation_draw` 工具的自测 —— 不需要 DSH 在跑，也不碰真实项目。
 *
 * 用一个临时的 DSH_HOME 建一份空项目，直接走 `apply()` 注册出来的工具：
 *   1) 工具注册成功、声明了 output（DSH 加载工具时强制要求）；
 *   2) 空图上画节点与关系，写进 `.drawio`（节点名、动作词、备注都在）；
 *   3) 故意摆两条交叉的线 —— 必须被打回，且一个字节都不写。
 *
 * 用法：node tests/smoke-relation-tool.mjs
 */
import { promises as fsp } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const entry = pathToFileURL(path.join(here, '..', 'index.js')).href

let failures = 0
let checks = 0
function ok(condition, label) {
  checks += 1
  if (condition) {
    console.log('  ✓ ' + label)
    return true
  }
  failures += 1
  console.log('  ✗ ' + label)
  return false
}

const home = await fsp.mkdtemp(path.join(os.tmpdir(), 'filegraph-tool-'))
process.env.DSH_HOME = home
const root = path.join(home, 'proj')
await fsp.mkdir(root, { recursive: true })
const drawio = path.join(root, 'test.drawio')
const graphFile = path.join(root, 'test.graph.json')

await fsp.writeFile(drawio, '')
await fsp.writeFile(
  graphFile,
  JSON.stringify({
    version: 3,
    root,
    updatedAt: 0,
    seq: 0,
    flowSeq: 0,
    edgeSeq: 0,
    nodes: {},
    windows: {},
    sources: {},
    positions: {},
    flowNodes: [],
    flowPositions: {},
    nodeNotes: {},
    groups: {},
    flows: [],
  }),
)
await fsp.mkdir(path.join(home, 'storages', 'filegraph'), { recursive: true })
await fsp.writeFile(
  path.join(home, 'storages', 'filegraph', 'settings.json'),
  JSON.stringify({ graphFile: '', drawioFile: drawio, undoDepth: 30, projects: { [root]: { graphFile, updatedAt: Date.now(), nodeCount: 0 } } }),
)

const plugin = await import(entry)
const tools = new Map()
plugin.apply(
  {
    tools: { register: (tool) => tools.set(tool.name, tool) },
    webServer: { register: () => {} },
    on: () => {},
    effect: () => {},
    workingDirectory: {},
  },
  {},
)

console.log('relation_draw 自测')

const tool = tools.get('relation_draw')
ok(Boolean(tool), '工具注册出来了')
ok(Boolean(tool && tool.output && tool.output.schema && typeof tool.output.render === 'function'), '声明了 output { schema, render }')

const drawn = await tool.execute(
  {
    ops: [
      { op: 'addNode', name: '节律', note: '每天唤醒' },
      { op: 'addNode', name: '输入' },
      { op: 'addNode', name: '思考' },
      { op: 'addEdge', from: '节律', to: '输入', verb: '叫醒' },
      { op: 'addEdge', from: '输入', to: '思考', verb: '取数' },
    ],
  },
  {},
)
ok(drawn.nodeCount === 3 && drawn.edgeCount === 2, '画出 3 节点 2 关系')
const xml = await fsp.readFile(drawio, 'utf8')
ok(xml.indexOf('节律') >= 0 && xml.indexOf('思考') >= 0, '节点名写进了 .drawio')
ok(xml.indexOf('叫醒') >= 0, '动作词写进了 .drawio')
ok(xml.indexOf('每天唤醒') >= 0, '备注写进了 .drawio（UserObject note）')

const before = await fsp.readFile(drawio, 'utf8')
let rejected = false
try {
  await tool.execute(
    {
      ops: [
        { op: 'addNode', name: 'X', x: 0, y: 0 },
        { op: 'addNode', name: 'Y', x: 500, y: 0 },
        { op: 'addNode', name: 'P', x: 250, y: 220 },
        { op: 'addNode', name: 'Q', x: 250, y: -220 },
        { op: 'addEdge', from: 'X', to: 'Y' },
        { op: 'addEdge', from: 'P', to: 'Q' },
      ],
    },
    {},
  )
} catch (error) {
  rejected = /相交/.test(error.message)
}
ok(rejected, '摆出交叉的两条线 → 整次打回')
ok((await fsp.readFile(drawio, 'utf8')) === before, '打回时一个字节都没写')

await fsp.rm(home, { recursive: true, force: true })

console.log('')
if (failures === 0) console.log('全部通过：' + checks + ' 项')
else console.log('失败 ' + failures + ' / ' + checks)
process.exit(failures === 0 ? 0 : 1)
