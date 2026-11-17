# 关系（dsh-filegraph）

把「对象之间怎么互相影响」画成一张图。节点可以是文件、模块、窗口、概念，随便什么；
关系写在线上方，格式是 `动作 + 对象`。节点组（蓝色节点）可以打开，里面是另一张画布。

面板名、侧栏按钮、locale 都叫 **关系**；包 id 仍是 `@local/dsh-filegraph`（历史 id，profile 里是 link，不改它）。

## 两种视图

| 视图 | 画什么 | 数据来源 |
| --- | --- | --- |
| **关系**（默认） | 人/模型标的节点、关系、节点组 | 当前 `.drawio`（唯一真源） |
| **全部** | AI 读/写过的文件、窗口、其他来源 | `.graph.json` 里自动记的记录 |

AI 记录层只读：`write`/`edit` 记「窗口写出文件」，`read`/`read_image` 记「窗口读入文件」，
`mcp__*` / `web_*` / `pwsh` / `bash` / `terminal_*` / `see_now` / `browser_*` 记「窗口从某来源取数」。

## 节点、名字、id

- 画布上**每个节点都有自己的 id**（`.drawio` 里的 cell id，或 `n1`/`n2`…），连线、位置、拖动矢量都按 id 存。
- **节点信息按名字保存**：备注 `nodeNotes[名字]` 是全图共享的。所以：
  - 两个节点取同一个名字 ⇒ 它们表述的是同一份数据（备注共用）；
  - 但它们是两个节点，各有各的 id、位置和连线（「再放一个同名节点」= Shift+D）。
- 改名只改**这一个节点实例**的名字，不影响别的同名节点（数据跟着名字走）。
- **节点组的数据和节点的数据不互通**：组内节点备注存在组自己的 `notes` 里，跟外面同名节点无关。
  两个同名节点组也是**两个不同的组**（内部数据按组节点 id 存），只是标签一样。

## 节点组

- 画布上的节点组是**蓝色节点**，左右各有多个端口（输入在左、输出在右），端口名就是组的输入/输出名。
- **创建方式**：`Shift + 拖空白` 框选若干节点 → **`Shift+A`** 收进一个新节点组。
  跨边界的线会自动变成组的端口：外面的线连进来 → 一个输入端口；线连出去 → 一个输出端口；两端都在选中的线留在组内部。
  （没框选时 `Shift+A` 就是加一个节点。框选里可以包含普通节点，也可以包含节点组。）
- **右键节点组 → 「打开节点组」** 进入组内编辑；面板顶部出现面包屑（`关系 / 组名`），点「返回」或按 Esc 回上一层。
- **组内右击任意处**（空白 / 节点 / 线 / 端口）的右键菜单底部都有「**退出节点组**」，回上一层。
- 组内固定有两个保留节点：**组输入**（绿色标题，右侧是组的输入端口）和**组输出**（左侧是组的输出端口）。
  往组输入的输出端口拉线 = 取外部输入；拉到组输出的输入端口 = 给出外部输出。
- 组内可以继续放节点、放**子节点组**（右键 →「添加节点组」），所以组可以套组。
- **解散节点组**：右键节点组 →「解散节点组」，组里的节点放回上一层，跨边界的线按端口接回外部，组本身删掉（嵌套组也适用）。
- 端口操作：右键端口名 → 重命名 / 删除（删除会连带删掉连在它上面的线）；右键节点组 → 加输入/输出端口。
- 组内普通节点默认 1 进 1 出，右键可以继续加端口。

## 操作

| 操作 | 效果 |
| --- | --- |
| 左键点节点 | 选中，右侧看详情（详情栏宽度固定，开合不改变画布缩放） |
| 左键点空白 | 取消选中，收起菜单 |
| 左键拖节点 | 摆位置（拖框选中的节点＝整组一起动；**拖动不会打开详情**） |
| 左键拖空白 | 平移画布 |
| 左键拖输出端口 → 输入端口（或节点框） | 连一条关系 |
| Shift + 左键点节点 | 多选 / 取消多选 |
| Shift + 左键点线（或线旁 8px） | 改动作词 |
| Shift + 左键拖空白 | 框选节点（框选后 Shift+A 收进节点组） |
| Shift + A | 加一个节点；有框选时 = 把框选的节点收进节点组 |
| Shift + D | 再放一个同名节点 |
| Ctrl + 左键点线 | 剪掉这一条关系 |
| Ctrl + 左键拖过线 | 剪刀：划过的线松手一起剪掉 |
| Ctrl + S / Ctrl + Z | 保存 / 回退一步（回退的是整张图） |
| Esc | 关弹窗 / 退出节点组 / 关面板 |
| 滚轮 / 右下角按钮 | 缩放（不设上限）/ 适应 |
| 右键节点 | 打开节点组 / 解散节点组（组）/ 重命名 / 改组名 / 再放一个同名节点 / 删除 |
| 右键连线 | 改动作词 / 删除这条关系 |
| 右键端口名 | 重命名端口 / 删除端口 |
| 右键 组输入 / 组输出 | 每个关系一个端口（同一端口挂了两条关系就再加一个；连线时也会自动加） |
| 右键空白 | 添加节点 / 添加节点组；新对象落在**屏幕中心**，压住已有节点时自动往外找空位 |
| 左上角路径 | 回到上一层节点组 |
| 文件 ▾ | 新建 / 打开 / 恢复 / 另存为 / 保存副本 / 导出关系文档 |
| 关系 ▾ | 关系 / 全部 / 此节点关系 / 此节点链路 |
| ⋯ | 加节点 / 加节点组 / 再放同名 / 设置 / 清空这张图 |
| 组端口名字 | 默认名（输入 / 输入 2）自动补成外面那条线的节点名：入口=上一节点名，出口=默认名；同一根输入加出来的端口与原端口同名；端口始终 n+1（n 条已接 + 1 个空口） |
| 拖动后的位置 | 只存一份绝对坐标：拖完先在内存里，Ctrl+S、退出、每 3 分钟自动写进 `.drawio`；Ctrl+Z 能退回上一步 |
| 节点说明（备注） | 跟节点一起写进 `.drawio`（drawio 的「编辑数据」= `UserObject` 的 `note` 属性），换文件或被 drawio 打开都不会丢 |
| 表头「说明」 | 弹出快捷键与对应操作一览（只有这两列） |

