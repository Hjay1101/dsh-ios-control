# 极简移动端 PWA 产品方案（"DSH 遥控器"）

> 状态：设计稿定稿，2026-08-23。前置阅读：`../README.md`（网关/配对/通知/保活现有能力）、
> [`PAIRING-DESIGN.md`](PAIRING-DESIGN.md)、[`LINK-KEEPALIVE-DESIGN.md`](LINK-KEEPALIVE-DESIGN.md)。
>
> 原则：**零新协议、零新依赖、复用现有认证/反代/保活/通知**；为"应急短时处理"场景
> 重做交互，不做桌面 UI 的移动化搬运。移动端是"遥控器"不是"完整客户端"。
>
> 调研基线：2026-08-23 安装版 DSH（`@deepseek-ai/dsh-host-apiproxy` 与
> `dsh-client-connection` 的 lib 输出；RPC 契约以宿主侧 `dsh-host-apiproxy/lib/types/api/*.d.ts`
> 为准，与官方客户端实现交叉验证）。

## 0. 产品定位

桌面 DSH 是为宽屏桌面设计的（侧边栏、多面板、完整 markdown、插件管理）。手机端的
合理使用场景是**应急 + 短时**：看任务在不在跑、卡没卡住、等没等你；放行/停止/跟进。
本产品的第一句话：

> 这不是 DSH 的移动版，这是 DSH 的遥控器——扫码即用，5 秒处理一个任务。

与"把桌面 UI 反代到手机"（上游 dsh-remote-link 本体及同类项目）的差异不在功能，
在**场景**：打开即用（3 秒内看到"哪个任务需要你"）、推送即动作（notify 深链直达
审批）、单手可达（全部动作在拇指热区，无抽屉无汉堡菜单）、弱网友好（轻量列表 +
增量流，不挂全量事件）。

## 1. 需求决策记录（已确认，不再回炉）

| # | 决策点 | 结论 |
|---|---|---|
| 1 | 任务口径 | **按工作区分组**，展示工作区下的会话清单；无归属会话进"其他"桶 |
| 2 | 能否出门"下令" | 可以——发送消息是 v0 能力（需求优先级：审批 > 查看 > 发消息，但三者同版交付） |
| 3 | 技术形态 | **网关内置 PWA**（新增 `/m` 路由，单文件静态页，同源调 API） |
| 4 | 开源形态 | 并入本仓库作为 `mobile/` 目录，与现有网关一起发布（v1.8+） |
| 5 | 子 agent 层级 | **平铺 + 小标记**（不做缩进树；`parentSessionId` 仅在行上显示 ↳ 标记与来源） |
| 6 | plan-review | **M0 即显示标记**（`pendingInteraction` 三态全部进列表状态点；plan-review 的回答协议与 approval 同构，回答能力放 M1） |

明确不做：设置、插件管理、成本面板、模型选择、附件图片、主题、多语言、
完整 markdown 渲染、消息编辑、桌面 UI 的任何入口。

## 2. 关键事实：传输契约（2026-08-25 隔离实例实测定案）

> 实测方法：`dsh web --patch` 起隔离实例（独立网关端口 + Basic 认证），curl/node
> 原始 WS 客户端逐项验证；不碰现网 3081。结论已回填本节与 §5/§10。

- **RPC**：普通 `POST /api/<namespace.method>`（**点号形式，如 `/api/session.list`**
  ——斜杠形式 `/api/session/list` 实测 404 "not found"）。body 为
  `{type:'client-request', rpcId, method, payload}` 信封；响应
  `{type:'server-response', rpcId, result: {ok, value|error}}`。
  ⚠️ 宿主 HTTP 层就绪晚于端口监听数秒：过早请求会得到 "not found"（就绪竞态，
  非形状错误）。
- **事件下行：只有 WebSocket 一条路**。GET `/api/events.host|mux` 无 upgrade 头时
  实测回 `426 upgrade required`（SSE 变体在当前宿主不可达——此前"Node 端 SSE"
  的判断已过时）。浏览器端 WS 自动携带配对 cookie，经网关 `proxyUpgrade` 反代；
  网关注入的 keepalive ping 对手机腿同样生效（SSE 方案没有的福利）。
- **WS 帧信封（实测首帧）**：`{type:'server-request', rpcId, method, payload:{type:'session/subscribed', sessionId, lastSeq}}`
  ——外层信封 + 内层帧；mux open 后宿主主动推订阅基线并重放未决请求（stable
  rpcId），PWA 打开即可重建存量待审批集合。
- **审批回答**：既非 RPC 也非 WS——对 mux 帧的响应，走 `POST /api/respond` 普通 HTTP，
  回显 server-request 的 rpcId + `{sessionId, approvalId, outcome}`，HTTP 响应体即收据。

因此 PWA = fetch（指令）+ WebSocket（下行）+ fetch respond（审批）；认证、限速、
keepalive 全部复用网关现有层，无新增传输代码。

## 3. 信息架构：三视图

