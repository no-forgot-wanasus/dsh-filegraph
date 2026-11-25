/**
 * dsh-filegraph · Client 半边（显示名「关系」）
 *
 * 两个画布：
 *   FlowCanvas —— 关系画布：节点（独立 id）/ 关系（带动作）/ 节点组（蓝色、多端口、右键打开）；
 *   FlowCanvas —— 关系画布：节点、关系、节点组；详情栏 / 文件对话框 / 说明弹窗。
 * 节点信息（备注）按名字存：同名节点共用数据，但各有各的 id 与连线。
 */
window.__ModuleLoader__.load({
  id: '@local/dsh-filegraph',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useEffect, useMemo, useRef, useState, useSyncExternalStore, useCallback } = React

    const DATA_URL = '/filegraph/data'
    const SETTINGS_URL = '/filegraph/settings'
    const RESET_URL = '/filegraph/reset'
    const WINDOW_URL = '/filegraph/window'
    const SCAN_URL = '/filegraph/scan'
    const POSITION_URL = '/filegraph/position'
    const PRUNE_URL = '/filegraph/prune'
    const OPEN_URL = '/filegraph/open'
    const DRAG_URL = '/filegraph/drag'
    const EXPORT_URL = '/filegraph/export'
    const HISTORY_URL = '/filegraph/history'
    const POST_HEADERS = { 'content-type': 'application/json', 'x-filegraph': '1' }

    const WINDOW_COLOR = '#8b5cf6'
    const SOURCE_COLOR = '#f59e0b'
    const IN_COLOR = '#3b82f6'
    const OUT_COLOR = '#22c55e'

    /** 「操作说明」弹窗的唯一内容：快捷键 → 对应操作。只有这两列。 */
    const SHORTCUTS = [
      // 左键 / 拖动
      ['左键点节点', '选中，右侧看详情'],
      ['左键点空白', '取消选中，收起菜单'],
      ['左键拖节点', '摆位置'],
      ['左键拖空白', '平移画布'],
      ['左键拖输出端口 → 输入端口', '连一条关系'],
      ['左键拖过线', '什么都不做（剪线要按 Ctrl）'],
      // 组合键
      ['Shift + 左键点节点', '多选 / 取消多选'],
      ['Shift + 左键点线', '改动作词'],
      ['Shift + 左键拖空白', '框选'],
      ['Shift + A', '加节点；有框选时收进节点组'],
      ['Shift + D', '再放一个同名节点'],
      ['Ctrl + 左键拖过线', '剪掉划过的关系'],
      ['Ctrl + 左键点线', '剪掉这一条关系'],
      ['Ctrl + S', '保存'],
      ['Ctrl + Z', '回退一步'],
      ['Esc', '关弹窗 / 退出节点组 / 关面板'],
      // 右键
      ['右键节点', '打开节点组 / 解散 / 重命名 / 删除 / 再放同名'],
      ['右键组输入·组输出', '每个关系一个端口'],
      ['右键线', '改动作词 / 删除这条关系'],
      ['右键端口名', '重命名端口 / 删除端口'],
      ['右键空白', '添加节点 / 添加节点组 / 退出节点组'],
      // 其它
      ['左键拖端口到节点框上', '连一条关系'],
      ['滚轮', '缩放（不设上限）'],
      ['文件 ▾', '新建 / 打开 / 恢复 / 另存为 / 保存副本 / 导出关系文档'],
      ['全部 ▾', '全部 / 此节点关系 / 此节点链路'],
      ['⋯', '加节点 / 加节点组 / 工作流预设 / 设置 / 清空这张图'],
      ['左上角路径', '回到上一层节点组'],
    ]

    /* ------------------------------------------------------ 极简 store */

    const state = {
      open: false,
      loading: false,
      scanning: false,
      autoScanned: false,
      notice: '',
      data: null,
      error: null,
      selected: null,
      fileMenu: false,
      scopeMode: 'none',
      scopeDrags: {},
      moreMenu: false,
      viewMenu: false,
      filePrompt: '',
      fileDraft: '',
      newNode: '',
      ctxMenu: null,
      renameTarget: null,
      renameDraft: '',
      editing: false,
      draftName: '',
      draftGroup: '',
      showSettings: false,
      draft: null,
      addProject: false,
      draftRoot: '',
      nodePos: {},
      draggingIds: [],
      viewport: null,
      viewMode: 'flow',
      hostLegacy: false,
      picked: [],
      confirmReset: false,
      helpOpen: false,
      // 节点组：打开的是哪一级（栈顶 = 当前编辑的组）
      groupStack: [],
      // 往期历史：眼睛 = 这个版本叠在画布上对照；models 缓存版本内容（只读）
      historyEyes: {},
      historyPick: 0,
      historyModels: {},
      historyFile: '',
    }
    const subscribers = new Set()
    let revision = 0

    function notify() {
      revision += 1
      for (const fn of subscribers) fn()
    }
    function subscribe(fn) {
      subscribers.add(fn)
      return () => subscribers.delete(fn)
    }
    const useStore =
      typeof useSyncExternalStore === 'function'
        ? function useStoreExternal() {
            useSyncExternalStore(subscribe, () => revision, () => revision)
            return state
          }
        : function useStoreLegacy() {
            const [, force] = useState(0)
            useEffect(() => subscribe(() => force((value) => value + 1)), [])
            return state
          }

    /* --------------------------------------------------------- 数据 */

    async function load(root) {
      state.loading = true
      notify()
      try {
        const url = root ? DATA_URL + '?root=' + encodeURIComponent(root) : DATA_URL
        const res = await fetch(url, { headers: { 'x-filegraph': '1' }, cache: 'no-store' })
        const text = await res.text()
        let json = null
        try {
          json = text ? JSON.parse(text) : null
        } catch {
          throw new Error('宿主返回的不是 JSON')
        }
        if (!json) throw new Error('宿主没有返回数据，先完全退出 DSH 再打开')
        if (json.ok !== true) throw new Error(json.error || '读取失败')
        state.data = json
        state.error = null
        // 换了一张图：旧的对照缓存全部作废（版本号是每张图各自的）
        const nextFile = (json.active && json.active.graphFile) || ''
        if (nextFile !== state.historyFile) {
          state.historyFile = nextFile
          state.historyEyes = {}
          state.historyPick = 0
          state.historyModels = {}
        }
        // 旧宿主没有 flowNodes / 节点组接口：明确报出来，别让用户对着空白画布猜
        state.hostLegacy = !Array.isArray(json.flowNodes) && Array.isArray(json.flows)
        const nextPos = {}
        for (const [id, pos] of Object.entries(json.positions || {})) {
          // 正在拖的那些节点不接受服务端回包，免得拖到一半被拽回去。
          if (state.draggingIds.indexOf(id) >= 0) continue
          nextPos[id] = pos
        }
        state.nodePos = nextPos
        state.nodeNotes = (json && json.nodeNotes) || {}
        if (state.selected) {
          const ids = new Set()
          for (const node of json.nodes || []) ids.add('file:' + node.path)
          for (const win of json.windows || []) ids.add('win:' + win.id)
          for (const source of json.sources || []) ids.add('src:' + source.key)
          for (const flowNode of json.flowNodes || []) ids.add('f:' + flowNode.id)
          if (!ids.has(state.selected)) state.selected = null
        }
        // 节点组被删掉/换图了：退回上一层，别停在一个不存在的组里
        if (state.groupStack.length > 0) {
          const groups = (json && json.groups) || {}
          const stack = state.groupStack.filter((id) => groups[id])
          if (stack.length !== state.groupStack.length) {
            state.groupStack = stack
            state.selected = null
          }
        }
      } catch (error) {
        state.error = String((error && error.message) || error)
      } finally {
        state.loading = false
        notify()
      }
    }

    function activeRoot() {
      return state.data && state.data.active ? state.data.active.root : undefined
    }
    function openPanel() {
      state.open = true
      state.confirmReset = false
      state.autoScanned = false
      state.notice = ''
      state.scopeMode = 'none'
      state.groupStack = []
      notify()
      void load(activeRoot())
    }
    function closePanel() {
      state.open = false
      state.showSettings = false
      state.confirmReset = false
      notify()
    }
    function togglePanel() {
      if (state.open) closePanel()
      else openPanel()
    }
    async function selectProject(root) {
      state.selected = null
      await load(root)
    }
    async function postJson(url, body) {
      const res = await fetch(url, { method: 'POST', headers: POST_HEADERS, body: JSON.stringify(body) })
      const text = await res.text()
      let json = null
      try {
        json = text ? JSON.parse(text) : null
      } catch {
        throw new Error('宿主返回的不是 JSON')
      }
      // 空响应 = 宿主没有这个接口（多半是还挂着旧版宿主）
      if (!json) throw new Error('宿主没有这个接口，先完全退出 DSH 再打开')
      if (json.ok !== true) throw new Error(json.error || '操作失败')
      return json
    }
    async function savePath() {
      try {
        await postJson(SETTINGS_URL, { graphFile: state.draft ?? '', undoDepth: state.undoDraft })
        state.showSettings = false
        await load(undefined)
        state.notice =
          '关系文件已切到：' +
          ((state.data && state.data.active && state.data.active.graphFile) || state.draft || '默认位置')
        notify()
      } catch (error) {
        state.error = String((error && error.message) || error)
        notify()
      }
    }
    async function scanProject(root) {
      if (state.scanning) return
      state.scanning = true
      state.notice = '正在扫描项目里的文件…'
      notify()
      try {
        const json = await postJson(SCAN_URL, { root: root ?? activeRoot() })
        state.data = json
        state.error = null
        state.addProject = false
        state.notice =
          '扫描完成：' + (json.active ? json.active.root : '') +
          ' 新增 ' + (json.added || 0) + ' 个文件，共 ' + ((json.nodes || []).length) + ' 个节点'
      } catch (error) {
        state.error = String((error && error.message) || error)
        state.notice = ''
      } finally {
        state.scanning = false
        notify()
      }
    }
    async function saveWindow(id) {
      try {
        await postJson(WINDOW_URL, {
          root: activeRoot(),
          id,
          label: state.draftName,
          group: state.draftGroup,
        })
        await load(activeRoot())
        state.editing = false
        notify()
      } catch (error) {
        state.error = String((error && error.message) || error)
        notify()
      }
    }
    /** 拖完直接写绝对坐标（位置只存一份）；先本地生效，宿主那边记内存、按保存/退出/3分钟落盘。 */
    async function moveNodes(entries) {
      if (!entries || Object.keys(entries).length === 0) return
      const merged = { ...state.nodePos }
      for (const [id, pos] of Object.entries(entries)) merged[id] = pos
      state.nodePos = merged
      state.draggingIds = []
      const list = []
      const local = { ...((state.data && state.data.flowPositions) || {}) }
      for (const [canvasId, pos] of Object.entries(entries)) {
        const nodeId = canvasId.indexOf('f:') === 0 ? canvasId.slice(2) : canvasId
        const next = { x: Math.round(pos.x), y: Math.round(pos.y) }
        list.push({ id: nodeId, x: next.x, y: next.y })
        local[nodeId] = next
      }
      // 换一个新的 data 对象：useMemo 靠引用判断，原地改 flowPositions 不会触发重算，
      // 松手后节点会弹回旧位置（"拖不动"）。
      if (state.data) state.data = { ...state.data, flowPositions: local }
      notify()
      try {
        await postJson(DRAG_URL, { entries: list })
      } catch (error) {
        state.error = String((error && error.message) || error)
        notify()
      }
    }
    async function resetLayout() {
      try {
        state.nodePos = {}
        state.draggingIds = []
        await postJson(POSITION_URL, { root: activeRoot(), reset: true })
        await load(activeRoot())
      } catch (error) {
        state.error = String((error && error.message) || error)
        notify()
      }
    }
    async function pruneGraph() {
      try {
        const json = await postJson(PRUNE_URL, { root: activeRoot(), all: true })
        state.data = json
        state.notice = '清理了 ' + (json.removed || 0) + ' 个没有任何关系的节点'
        notify()
      } catch (error) {
        state.error = String((error && error.message) || error)
        notify()
      }
    }
    /** 路径没写后缀就补上（'use' → 'use.drawio'）：存出来的文件要能在「打开」框里找回来。 */
    function withExt(target, ext) {
      const name = String(target).split(/[\\/]/).pop() || ''
      if (name.indexOf('.') > 0) return target
      return target + ext
    }

    /** 新建的默认路径：跟当前图同目录、换个名字，带 .drawio，不会一按就把现有图覆盖掉。 */
    function defaultNewDrawioPath() {
      const cur = String((state.data && state.data.settings && state.data.settings.drawioFile) || '').trim()
      const root = String((state.data && state.data.active && state.data.active.root) || '').trim()
      const dir = cur ? cur.replace(/[\\/][^\\/]*$/, '') : root
      return (dir ? dir + '\\' : '') + '新建关系图.drawio'
    }

    async function runFileAction(mode, path) {
      const raw = String(path || '').trim()
      if (!raw) {
        state.error = '先填文件路径'
        notify()
        return
      }
      const target = withExt(raw, mode === 'md' ? '.md' : '.drawio')
      try {
        let opened = null
        if (mode === 'md') {
          const md = await postJson('/filegraph/export-md', { path: target })
          state.fileMenu = false
          state.filePrompt = ''
          state.notice = '已导出关系文档：' + ((md && md.exported) || target)
          notify()
          return
        }
        if (mode === 'open') opened = await postJson(OPEN_URL, { path: target })
        else if (mode === 'new') await postJson('/filegraph/new', { path: target })
        else await postJson(EXPORT_URL, { path: target, switchTo: mode === 'saveas' })
        state.fileMenu = false
        state.filePrompt = ''
        await load(undefined)
        const flowCount = opened && opened.flows ? opened.flows.length : null
        state.notice =
          (mode === 'open' ? '已打开 ' : mode === 'new' ? '已新建 ' : mode === 'saveas' ? '已另存为 ' : '已导出副本 ') +
          target +
          (flowCount === null ? '' : '（' + flowCount + ' 条关系）') +
          (opened && opened.warning ? ' · ' + opened.warning : '')
        notify()
      } catch (error) {
        state.error = String((error && error.message) || error)
        notify()
      }
    }

    /** 从端口拉一条关系：两端都用节点 id（名只是标签，不参与认人）。 */
    async function addRelation(fromCanvasId, fromPort, toCanvasId, toPort) {
      const bare = (value) => (String(value || '').indexOf('f:') === 0 ? String(value).slice(2) : String(value || ''))
      const fromId = bare(fromCanvasId)
      const toId = bare(toCanvasId)
      if (!fromId || !toId) return
      try {
        const json = await postJson('/filegraph/edge', {
          fromId,
          toId,
          fromPort: fromPort || 0,
          toPort: toPort || 0,
          verb: '',
          allowDuplicate: fromId === toId,
        })
        if (json && json.added === false) {
          state.selected = 'f:' + fromId
          state.notice = '这条关系已经存在'
        } else {
          state.notice = '已连上一条关系'
        }
        await load(undefined)
        notify()
      } catch (error) {
        state.error = String((error && error.message) || error)
        notify()
      }
    }

    async function resetGraph() {
      if (!state.confirmReset) {
        state.confirmReset = true
        notify()
        return
      }
      state.confirmReset = false
      try {
        await postJson(RESET_URL, { root: activeRoot() })
        state.selected = null
        state.autoScanned = true
        await load(activeRoot())
      } catch (error) {
        state.error = String((error && error.message) || error)
        notify()
      }
    }

    /* --------------------------------------------------- 布局（确定性） */

    const NODE_W = 134
    const NODE_H = 30
    const GAP_X = 12
    const GAP_Y = 10
    const PAD = 14
    const HEAD = 22
    const COLS = 2
    const GROUP_GAP = 32
    const MAX_ROW_W = 1120

    function layout(items, overrides) {
      const groups = new Map()
      for (const item of items) {
        const key = item.group || '.'
        if (!groups.has(key)) groups.set(key, { rank: item.groupRank ?? 2, list: [] })
        groups.get(key).list.push(item)
      }
      const boxes = [...groups.entries()]
        .sort((a, b) => a[1].rank - b[1].rank || a[0].localeCompare(b[0]))
        .map(([key, group]) => {
          const sorted = group.list.slice().sort((a, b) => a.label.localeCompare(b.label))
          const cols = Math.min(COLS, Math.max(1, sorted.length))
          const rows = Math.ceil(sorted.length / cols)
          return {
            key,
            rank: group.rank,
            list: sorted,
            cols,
            rows,
            w: cols * NODE_W + (cols - 1) * GAP_X + PAD * 2,
            h: HEAD + rows * NODE_H + (rows - 1) * GAP_Y + PAD,
            x: 0,
            y: 0,
          }
        })

      let x = 0
      let y = 0
      let rowH = 0
      let width = 0
      for (const box of boxes) {
        if (x > 0 && x + box.w > MAX_ROW_W) {
          x = 0
          y += rowH + GROUP_GAP
          rowH = 0
        }
        box.x = x
        box.y = y
        x += box.w + GROUP_GAP
        rowH = Math.max(rowH, box.h)
        width = Math.max(width, box.x + box.w)
      }
      const height = boxes.length === 0 ? 0 : y + rowH

      const positions = new Map()
      for (const box of boxes) {
        box.list.forEach((item, index) => {
          const col = index % box.cols
          const row = Math.floor(index / box.cols)
          positions.set(item.id, { x: box.x + PAD + col * (NODE_W + GAP_X), y: box.y + HEAD + row * (NODE_H + GAP_Y) })
        })
      }
      // 人手拖过的位置优先；框按成员的实际位置收紧（拖出去框也跟过去）。
      return finishLayout(items, positions, overrides)
    }

    /** 收尾：套用手拖坐标 → 按成员位置重算每个框 → 算画布尺寸。网格视图和链路视图共用。 */
    function finishLayout(items, positions, overrides) {
      if (overrides) {
        for (const [id, pos] of Object.entries(overrides)) {
          if (positions.has(id) && pos && Number.isFinite(pos.x) && Number.isFinite(pos.y)) {
            positions.set(id, { x: pos.x, y: pos.y })
          }
        }
      }
      const groups = new Map()
      for (const item of items) {
        const key = item.group || '.'
        if (!groups.has(key)) groups.set(key, { rank: item.groupRank ?? 2, list: [] })
        groups.get(key).list.push(item)
      }
      const boxes = []
      for (const [key, group] of groups) {
        let minX = Infinity
        let minY = Infinity
        let maxX = -Infinity
        let maxY = -Infinity
        for (const item of group.list) {
          const pos = positions.get(item.id)
          if (!pos) continue
          minX = Math.min(minX, pos.x)
          minY = Math.min(minY, pos.y)
          maxX = Math.max(maxX, pos.x + NODE_W)
          maxY = Math.max(maxY, pos.y + NODE_H)
        }
        if (minX === Infinity) continue
        boxes.push({
          key,
          rank: group.rank,
          list: group.list,
          x: minX - PAD,
          y: minY - HEAD,
          w: maxX - minX + PAD * 2,
          h: maxY - minY + HEAD + PAD,
        })
      }
      boxes.sort((a, b) => a.rank - b.rank || a.key.localeCompare(b.key))

      // 允许负坐标（节点/框能往左上拖），viewBox 的原点跟着扩。
      let minX = 0
      let minY = 0
      let maxX = 240
      let maxY = 160
      for (const box of boxes) {
        minX = Math.min(minX, box.x)
        minY = Math.min(minY, box.y)
        maxX = Math.max(maxX, box.x + box.w + PAD)
        maxY = Math.max(maxY, box.y + box.h + PAD)
      }
      for (const pos of positions.values()) {
        minX = Math.min(minX, pos.x)
        minY = Math.min(minY, pos.y)
        maxX = Math.max(maxX, pos.x + NODE_W + PAD)
        maxY = Math.max(maxY, pos.y + NODE_H + PAD)
      }
      return { boxes, positions, originX: minX, originY: minY, width: maxX - minX, height: maxY - minY }
    }


    /* ------------------------------------------------ 只看局部（链路/关系） */

    function buildAdjacency(edges) {
      const incoming = new Map()
      const outgoing = new Map()
      for (const edge of edges) {
        if (!incoming.has(edge.to)) incoming.set(edge.to, [])
        incoming.get(edge.to).push(edge.from)
        if (!outgoing.has(edge.from)) outgoing.set(edge.from, [])
        outgoing.get(edge.from).push(edge.to)
      }
      return { incoming, outgoing }
    }

    /** 此节点关系：选中节点 + 直接上游 + 直接下游（只一层）。 */
    function egoScope(selected, edges) {
      const keep = new Set([selected])
      const levels = new Map([[selected, 0]])
      for (const edge of edges) {
        if (edge.from === selected && !levels.has(edge.to)) {
          keep.add(edge.to)
          levels.set(edge.to, 1)
        }
        if (edge.to === selected && !levels.has(edge.from)) {
          keep.add(edge.from)
          levels.set(edge.from, -1)
        }
      }
      return { keep, levels }
    }

    /** 此文件链路：上游全部祖先（逐层到底）+ 只一层下游。 */
    function chainScope(selected, edges) {
      const { incoming, outgoing } = buildAdjacency(edges)
      const keep = new Set([selected])
      const levels = new Map([[selected, 0]])

      // 上游：反向 BFS 到没有未访问父节点为止
      let frontier = [selected]
      let depth = 0
      while (frontier.length > 0) {
        const next = []
        depth += 1
        for (const current of frontier) {
          for (const parent of incoming.get(current) || []) {
            if (keep.has(parent)) continue
            keep.add(parent)
            levels.set(parent, -depth)
            next.push(parent)
          }
        }
        frontier = next
      }

      // 下游只走一层
      for (const child of outgoing.get(selected) || []) {
        if (keep.has(child)) continue
        keep.add(child)
        levels.set(child, 1)
      }
      return { keep, levels }
    }

    const EDGE_GRAY = 'var(--dsw-alias-label-secondary)'
    const EDGE_STYLE = {
      in: { color: EDGE_GRAY, dash: undefined, width: 1.5 },
      out: { color: EDGE_GRAY, dash: undefined, width: 1.5 },
      src: { color: EDGE_GRAY, dash: '1 4', width: 1.4 },
      ref: { color: EDGE_GRAY, dash: undefined, width: 1.3 },
      seq: { color: EDGE_GRAY, dash: '4 4', width: 1.2 },
      verb: { color: EDGE_GRAY, dash: undefined, width: 1.6 },
    }

    /** 归框规则：某个非文件节点如果只跟同一个框里的东西有关联，就把它也放进那个框，别另开一个框把线拉乱。 */

    /** 短线标签给人看：动作 + 对象。 */
    function edgeLabelText(edge, byId) {
      const from = byId.get(edge.from)
      const to = byId.get(edge.to)
      const fromName = from ? from.label : ''
      const toName = to ? to.label : ''
      if (edge.kind === 'in') return '读入 ' + fromName
      if (edge.kind === 'out') return '写入 ' + toName
      if (edge.kind === 'src') return '取数 ' + fromName
      if (edge.kind === 'ref') return '提到 ' + toName
      if (edge.kind === 'seq') return '写入 ' + toName
      if (edge.kind === 'verb') return edge.verb || ''
      return ''
    }

    function shortName(name, limit) {
      if (!name) return '?'
      const cap = limit || 18
      return name.length > cap ? name.slice(0, cap - 1) + '…' : name
    }
    function shortId(id) {
      if (!id) return ''
      return id.replace(/^session-/, '').slice(0, 8)
    }
    function formatTime(ts) {
      if (!ts) return '—'
      const date = new Date(ts)
      const pad = (n) => String(n).padStart(2, '0')
      return (
        date.getFullYear() + '-' + pad(date.getMonth() + 1) + '-' + pad(date.getDate()) +
        ' ' + pad(date.getHours()) + ':' + pad(date.getMinutes()) + ':' + pad(date.getSeconds())
      )
    }
    function formatSize(bytes) {
      if (!bytes && bytes !== 0) return '—'
      if (bytes < 1024) return bytes + ' B'
      if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB'
      return (bytes / 1024 / 1024).toFixed(1) + ' MB'
    }

    /* ------------------------------------------------------ 图本体 */

    /** 采样一条边的贝塞尔曲线（和渲染同一套控制点），剪刀/取最近线都用它。 */
    function bezierPoints(from, to, index, count) {
      const x1 = from.x + NODE_W
      const y1 = from.y + NODE_H / 2
      const x2 = to.x
      const y2 = to.y + NODE_H / 2
      const bend = Math.max(36, Math.abs(x2 - x1) * 0.45)
      const offset = count > 1 ? (index - (count - 1) / 2) * 34 : 0
      const vx = x2 - x1
      const vy = y2 - y1
      const len = Math.sqrt(vx * vx + vy * vy) || 1
      const c1x = x1 + bend + (-vy / len) * offset
      const c1y = y1 + (vx / len) * offset
      const c2x = x2 - bend + (-vy / len) * offset
      const c2y = y2 + (vx / len) * offset
      const points = []
      for (let i = 0; i <= 16; i += 1) {
        const t = i / 16
        const u = 1 - t
        points.push({ x: u * u * u * x1 + 3 * u * u * t * c1x + 3 * u * t * t * c2x + t * t * t * x2, y: u * u * u * y1 + 3 * u * u * t * c1y + 3 * u * t * t * c2y + t * t * t * y2 })
      }
      return points
    }

    function segmentsCross(a, b, c, d) {
      const d1 = (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x)
      const d2 = (b.x - a.x) * (d.y - a.y) - (b.y - a.y) * (d.x - a.x)
      const d3 = (d.x - c.x) * (a.y - c.y) - (d.y - c.y) * (a.x - c.x)
      const d4 = (d.x - c.x) * (b.y - c.y) - (d.y - c.y) * (b.x - c.x)
      return d1 * d2 < 0 && d3 * d4 < 0
    }

    function pointSegDistance(p, a, b) {
      const vx = b.x - a.x
      const vy = b.y - a.y
      const len2 = vx * vx + vy * vy || 1
      let t = ((p.x - a.x) * vx + (p.y - a.y) * vy) / len2
      t = Math.max(0, Math.min(1, t))
      const px = a.x + vx * t
      const py = a.y + vy * t
      return Math.sqrt((p.x - px) * (p.x - px) + (p.y - py) * (p.y - py))
    }
    /** 拖动时直接改 <path d>：和渲染里的曲线算法保持一致。 */
    function bezierFor(from, to, index, count) {
      const x1 = from.x + NODE_W
      const y1 = from.y + NODE_H / 2
      const x2 = to.x
      const y2 = to.y + NODE_H / 2
      const bend = Math.max(36, Math.abs(x2 - x1) * 0.45)
      const offset = count > 1 ? (index - (count - 1) / 2) * 34 : 0
      const vx = x2 - x1
      const vy = y2 - y1
      const len = Math.sqrt(vx * vx + vy * vy) || 1
      const c1x = x1 + bend + (-vy / len) * offset
      const c1y = y1 + (vx / len) * offset
      const c2x = x2 - bend + (-vy / len) * offset
      const c2y = y2 + (vx / len) * offset
      return { d: 'M' + x1 + ' ' + y1 + ' C' + c1x + ' ' + c1y + ', ' + c2x + ' ' + c2y + ', ' + x2 + ' ' + y2 }
    }

    /* ============================================================ 画布 A：文件/窗口视图 */
    /** 只读观察层：AI 读过/写过的文件、窗口、其他来源。人拖过的位置存盘。 */

    /* ============================================================ 画布 B：关系画布（节点 / 节点组） */

    const FLOW_W = 178
    const FLOW_GROUP_W = 200
    const FLOW_HEAD = 24
    const FLOW_ROW = 18

    /** 节点尺寸：普通节点一条"匿名"输入/输出；节点组按端口数量长高。 */
    function flowMetrics(node) {
      const labeled = node.kind === 'group' || node.kind === 'input' || node.kind === 'output'
      const rows = labeled ? Math.max((node.inputs || []).length, (node.outputs || []).length, 1) : 1
      const w = labeled ? FLOW_GROUP_W : FLOW_W
      const h = labeled ? FLOW_HEAD + 6 + rows * FLOW_ROW : 34
      return { w, h, rows, labeled }
    }

    function flowPortPos(node, pos, side, index) {
      const m = flowMetrics(node)
      if (!m.labeled) return { x: side === 'in' ? pos.x : pos.x + m.w, y: pos.y + m.h / 2 }
      return { x: side === 'in' ? pos.x : pos.x + m.w, y: pos.y + FLOW_HEAD + 6 + index * FLOW_ROW + FLOW_ROW / 2 }
    }

    /**
     * 一根线一个端口：多端口节点（节点组 / 组输入 / 组输出）上，同一个口被几条线共用时，
     * 按出现顺序把它们摊到不同端口 —— 旧数据没存端口的也能立刻显示成"分开的"。
     */
    function spreadPorts(flows, kindOf) {
      const kindOfNode = (id) => kindOf.get(id) || ''
      const multiOut = (id) => kindOfNode(id) === 'group' || kindOfNode(id) === 'input'
      const multiIn = (id) => kindOfNode(id) === 'group' || kindOfNode(id) === 'output'
      const usedOut = new Map()
      const usedIn = new Map()
      const take = (map, id, want) => {
        const used = map.get(id) || new Set()
        let port = Math.max(0, Number(want) || 0)
        if (used.has(port)) {
          port = 0
          while (used.has(port)) port += 1
        }
        used.add(port)
        map.set(id, used)
        return port
      }
      return (flows || []).map((flow) => ({
        id: flow.id,
        from: 'f:' + flow.fromId,
        to: 'f:' + flow.toId,
        fromPort: multiOut(flow.fromId) ? take(usedOut, flow.fromId, flow.fromPort) : (flow.fromPort || 0),
        toPort: multiIn(flow.toId) ? take(usedIn, flow.toId, flow.toPort) : (flow.toPort || 0),
        verb: flow.verb || '',
        kind: 'verb',
      }))
    }

    function FlowCanvas({ nodes, edges, ghosts, positions, selected, picked, keepSelection, onSelect, onPick, onMove, onConnect, onRenameNode, onRenameEdge, onCutEdge, onCut, onContextNode, onContextEdge, onContextBlank, onPortContext, onViewport, viewKey }) {
      const svgRef = useRef(null)
      const [view, setView] = useState({ k: 1, dx: 0, dy: 0 })
      const viewRef = useRef(view)
      useEffect(() => { viewRef.current = view }, [view])
      const [live, setLive] = useState(null)
      const [link, setLink] = useState(null)
      const dragRef = useRef(null)
      const movedRef = useRef(false)
      const boxRef = useRef({ key: '', x: 0, y: 0, w: 0, h: 0 })
      const marqueeRef = useRef(null)
      const scissorRef = useRef(null)

      const posOf = useCallback((id) => {
        if (live && live[id]) return live[id]
        return positions[id] || null
      }, [live, positions])

      const bounds = useMemo(() => {
        let minX = 0
        let minY = 0
        let maxX = 600
        let maxY = 400
        for (const node of nodes) {
          const pos = positions[node.id]
          if (!pos) continue
          const m = flowMetrics(node)
          minX = Math.min(minX, pos.x)
          minY = Math.min(minY, pos.y)
          maxX = Math.max(maxX, pos.x + m.w)
          maxY = Math.max(maxY, pos.y + m.h)
        }
        // 往期对照里的旧节点也要在视野里（它们可能早就被挪到当前范围外了）
        for (const ghost of ghosts || []) {
          const model = ghost.model || {}
          const oldPositions = model.flowPositions || {}
          for (const node of model.flowNodes || []) {
            if (nodes.some((item) => item.nodeId === node.id)) continue
            const pos = oldPositions[node.id]
            if (!pos) continue
            const m = flowMetrics({ kind: node.kind === 'group' ? 'group' : 'node', inputs: [], outputs: [] })
            minX = Math.min(minX, pos.x)
            minY = Math.min(minY, pos.y)
            maxX = Math.max(maxX, pos.x + m.w)
            maxY = Math.max(maxY, pos.y + m.h)
          }
        }
        return { x: minX - 70, y: minY - 70, w: maxX - minX + 140, h: maxY - minY + 140 }
      }, [nodes, positions, ghosts])

      const key = viewKey || 'flow'
      const outside =
        bounds.x < boxRef.current.x - 1 ||
        bounds.y < boxRef.current.y - 1 ||
        bounds.x + bounds.w > boxRef.current.x + boxRef.current.w + 1 ||
        bounds.y + bounds.h > boxRef.current.y + boxRef.current.h + 1
      if (boxRef.current.key !== key || outside) boxRef.current = { key, ...bounds }
      const vb = boxRef.current

      const scaleOf = () => {
        const svg = svgRef.current
        if (!svg) return 1
        const rect = svg.getBoundingClientRect()
        return Math.min(rect.width / vb.w, rect.height / vb.h) || 1
      }
      const localOf = (event) => {
        const svg = svgRef.current
        if (!svg) return { x: 0, y: 0 }
        const rect = svg.getBoundingClientRect()
        const scale = Math.min(rect.width / vb.w, rect.height / vb.h) || 1
        const rawX = (event.clientX - rect.left) / scale + vb.x
        const rawY = (event.clientY - rect.top) / scale + vb.y
        const v = viewRef.current
        return { x: (rawX - (v.dx || 0)) / (v.k || 1), y: (rawY - (v.dy || 0)) / (v.k || 1) }
      }

      useEffect(() => { setView({ k: 1, dx: 0, dy: 0 }) }, [key])

      // 把当前视野中心报给面板：新节点/新节点组要落在屏幕中心
      useEffect(() => {
        if (!onViewport) return
        onViewport({
          x: (vb.x + vb.w / 2 - (view.dx || 0)) / (view.k || 1),
          y: (vb.y + vb.h / 2 - (view.dy || 0)) / (view.k || 1),
        })
      }, [view, vb.x, vb.y, vb.w, vb.h])

      useEffect(() => {
        const svg = svgRef.current
        if (!svg) return undefined
        const onWheel = (event) => {
          event.preventDefault()
          const point = localOfScreen(event)
          setView((current) => {
            const next = Math.min(32, Math.max(0.12, current.k * Math.exp(-event.deltaY * 0.0015)))
            const ratio = next / current.k
            return { k: next, dx: point.x - (point.x - current.dx) * ratio, dy: point.y - (point.y - current.dy) * ratio }
          })
        }
        const localOfScreen = (event) => {
          const rect = svg.getBoundingClientRect()
          const scale = Math.min(rect.width / vb.w, rect.height / vb.h) || 1
          return { x: (event.clientX - rect.left) / scale + vb.x, y: (event.clientY - rect.top) / scale + vb.y }
        }
        svg.addEventListener('wheel', onWheel, { passive: false })
        return () => svg.removeEventListener('wheel', onWheel)
      }, [vb.w, vb.h, vb.x, vb.y])

      /** 找指针下面最近的输入端口（吸附半径按屏幕像素算）。 */
      const findTarget = (lx, ly) => {
        const scale = scaleOf()
        const k = viewRef.current.k || 1
        const hitR = 10 / (scale * k)
        let best = null
        let bestDist = Infinity
        for (const node of nodes) {
          if (node.kind === 'input') continue
          const pos = posOf(node.id)
          if (!pos) continue
          const count = Math.max((node.inputs || []).length, 1)
          for (let i = 0; i < count; i += 1) {
            const p = flowPortPos(node, pos, 'in', i)
            const d = Math.hypot(lx - p.x, ly - p.y)
            if (d < Math.min(bestDist, hitR)) {
              bestDist = d
              best = { id: node.id, port: i }
            }
          }
        }
        if (best) return best
        // 没吸到端口：落在节点框里也算（普通节点只有一个输入口）
        for (const node of nodes) {
          if (node.kind === 'input') continue
          const pos = posOf(node.id)
          if (!pos) continue
          const m = flowMetrics(node)
          if (lx >= pos.x - 6 && lx <= pos.x + m.w + 6 && ly >= pos.y && ly <= pos.y + m.h) return { id: node.id, port: 0 }
        }
        return null
      }

      useEffect(() => {
        const onMoveWindow = (event) => {
          const drag = dragRef.current
          if (!drag) return
          const { x: lx, y: ly } = localOf(event)
          if (drag.mode === 'pan') {
            setView((current) => ({ k: current.k, dx: drag.dx + (event.clientX - drag.sx) / scaleOf(), dy: drag.dy + (event.clientY - drag.sy) / scaleOf() }))
            return
          }
          if (drag.mode === 'link') {
            const target = findTarget(lx, ly)
            setLink({ fromId: drag.fromId, fromPort: drag.fromPort, x: lx, y: ly, target })
            return
          }
          if (drag.mode === 'marquee') {
            drag.ex = lx
            drag.ey = ly
            const rect = marqueeRef.current
            if (rect) {
              rect.setAttribute('x', String(Math.min(drag.sx, lx)))
              rect.setAttribute('y', String(Math.min(drag.sy, ly)))
              rect.setAttribute('width', String(Math.abs(lx - drag.sx)))
              rect.setAttribute('height', String(Math.abs(ly - drag.sy)))
            }
            return
          }
          if (drag.mode === 'scissor') {
            drag.ex = lx
            drag.ey = ly
            const cut = scissorRef.current
            if (cut) {
              cut.setAttribute('x2', String(lx))
              cut.setAttribute('y2', String(ly))
            }
            return
          }
          if (drag.mode === 'node') {
            const scale = scaleOf()
            const k = viewRef.current.k || 1
            const dx = (event.clientX - drag.sx) / (scale * k)
            const dy = (event.clientY - drag.sy) / (scale * k)
            if (Math.abs(dx) + Math.abs(dy) > 2) movedRef.current = true
            const moved = {}
            for (const [id, base] of Object.entries(drag.bases)) moved[id] = { x: Math.round(base.x + dx), y: Math.round(base.y + dy) }
            setLive(moved)
          }
        }
        const onUpWindow = (event) => {
          const drag = dragRef.current
          dragRef.current = null
          if (!drag) return
          if (drag.mode === 'marquee') {
            const rect = marqueeRef.current
            if (rect) rect.style.opacity = '0'
            const point = localOf(event)
            const ax = Math.min(drag.sx, point.x)
            const ay = Math.min(drag.sy, point.y)
            const bx = Math.max(drag.sx, point.x)
            const by = Math.max(drag.sy, point.y)
            const ids = []
            for (const node of nodes) {
              const pos = posOf(node.id)
              if (!pos) continue
              const m = flowMetrics(node)
              if (pos.x < bx && pos.x + m.w > ax && pos.y < by && pos.y + m.h > ay) ids.push(node.id)
            }
            if (onPick) onPick(ids)
            return
          }
          if (drag.mode === 'scissor') {
            const cut = scissorRef.current
            if (cut) cut.style.opacity = '0'
            if (svgRef.current) svgRef.current.style.cursor = 'grab'
            const point = localOf(event)
            const list = cutPath({ x: drag.sx, y: drag.sy }, { x: point.x, y: point.y })
            if (list.length > 0) {
              if (onCut) onCut(list)
              else if (onCutEdge) list.forEach((edge) => onCutEdge(edge))
            }
            return
          }
          if (drag.mode === 'link') {
            const target = link && link.target
            setLink(null)
            if (target && onConnect) onConnect(drag.fromId, drag.fromPort, target.id, target.port)
            return
          }
          if (drag.mode === 'node') {
            const moved = live
            const wasMoved = movedRef.current
            setLive(null)
            if (moved && Object.keys(moved).length > 0 && onMove) onMove(moved)
            movedRef.current = false
            // 只有"点了没拖"才打开详情：拖动不弹编辑/详情窗口
            if (!wasMoved && drag.selectId && onSelect) onSelect(drag.selectId)
          }
        }
        window.addEventListener('pointermove', onMoveWindow)
        window.addEventListener('pointerup', onUpWindow)
        window.addEventListener('pointercancel', onUpWindow)
        return () => {
          window.removeEventListener('pointermove', onMoveWindow)
          window.removeEventListener('pointerup', onUpWindow)
          window.removeEventListener('pointercancel', onUpWindow)
        }
      })

      const edgeLine = (edge) => {
        const from = nodes.find((node) => node.id === edge.from)
        const to = nodes.find((node) => node.id === edge.to)
        if (!from || !to) return null
        const fp = posOf(edge.from)
        const tp = posOf(edge.to)
        if (!fp || !tp) return null
        const a = flowPortPos(from, fp, 'out', edge.fromPort || 0)
        const b = flowPortPos(to, tp, 'in', edge.toPort || 0)
        if (edge.from === edge.to) {
          const c1 = { x: a.x + 70, y: a.y - 46 }
          const c2 = { x: b.x - 70, y: b.y - 46 }
          return { a, c1, c2, b, d: 'M' + a.x + ' ' + a.y + ' C' + c1.x + ' ' + c1.y + ', ' + c2.x + ' ' + c2.y + ', ' + b.x + ' ' + b.y, mx: (a.x + b.x) / 2, my: Math.min(a.y, b.y) - 40 }
        }
        const bend = Math.max(40, Math.abs(b.x - a.x) * 0.45)
        const c1 = { x: a.x + bend, y: a.y }
        const c2 = { x: b.x - bend, y: b.y }
        const d = 'M' + a.x + ' ' + a.y + ' C' + c1.x + ' ' + c1.y + ', ' + c2.x + ' ' + c2.y + ', ' + b.x + ' ' + b.y
        return { a, c1, c2, b, d, mx: (a.x + b.x) / 2 + (bend - Math.abs(b.x - a.x) * 0.45) / 2, my: (a.y + b.y) / 2 }
      }
      const edgePath = (edge) => edgeLine(edge)

      // 剪刀：Ctrl + 拖过线，松手把划过的线一起剪掉。
      const cutPath = (from, to) => {
        const k = (viewRef.current && viewRef.current.k) || 1
        const near = 7 / k
        const hit = []
        for (const edge of edges) {
          const line = edgeLine(edge)
          if (!line) continue
          let crossed = false
          for (let i = 0; i <= 24 && !crossed; i += 1) {
            const t0 = i / 24
            const t1 = (i + 1) / 24
            const p0 = bezierAt(line, t0)
            const p1 = bezierAt(line, t1)
            if (segmentsCross(from, to, p0, p1) || pointSegDistance(p0, from, to) < near) crossed = true
          }
          if (crossed) hit.push(edge)
        }
        return hit
      }
      const bezierAt = (line, t) => {
        const u = 1 - t
        return {
          x: u * u * u * line.a.x + 3 * u * u * t * line.c1.x + 3 * u * t * t * line.c2.x + t * t * t * line.b.x,
          y: u * u * u * line.a.y + 3 * u * u * t * line.c1.y + 3 * u * t * t * line.c2.y + t * t * t * line.b.y,
        }
      }

      const nodeById = new Map(nodes.map((node) => [node.id, node]))

      /**
       * 往期历史对照（只读叠加）：
       *   back  = 旧版本有、现在没有的节点（虚线灰框）和关系（虚线灰线）；
       *   front = 现在有、旧版本没有的节点（绿色虚线外框）。
       * 两端都在的节点一律按现在的位置画，这样看到的是结构差异，不是当初的排版。
       */
      const ghostShapes = useMemo(() => {
        const list = ghosts || []
        if (list.length === 0) return null
        const back = []
        const front = []
        const currentIds = new Set(nodes.map((node) => node.nodeId))
        const currentEdges = new Set(edges.map((edge) => String(edge.from).replace(/^f:/, '') + '|' + String(edge.to).replace(/^f:/, '') + '|' + (edge.verb || '')))
        const halo = new Set()
        const endpointOf = (id, side, oldNodes, oldPositions) => {
          const current = nodeById.get('f:' + id)
          if (current) {
            const pos = posOf(current.id)
            if (pos) {
              const m = flowMetrics(current)
              return { x: side === 'out' ? pos.x + m.w : pos.x, y: pos.y + (m.labeled ? FLOW_HEAD + 6 + FLOW_ROW / 2 : m.h / 2) }
            }
          }
          const base = oldPositions[id] || { x: 0, y: 0 }
          const oldNode = oldNodes.find((node) => node.id === id) || {}
          const m = flowMetrics({ kind: oldNode.kind === 'group' ? 'group' : 'node', inputs: [], outputs: [] })
          return { x: side === 'out' ? base.x + m.w : base.x, y: base.y + (oldNode.kind === 'group' ? FLOW_HEAD + 6 + FLOW_ROW / 2 : m.h / 2) }
        }
        for (const item of list) {
          const model = item.model || {}
          const oldNodes = Array.isArray(model.flowNodes) ? model.flowNodes : []
          const oldPositions = model.flowPositions || {}
          const oldIds = new Set(oldNodes.map((node) => node.id))
          for (const node of oldNodes) {
            if (currentIds.has(node.id)) continue
            const base = oldPositions[node.id] || { x: 0, y: 0 }
            const m = flowMetrics({ kind: node.kind === 'group' ? 'group' : 'node', inputs: [], outputs: [] })
            back.push(
              h('g', { key: 'gh' + item.n + ':' + node.id, transform: 'translate(' + base.x + ' ' + base.y + ')', style: { opacity: 0.85, pointerEvents: 'none' } },
                h('rect', { width: m.w, height: m.h, rx: 9, fill: 'transparent', stroke: '#94a3b8', strokeWidth: 1.4, strokeDasharray: '6 4' }),
                h('text', { x: 10, y: 20, fontSize: 11, fill: '#94a3b8', style: { userSelect: 'none' } }, node.name),
              ),
            )
          }
          for (const flow of Array.isArray(model.flows) ? model.flows : []) {
            const key = flow.fromId + '|' + flow.toId + '|' + (flow.verb || '')
            if (currentEdges.has(key)) continue
            const a = endpointOf(flow.fromId, 'out', oldNodes, oldPositions)
            const b = endpointOf(flow.toId, 'in', oldNodes, oldPositions)
            back.push(h('path', {
              key: 'ghe' + item.n + ':' + key,
              d: 'M' + a.x + ' ' + a.y + ' C' + (a.x + 56) + ' ' + a.y + ', ' + (b.x - 56) + ' ' + b.y + ', ' + b.x + ' ' + b.y,
              fill: 'none', stroke: '#94a3b8', strokeWidth: 1.3, strokeDasharray: '5 4', style: { pointerEvents: 'none' },
            }))
          }
          for (const node of nodes) {
            if (oldIds.has(node.nodeId) || halo.has(node.id)) continue
            const pos = posOf(node.id)
            if (!pos) continue
            halo.add(node.id)
            const m = flowMetrics(node)
            front.push(h('rect', {
              key: 'ghn' + item.n + ':' + node.id,
              x: pos.x - 4, y: pos.y - 4, width: m.w + 8, height: m.h + 8, rx: 11,
              fill: 'none', stroke: '#22c55e', strokeWidth: 1.2, strokeDasharray: '4 4', style: { pointerEvents: 'none' },
            }))
          }
        }
        return { back, front }
      }, [ghosts, nodes, edges, positions, live])

      return h('div',
        { style: { position: 'relative', flex: 1, minHeight: 0, background: 'var(--dsw-alias-bg-base)', userSelect: 'none', WebkitUserSelect: 'none' } },
        h('svg',
          {
            ref: svgRef,
            viewBox: vb.x + ' ' + vb.y + ' ' + vb.w + ' ' + vb.h,
            preserveAspectRatio: 'xMinYMin meet',
            style: { width: '100%', height: '100%', display: 'block', cursor: 'grab', touchAction: 'none', overflow: 'hidden' },
            onDragStart: (event) => event.preventDefault(),
            onPointerDown: (event) => {
              if (event.button === 2) return
              if (event.target !== event.currentTarget) return
              try { event.currentTarget.setPointerCapture(event.pointerId) } catch {}
              if ((event.ctrlKey || event.metaKey) && !event.shiftKey) {
                // Ctrl + 拖过线 = 剪刀：松手时把划过的线一起剪掉
                const point = localOf(event)
                dragRef.current = { mode: 'scissor', sx: point.x, sy: point.y, ex: point.x, ey: point.y }
                const cut = scissorRef.current
                if (cut) {
                  cut.setAttribute('x1', String(point.x))
                  cut.setAttribute('y1', String(point.y))
                  cut.setAttribute('x2', String(point.x))
                  cut.setAttribute('y2', String(point.y))
                  cut.style.opacity = '1'
                }
                if (svgRef.current) svgRef.current.style.cursor = 'crosshair'
                return
              }
              if (event.shiftKey && !event.ctrlKey) {
                // Shift + 拖空白 = 框选（框选完按 Shift+A 收进节点组）
                const point = localOf(event)
                if (onPick) onPick([])
                dragRef.current = { mode: 'marquee', sx: point.x, sy: point.y, ex: point.x, ey: point.y }
                const rect = marqueeRef.current
                if (rect) {
                  rect.setAttribute('x', String(point.x))
                  rect.setAttribute('y', String(point.y))
                  rect.setAttribute('width', '0')
                  rect.setAttribute('height', '0')
                  rect.style.opacity = '1'
                }
                return
              }
              if (!keepSelection && onSelect) onSelect(null)
              if (onPick) onPick([])
              movedRef.current = false
              dragRef.current = { mode: 'pan', sx: event.clientX, sy: event.clientY, dx: view.dx, dy: view.dy }
            },
            onPointerMove: (event) => {
              // 统一在 window 上处理拖动；这里只负责 hover 光标
              void event
            },
            onPointerUp: () => {},
            onContextMenu: (event) => {
              if (event.target !== event.currentTarget) return
              // 别再往上冒：面板容器上的「空白右键收起菜单」会把刚打开的菜单立刻关掉
              event.stopPropagation()
              event.preventDefault()
              if (onContextBlank) onContextBlank(event.clientX, event.clientY)
            },
          },
          h('defs',
            null,
            ['#60a5fa', '#94a3b8'].map((color, index) =>
              h('marker',
                { key: 'fm' + index, id: 'fg-flow-arrow-' + index, viewBox: '0 0 8 8', refX: 7, refY: 4, markerWidth: 7, markerHeight: 7, orient: 'auto-start-reverse' },
                h('path', { d: 'M0 0 L8 4 L0 8 z', fill: color }),
              ),
            ),
          ),
          h('g', { transform: 'translate(' + view.dx + ' ' + view.dy + ') scale(' + view.k + ')' },
            h('rect', {
              ref: marqueeRef,
              x: 0, y: 0, width: 0, height: 0, rx: 8,
              fill: 'rgba(59,130,246,0.10)',
              stroke: 'var(--dsw-alias-brand-primary)',
              strokeDasharray: '6 4',
              style: { opacity: 0, pointerEvents: 'none' },
            }),
            h('line', {
              ref: scissorRef,
              x1: 0, y1: 0, x2: 0, y2: 0,
              stroke: '#ef4444', strokeWidth: 1.4, strokeDasharray: '3 3',
              style: { opacity: 0, pointerEvents: 'none' },
            }),
            edges.map((edge) => {
              const path = edgePath(edge)
              if (!path) return null
              return h('g', { key: 'fe:' + (edge.id || edge.from + '|' + edge.to + '|' + (edge.fromPort || 0) + '|' + (edge.toPort || 0)) },
                h('path', {
                  d: path.d, fill: 'none', stroke: 'transparent', strokeWidth: 14, strokeLinecap: 'round',
                  style: { cursor: 'pointer' },
                  onPointerDown: (event) => {
                    event.stopPropagation()
                    if (event.shiftKey && onRenameEdge) onRenameEdge(edge)
                    else if (event.ctrlKey || event.metaKey) {
                      // 剪刀：按下的这条线算起点，拖过的线松手一起剪
                      const point = localOf(event)
                      dragRef.current = { mode: 'scissor', sx: point.x, sy: point.y, ex: point.x, ey: point.y }
                      const cut = scissorRef.current
                      if (cut) {
                        cut.setAttribute('x1', String(point.x))
                        cut.setAttribute('y1', String(point.y))
                        cut.setAttribute('x2', String(point.x))
                        cut.setAttribute('y2', String(point.y))
                        cut.style.opacity = '1'
                      }
                      if (svgRef.current) svgRef.current.style.cursor = 'crosshair'
                    } else {
                      if (!keepSelection && onSelect) onSelect(null)
                      if (onPick) onPick([])
                    }
                  },
                  onContextMenu: (event) => {
                    event.preventDefault()
                    event.stopPropagation()
                    if (onContextEdge) onContextEdge(edge, event.clientX, event.clientY)
                  },
                }),
                h('path', {
                  d: path.d, fill: 'none', stroke: 'var(--dsw-alias-label-secondary)', strokeWidth: 1.5,
                  markerEnd: 'url(#fg-flow-arrow-0)', strokeLinecap: 'round',
                  style: { pointerEvents: 'none' },
                }),
                edge.verb
                  ? h('text', {
                      x: path.mx, y: path.my - 6, textAnchor: 'middle', fontSize: 10,
                      fill: 'var(--dsw-alias-label-secondary)',
                      style: { userSelect: 'none', pointerEvents: 'none', paintOrder: 'stroke', stroke: 'var(--dsw-alias-bg-base)', strokeWidth: 3, strokeLinejoin: 'round' },
                    }, edge.verb)
                  : null,
              )
            }),
            link
              ? (() => {
                  const from = nodeById.get(link.fromId)
                  const fp = from ? posOf(from.id) : null
                  if (!from || !fp) return null
                  const a = flowPortPos(from, fp, 'out', link.fromPort)
                  return h('path', {
                    d: 'M' + a.x + ' ' + a.y + ' C' + (a.x + 60) + ' ' + a.y + ', ' + (link.x - 60) + ' ' + link.y + ', ' + link.x + ' ' + link.y,
                    fill: 'none', stroke: 'var(--dsw-alias-brand-primary)', strokeWidth: 1.6, strokeDasharray: '5 3',
                    markerEnd: 'url(#fg-flow-arrow-0)', style: { pointerEvents: 'none' },
                  })
                })()
              : null,
            ghostShapes ? ghostShapes.back : null,
            nodes.map((node) => {
              const pos = posOf(node.id)
              if (!pos) return null
              const m = flowMetrics(node)
              const isSelected = node.id === selected
              const isGroup = node.kind === 'group'
              const isIO = node.kind === 'input' || node.kind === 'output'
              const headerFill = isGroup ? '#1d4ed8' : isIO ? '#2f6f4f' : 'var(--dsw-alias-bg-layer-2)'
              const stroke = isSelected ? 'var(--dsw-alias-brand-primary)' : isGroup ? '#3b82f6' : isIO ? '#3f8f63' : 'var(--dsw-alias-border-l2)'
              const showLabels = m.labeled
              return h('g',
                {
                  key: 'fn:' + node.id,
                  transform: 'translate(' + pos.x + ' ' + pos.y + ')',
                  style: { cursor: 'grab' },
                  onPointerDown: (event) => {
                    if (event.button !== 0) return
                    event.stopPropagation()
                    if (event.shiftKey) {
                      // Shift+单击节点 = 多选/取消多选（改名走右键菜单）
                      const current = picked || []
                      const next = current.indexOf(node.id) >= 0
                        ? current.filter((id) => id !== node.id)
                        : current.concat([node.id])
                      if (onPick) onPick(next)
                      return
                    }
                    const current = picked || []
                    const inPicked = current.indexOf(node.id) >= 0
                    // 点的是框选里的节点：别先清多选，整组一起拖；松手没动才算单击、收成单选
                    if (!inPicked && onPick && current.length > 0) onPick([])
                    const baseIds = inPicked ? current : [node.id]
                    const bases = {}
                    for (const id of baseIds) {
                      const at = positions[id]
                      if (at) bases[id] = { x: at.x, y: at.y }
                    }
                    if (!bases[node.id]) bases[node.id] = { x: pos.x, y: pos.y }
                    movedRef.current = false
                    dragRef.current = { mode: 'node', sx: event.clientX, sy: event.clientY, bases, selectId: node.id }
                  },
                  onContextMenu: (event) => {
                    event.preventDefault()
                    event.stopPropagation()
                    if (onContextNode) onContextNode(node, event.clientX, event.clientY)
                  },
                },
                picked && picked.indexOf(node.id) >= 0
                  ? h('rect', { x: -4, y: -4, width: m.w + 8, height: m.h + 8, rx: 10, fill: 'none', stroke: '#3b82f6', strokeDasharray: '5 3', strokeWidth: 1.6 })
                  : null,
                h('rect', {
                  width: m.w, height: m.h, rx: 8,
                  fill: isGroup ? 'rgba(29,78,216,0.16)' : isIO ? 'rgba(47,111,79,0.14)' : 'var(--dsw-alias-bg-layer-2)',
                  stroke, strokeWidth: isSelected ? 2 : 1,
                }),
                h('rect', { width: m.w, height: Math.min(FLOW_HEAD, m.h), rx: 8, fill: headerFill, opacity: isGroup || isIO ? 1 : 0.55 }),
                h('text', {
                  x: 10, y: Math.min(FLOW_HEAD, m.h) / 2 + 4,
                  fontSize: 11.5, fontWeight: 600,
                  fill: isGroup || isIO ? '#fff' : 'var(--dsw-alias-label-primary)',
                  style: { userSelect: 'none' },
                }, shortName(node.label, showLabels ? 30 : 20)),
                showLabels
                  ? (node.inputs || []).map((label, index) => {
                      const y = FLOW_HEAD + 6 + index * FLOW_ROW + FLOW_ROW / 2 + 3.5
                      return h('g', { key: 'in' + index },
                        h('text', {
                          x: 10, y, fontSize: 10, fill: 'var(--dsw-alias-label-secondary)', style: { userSelect: 'none', cursor: 'context-menu' },
                          onContextMenu: (event) => {
                            event.preventDefault()
                            event.stopPropagation()
                            if (onPortContext) onPortContext(node, 'in', index, event.clientX, event.clientY)
                          },
                        }, label || ''),
                      )
                    })
                  : null,
                showLabels
                  ? (node.outputs || []).map((label, index) => {
                      const y = FLOW_HEAD + 6 + index * FLOW_ROW + FLOW_ROW / 2 + 3.5
                      return h('text', {
                        key: 'out' + index, x: m.w - 10, y, textAnchor: 'end', fontSize: 10, fill: 'var(--dsw-alias-label-secondary)', style: { userSelect: 'none', cursor: 'context-menu' },
                        onContextMenu: (event) => {
                          event.preventDefault()
                          event.stopPropagation()
                          if (onPortContext) onPortContext(node, 'out', index, event.clientX, event.clientY)
                        },
                      }, label || '')
                    })
                  : null,
                (node.inputs || []).map((label, index) => {
                  const p = flowPortPos(node, { x: 0, y: 0 }, 'in', index)
                  return h('circle', {
                    key: 'pin' + index, cx: p.x, cy: p.y, r: 4.5,
                    fill: 'var(--dsw-alias-bg-base)', stroke: IN_COLOR, strokeWidth: 1.5,
                  })
                }),
                (node.outputs || []).map((label, index) => {
                  const p = flowPortPos(node, { x: 0, y: 0 }, 'out', index)
                  return h('circle', {
                    key: 'pout' + index, cx: p.x, cy: p.y, r: 4.5,
                    fill: 'var(--dsw-alias-bg-base)', stroke: OUT_COLOR, strokeWidth: 1.5,
                    style: { cursor: 'crosshair' },
                    onPointerDown: (event) => {
                      if (event.button !== 0) return
                      event.stopPropagation()
                      dragRef.current = { mode: 'link', fromId: node.id, fromPort: index }
                      setLink({ fromId: node.id, fromPort: index, x: p.x, y: p.y, target: null })
                    },
                  })
                }),
                h('title', null, showLabels ? node.label + '（节点组）' : node.label),
              )
            }),
            ghostShapes ? ghostShapes.front : null,
          ),
        ),
        h('div',
          { style: { position: 'absolute', right: 10, bottom: 10, display: 'flex', gap: 6 } },
          zoomButton('－', () => setView((v) => ({ ...v, k: Math.max(0.12, v.k / 1.3) }))),
          zoomButton('＋', () => setView((v) => ({ ...v, k: Math.min(32, v.k * 1.3) }))),
          zoomButton('适应', () => setView({ k: 1, dx: 0, dy: 0 })),
        ),
      )
    }

    function zoomButton(label, onClick) {
      return h('button', { key: label, onClick, style: { minWidth: 30, height: 26, padding: '0 8px', borderRadius: 7, border: '1px solid var(--dsw-alias-border-l1)', background: 'var(--dsw-alias-bg-overlay)', color: 'var(--dsw-alias-label-secondary)', fontSize: 12, cursor: 'pointer', }, }, label,)
    }

    /* ------------------------------------------------------ 往期历史 */

    const historyIconStyle = (on) => ({ flex: '0 0 auto', width: 22, height: 22, display: 'flex', alignItems: 'center', justifyContent: 'center', border: 'none', background: 'transparent', cursor: 'pointer', color: on ? 'var(--dsw-alias-brand-primary)' : 'var(--dsw-alias-label-secondary)', opacity: on ? 1 : 0.7 })

    function eyeGlyph(on) {
      return h('svg', { viewBox: '0 0 16 16', width: 13, height: 13, 'aria-hidden': true, style: { display: 'block' } },
        h('path', { d: 'M1.5 8S4.1 3.9 8 3.9 14.5 8 14.5 8 11.9 12.1 8 12.1 1.5 8 1.5 8Z', fill: 'none', stroke: 'currentColor', strokeWidth: 1.2 }),
        on
          ? h('circle', { cx: 8, cy: 8, r: 2.1, fill: 'currentColor' })
          : h('path', { d: 'M2.6 13.4 13.4 2.6', stroke: 'currentColor', strokeWidth: 1.2 }),
      )
    }

    function restoreGlyph() {
      return h('svg', { viewBox: '0 0 16 16', width: 13, height: 13, 'aria-hidden': true, style: { display: 'block' } },
        h('path', { d: 'M3.2 3.2V6.6h3.4', fill: 'none', stroke: 'currentColor', strokeWidth: 1.2, strokeLinecap: 'round', strokeLinejoin: 'round' }),
        h('path', { d: 'M3.5 6.4A5 5 0 1 1 8 13', fill: 'none', stroke: 'currentColor', strokeWidth: 1.2, strokeLinecap: 'round' }),
      )
    }

    function trashGlyph() {
      return h('svg', { viewBox: '0 0 16 16', width: 13, height: 13, 'aria-hidden': true, style: { display: 'block' } },
        h('path', { d: 'M3.4 4.6h9.2M6.4 4.6V3.2h3.2v1.4M4.6 4.6l.6 8h5.6l.6-8', fill: 'none', stroke: 'currentColor', strokeWidth: 1.2, strokeLinecap: 'round', strokeLinejoin: 'round' }),
      )
    }

    /** 版本行里的时间：今天的只写时分，更早的带月-日（258px 宽塞不下完整日期）。 */
    function historyTimeOf(ts) {
      if (!ts) return ''
      const date = new Date(ts)
      const pad = (n) => String(n).padStart(2, '0')
      const hm = pad(date.getHours()) + ':' + pad(date.getMinutes())
      const now = new Date()
      const sameDay = date.getFullYear() === now.getFullYear() && date.getMonth() === now.getMonth() && date.getDate() === now.getDate()
      return sameDay ? hm : pad(date.getMonth() + 1) + '-' + pad(date.getDate()) + ' ' + hm
    }

    /**
     * 右上窗口：往期历史（手动保存的文件快照）。版本号从大到小排（新的在上），列表自己滚。
     * 顶部「保存快照」= 与保存分开的独立动作，每点一次新增一份「版本 N」；真源不自动保存。
     * 行内：眼睛 = 叠到画布对照；时钟 = 回到这一版；垃圾桶只在选中这一行后出现。
     */
    function HistoryPanel({ versions, eyes, pick, onPick, onToggle, onRestore, onSnapshot, onDelete }) {
      const list = (versions || []).slice().sort((a, b) => b.n - a.n)
      return h('div',
        { style: { display: 'flex', flexDirection: 'column', flex: '0 0 46%', minHeight: 96, maxHeight: '58%', borderBottom: '1px solid var(--dsw-alias-border-l1)' } },
        h('div', { style: { display: 'flex', alignItems: 'center', gap: 8, padding: '8px 12px 4px' } },
          h('span', { style: { fontSize: 11, fontWeight: 600, color: 'var(--dsw-alias-label-primary)' } }, '历史'),
          h('span', { style: { fontSize: 10, color: 'var(--dsw-alias-label-secondary)' } }, list.length ? '共 ' + list.length + ' 个版本' : ''),
          h('button',
            {
              onClick: onSnapshot,
              title: '保存快照',
              style: { marginLeft: 'auto', height: 22, padding: '0 8px', borderRadius: 6, border: '1px solid var(--dsw-alias-border-l1)', background: 'transparent', color: 'var(--dsw-alias-label-secondary)', fontSize: 10, cursor: 'pointer', whiteSpace: 'nowrap' },
            },
            '保存快照',
          ),
        ),
        h('div',
          { style: { flex: '1 1 auto', minHeight: 0, overflowY: 'auto', overscrollBehavior: 'contain', padding: '0 8px 6px' } },
          list.length === 0
            ? h('div', { style: { padding: '4px 2px', fontSize: 11, color: 'var(--dsw-alias-label-secondary)' } }, '无往期版本')
            : list.map((item) => {
                const open = !!eyes[item.n]
                return h('div',
                  { key: 'h' + item.n, style: { display: 'flex', alignItems: 'center', gap: 2, borderRadius: 7, background: pick === item.n || open ? 'var(--dsw-alias-bg-layer-2)' : 'transparent' } },
                  h('button',
                    {
                      onClick: () => onPick(item.n),
                      style: { flex: 1, minWidth: 0, padding: '4px 6px', border: 'none', background: 'transparent', textAlign: 'left', cursor: 'pointer' },
                    },
                    h('div', { style: { display: 'flex', alignItems: 'baseline', gap: 6 } },
                      h('span', { style: { fontSize: 11, color: 'var(--dsw-alias-label-primary)', whiteSpace: 'nowrap' } }, '版本 ' + item.n),
                      h('span', { style: { fontSize: 9, color: 'var(--dsw-alias-label-secondary)', marginLeft: 'auto', whiteSpace: 'nowrap' } }, historyTimeOf(item.at)),
                    ),
                    h('div', { style: { fontSize: 9, color: 'var(--dsw-alias-label-secondary)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' } },
                      item.nodes + ' 节点 · ' + item.edges + ' 关系' + (item.groups ? ' · ' + item.groups + ' 组' : '')),
                  ),
                  h('button', { onClick: () => onToggle(item.n), title: '对照显示', style: historyIconStyle(open) }, eyeGlyph(open)),
                  h('button', { onClick: () => onRestore(item.n), title: '回到此版本', style: historyIconStyle(false) }, restoreGlyph()),
                  pick === item.n
                    ? h('button', { onClick: () => onDelete(item.n), title: '删除快照', style: historyIconStyle(false) }, trashGlyph())
                    : null,
                )
              }),
        ),
      )
    }

    /* ------------------------------------------------------ 详情栏 */

    const primaryButton = { height: 26, padding: '0 10px', borderRadius: 7, border: '1px solid var(--dsw-alias-brand-primary)', background: 'var(--dsw-alias-brand-primary)', color: '#fff', fontSize: 11, cursor: 'pointer' }
    const linkInputStyle = { height: 24, padding: '0 7px', borderRadius: 6, border: '1px solid var(--dsw-alias-border-l2)', background: 'var(--dsw-alias-bg-base)', color: 'var(--dsw-alias-label-primary)', fontSize: 11 }
    const menuItemStyle = { textAlign: 'left', padding: '6px 8px', borderRadius: 7, border: 'none', background: 'transparent', color: 'var(--dsw-alias-label-primary)', fontSize: 11, cursor: 'pointer' }
    const ghostButton = { height: 28, padding: '0 10px', borderRadius: 7, border: '1px solid var(--dsw-alias-border-l1)', background: 'transparent', color: 'var(--dsw-alias-label-secondary)', fontSize: 11, cursor: 'pointer' }
    const inputStyle = { width: '100%', height: 26, padding: '0 8px', borderRadius: 7, border: '1px solid var(--dsw-alias-border-l2)', background: 'var(--dsw-alias-bg-base)', color: 'var(--dsw-alias-label-primary)', fontSize: 11, boxSizing: 'border-box' }

    /**
     * 复制一段文本到剪贴板：优先 Clipboard API，失败回落到临时 textarea + execCommand。
     * （WebView 里 Clipboard API 偶尔因为没焦点/非安全上下文被拒，回落那一手是兜底。）
     * @returns {Promise<boolean>} 是否真的复制成功
     */
    const copyText = async (text) => {
      try {
        if (typeof navigator !== 'undefined' && navigator.clipboard && navigator.clipboard.writeText) {
          await navigator.clipboard.writeText(text)
          return true
        }
      } catch { /* 落到下面的兜底 */ }
      try {
        const area = document.createElement('textarea')
        area.value = text
        area.setAttribute('readonly', '')
        area.style.position = 'fixed'
        area.style.top = '-1000px'
        area.style.opacity = '0'
        document.body.appendChild(area)
        area.select()
        const ok = document.execCommand('copy')
        document.body.removeChild(area)
        return !!ok
      } catch { return false }
    }

    /** 当前这张图落在哪个文件上（没有就返回空串）。 */
    const currentDrawioPath = () => {
      const settings = (state.data && state.data.settings) || {}
      return String(settings.drawioFile || '').trim()
    }

    function Details({ item, items, edges, mode, onMode, note, onNoteChange, onOpenGroup }) {
      const byId = useMemo(() => {
        const map = new Map()
        for (const entry of items) map.set(entry.id, entry)
        return map
      }, [items])

      // 没选中也占着这块宽度：详情开合时画布不变宽，缩放/取景就不会跳。
      if (!item) {
        return h('div',
          {
            style: { width: '100%', flex: '1 1 auto', minHeight: 0, padding: '12px 14px', background: 'var(--dsw-alias-bg-layer-1)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 11, color: 'var(--dsw-alias-label-secondary)' },
          },
          '点一个节点看详情',
        )
      }

      const row = (label, value) =>
        h('div', { style: { display: 'flex', gap: 8, fontSize: 11, lineHeight: '18px' } }, h('span', { style: { color: 'var(--dsw-alias-label-secondary)', minWidth: 46 } }, label), h('span', { style: { color: 'var(--dsw-alias-label-primary)', wordBreak: 'break-all' } }, value),)

      const noteBox = h('div', { style: { display: 'flex', flexDirection: 'column', gap: 4, marginBottom: 10 } },
        h('div', { style: { fontSize: 10, color: 'var(--dsw-alias-label-secondary)' } }, '节点功能描述'),
        h('textarea', {
          defaultValue: note || '',
          placeholder: '（这个节点做什么用）',
          rows: 3,
          spellCheck: false,
          onChange: (event) => {
            // 边打边存（500ms 防抖）：点画布会让面板卸载，blur 可能根本不触发
            const value = event.target.value
            const who = item.label || item.path || ''
            if (window.__fgNoteTimer) clearTimeout(window.__fgNoteTimer)
            window.__fgNoteTimer = setTimeout(() => {
              window.__fgNoteTimer = null
              if (onNoteChange) onNoteChange(who, value)
            }, 500)
          },
          onBlur: (event) => {
            const value = event.target.value
            const who = item.label || item.path || ''
            if (window.__fgNoteTimer) {
              clearTimeout(window.__fgNoteTimer)
              window.__fgNoteTimer = null
            }
            if (onNoteChange) onNoteChange(who, value)
          },
          onKeyDown: (event) => {
            if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') event.currentTarget.blur()
          },
          style: { width: '100%', resize: 'vertical', borderRadius: 8, border: '1px solid var(--dsw-alias-border-l2)', background: 'var(--dsw-alias-bg-base)', color: 'var(--dsw-alias-label-primary)', fontSize: 11, padding: '6px 8px', fontFamily: 'inherit', },
        }),
      )
        const upstream = edges.filter((edge) => edge.to === item.id).map((edge) => ({ label: (byId.get(edge.from) || {}).label || edge.from, verb: edge.verb || '' }))
        const downstream = edges.filter((edge) => edge.from === item.id).map((edge) => ({ label: (byId.get(edge.to) || {}).label || edge.to, verb: edge.verb || '' }))
        return h('div',
        {
          style: { width: '100%', flex: '1 1 auto', minHeight: 0, padding: '12px 14px', overflowY: 'auto', background: 'var(--dsw-alias-bg-layer-1)', display: 'flex', flexDirection: 'column', gap: 8, },
          },
          noteBox,
          h('div',
            { style: { display: 'flex', gap: 4 } },
            [
              ['全部', 'all'],
              ['此节点关系', 'ego'],
              ['此节点链路', 'chain'],
            ].map(([label, value]) =>
              h('button',
                {
                  key: value,
                  onClick: () => onMode && onMode(value),
                  title:
                    value === 'ego'
                      ? '只显示这个节点 + 直接上游 + 直接下游，横向排'
                      : value === 'chain'
                        ? '上游整条链路 + 一层下游'
                        : '显示整张图',
                  style: { flex: 1, height: 24, padding: '0 6px', borderRadius: 6, border: '1px solid ' + (mode === value ? 'var(--dsw-alias-brand-primary)' : 'var(--dsw-alias-border-l1)'), background: mode === value ? 'var(--dsw-alias-brand-primary)' : 'transparent', color: mode === value ? '#fff' : 'var(--dsw-alias-label-secondary)', fontSize: 10, cursor: 'pointer', whiteSpace: 'nowrap' },
                },
                label,
              ),
            ),
          ),
          item.kind === 'group'
            ? h('button', {
                onClick: () => onOpenGroup && onOpenGroup(item.id),
                style: { height: 26, borderRadius: 7, border: '1px solid var(--dsw-alias-brand-primary)', background: 'var(--dsw-alias-brand-primary)', color: '#fff', fontSize: 11, cursor: 'pointer' },
              }, '打开节点组')
            : null,
          item.kind === 'group'
            ? h('div', { style: { fontSize: 10, color: 'var(--dsw-alias-label-secondary)', whiteSpace: 'pre-wrap' } },
                '输入：' + ((item.inputs || []).filter(Boolean).join('、') || '（无）') + '\n' +
                '输出：' + ((item.outputs || []).filter(Boolean).join('、') || '（无）'))
            : null,
          h('div', { style: { display: 'flex', flexDirection: 'column', gap: 4 } },
            h('div', { style: { fontSize: 10, color: 'var(--dsw-alias-label-secondary)' } }, '输入（从哪来）'),
            upstream.length === 0
              ? h('div', { style: { fontSize: 11, color: 'var(--dsw-alias-label-secondary)' } }, '（无）')
              : upstream.map((row) =>
                  h('div', { key: 'up:' + row.label, style: { fontSize: 11, color: 'var(--dsw-alias-label-secondary)' } }, '← ' + row.label + (row.verb ? '（' + row.verb + '）' : '')),
                ),
            h('div', { style: { fontSize: 10, color: 'var(--dsw-alias-label-secondary)', marginTop: 4 } }, '输出（到哪去）'),
            downstream.length === 0
              ? h('div', { style: { fontSize: 11, color: 'var(--dsw-alias-label-secondary)' } }, '（无）')
              : downstream.map((row) =>
                  h('div', { key: 'down:' + row.label, style: { fontSize: 11, color: 'var(--dsw-alias-label-primary)' } }, '→ ' + row.label + (row.verb ? '（' + row.verb + '）' : '')),
                ),
          ),
        )
    }

    /* --------------------------------------------------- 设置条 */

    function SettingsBar({ data, draft, onChange, undoDraft, onUndoChange, onSave, onCancel }) {
      return h('div',
        {
          style: { padding: '10px 16px', borderTop: '1px solid var(--dsw-alias-border-l1)', background: 'var(--dsw-alias-bg-layer-1)', display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', },
        },
        h('span', { style: { fontSize: 11, color: 'var(--dsw-alias-label-secondary)' } }, '关系文件保存到'),
        h('input', {
          value: draft,
          autoFocus: true,
          onChange: (event) => onChange(event.target.value),
          placeholder: '留空 = <项目>/.filegraph/graph.json，也可以填绝对路径 D:\\graphs\\proj.json',
          spellCheck: false,
          style: { flex: 1, minWidth: 260, height: 28, padding: '0 8px', borderRadius: 7, border: '1px solid var(--dsw-alias-border-l2)', background: 'var(--dsw-alias-bg-base)', color: 'var(--dsw-alias-label-primary)', fontSize: 11, fontFamily: 'ui-monospace, SFMono-Regular, Consolas, monospace', },
        }),
        h('span', { style: { fontSize: 11, color: 'var(--dsw-alias-label-secondary)' } }, '可回退步数'),
        h('input', {
          type: 'number',
          min: 10,
          max: 1000,
          value: undoDraft,
          onChange: (event) => onUndoChange(event.target.value),
          style: { width: 78, height: 28, padding: '0 8px', borderRadius: 7, border: '1px solid var(--dsw-alias-border-l2)', background: 'var(--dsw-alias-bg-base)', color: 'var(--dsw-alias-label-primary)', fontSize: 11, fontFamily: 'ui-monospace, SFMono-Regular, Consolas, monospace', },
        }),
        h('button', { onClick: onSave, style: primaryButton }, '保存'),
        h('button', { onClick: onCancel, style: ghostButton }, '取消'),
        h('div',
          { style: { width: '100%', fontSize: 10, color: 'var(--dsw-alias-label-secondary)' } },
          '当前：' + ((data && data.active && data.active.graphFile) || '还没有记录') +
            '　·　回退 10~1000 步，默认 30',
        ),
      )
    }

    /* --------------------------------------------------------- 面板 */

    /** 文件对话框的确认按钮：跟着动作走（新建就是「新建」，不能写「打开」）。 */
    const PICK_LABEL = {
      open: '打开',
      reload: '打开',
      new: '新建',
      saveas: '另存为',
      copy: '保存副本',
      md: '导出',
    }

    /** Blender 风格的文件浏览：上一级 + 子目录/.drawio 列表 + 路径框 + 打开/取消。 */
    function FileBrowser(props) {
      const initial = props.initialPath || ''
      const [dir, setDir] = useState(initial.replace(/[\\/][^\\/]*$/, ''))
      const [entries, setEntries] = useState([])
      const [draft, setDraft] = useState(initial)
      const [busy, setBusy] = useState(false)

      const loadDir = (target) => {
        setBusy(true)
        const ext = props.mode === 'md' ? 'md' : 'drawio'
        fetch('/filegraph/list' + (target ? '?path=' + encodeURIComponent(target) + '&ext=' + ext : '?ext=' + ext))
          .then((res) => res.json())
          .then((json) => {
            if (json && json.ok) {
              setDir(json.dir)
              setEntries(json.entries || [])
            }
            setBusy(false)
          })
          .catch(() => setBusy(false))
      }

      useEffect(() => {
        loadDir(dir)
      }, [])

      const list = entries || []
      return h('div',
        { style: { display: 'flex', flexDirection: 'column', gap: 6, width: 520 } },
        h('div',
          { style: { display: 'flex', gap: 6, alignItems: 'center' } },
          h('button', { onClick: () => loadDir(dir.replace(/[\\/][^\\/]*$/, '')), style: ghostButton, title: '上一级' }, '↑'),
          h('div',
            {
              style: { flex: 1, fontSize: 10, color: 'var(--dsw-alias-label-secondary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
              title: dir,
            },
            dir || '(根目录)',
          ),
        ),
        h('div',
          { style: { maxHeight: 230, overflowY: 'auto', border: '1px solid var(--dsw-alias-border-l1)', borderRadius: 8 } },
          list.length === 0
            ? h('div', { style: { padding: 8, fontSize: 11, color: 'var(--dsw-alias-label-secondary)' } }, busy ? '读取中…' : '没有子目录或 .drawio')
            : list.map((entry) =>
                h('button',
                  {
                    key: entry.path,
                    title: entry.path,
                    onClick: () => {
                      if (entry.isDir) loadDir(entry.path)
                      else setDraft(entry.path)
                    },
                    style: { display: 'flex', alignItems: 'center', gap: 8, width: '100%', textAlign: 'left', padding: '4px 8px', border: 'none', background: 'transparent', color: 'var(--dsw-alias-label-primary)', fontSize: 11, cursor: 'pointer', },
                  },
                  h('span', { style: { flex: '0 0 auto' } }, entry.isDir ? '📁' : '📄'),
                  h('span', { style: { flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, entry.name),
                  h('span',
                    { style: { flex: '0 0 auto', fontSize: 9, color: 'var(--dsw-alias-label-secondary)' } },
                    entry.isDir ? '' : entry.size ? Math.round(entry.size / 1024) + ' KB' : '',
                  ),
                ),
              ),
        ),
        h('input', {
          value: draft,
          spellCheck: false,
          onChange: (event) => setDraft(event.target.value),
          onKeyDown: (event) => {
            if (event.key === 'Enter' && draft.trim()) props.onPick(withExt(draft.trim(), props.mode === 'md' ? '.md' : '.drawio'))
          },
          style: { height: 26, padding: '0 8px', borderRadius: 7, border: '1px solid var(--dsw-alias-border-l2)', background: 'var(--dsw-alias-bg-base)', color: 'var(--dsw-alias-label-primary)', fontSize: 11, fontFamily: 'ui-monospace, Consolas, monospace', },
        }),
        h('div',
          { style: { display: 'flex', gap: 6, justifyContent: 'flex-end' } },
          h('button', { onClick: () => draft.trim() && props.onPick(withExt(draft.trim(), props.mode === 'md' ? '.md' : '.drawio')), style: primaryButton }, PICK_LABEL[props.mode] || '打开'),
          h('button', { onClick: props.onCancel, style: ghostButton }, '取消'),
        ),
      )
    }

    async function cutEdges(list) {
      if (!list || list.length === 0) return
      const gid = openGroupId()
      if (gid) {
        // 节点组内部：直接改组数据
        const ids = new Set(list.map((edge) => edge && edge.id).filter(Boolean))
        editGroup(gid, (draft) => {
          draft.flows = (draft.flows || []).filter((flow) => !ids.has(flow.id))
        })
        state.notice = '剪掉了 ' + ids.size + ' 条关系'
        return
      }
      try {
        const json = await postJson('/filegraph/remove-edge', { edges: list.map((edge) => ({ id: edge.id })) })
        const removed = json && typeof json.removed === 'number' ? json.removed : list.length
        state.notice = removed > 0 ? '剪掉了 ' + removed + ' 条关系' : '没匹配到要剪的关系'
        await load(undefined)
        notify()
      } catch (error) {
        state.error = String((error && error.message) || error)
        notify()
      }
    }

    function openGroupId() {
      const stack = state.groupStack || []
      return stack.length > 0 ? stack[stack.length - 1] : null
    }

    /** 打开节点组：递归下去就是嵌套组（栈），返回键退回上一层。 */
    function openGroupNode(canvasId) {
      const id = String(canvasId || '').indexOf('f:') === 0 ? String(canvasId).slice(2) : String(canvasId || '')
      if (!id || !((state.data && state.data.groups) || {})[id]) {
        state.notice = '这个节点不是节点组'
        notify()
        return
      }
      state.groupStack = [...(state.groupStack || []), id]
      state.selected = null
      state.ctxMenu = null
      notify()
      repairPortNames(id)
    }

    function closeGroup() {
      const stack = (state.groupStack || []).slice(0, -1)
      state.groupStack = stack
      state.selected = null
      state.ctxMenu = null
      notify()
    }

    /** 组端口外面接的是谁：into(口) = 上一节点名，outOf(口) = 下一节点名。 */
    function groupPortNames(groupId) {
      const stack = state.groupStack || []
      const at = stack.lastIndexOf(groupId)
      const parent = at > 0 ? (((state.data && state.data.groups) || {})[stack[at - 1]] || null) : null
      const flows = (parent ? parent.flows : (state.data && state.data.flows)) || []
      const nodes = (parent ? parent.nodes : (state.data && state.data.flowNodes)) || []
      const nameOf = (id) => {
        const hit = nodes.find((node) => node.id === id)
        return (hit && hit.name) || ''
      }
      const at0 = (value) => Math.max(0, Number(value) || 0)
      return {
        into: (port) => {
          const flow = flows.find((item) => item.toId === groupId && at0(item.toPort) === port)
          return flow ? nameOf(flow.fromId).slice(0, 60) : ''
        },
        outOf: (port) => {
          const flow = flows.find((item) => item.fromId === groupId && at0(item.fromPort) === port)
          return flow ? nameOf(flow.toId).slice(0, 60) : ''
        },
        /** 这个口外面有没有线接着 */
        intoLive: (port) => flows.some((item) => item.toId === groupId && at0(item.toPort) === port),
        outOfLive: (port) => flows.some((item) => item.fromId === groupId && at0(item.fromPort) === port),
      }
    }

    /**
     * 端口规则（照 use 里那张流程）：
     * ① 没线接入 → 端口清除（内部线、外面线都没有才算没接入）；
     * ② 输入口（线从上一级进来）→ 名字按规则变：默认名换成上一节点名（灰线功能）；
     * ③ 输出口（线往外走）→ 默认名称（输出 / 输出 N），不拿节点名乱猜。
     * 用户自己改过的名字一律不动。
     */
    function applyPortRules(groupId, draft) {
      const names = groupPortNames(groupId)
      const generic = (label, word) => {
        const text = String(label == null ? '' : label).trim()
        return text === '' || text === word || new RegExp('^' + word + ' \\d+$').test(text)
      }
      // 端口名
      ;(draft.inputs || []).forEach((label, index) => {
        if (!generic(label, '输入')) return
        const name = names.into(index)
        if (name) draft.inputs[index] = name
      })
      ;(draft.outputs || []).forEach((label, index) => {
        if (!generic(label, '输出')) return
        if (!String(label || '').trim()) draft.outputs[index] = '输出 ' + (index + 1)
      })
      // 端口清除：把没接线的口删掉，后面的关系跟着挪号
      const prune = (which) => {
        const sideIn = which === 'gin'
        const list = sideIn ? draft.inputs : draft.outputs
        if (!Array.isArray(list)) return
        const portKey = sideIn ? 'fromPort' : 'toPort'
        const selfKey = sideIn ? 'fromId' : 'toId'
        const live = sideIn ? names.intoLive : names.outOfLive
        const users = new Map()
        for (const flow of draft.flows || []) {
          if (flow[selfKey] !== which) continue
          const port = Math.max(0, Number(flow[portKey]) || 0)
          if (!users.has(port)) users.set(port, [])
          users.get(port).push(flow)
        }
        const keep = []
        const remap = new Map()
        for (let index = 0; index < list.length; index += 1) {
          const used = (users.get(index) || []).length > 0 || live(index)
          if (!used) continue
          remap.set(index, keep.length)
          keep.push(list[index])
        }
        // 列表外的脏端口：有线就留到最后
        for (const port of users.keys()) {
          if (port < list.length) continue
          remap.set(port, keep.length)
          keep.push('端口 ' + (keep.length + 1))
        }
        // 保持 n+1：有 n 个已接入就留 n 个 + 一个空口；一个都没接入时也留一个。
        const spare = (() => {
          for (let index = 0; index < list.length; index += 1) {
            if (!remap.has(index)) return list[index]
          }
          return ''
        })()
        keep.push(spare || (sideIn ? '输入 ' : '输出 ') + (keep.length + 1))
        for (const [port, flows] of users) {
          if (!remap.has(port)) continue
          for (const flow of flows) flow[portKey] = remap.get(port)
        }
        if (sideIn) draft.inputs = keep
        else draft.outputs = keep
      }
      prune('gin')
      prune('gout')
    }

    /** 打开组时顺手跑一次端口规则：没变化就不存盘。 */
    function repairPortNames(groupId) {
      const def = ((state.data && state.data.groups) || {})[groupId]
      if (!def) return
      const draft = JSON.parse(JSON.stringify(def))
      const before = JSON.stringify([draft.inputs || [], draft.outputs || [], draft.flows || []])
      applyPortRules(groupId, draft)
      if (JSON.stringify([draft.inputs || [], draft.outputs || [], draft.flows || []]) === before) return
      editGroup(groupId, (target) => {
        target.inputs = draft.inputs
        target.outputs = draft.outputs
        target.flows = draft.flows
      })
    }

    /** 改节点组内部：先本地生效（拖拽/连线手感），再整份存回宿主。 */
    function editGroup(groupId, mutate, options) {
      const groups = (state.data && state.data.groups) || {}
      const source = groups[groupId]
      if (!source) return null
      const draft = JSON.parse(JSON.stringify(source))
      mutate(draft)
      if (!(options && options.keepEmpty)) applyPortRules(groupId, draft)
      const gin = (draft.nodes || []).find((node) => node.id === 'gin')
      if (gin) gin.outputs = (draft.inputs || []).slice()
      const gout = (draft.nodes || []).find((node) => node.id === 'gout')
      if (gout) gout.inputs = (draft.outputs || []).slice()
      groups[groupId] = draft
      notify()
      postJson('/filegraph/group', { action: 'save', id: groupId, data: draft })
        .then((json) => {
          state.data = json
          notify()
        })
        .catch((error) => {
          state.error = String((error && error.message) || error)
          notify()
        })
      return draft
    }

    function startRenameNode(item) {
      if (item.kind === 'input' || item.kind === 'output') {
        state.notice = '组输入/组输出是保留节点，不能改名'
        notify()
        return
      }
      const gid = openGroupId()
      state.renameTarget = { kind: 'node', id: item.id, groupId: gid, name: item.label }
      state.renameDraft = item.label || ''
      state.ctxMenu = null
      notify()
    }

    function startRenameEdge(edge) {
      state.renameTarget = { kind: 'edge', id: edge.id, groupId: openGroupId(), verb: edge.verb || '', from: edge.from, to: edge.to }
      state.renameDraft = edge.verb || ''
      state.ctxMenu = null
      notify()
    }

    function startRenameGroup(groupId) {
      const group = ((state.data && state.data.groups) || {})[groupId]
      state.renameTarget = { kind: 'group', id: groupId, name: group ? group.name : '' }
      state.renameDraft = group ? group.name : ''
      state.ctxMenu = null
      notify()
    }

    async function submitRename() {
      const t = state.renameTarget
      if (!t) return
      const next = String(state.renameDraft || '').trim()
      try {
        if (t.kind === 'group') {
          if (!next) throw new Error('组名不能为空')
          await postJson('/filegraph/group', { action: 'rename', id: t.id, name: next })
          state.renameTarget = null
          state.notice = '已把节点组改名为「' + next + '」'
          await load(undefined)
          notify()
          return
        }
        if (t.kind === 'port') {
          if (!next) throw new Error('端口名不能为空')
          const gid = t.groupId
          editGroup(gid, (draft) => {
            if (t.nodeId) {
              const node = (draft.nodes || []).find((item) => item.id === t.nodeId)
              if (node) {
                const list = t.side === 'in' ? node.inputs : node.outputs
                list[t.index] = next
              }
            } else {
              const list = t.side === 'in' ? (draft.inputs = draft.inputs || []) : (draft.outputs = draft.outputs || [])
              list[t.index] = next
            }
          })
          state.renameTarget = null
          state.notice = '端口改名为「' + next + '」'
          notify()
          return
        }
        if (t.groupId) {
          // 节点组内部改名：只改组内数据
          if (!next) throw new Error('名字不能为空')
          editGroup(t.groupId, (draft) => {
            if (t.kind === 'node') {
              const node = (draft.nodes || []).find((item) => item.id === t.id)
              if (node) node.name = next
            } else {
              const flow = (draft.flows || []).find((item) => item.id === t.id)
              if (flow) flow.verb = next
            }
          })
          state.renameTarget = null
          state.notice = t.kind === 'node' ? '已改名为「' + next + '」' : next ? '动作改成「' + next + '」' : '这条关系没有动作词了'
          notify()
          return
        }
        if (t.kind === 'node') {
          if (!next) throw new Error('名字不能为空')
          await postJson('/filegraph/rename-node', { id: String(t.id).replace(/^f:/, ''), name: next })
          state.renameTarget = null
          state.notice = '已把节点改名为「' + next + '」'
        } else {
          if (!t.id) throw new Error('这条关系没有 id')
          await postJson('/filegraph/rename-edge', { id: t.id, verb: next })
          state.renameTarget = null
          state.notice = next ? '动作改成「' + next + '」' : '这条关系没有动作词了'
        }
        await load(undefined)
        notify()
      } catch (error) {
        state.error = String((error && error.message) || error)
        notify()
      }
    }

    async function saveNow(silent) {
      try {
        await postJson('/filegraph/save', {})
        if (!silent) {
          state.notice = '已保存'
          notify()
        }
      } catch (error) {
        state.error = String((error && error.message) || error)
        notify()
      }
    }

    async function undoLast() {
      try {
        const json = await postJson('/filegraph/undo', {})
        if (json && json.ok === false) state.notice = json.error || '没有可回退的操作'
        else state.notice = '已回退上一步'
        await load(undefined)
        notify()
      } catch (error) {
        state.error = String((error && error.message) || error)
        notify()
      }
    }

    /** 取某个版本的图（只读，按版本号缓存）。 */
    async function loadHistoryModel(n) {
      if (state.historyModels[n]) return state.historyModels[n]
      try {
        const json = await postJson(HISTORY_URL, { action: 'show', n })
        state.historyModels = { ...state.historyModels, [n]: json.version }
        notify()
        return json.version
      } catch (error) {
        state.error = String((error && error.message) || error)
        notify()
        return null
      }
    }

    /** 点一行版本：选中它并把它的对照叠到画布上（再点一次只切眼睛）。 */
    /** 点一行只选中（出现删除按钮）；开对照是眼睛的事，别让"选中"顺手把虚线框糊到画布上。 */
    async function pickHistory(n) {
      state.historyPick = n
      notify()
    }

    async function toggleHistory(n) {
      const next = { ...state.historyEyes }
      if (next[n]) delete next[n]
      else {
        next[n] = true
        state.historyPick = n
      }
      state.historyEyes = next
      notify()
      if (next[n]) await loadHistoryModel(n)
    }

    /** 回到某个版本：先给当前版本留一份快照，所以这一步本身也能 Ctrl+Z 回来。 */
    async function restoreHistory(n) {
      try {
        const json = await postJson(HISTORY_URL, { action: 'restore', n })
        state.historyEyes = {}
        state.historyPick = 0
        state.historyModels = {}
        state.data = json
        state.error = null
        state.notice = '已回到版本 ' + n
        notify()
      } catch (error) {
        state.error = String((error && error.message) || error)
        notify()
      }
    }

    /** 手动存一份文件快照（与「保存」分开；每点一次新增一份，不自动生成）。 */
    async function saveSnapshot() {
      try {
        const json = await postJson(HISTORY_URL, { action: 'snapshot' })
        const list = Array.isArray(json && json.history) ? json.history : []
        if (state.data) state.data = { ...state.data, history: list }
        if (json && json.snapshot) state.historyPick = json.snapshot.n
        state.error = null
        state.notice = json && json.snapshot ? '已保存快照：版本 ' + json.snapshot.n : '已保存快照'
        notify()
      } catch (error) {
        state.error = String((error && error.message) || error)
        notify()
      }
    }

    /** 删掉一份快照文件（UI 上要先选中那一行才会出现删除按钮）。 */
    async function deleteHistory(n) {
      try {
        const json = await postJson(HISTORY_URL, { action: 'delete', n })
        if (state.data) state.data = { ...state.data, history: Array.isArray(json && json.history) ? json.history : [] }
        if (state.historyPick === n) state.historyPick = 0
        const eyes = { ...state.historyEyes }
        delete eyes[n]
        state.historyEyes = eyes
        const models = { ...state.historyModels }
        delete models[n]
        state.historyModels = models
        state.error = null
        state.notice = '已删除版本 ' + n
        notify()
      } catch (error) {
        state.error = String((error && error.message) || error)
        notify()
      }
    }

    /** 再放一个同名节点：名字一样 = 数据（备注）一样，但各自有 id 和连线。 */
    async function duplicateSelected() {
      const gid = openGroupId()
      if (gid) {
        const id = String(state.selected || '').replace(/^f:/, '')
        if (!id) {
          state.notice = '先选中一个节点'
          notify()
          return
        }
        const group = ((state.data && state.data.groups) || {})[gid]
        const source = group && (group.nodes || []).find((node) => node.id === id)
        if (!source) return
        editGroup(gid, (draft) => {
          draft.nodes.push({
            id: 'gn' + Date.now().toString(36),
            name: source.name,
            kind: source.kind === 'group' ? 'node' : source.kind,
            x: (source.x || 0) + 60,
            y: (source.y || 0) + 60,
            inputs: (source.inputs || []).slice(),
            outputs: (source.outputs || []).slice(),
          })
        })
        state.notice = '又放了一个「' + source.name + '」'
        notify()
        return
      }
      const id = String(state.selected || '').replace(/^f:/, '')
      if (!id) {
        state.notice = '先选中一个节点'
        notify()
        return
      }
      try {
        const json = await postJson('/filegraph/duplicate', { id })
        state.notice = '又放了一个「' + ((json && json.copyName) || '这个节点') + '」'
        await load(undefined)
        notify()
      } catch (error) {
        state.error = String((error && error.message) || error)
        notify()
      }
    }

    /** 当前作用域里所有节点的实际显示框（主画布 = 画布坐标+手拖矢量，组内 = node.x/y）。 */
    function visualNodeBoxes() {
      const data = state.data || {}
      const stack = state.groupStack || []
      const gid = stack.length > 0 ? stack[stack.length - 1] : null
      const group = gid ? ((data.groups || {})[gid] || null) : null
      const out = []
      const box = (node, x, y) => {
        const labeled = node.kind === 'group' || node.kind === 'input' || node.kind === 'output'
        const rows = labeled ? Math.max((node.inputs || []).length, (node.outputs || []).length, 1) : 1
        out.push({ x, y, w: labeled ? 200 : 178, h: labeled ? 30 + rows * 18 : 34 })
      }
      if (group) {
        for (const node of group.nodes || []) box(node, Number(node.x) || 0, Number(node.y) || 0)
      } else {
        for (const node of data.flowNodes || []) {
          const base = (data.flowPositions || {})[node.id] || { x: 80, y: 80 }
          box(node, base.x, base.y)
        }
      }
      return out
    }

    /** 在屏幕中心附近找空位：先试正中心，压住别的节点就一圈圈往外找。 */
    function freeSpotNear(w, h) {
      const center = state.viewport || { x: 320, y: 200 }
      const taken = visualNodeBoxes()
      const gap = 18
      const startX = Math.round(center.x - w / 2)
      const startY = Math.round(center.y - h / 2)
      const fits = (x, y) =>
        !taken.some((t) => x < t.x + t.w + gap && x + w + gap > t.x && y < t.y + t.h + gap && y + h + gap > t.y)
      if (fits(startX, startY)) return { x: startX, y: startY }
      const stepX = w + 40
      const stepY = h + 40
      for (let ring = 1; ring <= 12; ring += 1) {
        for (let i = -ring; i <= ring; i += 1) {
          const spots = [
            { x: startX + i * stepX, y: startY - ring * stepY },
            { x: startX + i * stepX, y: startY + ring * stepY },
            { x: startX - ring * stepX, y: startY + i * stepY },
            { x: startX + ring * stepX, y: startY + i * stepY },
          ]
          for (const spot of spots) if (fits(spot.x, spot.y)) return spot
        }
      }
      return { x: startX, y: startY }
    }

    async function addNode() {
      const gid = openGroupId()
      if (gid) {
        const group = ((state.data && state.data.groups) || {})[gid]
        if (!group) return
        const count = (group.nodes || []).length
        const spot = freeSpotNear(178, 34)
        editGroup(gid, (draft) => {
          draft.nodes.push({
            id: 'gn' + Date.now().toString(36),
            name: '节点 ' + count,
            kind: 'node',
            x: spot.x,
            y: spot.y,
            inputs: ['输入'],
            outputs: ['输出'],
          })
        })
        state.newNode = ''
        state.notice = '已往节点组里加了一个节点'
        notify()
        return
      }
      const name = String(state.newNode || '').trim()
      const spot = freeSpotNear(178, 34)
      try {
        await postJson('/filegraph/node', { name, x: spot.x, y: spot.y })
        state.newNode = ''
        state.notice = '已添加节点'
        await load(undefined)
        notify()
      } catch (error) {
        state.error = String((error && error.message) || error)
        notify()
      }
    }

    /** 一键画一套工作流模板（presets/*.json）：主干一条线 + 侧枝。 */
    async function applyPreset() {
      try {
        const json = await postJson('/filegraph/preset', { action: 'apply' })
        await load(undefined)
        // payload 里也有 nodes/edges（文件层），模板数量要用 presetNodes/presetEdges，别撞名
        state.notice = '已添加「' + ((json && json.presetName) || '工作流预设') + '」：' +
          ((json && json.presetNodes) || 0) + ' 个节点 / ' + ((json && json.presetEdges) || 0) + ' 条关系'
        notify()
      } catch (error) {
        state.error = String((error && error.message) || error)
        notify()
      }
    }

    async function addGroupNode() {
      const parent = openGroupId()
      const spot = freeSpotNear(200, 66)
      try {
        if (parent) {
          await postJson('/filegraph/group', { action: 'create', parent, x: spot.x, y: spot.y })
        } else {
          await postJson('/filegraph/group', { action: 'create', x: spot.x, y: spot.y })
        }
        state.notice = parent ? '已在节点组里加了一个子节点组' : '已在画布上加了一个节点组'
        await load(undefined)
        notify()
      } catch (error) {
        state.error = String((error && error.message) || error)
        notify()
      }
    }

    /** 框选了几个节点 → Shift+A：把它们收进一个新节点组（跨边界的线变成组的端口）。 */
    async function wrapSelection() {
      const parent = openGroupId()
      const ids = (state.picked || []).map((id) => String(id).replace(/^f:/, '')).filter(Boolean)
      if (ids.length === 0) return
      try {
        const json = await postJson('/filegraph/group', { action: 'wrap', parent: parent || undefined, ids })
        state.picked = []
        // 选中刚建的组：详情栏能看到它、右键能直接打开/解散
        state.selected = json && json.created ? 'f:' + json.created : null
        state.notice = '已把 ' + ids.length + ' 个节点收进「' + ((json && json.createdName) || '节点组') + '」'
        await load(undefined)
        notify()
      } catch (error) {
        const message = String((error && error.message) || error)
        // 旧宿主没有 action:'wrap'（会回 id required / unknown action）：说清怎么修
        state.error = message === 'id required' || message.indexOf('unknown action') >= 0
          ? '宿主还是旧版本：框选成组要完全退出 DSH 再打开才生效'
          : message
        notify()
      }
    }

    async function renameGroup(groupId) {
      startRenameGroup(groupId)
    }

    async function deleteGroup(groupId) {
      try {
        await postJson('/filegraph/group', { action: 'delete', id: groupId })
        state.notice = '已删除节点组'
        state.ctxMenu = null
        await load(undefined)
        notify()
      } catch (error) {
        state.error = String((error && error.message) || error)
        notify()
      }
    }

    /** 解散节点组：组里的节点放回上一层，跨边界的线按端口接回外部，组本身删掉。 */
    async function ungroupNode(groupId) {
      try {
        const json = await postJson('/filegraph/group', { action: 'ungroup', id: groupId })
        state.notice = '已解散节点组：放回 ' + ((json && json.ungrouped) || 0) + ' 个节点，接回 ' + ((json && json.ungroupedEdges) || 0) + ' 条关系'
        state.ctxMenu = null
        await load(undefined)
        notify()
      } catch (error) {
        const message = String((error && error.message) || error)
        state.error = message.indexOf('unknown action') >= 0
          ? '宿主还是旧版本：解散节点组要完全退出 DSH 再打开才生效'
          : message
        notify()
      }
    }

    function addPort(groupId, side) {
      editGroup(groupId, (draft) => {
        const list = side === 'in' ? (draft.inputs = draft.inputs || []) : (draft.outputs = draft.outputs || [])
        list.push(side === 'in' ? '输入 ' + (list.length + 1) : '输出 ' + (list.length + 1))
      }, { keepEmpty: true })
      state.notice = side === 'in' ? '加了一个输入端口' : '加了一个输出端口'
      notify()
    }

    /**
     * 组输入 / 组输出：一个端口只走一条关系。
     * 同一端口上挂了第二条关系时，就再加一个端口（名字取对端节点名），后面的关系挪过去。
     * 原来的端口留给外面那条灰线——它的名字（上一节点名）不动。
     */
    function splitPortsInDraft(draft, which, seedName) {
      const node = (draft.nodes || []).find((item) => item.id === which)
      if (!node) return 0
      const sideIn = which === 'gin'
      const list = sideIn ? (draft.inputs = draft.inputs || []) : (draft.outputs = draft.outputs || [])
      const portKey = sideIn ? 'fromPort' : 'toPort'
      const selfKey = sideIn ? 'fromId' : 'toId'
      const used = new Set()
      let added = 0
      for (const flow of draft.flows || []) {
        if (flow[selfKey] !== which) continue
        const port = Math.max(0, Number(flow[portKey]) || 0)
        if (!used.has(port)) {
          used.add(port)
          continue
        }
        const seed = typeof seedName === 'function' ? seedName(port) : ''
        list.push(seed || list[port] || (sideIn ? '输入 ' : '输出 ') + (list.length + 1))
        flow[portKey] = list.length - 1
        used.add(flow[portKey])
        added += 1
      }
      return added
    }

    function splitGroupPorts(groupId, which) {
      const names = groupPortNames(groupId)
      const seed = which === 'gin' ? names.into : names.outOf
      let added = 0
      editGroup(groupId, (draft) => { added = splitPortsInDraft(draft, which, seed) })
      state.notice = added > 0 ? '多加了 ' + added + ' 个端口' : '每条关系已经各占一个端口'
      notify()
    }

    function setNodePorts(groupId, nodeId, side, labels) {
      editGroup(groupId, (draft) => {
        const node = (draft.nodes || []).find((item) => item.id === nodeId)
        if (!node) return
        if (side === 'in') node.inputs = labels
        else node.outputs = labels
      })
    }

    function portTarget(node, side) {
      // 节点组：端口就是组对外的端口；普通节点：端口在节点自己身上
      if (node.kind === 'group') return { groupId: node.nodeId, nodeId: null }
      return { groupId: openGroupId(), nodeId: node.nodeId }
    }

    function startRenamePort(node, side, index) {
      const target = portTarget(node, side)
      const list = side === 'in' ? node.inputs || [] : node.outputs || []
      state.renameTarget = { kind: 'port', ...target, side, index, name: list[index] || '' }
      state.renameDraft = list[index] || ''
      state.ctxMenu = null
      notify()
    }

    /** 删一个端口：连在它上面的关系一起删，后面的端口序号往前挪。 */
    function removePortOf(draft, nodeId, side, index) {
      draft.flows = (draft.flows || []).filter((flow) => {
        const hit = side === 'out' ? flow.fromId === nodeId && flow.fromPort === index : flow.toId === nodeId && flow.toPort === index
        return !hit
      })
      for (const flow of draft.flows || []) {
        if (side === 'out' && flow.fromId === nodeId && flow.fromPort > index) flow.fromPort -= 1
        if (side === 'in' && flow.toId === nodeId && flow.toPort > index) flow.toPort -= 1
      }
    }

    function removePort(node, side, index) {
      const target = portTarget(node, side)
      if (!target.groupId) return
      editGroup(target.groupId, (draft) => {
        if (target.nodeId) {
          const inner = (draft.nodes || []).find((item) => item.id === target.nodeId)
          if (!inner) return
          const list = side === 'in' ? inner.inputs : inner.outputs
          list.splice(index, 1)
          removePortOf(draft, target.nodeId, side, index)
        } else {
          const list = side === 'in' ? (draft.inputs = draft.inputs || []) : (draft.outputs = draft.outputs || [])
          list.splice(index, 1)
          removePortOf(draft, side === 'in' ? 'gin' : 'gout', side === 'in' ? 'out' : 'in', index)
        }
      })
      state.notice = '删了一个端口'
      notify()
    }

    async function saveNote(name, text) {
      try {
        const json = await postJson('/filegraph/note', { name, text })
        const next = { ...(state.nodeNotes || {}) }
        if (String(text || '').trim()) next[name] = String(text)
        else delete next[name]
        state.nodeNotes = (json && json.nodeNotes) || next
        notify()
      } catch (error) {
        state.error = String((error && error.message) || error)
        notify()
      }
    }

    async function deleteNodeById(canvasId) {
      state.ctxMenu = null
      const id = String(canvasId || '').replace(/^f:/, '')
      if (!id) return
      const gid = openGroupId()
      if (gid) {
        editGroup(gid, (draft) => {
          draft.nodes = (draft.nodes || []).filter((node) => node.id !== id || node.id === 'gin' || node.id === 'gout')
          draft.flows = (draft.flows || []).filter((flow) => flow.fromId !== id && flow.toId !== id)
        })
        state.notice = '已删除组内节点'
        notify()
        return
      }
      try {
        await postJson('/filegraph/remove-node', { id })
        state.notice = '已删除节点'
        await load(undefined)
        notify()
      } catch (error) {
        state.error = String((error && error.message) || error)
        notify()
      }
    }

    function GraphPanel() {
      const current = useStore()
      const data = current.data

      // 打开的是哪个节点组（栈顶）；没有就是主画布。
      const group = current.groupStack && current.groupStack.length > 0
        ? ((data && data.groups) || {})[current.groupStack[current.groupStack.length - 1]] || null
        : null

      // 关系画布：节点各自有 id；节点信息按名字存（同名节点共用备注）。
      const flowModel = useMemo(() => {
        if (!data) return null
        if (group) {
          const list = (group.nodes || []).map((node) => ({
            id: 'f:' + node.id,
            nodeId: node.id,
            label: node.name,
            kind: node.kind,
            inputs: node.kind === 'input' ? [] : (node.inputs || []),
            outputs: node.kind === 'output' ? [] : (node.outputs || []),
            group: '节点组',
            groupRank: 0,
            color: '#1d4ed8',
            writes: 0,
            reads: 0,
            lastAt: 0,
          }))
          const positions = {}
          for (const node of group.nodes || []) positions['f:' + node.id] = { x: node.x || 0, y: node.y || 0 }
          const innerKind = new Map((group.nodes || []).map((node) => [node.id, node.kind]))
          const edgeList = spreadPorts(group.flows || [], innerKind)
          return { items: list, edges: edgeList, positions, inGroup: true }
        }
        const groups = (data && data.groups) || {}
        const list = (data.flowNodes || []).map((node) => {
          const def = groups[node.id]
          return {
            id: 'f:' + node.id,
            nodeId: node.id,
            label: node.name,
            kind: node.kind === 'group' ? 'group' : 'node',
            inputs: def ? (def.inputs || []) : [''],
            outputs: def ? (def.outputs || []) : [''],
            group: '关系',
            groupRank: 0,
            color: '#64748b',
            writes: 0,
            reads: 0,
            lastAt: 0,
          }
        })
        const positions = {}
        for (const item of list) {
          const base = (data.flowPositions || {})[item.nodeId] || { x: 80, y: 80 }
          positions[item.id] = { x: base.x, y: base.y }
        }
        const kindOf = new Map(list.map((item) => [item.nodeId, item.kind]))
        const edgeList = spreadPorts(data.flows || [], kindOf)
        return { items: list, edges: edgeList, positions, inGroup: false }
      }, [data, current.groupStack, group])

      // 只有这一张画布了：节点 / 关系 / 节点组。
      const baseItems = flowModel ? flowModel.items : []
      const baseEdges = flowModel ? flowModel.edges : []

      const selectedItem = current.selected
        ? baseItems.find((item) => item.id === current.selected)
        : null

      // 选中的是节点组时：它的数据（端口/内部/备注）在 groups[id] 里，和普通节点的数据不互通
      const selectedGroupDef = selectedItem && selectedItem.kind === 'group'
        ? ((data && data.groups) || {})[selectedItem.nodeId] || null
        : null

      // 只看局部：在**当前这张图**上按选中节点收窄（不换图、只筛）。
      const scope = useMemo(() => {
        if (!current.selected || current.scopeMode === 'none') return null
        if (!baseItems.some((item) => item.id === current.selected)) return null
        return current.scopeMode === 'chain'
          ? chainScope(current.selected, baseEdges)
          : egoScope(current.selected, baseEdges)
      }, [current.selected, current.scopeMode, baseItems, baseEdges])

      const shownItems = useMemo(
        () => (scope ? baseItems.filter((item) => scope.keep.has(item.id)) : baseItems),
        [baseItems, scope],
      )
      const shownEdges = useMemo(
        () => (scope ? baseEdges.filter((edge) => scope.keep.has(edge.from) && scope.keep.has(edge.to)) : baseEdges),
        [baseEdges, scope],
      )

      /**
       * 只看局部时按"制造链路"横向排：上游全在左（深度越深越左），选中节点居中，下游一列在右。
       * 只影响显示，不动文件里存的位置。
       */
      const layeredPositions = useMemo(() => {
        if (!scope || !flowModel) return null
        const columns = new Map()
        for (const item of flowModel.items) {
          if (!scope.keep.has(item.id)) continue
          const level = scope.levels.get(item.id) ?? 0
          if (!columns.has(level)) columns.set(level, [])
          columns.get(level).push(item)
        }
        const order = [...columns.keys()].sort((a, b) => a - b)
        const positions = {}
        order.forEach((level, columnIndex) => {
          const list = columns.get(level).slice().sort((a, b) => {
            const pa = flowModel.positions[a.id] || { x: 0, y: 0 }
            const pb = flowModel.positions[b.id] || { x: 0, y: 0 }
            return pa.y - pb.y || pa.x - pb.x
          })
          list.forEach((item, rowIndex) => {
            positions[item.id] = { x: 60 + columnIndex * 260, y: 60 + rowIndex * 96 }
          })
        })
        // 筛选模式下的拖动只改显示（scopeDrags），不写进文件位置
        const tweak = current.scopeDrags || {}
        for (const id of Object.keys(positions)) {
          if (tweak[id]) positions[id] = { x: tweak[id].x, y: tweak[id].y }
        }
        return positions
      }, [scope, flowModel, current.scopeDrags])

      const groupStack = current.groupStack || []
      const groupPath = groupStack.map((id) => (((data && data.groups) || {})[id] || {}).name || '节点组')

      // 双向关系就让两条反向的线回到同一个节点（不做副本）。

      useEffect(() => {
        // 自动轮询已关闭：只有点「刷新」或执行编辑操作时才重新读盘（用户要求不要一跳一跳）
        return undefined
      }, [current.open])

      // 自动保存：每 3 分钟兜一次（写盘本身即时，这里保证图文件与设置都落盘）
      useEffect(() => {
        if (!current.open) return undefined
        const timer = setInterval(() => {
          void saveNow(true)
        }, 180000)
        return () => clearInterval(timer)
      }, [current.open])

      useEffect(() => {
        if (!current.open) return undefined
        const onKey = (event) => {
          const tag = ((event.target && event.target.tagName) || '').toLowerCase()
          if (tag === 'input' || tag === 'textarea') return // 正在输入名字，别抢键
          if (event.key === 'Escape') {
            // 说明弹窗开着：先收它
            if (state.helpOpen) {
              state.helpOpen = false
              notify()
              return
            }
            // 在节点组里：先退回上一层；在最外层才关面板
            if (state.groupStack && state.groupStack.length > 0) closeGroup()
            else closePanel()
            return
          }
          if (event.shiftKey && (event.key === 'A' || event.key === 'a') && !event.ctrlKey && !event.altKey && !event.metaKey) {
            event.preventDefault()
            // 框选了几个节点：收进节点组；没框选：加一个节点
            if ((state.picked || []).length > 0) void wrapSelection()
            else void addNode()
            return
          }
          if (event.shiftKey && (event.key === 'D' || event.key === 'd') && !event.ctrlKey && !event.altKey) {
            event.preventDefault()
            void duplicateSelected()
            return
          }
          if ((event.ctrlKey || event.metaKey) && (event.key === 's' || event.key === 'S')) {
            event.preventDefault()
            void saveNow(false)
          }
          if ((event.ctrlKey || event.metaKey) && (event.key === 'z' || event.key === 'Z')) {
            event.preventDefault()
            void undoLast()
          }
        }
        window.addEventListener('keydown', onKey)
        return () => window.removeEventListener('keydown', onKey)
      }, [current.open])

      // 不自动扫项目：这个插件是给"AI 自己写的项目"用的，不是拿别人的目录做逆向。
      // 要扫哪个目录由人点「扫描项目」/「＋目录」明确指定。

      if (!current.open) return null

      const activeDrawio = (data && data.settings && data.settings.drawioFile) || ''
      const projectSelect = h('span',
        {
          title: activeDrawio || '还没指定关系文件',
          style: { flex: '0 0 auto', maxWidth: 240, fontSize: 11, padding: '3px 8px', borderRadius: 7, border: '1px solid var(--dsw-alias-border-l1)', color: 'var(--dsw-alias-label-secondary)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', },
        },
        activeDrawio ? activeDrawio.split(/[\\/]/).pop() : '未指定文件',
      )

      /** 表头的下拉菜单（文件 / 视图 / ⋯ 三处共用一套开关与面板样式）。 */
      const drop = (name, label, hint, width, items) => {
        const isOpen = !!state[name]
        return h('div', { key: 'drop:' + name, style: { position: 'relative', flex: '0 0 auto' } },
          h('button', {
            onClick: () => {
              state.fileMenu = false
              state.viewMenu = false
              state.moreMenu = false
              state[name] = !isOpen
              if (name === 'fileMenu') {
                state.filePrompt = ''
                state.fileDraft = (data && data.settings && data.settings.drawioFile) || (((data && data.active ? data.active.root : '') || '') + '\\项目关系图.drawio')
              }
              notify()
            },
            style: isOpen ? { ...ghostButton, borderColor: WINDOW_COLOR, color: WINDOW_COLOR } : ghostButton,
            title: hint,
          }, label),
          !isOpen ? null : h('div', {
            style: { position: 'absolute', top: 32, right: 0, width, zIndex: 6, padding: width > 300 ? 10 : 8, borderRadius: 10, border: '1px solid var(--dsw-alias-border-l1)', background: 'var(--dsw-alias-bg-overlay)', boxShadow: '0 12px 32px rgba(0,0,0,0.28)', display: 'flex', flexDirection: 'column', },
          }, ...(Array.isArray(items) ? items : [items])),
        )
      }

      const closeMenu = () => {
        state.ctxMenu = null
        notify()
      }

      /** 在节点组里右击任何一处，菜单底部都带「退出节点组」。 */
      const withGroupExit = (items) => (group ? items.concat([{ label: '退出节点组', onClick: () => closeGroup() }]) : items)

      /** 右键菜单：节点 / 连线 / 空白三套。 */
      const openNodeMenu = (node, x, y) => {
        const inGroup = !!group
        const items = []
        if (node.kind === 'group') {
          items.push({ label: '打开节点组', onClick: () => openGroupNode(node.id) })
          items.push({ label: '解散节点组', onClick: () => void ungroupNode(node.nodeId) })
        }
        if (node.kind === 'input' && inGroup) {
          items.push({ label: '每个关系一个端口', onClick: () => splitGroupPorts(group.id, 'gin') })
        }
        if (node.kind === 'output' && inGroup) {
          items.push({ label: '每个关系一个端口', onClick: () => splitGroupPorts(group.id, 'gout') })
        }
        if (node.kind !== 'input' && node.kind !== 'output') {
          items.push({ label: '重命名', onClick: () => startRenameNode(node) })
        }
        if (node.kind === 'group') {
          items.push({ label: '改节点组名字', onClick: () => startRenameGroup(node.nodeId) })
          if (!inGroup) items.push({ label: '删除节点组', danger: true, onClick: () => void deleteGroup(node.nodeId) })
        }
        if (node.kind !== 'input' && node.kind !== 'output') {
          items.push({
            label: '再放一个同名节点',
            onClick: () => {
              state.selected = node.id
              void duplicateSelected()
            },
          })
          items.push({ label: '删除节点', danger: true, onClick: () => void deleteNodeById(node.id) })
        }
        state.ctxMenu = { x, y, title: node.label, items: withGroupExit(items) }
        notify()
      }

      const openEdgeMenu = (edge, x, y) => {
        state.ctxMenu = {
          x,
          y,
          title: edge.verb || '（这条关系没有动作词）',
          items: withGroupExit([
            { label: '改动作词', onClick: () => startRenameEdge(edge) },
            { label: '删除这条关系', danger: true, onClick: () => void cutEdges([edge]) },
          ]),
        }
        notify()
      }

      const openBlankMenu = (x, y) => {
        state.ctxMenu = {
          x,
          y,
          title: group ? '节点组「' + group.name + '」' : '关系画布',
          items: withGroupExit([
            { label: '添加节点', onClick: () => void addNode() },
            { label: '添加节点组', onClick: () => void addGroupNode() },
            ...((state.picked || []).length > 0
              ? [{ label: '把框选的 ' + state.picked.length + ' 个节点收进节点组', onClick: () => void wrapSelection() }]
              : []),
          ]),
        }
        notify()
      }

      const openPortMenu = (node, side, index, x, y) => {
        const list = side === 'in' ? node.inputs || [] : node.outputs || []
        state.ctxMenu = {
          x,
          y,
          title: '端口：' + (list[index] || '（空）'),
          items: withGroupExit([
            { label: '重命名端口', onClick: () => startRenamePort(node, side, index) },
            { label: '删除端口', danger: true, onClick: () => removePort(node, side, index) },
          ]),
        }
        notify()
      }

      const ctxMenuEl = current.ctxMenu
        ? h('div',
            {
              style: { position: 'fixed', left: Math.min(current.ctxMenu.x, Math.max(0, window.innerWidth - 240)), top: Math.min(current.ctxMenu.y, Math.max(0, window.innerHeight - 60 - current.ctxMenu.items.length * 30)), zIndex: 30, width: 220, padding: 6, borderRadius: 10, border: '1px solid var(--dsw-alias-border-l1)', background: 'var(--dsw-alias-bg-overlay)', boxShadow: '0 12px 32px rgba(0,0,0,0.3)', display: 'flex', flexDirection: 'column' },
              onPointerDown: (event) => event.stopPropagation(),
              onContextMenu: (event) => event.preventDefault(),
            },
            h('div', { style: { fontSize: 10, color: 'var(--dsw-alias-label-secondary)', padding: '2px 6px', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' } }, current.ctxMenu.title),
            ...(current.ctxMenu.items || []).map((item) =>
              h('button', {
                key: item.label,
                onClick: () => {
                  state.ctxMenu = null
                  notify()
                  item.onClick()
                },
                style: item.danger ? { ...menuItemStyle, color: 'var(--dsw-alias-state-error-primary)' } : menuItemStyle,
              }, item.label),
            ),
            h('div', { style: { height: 1, background: 'var(--dsw-alias-border-l1)', margin: '4px 0' } }),
            h('button', { onClick: closeMenu, style: menuItemStyle }, '取消'),
          )
        : null

      const header = h('div',
        { style: { display: 'flex', alignItems: 'center', gap: 8, padding: '10px 14px', borderBottom: '1px solid var(--dsw-alias-border-l1)', flexWrap: 'nowrap' } },
        h('span', { style: { fontSize: 13, fontWeight: 600, color: 'var(--dsw-alias-label-primary)', whiteSpace: 'nowrap' } }, '关系'),
        projectSelect,
        group
          ? h('div', { style: { flex: 1, minWidth: 0, display: 'flex', alignItems: 'center', gap: 4, fontSize: 11, color: 'var(--dsw-alias-label-secondary)', whiteSpace: 'nowrap', overflow: 'hidden' } },
              h('button', { onClick: () => { state.groupStack = []; state.selected = null; notify() }, style: { ...ghostButton, height: 22, padding: '0 6px' } }, '关系'),
              ...groupPath.map((name, index) =>
                h('span', { key: 'crumb' + index, style: { display: 'flex', alignItems: 'center', gap: 4 } },
                  h('span', null, '/'),
                  h('button', {
                    onClick: () => {
                      state.groupStack = groupStack.slice(0, index + 1)
                      state.selected = null
                      notify()
                    },
                    style: { border: 'none', background: 'transparent', color: index === groupStack.length - 1 ? 'var(--dsw-alias-label-primary)' : 'var(--dsw-alias-label-secondary)', fontSize: 11, cursor: 'pointer', padding: '0 2px' },
                  }, name),
                ),
              ),
            )
          : h('span',
              {
                title: data && data.active ? data.active.root : '',
                style: { flex: 1, minWidth: 0, fontSize: 11, color: 'var(--dsw-alias-label-secondary)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', fontFamily: 'ui-monospace, SFMono-Regular, Consolas, monospace' },
              },
              (data && data.active ? data.active.graphFile : '尚未记录') +
                '   ·   ' + ((data && data.flowNodes) || []).length + ' 节点 / ' + ((data && data.flows) || []).length + ' 关系 / ' + Object.keys((data && data.groups) || {}).length + ' 组' +
                (scope ? '   ·   只看 ' + shownItems.length + ' 个' : ''),
            ),
        group
          ? [
              h('button', { key: 'g1', onClick: () => void addNode(), style: ghostButton }, '＋ 节点'),
              h('button', { key: 'g2', onClick: () => void addGroupNode(), style: ghostButton }, '＋ 节点组'),
              h('button', { key: 'g5', onClick: () => startRenameGroup(group.id), style: ghostButton }, '重命名组'),
              h('button', { key: 'g6', onClick: () => closeGroup(), style: ghostButton, title: '返回上一层' }, '返回'),
            ]
          : [
              // ⭐ 复制当前 .drawio 的文件地址：粘到对话里，AI 就能直接读这个文件
              //    （按钮不叫「复制路径」：面板里「路径」还指节点链路/面包屑，会看串）
              h('button', {
                key: 'copyPath',
                title: '复制当前 .drawio 的文件地址（粘给 AI 就能读）',
                onClick: () => {
                  const file = currentDrawioPath()
                  if (!file) {
                    state.notice = '这张图还没有落到文件：先在「文件 ▾」里另存为，再复制地址'
                    notify()
                    return
                  }
                  // 路径里有空格 ⇒ 用 @"..." 形式，DSH 里能直接当文件引用
                  const target = /\s/.test(file) ? '@"' + file + '"' : file
                  void copyText(target).then((ok) => {
                    state.notice = ok ? '已复制文件地址：' + target : '复制没成功，手动抄一下这个地址：' + target
                    notify()
                  })
                },
                style: { ...ghostButton, height: 24, padding: '0 8px', whiteSpace: 'nowrap' },
              }, '复制文件地址'),
              drop('fileMenu', '文件 ▾', '打开 / 恢复 / 另存为 / 保存副本', 540,
                current.filePrompt
                  ? h(FileBrowser, {
                      mode: current.filePrompt,
                      initialPath: current.fileDraft,
                      onPick: (picked) => void runFileAction(current.filePrompt, picked),
                      onCancel: () => { state.filePrompt = ''; notify() },
                    })
                  : [
                      ['新建…', 'new', '新建一个空的关系文件'],
                      ['打开…', 'open', '打开一个 .drawio 当这份图'],
                      ['恢复', 'reload', '重新读盘，丢掉缓存'],
                      ['另存为…', 'saveas', '导出成新 .drawio 并切过去'],
                      ['保存副本…', 'copy', '导出成新 .drawio，不切换'],
                      ['导出关系文档…', 'md', '把图上的关系写成一份 .md'],
                    ].map(([label, action, hint]) =>
                      h('button', {
                        key: label,
                        title: hint,
                        onClick: () => {
                          if (action === 'reload') {
                            void runFileAction('open', (data && data.settings && data.settings.drawioFile) || '')
                            return
                          }
                          state.filePrompt = action
                          if (action === 'new') state.fileDraft = defaultNewDrawioPath()
                          notify()
                        },
                        style: menuItemStyle,
                      }, label)),
              ),
              drop('viewMenu',
                '全部' +
                  (current.scopeMode === 'ego' ? ' · 此节点关系' : current.scopeMode === 'chain' ? ' · 此节点链路' : '') + ' ▾',
                '全部 / 此节点关系 / 此节点链路', 210,
                [
                  ['全部', 'all', '整张图'],
                  ['此节点关系', 'ego', '选中节点 + 直接上游/下游'],
                  ['此节点链路', 'chain', '上游整条链路 + 一层下游'],
                ].map(([label, mode, hint]) => {
                  const on = mode === 'all' ? current.scopeMode === 'none' : current.scopeMode === mode
                  return h('button', {
                    key: mode,
                    title: hint,
                    onClick: () => {
                      if (mode !== 'all' && !current.selected) {
                        state.notice = '先选中一个节点，再用「' + label + '」'
                        state.viewMenu = false
                        notify()
                        return
                      }
                      state.scopeMode = mode === 'all' ? 'none' : mode
                      state.scopeDrags = {}
                      state.viewMenu = false
                      notify()
                    },
                    style: { ...menuItemStyle, color: on ? WINDOW_COLOR : undefined },
                  }, (on ? '✓ ' : '   ') + label)
                }),
              ),
              drop('moreMenu', '⋯', '更多操作', 280, [
                h('div', { key: 'l1', style: { fontSize: 10, color: 'var(--dsw-alias-label-secondary)' } }, '添加节点'),
                h('input', {
                  key: 'i1',
                  value: current.newNode || '',
                  placeholder: '节点名',
                  spellCheck: false,
                  onChange: (event) => { state.newNode = event.target.value; notify() },
                  onKeyDown: (event) => { if (event.key === 'Enter') void addNode() },
                  style: linkInputStyle,
                }),
                h('button', { key: 'b1', onClick: () => void addNode(), style: { ...menuItemStyle, textAlign: 'center', background: 'var(--dsw-alias-bg-layer-2)' } }, '＋ 添加节点'),
                h('button', { key: 'b2', onClick: () => void addGroupNode(), style: { ...menuItemStyle, textAlign: 'center' } }, '＋ 添加节点组'),
                h('button', { key: 'b6', onClick: () => void applyPreset(), style: { ...menuItemStyle, textAlign: 'center' } }, '添加工作流预设'),
                h('button', { key: 'b3', onClick: () => { state.moreMenu = false; void duplicateSelected() }, style: { ...menuItemStyle, textAlign: 'center' } }, '再放一个同名节点'),
                h('div', { key: 'sep', style: { height: 1, background: 'var(--dsw-alias-border-l1)', margin: '4px 0' } }),
                h('button', {
                  key: 'b5',
                  onClick: () => {
                    state.moreMenu = false
                    state.draft = (data && data.settings && data.settings.graphFile) || ''
                    state.undoDraft = (data && data.settings && data.settings.undoDepth) || 30
                    state.showSettings = true
                    notify()
                  },
                  style: { ...menuItemStyle, textAlign: 'center' },
                }, '设置…'),
                h('button', { key: 'b4', onClick: () => { state.moreMenu = false; void resetGraph() }, style: { ...menuItemStyle, color: 'var(--dsw-alias-state-error-primary)' } }, '清空这张图'),
              ]),
            ],
        h('button',
          {
            onClick: () => { state.helpOpen = !state.helpOpen; state.fileMenu = false; state.viewMenu = false; state.moreMenu = false; notify() },
            style: state.helpOpen ? { ...ghostButton, flex: '0 0 auto', borderColor: WINDOW_COLOR, color: WINDOW_COLOR } : { ...ghostButton, flex: '0 0 auto' },
            title: '操作说明',
          },
          '说明',
        ),
        h('button', { onClick: () => void load(activeRoot()), style: { ...ghostButton, flex: '0 0 auto' } }, current.loading ? '读取中…' : '刷新'),
        h('button', { onClick: closePanel, style: { ...ghostButton, flex: '0 0 auto' }, title: 'Esc' }, '关闭'),
      )

      const renameBar = current.renameTarget
        ? h('div',
            { style: { display: 'flex', alignItems: 'center', gap: 8, padding: '6px 14px', borderBottom: '1px solid var(--dsw-alias-border-l1)', background: 'var(--dsw-alias-bg-layer-1)', fontSize: 11 } },
            h('span', { style: { color: 'var(--dsw-alias-label-secondary)' } },
              current.renameTarget.kind === 'group'
                ? '节点组改名为：'
                : current.renameTarget.kind === 'port'
                  ? '端口「' + (current.renameTarget.name || '') + '」改名为：'
                  : current.renameTarget.kind === 'node'
                    ? '节点「' + current.renameTarget.name + '」改名为：'
                    : '这条关系的动作词：'),
            h('input', {
              value: current.renameDraft || '',
              autoFocus: true,
              spellCheck: false,
              onChange: (event) => {
                state.renameDraft = event.target.value
                notify()
              },
              onKeyDown: (event) => {
                if (event.key === 'Enter') void submitRename()
                if (event.key === 'Escape') {
                  state.renameTarget = null
                  notify()
                }
              },
              style: { flex: 1, height: 24, padding: '0 8px', borderRadius: 6, border: '1px solid var(--dsw-alias-border-l2)', background: 'var(--dsw-alias-bg-base)', color: 'var(--dsw-alias-label-primary)', fontSize: 11 },
            }),
            h('button', { onClick: () => void submitRename(), style: primaryButton }, '确定'),
            h('button', { onClick: () => { state.renameTarget = null; notify() }, style: ghostButton }, '取消'),
          )
        : null

      /** 操作说明：一个纯文本窗，只有「快捷键 / 操作」两列。 */
      const helpDialog = current.helpOpen
        ? h('div',
            {
              style: { position: 'absolute', inset: 0, zIndex: 50, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'rgba(0,0,0,0.38)' },
              onPointerDown: (event) => {
                if (event.target === event.currentTarget) {
                  state.helpOpen = false
                  notify()
                }
              },
            },
            h('div',
              { style: { width: 470, maxHeight: '82%', overflow: 'auto', padding: '10px 14px 12px', borderRadius: 12, border: '1px solid var(--dsw-alias-border-l1)', background: 'var(--dsw-alias-bg-overlay)', boxShadow: '0 18px 48px rgba(0,0,0,0.32)' } },
              ...SHORTCUTS.map(([key, action]) =>
                h('div', { key, style: { display: 'flex', gap: 12, padding: '3px 0', fontSize: 11, lineHeight: '16px' } },
                  h('span', { style: { flex: '0 0 178px', fontFamily: 'ui-monospace, SFMono-Regular, Consolas, monospace', color: 'var(--dsw-alias-label-primary)' } }, key),
                  h('span', { style: { color: 'var(--dsw-alias-label-secondary)' } }, action),
                ),
              ),
            ),
          )
        : null

      const flowEmpty = flowModel && flowModel.items.length === 0

      // 往期历史对照：只把开着「眼睛」、内容已经取到的版本交给画布（进节点组时不叠，坐标不是一套）。
      // 注意：这里不能用 useMemo —— 它在上面的 `if (!current.open) return null` 之后，
      // 面板开/关会让 hook 数量变化，React 直接报 #310（Rendered more hooks than during the previous render）。
      const ghostVersions = (() => {
        if (group || !data) return []
        const eyes = current.historyEyes || {}
        const models = current.historyModels || {}
        return Object.keys(eyes)
          .filter((n) => eyes[n] && models[n])
          .map((n) => ({ n: Number(n), model: models[n] }))
          .sort((a, b) => a.n - b.n)
      })()

      return h('div',
        {
          style: { position: 'fixed', inset: 0, zIndex: 40, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'rgba(0,0,0,0.38)', pointerEvents: 'auto' },
          onPointerDown: (event) => {
            if (event.target === event.currentTarget) closePanel()
          },
        },
        h('div',
          {
            style: { display: 'flex', flexDirection: 'column', width: 'min(1180px, 94vw)', height: 'min(820px, 88vh)', borderRadius: 14, border: '1px solid var(--dsw-alias-border-l1)', background: 'var(--dsw-alias-bg-overlay)', boxShadow: '0 24px 64px rgba(0,0,0,0.35)', overflow: 'hidden', position: 'relative' },
            onPointerDown: (event) => {
              event.stopPropagation()
              // 点面板别处 = 收起右键菜单（菜单根节点自己 stopPropagation）
              if (state.ctxMenu) {
                state.ctxMenu = null
                notify()
              }
            },
            onContextMenu: (event) => {
              // 面板空白处右键：收起菜单
              if (!current.ctxMenu) return
              event.preventDefault()
              state.ctxMenu = null
              notify()
            },
          },
          header,
          current.hostLegacy
            ? h('div',
                {
                  style: { padding: '7px 14px', fontSize: 11, lineHeight: '17px', color: 'var(--dsw-alias-state-error-primary)', background: 'rgba(239,68,68,0.10)', borderBottom: '1px solid var(--dsw-alias-state-error-primary)' },
                },
                '宿主还是旧版本，先完全退出 DSH 再打开。',
              )
            : null,
          ctxMenuEl,
          renameBar,
          helpDialog,
          current.error
            ? h('div', { style: { padding: '6px 14px', fontSize: 11, color: 'var(--dsw-alias-state-error-primary)', borderBottom: '1px solid var(--dsw-alias-border-l1)' } }, current.error)
            : null,
          current.notice
            ? h('div', { style: { padding: '5px 14px', fontSize: 11, color: 'var(--dsw-alias-label-secondary)', borderBottom: '1px solid var(--dsw-alias-border-l1)', background: 'var(--dsw-alias-bg-layer-1)' } }, current.notice)
            : null,
          current.showSettings
            ? h(SettingsBar, {
                data,
                draft: current.draft ?? '',
                undoDraft: current.undoDraft ?? 30,
                onChange: (value) => {
                  state.draft = value
                  notify()
                },
                onUndoChange: (value) => {
                  state.undoDraft = value
                  notify()
                },
                onSave: () => void savePath(),
                onCancel: () => {
                  state.showSettings = false
                  notify()
                },
              })
            : null,
          current.addProject
            ? h('div',
                { style: { padding: '10px 16px', borderBottom: '1px solid var(--dsw-alias-border-l1)', background: 'var(--dsw-alias-bg-layer-1)', display: 'flex', gap: 8, alignItems: 'center' } },
                h('span', { style: { fontSize: 11, color: 'var(--dsw-alias-label-secondary)' } }, '项目目录'),
                h('input', {
                  value: current.draftRoot ?? '',
                  autoFocus: true,
                  spellCheck: false,
                  placeholder: '例如 D:\\b站鱼包间',
                  onChange: (event) => {
                    state.draftRoot = event.target.value
                    notify()
                  },
                  onKeyDown: (event) => {
                    if (event.key === 'Enter') void scanProject(state.draftRoot)
                  },
                  style: { flex: 1, minWidth: 240, height: 28, padding: '0 8px', borderRadius: 7, border: '1px solid var(--dsw-alias-border-l2)', background: 'var(--dsw-alias-bg-base)', color: 'var(--dsw-alias-label-primary)', fontSize: 11, fontFamily: 'ui-monospace, SFMono-Regular, Consolas, monospace' },
                }),
                h('button', { onClick: () => void scanProject(current.draftRoot), style: primaryButton }, '扫描'),
                h('button', { onClick: () => { state.addProject = false; notify() }, style: ghostButton }, '取消'),
              )
            : null,
          h('div',
            { style: { flex: 1, minHeight: 0, display: 'flex', position: 'relative' } },
            flowModel
              ? (flowEmpty
                  ? h('div',
                      { style: { flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', flexDirection: 'column', gap: 8, color: 'var(--dsw-alias-label-secondary)', fontSize: 12 } },
                      h('div', { style: { fontSize: 13, color: 'var(--dsw-alias-label-primary)' } },
                        current.hostLegacy ? '宿主是旧版本，先重启 DSH' : group ? '这个节点组还是空的' : '这张关系图还是空的'),
                      h('button',
                        {
                          onClick: () => void addNode(),
                          style: { marginTop: 4, height: 30, padding: '0 14px', borderRadius: 8, border: '1px solid var(--dsw-alias-brand-primary)', background: 'var(--dsw-alias-brand-primary)', color: '#fff', fontSize: 12, cursor: 'pointer' },
                        },
                        '＋ 添加节点',
                      ),
                    )
                  : h(FlowCanvas, {
                      nodes: shownItems,
                      edges: shownEdges,
                      ghosts: ghostVersions,
                      positions: layeredPositions || flowModel.positions,
                      selected: current.selected,
                      picked: current.picked || [],
                      // 只看局部（此节点关系/链路）时，点空白、拖画布都不清选中，否则模式立刻被取消
                      keepSelection: current.scopeMode !== 'none',
                      viewKey: (data && data.active ? data.active.graphFile : '') + '|' + groupStack.join('>'),
                      onSelect: (id) => {
                        state.selected = id
                        state.picked = []
                        state.editing = false
                        notify()
                      },
                      onPick: (ids) => {
                        state.picked = Array.isArray(ids) ? ids : []
                        state.notice = state.picked.length > 0 ? '已框选 ' + state.picked.length + ' 个节点：Shift+A 收进节点组' : ''
                        notify()
                      },
                      onMove: (entries) => {
                        if (group) {
                          editGroup(group.id, (draft) => {
                            for (const [canvasId, pos] of Object.entries(entries)) {
                              const node = (draft.nodes || []).find((item) => 'f:' + item.id === canvasId)
                              if (node) {
                                node.x = Math.round(pos.x)
                                node.y = Math.round(pos.y)
                              }
                            }
                          })
                          return
                        }
                        // 筛选模式（此节点关系/链路）下拖动只挪显示，不改进文件位置，
                        // 否则会把自动排好的链路坐标写进「全部」的布局里。
                        if (current.scopeMode !== 'none') {
                          state.scopeDrags = { ...(state.scopeDrags || {}), ...entries }
                          notify()
                          return
                        }
                        void moveNodes(entries)
                      },
                      onConnect: (fromId, fromPort, toId, toPort) => {
                        if (group) {
                          const stamp = Date.now().toString(36)
                          editGroup(group.id, (draft) => {
                            draft.flows.push({
                              id: 'ge' + stamp,
                              fromId: String(fromId).replace(/^f:/, ''),
                              toId: String(toId).replace(/^f:/, ''),
                              fromPort: fromPort || 0,
                              toPort: toPort || 0,
                              verb: '',
                            })
                            // 组输入/组输出一个端口只走一条关系：被占了就再加一个端口
                            const portNames = groupPortNames(group.id)
                            splitPortsInDraft(draft, 'gin', portNames.into)
                            splitPortsInDraft(draft, 'gout', portNames.outOf)
                          })
                          state.notice = '已连上一条关系'
                          notify()
                        } else {
                          void addRelation(fromId, fromPort, toId, toPort)
                        }
                      },
                      onRenameNode: (node) => startRenameNode(node),
                      onRenameEdge: (edge) => startRenameEdge(edge),
                      onCutEdge: (edge) => void cutEdges([edge]),
                      onCut: (list) => void cutEdges(list),
                      onContextNode: (node, x, y) => openNodeMenu(node, x, y),
                      onContextEdge: (edge, x, y) => openEdgeMenu(edge, x, y),
                      onContextBlank: (x, y) => openBlankMenu(x, y),
                      onPortContext: (node, side, index, x, y) => openPortMenu(node, side, index, x, y),
                      onViewport: (center) => { state.viewport = center },
                    }))
              : null,
            h('div',
              { style: { width: 258, flex: '0 0 258px', borderLeft: '1px solid var(--dsw-alias-border-l1)', background: 'var(--dsw-alias-bg-layer-1)', display: 'flex', flexDirection: 'column', minHeight: 0 } },
              group
                ? null
                : h(HistoryPanel, {
                    versions: (data && data.history) || [],
                    eyes: current.historyEyes || {},
                    pick: current.historyPick || 0,
                    onPick: (n) => void pickHistory(n),
                    onToggle: (n) => void toggleHistory(n),
                    onRestore: (n) => void restoreHistory(n),
                    onSnapshot: () => void saveSnapshot(),
                    onDelete: (n) => void deleteHistory(n),
                  }),
              h('div', { style: { flex: '1 1 auto', minHeight: 0, display: 'flex', flexDirection: 'column' } },
                h(Details, {
                  item: selectedItem,
                  items: flowModel ? flowModel.items : [],
                  edges: flowModel ? flowModel.edges : [],
                  note: !selectedItem
                    ? ''
                    : selectedGroupDef
                      ? selectedGroupDef.note || ''
                      : group
                        ? (group.notes || {})[selectedItem.label] || ''
                        : (current.nodeNotes && Object.prototype.hasOwnProperty.call(current.nodeNotes, selectedItem.label)
                          ? current.nodeNotes[selectedItem.label]
                          : ((data && data.nodeNotes) || {})[selectedItem.label]) || '',
                  onNoteChange: (label, text) => {
                    if (selectedGroupDef) {
                      editGroup(selectedGroupDef.id, (draft) => {
                        draft.note = String(text || '')
                      })
                      return
                    }
                    if (group) {
                      editGroup(group.id, (draft) => {
                        draft.notes = draft.notes || {}
                        if (String(text || '').trim()) draft.notes[label] = String(text)
                        else delete draft.notes[label]
                      })
                      return
                    }
                    void saveNote(label, text)
                  },
                  onOpenGroup: (canvasId) => openGroupNode(canvasId),
                  mode: current.scopeMode === 'none' ? 'all' : current.scopeMode,
                  onMode: (value) => {
                    state.scopeMode = value === 'all' ? 'none' : value
                    state.scopeDrags = {}
                    notify()
                  },
                  onSelect: (id) => {
                    state.selected = id
                    state.editing = false
                    notify()
                  },
                }),
              ),
            ),
          ),
        ),
      )

    }

    /* ------------------------------------------------- 侧栏按钮 */

    /** 面板万一渲染出错，至少把错误显示出来，而不是"点了没反应"。 */
    class PanelBoundary extends React.Component {
      constructor(props) {
        super(props)
        this.state = { error: '' }
      }
      static getDerivedStateFromError(err) {
        return { error: String((err && err.message) || err) }
      }
      componentDidCatch(err) {
        try {
          console.error('[filegraph] panel crashed', err)
        } catch {}
      }
      render() {
        if (this.state.error) {
          return h('div',
            {
              style: { position: 'fixed', left: 24, bottom: 24, zIndex: 60, maxWidth: 620, padding: '10px 14px', borderRadius: 10, border: '1px solid var(--dsw-alias-state-error-primary)', background: 'var(--dsw-alias-bg-overlay)', color: 'var(--dsw-alias-state-error-primary)', fontSize: 11, whiteSpace: 'pre-wrap', pointerEvents: 'auto', fontFamily: 'ui-monospace, Consolas, monospace', },
            },
            '关系面板报错：' + this.state.error,
          )
        }
        return this.props.children
      }
    }

    function GraphGlyph() {
      return h('svg',
        { viewBox: '0 0 20 20', width: 16, height: 16, 'aria-hidden': true, style: { display: 'block' } },
        h('path', { d: 'M5.5 5.5 L5.5 14.5 M5.5 5.5 L14 3.5 M5.5 14.5 L13.5 15.5 M13.5 15.5 L14 3.5', fill: 'none', stroke: 'currentColor', strokeWidth: 1.3, strokeLinecap: 'round' }),
        h('circle', { cx: 5.5, cy: 5.5, r: 2.1, fill: 'currentColor' }),
        h('circle', { cx: 14, cy: 3.5, r: 1.8, fill: 'currentColor', opacity: 0.75 }),
        h('circle', { cx: 13.5, cy: 15.5, r: 1.8, fill: 'currentColor', opacity: 0.75 }),
        h('circle', { cx: 5.5, cy: 14.5, r: 2.1, fill: 'currentColor' }),
      )
    }

    function FooterAction(props) {
      const current = useStore()
      const wide = !!(props && props.wide)
      return h('button',
        {
          onClick: togglePanel,
          title: '关系',
          'aria-pressed': current.open,
          style: { display: 'flex', alignItems: 'center', justifyContent: wide ? 'flex-start': 'center', gap: 8, width: wide ? '100%': 30, height: 30, padding: wide ? '0 8px': 0, borderRadius: 8, border: '1px solid ' + (current.open ? 'var(--dsw-alias-brand-primary)': 'transparent'), background: current.open ? 'var(--dsw-alias-bg-layer-2)': 'transparent', color: current.open ? 'var(--dsw-alias-brand-primary)': 'var(--dsw-alias-label-secondary)', cursor: 'pointer', fontSize: 12, },
        },
        h(GraphGlyph),
        wide ? h('span', { style: { whiteSpace: 'nowrap' } }, '关系') : null,
      )
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        ctx.effect(() =>
          ctx.slots.inject('sidebar.footer.action', () =>
            ctx.slots.register(
              { name: 'sidebar.footer.action', id: 'dsh-filegraph:button', order: 60, label: '关系' },
              FooterAction,
            ),
          ),
        )
        ctx.effect(() =>
          ctx.slots.inject('shell.overlay', () =>
            ctx.slots.register(
              { name: 'shell.overlay', id: 'dsh-filegraph:panel', order: 30 },
              (props) => h(PanelBoundary, null, h(GraphPanel, props)),
            ),
          ),
        )
      },
    }
  },
})