## 文件与数据

- **`.drawio`** 是这份图的文件：节点（id + 名字 + 坐标）、连线（id + 两端 + 动作）、节点组画成蓝色节点。
  文件菜单里有 新建 / 打开 / 恢复（重读盘）/ 另存为（导出并切过去）/ 保存副本（导出不切换）/ 导出关系文档（.md）。
- **`.graph.json`** 是插件自己的库：节点组内部（组内节点/连线/端口/备注）、备注、手拖矢量、AI 记录。
  默认位置 `<项目>/.filegraph/graph.json`，可在设置里指到别处；写盘是原子写 + `.bak1`。
- 组内部**不写进 `.drawio`**：`.drawio` 只存顶层画布，组内部只存 `.graph.json`（按组节点 id 关联）。
  换一个 `.drawio` = 换顶层画布；组按 id 保留，找不到对应节点就自动丢弃。
- 设置：`%USERPROFILE%\.dsh\storages\filegraph\settings.json`（`graphFile` / `drawioFile`）。

## 路由

宿主 `index.js` 注册，全部为 JSON；POST 需带 `x-filegraph: 1`。

| 路由 | 作用 |
| --- | --- |
| `GET /filegraph/data` | 全量数据（含 `flowNodes` / `flows` / `flowPositions` / `drags` / `nodeNotes` / `groups`） |
| `GET /filegraph/list` | 文件浏览器用的目录列表 |
| `/filegraph/node` | 新建节点 `{name?,x?,y?,kind?}` |
| `/filegraph/group` | 节点组：`create`（可带 `parent` 嵌套）/ `save`（整份内部数据）/ `rename` / `delete` |
| `/filegraph/edge` | 加关系 `{fromId,toId,fromPort?,toPort?,verb?}` |
| `/filegraph/remove-edge` | 删关系 `{edges:[{id}]}` |
| `/filegraph/rename-edge` | 改动作词 `{id,verb}` |
| `/filegraph/rename-node` | 改节点名 `{id,name}` |
| `/filegraph/remove-node` | 删节点（连带连线）`{id}` |
| `/filegraph/note` | 写备注 `{name,text}`（按名字） |
| `/filegraph/duplicate` | 再放一个同名节点 `{id}` |
| `/filegraph/position` / `/filegraph/drag` | 画布坐标 / 手拖矢量 |
| `/filegraph/new` `/filegraph/open` `/filegraph/export` | 文件菜单 |
| `/filegraph/import` / `/filegraph/export-md` | 导入 `.drawio` / 导出关系文档 |
| `/filegraph/scan` `/filegraph/prune` `/filegraph/reset` | AI 记录层：扫描 / 清理孤点 / 清空 |
| `/filegraph/window` `/filegraph/settings` `/filegraph/flow` `/filegraph/undo` | 记录层杂项 |

## 文件地图

| 文件 | 负责 |
| --- | --- |
| `index.js` | 宿主：AI 记录、`.graph.json` 读写、`.drawio` 解析/生成、全部路由 |
| `client.js` | 面板：`GraphCanvas`（全部视图）、`FlowCanvas`（关系画布，含节点组）、`Details`、文件菜单 |
| `cordis.patch.yml` | bundle 入口（一条 Host 行） |
| `locale/*.json` | 面板标题与描述 |
| `icon.svg` | 侧栏图标 |
| `tests/smoke-host.mjs` | 全部路由实跑 + 断言（id/同名/节点组/长名/无框） |
| `tests/smoke-client.mjs` | 用真 React SSR 渲面板（关系视图/组内/详情/全部/菜单/右键菜单） |
| `tests/smoke-live.mjs` | 拉正在跑的宿主的真实 `/filegraph/data` 渲一遍面板，确认线上数据不炸 |

## 测试

```powershell
node --check index.js
node --check client.js
node tests/smoke-host.mjs
node tests/smoke-client.mjs "<react 所在 node_modules 目录>"
node tests/smoke-live.mjs "<react 目录>" http://127.0.0.1:<当前 GUI 端口>
```

## 迁移（v2 → v3）

2026-11-17 的这次改动是破坏性的：

- **框（frame）全部删除**：框的创建、拖动、归属、改名、右键菜单、导出文档里的框一节都没了；
  旧图文件里的 `frames` / `nodeFrame` 在加载时被丢弃。
- **分身（ghost）并入「同名节点」**：以前分身是特殊对象，现在就是又一个同名节点（名字相同、id 独立）；
  `ghosts` / `ghostEdges` 被丢弃，旧的分身连线不会自动迁移（节点本身还在）。
- 旧画布（节点 id 是名字的 v2）会在加载时清空画布层，然后从 `.drawio` 重新导入一次；
  `.drawio` 里的节点 id 会被保留，同名节点从此可以并存。
- 备注、AI 记录层（文件/窗口/来源）不受影响。

## 生效

- 前端（`client.js`）：刷新浏览器页面（Ctrl+R）即可。
- 宿主（`index.js`）：不热更新，需要重启 DSH 宿主，或把 `@local/dsh-filegraph` 停用再启用一次。