```
┌─────────────────────────────┐
│  任务                        │  ① 任务列表（首屏）
│  ▸ 工作区A（3）  运行中·1     │
│     · 修登录页 bug      ●运行 │
│     · 写周报           ⏸审批 │
│  ▸ 工作区B（2）              │
│     · 调研 xx            空闲 │
│  ▾ 其他（1）                 │
├─────────────────────────────┤
│需要我  [全部|运行中|待处理]   │  ② “需要我”聚合页（应急核心）
│  · 修登录页 bug  [允许一次]  │
│  · 调研问卷      [回答]      │
├─────────────────────────────┤
│  会话                       │  ③ 会话详情（点任务行进入）
└─────────────────────────────┘
```

### ① 任务列表（分组）

- 分组头 = 工作区名 + 区内运行数徽标；顺序按 `workspace.list` 返回（含手动排序），
  归档会话 (`archivedSessionIds`) 不显示；无工作区归属的会话进"其他"桶。
- 会话行 = 标题 + **状态点** + 最后活跃时间 + 待处理记号（见下）。
- 状态点五态（由 `running` 位 + `pendingInteraction` 聚合）：
  `●运行 / ⏸审批 / ?提问 / ▤计划评审 / ◦空闲`。
- 子 agent 行：平铺 + 小标记（↳ + 无独立操作入口，仅可查看）。
- 下拉刷新 + 顶部过滤（全部 / 运行中 / 需要我）；"卡住的任务排最前"
  由 `pendingInteraction` 位驱动排序，无需额外规则。

### ② 需要我（聚合页）

从 mux 帧实时聚合的 `pendingInteraction`（官方真实字段：`'approval' | 'plan-review' | 'question'`），
按会话分组，**一键 allow-once / reject / 回答**，回答后自动消失。notify 推送深链
落地于此：`/m?s=<sessionId>&a=<approvalId>`。

### ③ 会话详情

- 消息流：`session.history` 初始 `maxMessages:50`，上滑加载更早（`beforeSeq` 分页，
  `hasMore` 控制）；`session/event` 帧追加尾部。
- 渲染只做"人话视图"：用户消息原文、模型回复纯文本、工具调用折叠为一行灰字
  （工具名+状态）；不做完整 markdown。
- 底部输入框 + 三个动作：**发送**（`mode:'queue'`）、**停止**（`session.cancel`，
  二次确认）、**分叉**（`session.fork`）。
- 高危收敛：`mode:'steer'`（打断当前回合）在手机端默认隐藏——打断是破坏性输入，
  留给桌面；停止必须二次确认；审批回答带 1s 防误触。

## 4. 实时模型：基线 + 增量 + 重连 resync

两条下行增量子流，客户端按"基线 + 增量合并"维护本地状态，断连 backoff 重连 +
全量 resync（官方客户端同款连接代数语义）：

| 流 | 消费的帧 | 用途 |
|---|---|---|
| `host` 流 | `host/session-added` `host/session-status` `host/session-removed` `host/agent-error` `host/workspace-changed` `host/workspace-order-changed` `host/workspace-removed` `host/archived-sessions-changed` | 列表增删改 + 运行位翻转 + 分组刷新 |
| `mux` 流 | `approval/requested` `approval/resolved` `question/requested` `question/resolved` `session/title` `session/event` `tool/call` `tool/result` | "需要我"页 + 详情实时追加 + 标题更新 |

`approval/requested` / `question/requested` 为 server-request（稳定 rpcId）；回答 =
`POST /api/respond` 回显 rpcId（body 为 client-response 信封）。

## 5. API 契约（2026-08-25 实测定案，开工即照抄）

| 操作 | 端点（点号形式） | 关键字段 |
|---|---|---|
| 列会话 | `session.list` `{}` | `items[]`：`sessionId,updatedAt,running,blank,parentSessionId?,cwd,agentPreset,projections.values.*`；**title 在 `projections.values.title`**（顶层无 title）；values 另含 `todos/tokenUsage/contextPressure/sessionListMetadata/plan` 可供 M1+ 消费 |
| 列工作区 | `workspace.list` | `{items:[{workspaceId,path,title,sessionIds[],createdAt,updatedAt}], archivedSessionIds?}`（实测与类型一致） |
| 历史 | `session.history` `{sessionId, maxMessages, beforeSeq?}` | `{events:[{event,view?}], hasMore, projections}`，初始 `maxMessages:50` |
| 发消息 | `session.prompt` `{sessionId, mode:'queue'\|'steer', content:[{type:'text',text}], clientTimeZone?}` | `queue` 排队，`steer` 打断（手机端隐藏） |
| 停止 | `session.cancel` `{sessionId}` | |
| 创建 | `session.create` `{workspaceId?\|cwd?}` | 返回 `{sessionId}`；新会话自动挂工作区 |
| 分叉 | `session.fork` `{sessionId, atSeq?}` | 返回 `{sessionId}`；子会话带 `parentSessionId` |
| 重命名 | `session.rename` `{sessionId, title}` | |
| 搜索 | `session.search` `{query}` | `{items:[{sessionId,snippet}], hasMore}`（v1+） |
| 归档 | `workspace.archiveSession` `{sessionId}` | 极简版"删除任务"（会话日志保留） |
| 审批回答 | `POST /api/respond` | `{type:'client-response', rpcId, result:{ok:true, value:{sessionId, approvalId, outcome:'allowed-once'\|'rejected'}}}`；响应体即收据 |
| 宿主状态 | `host.describe` | 实测返回 `{version,cwd,provider,model,attachedSessions,home,canOpenPath}`（顶栏锚点） |

注意：
- **会话归属工作区的信息在 `workspace.list` 的 WorkspaceView 里**（`session.list`
  的 summary 无 workspaceId 字段）——分组以 `workspace.list` 为基座，`session.list`
  只补运行态。
- 所有 RPC 走点号形式路径；斜杠形式（官方 Connection 层的 goals/commands 等
  自定义端点用）对 session/workspace/host 域无效。

## 6. 网关集成点（改动最小化）

```
网关 (port 3081)  ──现有──▶ 官方 webserver (loopback)
   ├─ /  /pair  /status /api/*  …原样反代（不动）
   └─ /m                     ← 新增：网关自己答（返回 PWA 单页，不反代）
PWA 页面内 fetch('/api/session.list') 与 WS(/api/events.*) → 同源打到网关
   → 走现有反代 → cookie 认证全复用
```

实现（M0 已落地）：`mobile/index.html` 单文件 PWA（零依赖、零构建；
先例 `../mimo/ui.html`）+ `src/mobile-page.js` 加载器（每请求读盘，热更新友好）
+ `gateway.js` 内 `/m` 精确路由分支（gate 认证后、反代前；CSP 放行同源 WS）。
扫码/入口：默认配对码仍指向官方 UI 不回归；`/pair` 页加"极简版"入口按钮（M3）。

## 7. 安全设计

- 沿用全部现有认证；PWA 与网关同域、同 cookie、同限速桶，无新增攻击面。
- 高危动作加固：停止二次确认；审批回答防误触；`steer` 打断手机端隐藏；
  详情页只读模式不带清空类高危操作。
- 行为原则：移动端只做"观察 + 单点动作"，破坏性/批量性操作留在桌面。

## 8. 目录结构与开源形态

并入本仓库随包发布（v1.8+ 版本号），`mobile/` 与现有代码同仓库同许可证：

```
dsh-ios-control/
├─ mobile/index.html    新：极简 PWA 单页
├─ src/mobile-page.js   新：页面加载器（每请求读盘）
├─ src/gateway.js       改：/m 精确路由分支（~20 行）
├─ test/mobile-route.test.js 新：路由测试
└─ README.md            （M3）新增章节，主打"遥控器"叙事
```

## 9. 里程碑

- **M0（核心）**：`/m` 路由 + 任务列表（工作区分组 + 五态状态点 + 子 agent 平铺标记）
  + 下拉刷新 + host 流增量 + **plan-review 标记显示**。
- **M1（应急）**："需要我"页 + 审批/提问/计划评审一键回答 + notify 深链
  + 会话详情（纯文本） + 发送消息。
- **M2（控制）**：停止（确认）、分叉、重命名、创建任务（挂工作区）。
- **M3（打磨）**：搜索、归档、离线缓存（service worker）、桌面主屏图标、`/pair` 入口。

## 10. 风险与待验证点

1. **子 agent 层级**（已定案）：平铺 + ↳ 标记；不处理嵌套折叠。列表行仍需
   `workspace.list` 与 `session.list` 的合并去重（workspace 视图与会话列表的口径差异）。
2. **`session/event` 渲染**：简化渲染需实测常见 event kind（user / assistant /
   tool-call / plan / todo），确认折叠规则；`view` 槽是宿主计算的渲染意图，
   优先消费它而非裸解析 event。
3. **下行传输**（✅ 2026-08-25 定案）：SSE 变体实测不存在（GET 回 426），PWA 走
   WS 反代——隔离实例 rawUpgrade 实测 101 通过，mux open 首帧
   `session/subscribed` 确认重放机制真实存在。
4. **心跳**（✅ 定案）：WS 腿由网关现有 keepalive ping 覆盖（手机腿同样受益）；
   PWA 侧仅保留指数退避重连 + onopen 全量 resync，无需自建心跳。
5. **plan-review 协议**：M0 只消费标记；回答通道与 approval 同构
   （`POST /api/respond`），M1 以实测为准实现（question 的回答 payload 结构
   开工时以 questions domain 契约为准核验）。
6. **host.describe / /status 联动**：顶栏"电脑在线"复用现有宿主遥测结果，
   不新增探测。
7. **真机验收清单**（M0 收口标准）：工作区分组与真实标题、五态状态点翻转、
   "需要我"chip 对存量待审批的重建（依赖 mux 重放）、下拉刷新、弱网断连自动恢复。