# Mobile App 规范（原生 Android/iOS）

> 本文档是 **Android/iOS 原生 app** 的实现契约，交给实现 agent（本仓库只出 spec）。
> 状态：M6 **推迟**（2026-08 决定）。内部文档（中文）。
> 依赖契约：`docs/design/gateway.md`（网关端点/认证/配对）、`docs/research/relay-protocol.md`（relay 目录/转发）、`docs/research/opencode-mobile-architecture.md`（定位与重连模型，**逻辑借鉴、UI 禁止**）。
> 铁律：app 的 UI/UX **跟随官方 dsh Web**，绝不抄 opencode-mobile UI。

## 0. 实施策略（2026-08 决定：推迟 + 复兴时 WebView 优先）

**决定**：dsh 官方仍处于快速更新期，原生 app 暂不启动。理由：官方 Web UI 自身已适配移动端，
浏览器直开即用，且随官方更新免费获得新功能；任何**重实现官方 UI 的原生界面**都会把 app 绑死到
官方的 API/行为细节上，官方每次改动都要适配，维护成本不成比例。

**复兴时的推荐形态（优先级从高到低）**：

1. **WebView 包装（首选）**：WKWebView / Android WebView 直接加载官方 UI（经 gateway 的
   `https://<relay>/instance/<id>/` 或 tailscale origin），注入配对后的会话 cookie 或 Bearer。
   app 原生层只负责：QR 配对、token 安全存储、深链、通知（phase 2）。UI 面零重实现 →
   官方更新零适配，仅需跑 `docs/research/upstream-touchpoints.md` 的冒烟清单。
2. 原生重实现 UI（本文档 §2-§8 描述的完整方案）：仅在 WebView 方案被明确否决（如性能/体验
   要求）时才考虑，且必须接受「跟随官方 UI 变化持续适配」的维护义务。

本文档其余章节 = 方案 2 的完整契约，保留备查；方案 1 只使用 §3 的端点契约
（`/mobile/pair` mint-at-redemption、Bearer 代理面、relay 目录）。

## 1. 定位：监督/控制面板，不是开发环境

app 是**已存在 dsh 会话的监督与控制面板**：列会话、打开会话、读流、发消息、处理审批、管理连接。借鉴 `opencode-mobile-architecture.md` §5.2/§8.1 的定位结论：

- **只控制已有会话**：phase 1 **不提供**新建/fork/删除会话（`session.create`/`session.fork`/会话删除一律不暴露）。
  - 原因（来自 opencode 调研）：会话生命周期管理天然留在跑 dsh 的机器上（工作目录、agent preset、模型选择都是本机语义）；移动端是「远程遥控」而非「第二开发机」。把创建/fork 放上手机会把本机语义（cwd、workspace、preset 绑定）错误地迁移到远端，且会与官方 Web 的会话模型产生分叉。
- **server-authoritative**：app 无本地权威状态；一切列表/消息以服务端响应为准。
- 仅 phase 1 能力；phase 2 见 §9。

## 2. 架构建议

### 2.1 推荐：React Native + Expo（单一推荐）

推荐 **React Native（Expo 管理流，expo-router 或 react-navigation）**，理由：

1. **单一代码库覆盖 iOS/Android**：本 app 是两个完全等价的移动端，UI 逻辑/状态机/SSE 解析/连接模型只写一份。
2. **Expo 生态覆盖全部硬需求**：`expo-camera`（扫配对 QR）、`expo-secure-store`（Keychain/Keystore）、`expo-linking`（深链）、`expo-network`（连通性）。opencode 参考实现同样采用 Expo/RN，其「逻辑可借鉴」的部分（fetch-SSE、复合身份、refetch 重连）可直接迁移。
3. **无原生自维护成本**：不用分别维护 Swift/Kotlin 两套网络层与 UI。

**非谈判的原生能力（无论选 RN 还是纯原生都必须具备）**，见下表：

| 能力 | 要求 |
| --- | --- |
| 安全存储 | iOS Keychain（`kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly`）/ Android Keystore-backed（`EncryptedSharedPreferences` 或等价）；**绝不**用 AsyncStorage/明文文件存 token |
| 相机 QR | 扫配对 URL 提取 `code` |
| 深链 | 自定义 scheme（建议 `dshmobile://`）+ iOS Universal Links / Android App Links（relay 配对落地页跳转） |
| 后台/前台 | 切后台不崩溃、回前台触发 §5.4 重连；一期**无**后台常驻（无 push） |
| 网络策略 | Android network security config（§4.3）；iOS ATS 例外（§4.3） |

**允许实现 agent 换框架**（如纯 SwiftUI + Jetpack Compose）仅当其有充分理由（团队栈、性能），但 §2.1 表格的每一项能力都必须等价满足，且 UI/UX 仍须遵循 §7。

### 2.2 强制能力清单（与框架无关）

1. 连接凭据 + 非敏感元数据**分层存储**（token 进安全存储；baseUrl/instanceId/displayName 进普通偏好）。
2. 一次最多维护一个「当前连接」；多 relay 实例在 phase 2（§9）。
3. 每个网络请求可取消（AbortSignal），SSE 断开可重建。
4. 全程无 token 落日志、无 token 进状态 dump（§4.2）。

## 3. 端点契约

### 3.1 实例 gateway 自营端点（`/mobile/*`，来源 `gateway.md` §4.1）

> app 与 gateway 同源；这些端点在 tailscale/relay 两模式下路径一致，只是 origin 不同。

| 方法/路径 | 认证 | 行为 | app 用途 |
| --- | --- | --- | --- |
| `GET /mobile/health` | 无 | `{ok:true, version, mode, instanceId, uptimeSec}` | 连通性探活（不需鉴权） |
| `POST /mobile/pair` | 无 | `{code}` → 一次性兑换 → 签发设备 token，**JSON 只回一次** `{deviceId, token, expiresAt}` | **配对**（§4.1） |
| `GET /mobile/api/status` | Bearer | 网关/传输状态（tailscale ip、relay 隧道态、dsh web 健康） | 连接状态页（§3.4） |
| `GET /mobile/api/devices` | Bearer + owner | 设备列表 | 一期 app **不暴露**（owner 走 CLI） |
| `DELETE /mobile/api/devices/<id>` | Bearer + owner | 撤销并踢活会话 | 一期 app **不暴露** |
| `POST /mobile/api/token` | Bearer + owner | 给已配对设备重签长期 token（丢失恢复） | 一期 app **不暴露**（见 §9） |
| `GET /mobile/auth`、`POST /mobile/auth`、`GET /mobile/pair?code=`、`POST /mobile/logout` | 见 gateway.md | 浏览器 cookie 面 | **app 不使用**（app 走 Bearer，无 cookie） |

> 说明：`POST /mobile/pair {code} → {deviceId, token, expiresAt}` 是 app 的 mint-at-redemption 契约（与浏览器 `GET /mobile/pair?code= → 302` 并列）。**已与 M2 gateway 实现对齐**：请求 `{code}`（无需 deviceName），响应 `{ok:true, deviceId, token, expiresAt:null}`——设备 token 长期有效、以撤销管理，故 `expiresAt` 恒为 `null`；token 原文只在本次响应中出现一次。

### 3.2 代理路径（app 消费官方 dsh Web 的 `/api` 面）

- app **不直接**访问官方 web 的 `127.0.0.1:3080`；它通过 gateway 同源 origin 消费官方 `/api`：
  - tailscale：`http://<tailnet-host>:<gatewayPort>/api/...`，请求头 `Authorization: Bearer <device-token>`。
  - relay：`https://<relay>/instance/<instanceId>/api/...`，同 Bearer 头（relay 转发路径**不做 relay 认证**，`Authorization` 原样转发给实例 gateway）。
- 网关校验 Bearer → 反代 `127.0.0.1:<webPort>`，HTTP/SSE/WebSocket 全透传，响应带 `x-dsh-mobile-gateway: 1`。
- **app 不需要会话 cookie**（`dsh_mobile_sid` 只服务浏览器）；app 只用 Bearer。

### 3.3 relay 目录（relay 模式，来源 `relay-protocol.md` §2/§3.1）

| 端点 | 方法 | 认证 | 说明 |
| --- | --- | --- | --- |
| `/relay/health` | GET | 无 | `{ok, uptime, instances}` |
| `/relay/api/targets` | GET | **Bearer client token** | `[{id,name,online,lastSeenMs}]` |
| `/relay/instance/<id>/<path...>` | 任意 | 无（实例 gateway 自行认证） | 经隧道转发；app 带 `Authorization: Bearer <device-token>` |

**flow（app 侧）**：

1. app 保存**一个 relay client token**（由 relay owner 通过 `dsh-relay` 签发，只用于目录）。
2. `GET /relay/api/targets`（`Authorization: Bearer <relay-client-token>`）→ 拿到 `[{id,name,online,lastSeenMs}]`。
3. 用户选一个 `online` 实例 → 该实例的 origin 为 `https://<relay>/instance/<id>/`。
4. 对该实例的**每个**后续请求用**实例设备 token**（`Authorization: Bearer <instance-device-token>`，由 §3.1 配对换取），**不是** relay client token。
5. 两个 token 语义不同、不可混用：relay client token 只能调 `/relay/api/targets`；实例 device token 只能作为 gateway 凭据走 `/relay/instance/<id>/...`。

### 3.4 `/mobile/api/status` 响应形状（app 用）

> 该形状已与 M2 gateway 实现对齐（`/mobile/api/status`，任意已认证设备 Bearer 或 loopback 可读）。

```json
{
  "ok": true,
  "mode": "tailscale",                 // "tailscale" | "relay"
  "instanceId": "my-dsh",              // relay 模式有效；tailscale 模式为 null
  "displayName": "书房 Mac mini",       // 可空
  "uptimeSec": 12345,
  "tailscale": {
    "interfaceIp": "100.101.132.89",   // tailscale 模式有效；relay 模式 null
    "hostname": "woody.tail40672a.ts.net"  // 可空
  },
  "relay": {
    "connected": true,                 // relay 隧道是否在线
    "instanceId": "my-dsh",            // 可空
    "displayName": "书房 Mac mini"      // 可空
  },
  "dshWeb": {
    "healthy": true,                   // 官方 web 127.0.0.1:3080 健康
    "webPort": 3080
  }
}
```

要求：app **容错解析**——缺失字段不崩；未知字段忽略；`ok:false` 时展示 §5.4 的 stale 态。

### 3.5 官方 dsh Web `/api` 面（黑盒契约 + 已知快照 + 发现程序）

> 官方 `/api` 是 app 的**业务数据面**（会话列表/历史/发消息/审批）。实现 agent 必须把它当**黑盒**：**服务端权威**，只解析服务端返回，不做本地权威推断；未知字段一律忽略（官方契约是 merge-extensible，字段可漂移）。

**已知契约快照（来源：本机 `@deepseek-ai/dsh@0.1.0-rc.6` 源码 `dsh-host-apiproxy/lib/types/api/`，仅供起步，**一切以运行实例网络抓包为准**）：**

- **RPC 信封**（四象限消息模型）：
  - 客户端调用：`POST /api/<method>`，body `{ type:'client-request', rpcId:<uuid>, method:'<method>', payload:{...} }`；HTTP 响应体为 `{ type:'server-response', rpcId, result:{ ok:true, value:{...} } | { ok:false, error:{ code, message, details } } }`。
  - 服务端请求（审批/问题，经下行流帧下发）：`{ type:'server-request', rpcId, method, payload }`；客户端应答：`POST /api/respond`，body `{ type:'client-response', rpcId, result:{ ok:true, value:{...} } }`，HTTP 响应体为 `{ accepted:true } | { accepted:false, reason:'not-pending'|'bad-response' }`。
- **方法名 → 线路径**（`rpc-map.d.ts`，`method` 为 `session.list` 等点号命名；`POST /api/session.list` 形式以抓包确认为准）：
  - 会话：`session.list` / `session.search` / `session.create` / `session.history` / `session.models` / `session.selectModel` / `session.rename` / `session.fork` / `session.prompt` / `session.attachment` / `session.updateQueue` / `session.cancel`
  - 子代理：`subagent.list` / `subagent.history` / `subagent.prompt` / `subagent.interrupt`
  - 主机：`host.describe` / `host.pickDirectory` / `host.listDirectory` / `host.createDirectory` / `host.openPath`
  - 工作区：`workspace.list` / `workspace.create` / `workspace.rename` / `workspace.delete` / `workspace.insertBefore` / `workspace.insertSessionBefore` / `workspace.archiveSession`
  - 其他：`skill.list`、`agentPreset.list/select/read/copy/openDocument/remove`、`goal.*`、`settings.describe/openDocument/update/replace/mutate`、`credentials.describe/set/unset`、`llm.providers/models/discoverModels`
- **关键 payload（阶段一用到的）**：
  - `session.list` → `{ items:[{ sessionId, updatedAt, running, blank, parentSessionId?, origin?, cwd?, agentPreset?, projections? }] }`（`cursor` 参数 v1 未实现）。
  - `session.history` payload `{ sessionId, beforeSeq?, maxMessages? }` → `{ events:[{ event, view? }], hasMore, projections? }`；`event` 信封 `{ type, seq, time, data, sourceEventSeqs?, surfaceOp?, ignorable? }`；消息边界分页按 `user/message` / `assistant/message` 计数。
  - `session.prompt` payload `{ sessionId, mode:'queue'|'steer', content:[{type:'text',text}|{type:'image',mediaType,data,name?}], clientTimeZone? }` → `{ accepted:true, command? }`。
  - `session.cancel` payload `{ sessionId }` → `{ accepted:true }`。
  - **审批应答**（`/api/respond` 的 value）：`{ sessionId, approvalId, outcome:'allowed-once'|'rejected' }`。
  - **问题应答**（`/api/respond` 的 value）：`{ sessionId, answer:{ answers:[{ id, selected:[string], custom? }] } }`。
- **事件流帧**（下行 mux 流，`events.d.ts`）：`session/event`（含 `sessionId`、`event`、可选 `view`）、`session/subscribed`（`sessionId,lastSeq`）、`approval/requested`（`sessionId,approvalId,toolName,callId?,reason?`）、`approval/resolved`、`question/requested`（`sessionId,questions[]`）、`question/resolved`、`session/queue`、`session/jobs`、`session/projection`、`stream/error`；host 流另有 `host/session-added`、`host/session-removed`、`host/session-status`、`host/agent-error`、`host/workspace-*`、`host/archived-sessions-changed`、`host/remote-event`。**重连 = 重开流 + 重拉 `session.list`/`session.history`**；`since` 游标 v1 未实现（传入被忽略）。

**发现程序（实现 agent 必须执行，取代「猜测路由」）：**

1. 本地起官方 web（或经 gateway）→ 打开浏览器 DevTools Network → 逐个操作（列会话/开会话/发消息/审批/设置）→ **完整记录**：每个请求的 method/path/headers/body、响应体、SSE 流的 URL 与首帧、WebSocket 握手 URL（若有）。
2. 从官方前端源码交叉核对：`@deepseek-ai/dsh-host-apiproxy/lib/types/api/`（契约）、`@deepseek-ai/dsh-client-connection`（传输层 URL/信封）、`@deepseek-ai/dsh-web-frontend/dist`（构建产物中引用路径）。
3. 产出**一份接口清单文档**（方法 → path → payload/value 形状 → 事件类型），作为 app 实现的唯一路由依据；清单中任何不确定项标注「以抓包为准」，不写死猜测值。
4. **黑盒纪律**：app 解析一律容错（未知字段忽略、缺字段降级、类型不符不崩）；**不**在 app 内维护「会话/消息」的本地权威副本，只做展示缓存（见 §5.3）。

## 4. 认证与安全

### 4.1 token 生命周期（配对 → 存储 → Bearer → 401 → 重配对）

1. **配对**：owner 桌面执行 `dsh mobile device pair` 得到 URL/QR（含 6 位一次性 `code`）。app 扫 QR 或手输 `code` → `POST /mobile/pair { code, deviceName? }`（`deviceName` 若 M2 支持则带，展示用）。
2. **存 token**：响应 `{ deviceId, token, expiresAt }` 的 `token` 原文**只此一次可见**，立即写入安全存储（§4.2）；`deviceId` 存普通偏好（展示/重连定位用）。**绝不**把 token 写进 AsyncStorage、状态、日志、崩溃报告、截屏。
3. **每次请求带 Bearer**：`Authorization: Bearer <token>`，含 `/mobile/api/status`、`/api/*`、SSE/WS 连接。
4. **401 处理**：任何请求/流返回 401（token 无效/撤销/过期）→ 清本地 token → 进入「需重新配对」态 → 引导重新配对。**不得**自动重试或静默吞掉。
5. **重新配对**：走 1–3；`POST /mobile/api/token` 重签是 owner 桌面能力，phase 1 app 不暴露。

### 4.2 token 存储要求

- **iOS**：Keychain，`kSecClassGenericPassword`，`kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly`（后台可读、不随备份跨设备迁移）。
- **Android**：Keystore-backed `EncryptedSharedPreferences`（或 Keystore 加密的自有文件）；`android:allowBackup="false"` 或 token 不进 backup。
- 可选（推荐）：**生物识别**（Face ID / 指纹）门控读取 token——`expo-secure-store` 的 `requireAuthentication`，或原生 Keychain `kSecAccessControlBiometryCurrentSet` / Android `BiometricPrompt`。门控仅保护「打开 app 读取 token」，非强制。
- **禁止项**：token 不入日志（包括 `console.log`/崩溃上报/HTTP 客户端调试输出）、不入状态 dump/序列化、不入 AsyncStorage/MMKV/明文 `SharedPreferences`、不入截屏（必要时 `FLAG_SECURE`/`preventScreenshot`）、不入 URL（token 永远在 header，不在 query）。

### 4.3 传输安全

| 模式 | 传输 | 要求 |
| --- | --- | --- |
| tailscale | **明文 HTTP**（WireGuard 已加密） | 仅允许连 **tailnet 主机**；`http://` 明文仅对该 host 放行 |
| relay | **HTTPS**（Caddy） | 强制 HTTPS，证书校验开启 |

- **Android**：`network_security_config.xml` 用 `<domain-config>` **精确列出** tailnet 域名/IP（如 `100.101.132.89`、`woody.tail40672a.ts.net`、`*.tail40672a.ts.net`）并 `cleartextTrafficPermitted="true"`；`<base-config>` 保持 `cleartextTrafficPermitted="false"`。**禁止**全局 `usesCleartextTraffic` 或 `cleartextTrafficPermitted` 全开。
- **iOS**：ATS 用 `NSAppTransportSecurity` 的 `NSExceptionDomains` 精确豁免 tailnet host（`NSExceptionAllowsInsecureHTTPLoads=true`），**禁止** `NSAllowsArbitraryLoads`。
- **证书校验**：relay 模式默认严格校验证书链（不 `setInsecureSkipVerify`/自定义 TrustManager 放行）。自签证书不支持（relay 用 Let's Encrypt，见 `plan.md` §6-5）。
- **URL 校验**：进入的 baseUrl 必须白名单校验 `scheme ∈ {http,https}` 且（tailscale 模式）host 形如 tailnet IP/MagicDNS、（relay 模式）scheme 必须 `https`；拒绝 `file://`、非 tailnet 的明文 http、任意端口字符串注入。深链传入的 origin 同样过该校验。

## 5. 连接与会话模型

### 5.1 复合身份

连接身份为三元组 **`(transportBaseUrl, instanceId, sessionId)`**：

- `transportBaseUrl`：`http://<tailnet-host>:<gatewayPort>` 或 `https://<relay>/instance/<instanceId>`。
- `instanceId`：relay 模式为目录中的实例 id；tailscale 模式为 `null`（单实例直连）。
- `sessionId`：官方 dsh 会话 id（`session.list` 的 `sessionId`）。

该三元组贯穿路由键、缓存键、SSE 订阅键，避免跨连接/跨实例/跨会话串号。

### 5.2 会话列表（复用官方 API）

- 用 `session.list`（§3.5）拉取；渲染 `sessionId`、`updatedAt`（排序）、`running`/`blank`、可选 `agentPreset`/`cwd`。
- 列表按服务端返回为准，**不**本地合并历史缓存（重连后整表替换，见 §5.4）。
- phase 1 只读列表 + 打开；不新建/fork/删除（§1）。

### 5.3 打开会话：读流 + 发消息

1. **读历史**：`session.history`（`beforeSeq` 向后分页、`maxMessages` 默认 50）拉消息窗口；渲染沿用官方语义（§7）。
2. **订阅流**：建立下行流（mux 流）接收 `session/event`（增量消息/chunk/工具事件）、`approval/requested`、`question/requested`、`session/queue`、`session/jobs`、`session/projection`、`stream/error`。
3. **发消息**：`session.prompt`（`mode:'queue'` 常规发送；`mode:'steer'` 仅官方 UI 支持 steering 语义时对齐，否则只发 queue）。发送前过 §5.6 staleness 门控。
4. **取消**：`session.cancel`（可选，若官方 UI 在运行态提供取消）。

### 5.4 重连策略（server-authoritative refetch，无事件重放游标）

> 直接采纳 `opencode-mobile-architecture.md` §8.1 的结论。

1. 网络恢复 / app 回前台 / 流断开后，**不**从本地缓存续播。
2. 顺序：重拉 `session.list`（整表替换）→ 打开会话重拉 `session.history`（整体替换当前视图）→ 重开下行流（`since` 不传/忽略）。
3. **无事件重放游标**：不实现 `since`/seq 增量续播；历史以 `session.history` 分页为唯一权威，流只做增量。
4. 展示缓存仅用于「离线时仍能看上一次内容」，且必须标注 stale；恢复后立即被服务端数据覆盖。

### 5.5 SSE 消费（下行流）

- 用**自写 fetch + SSE 字节解析**（RN 的 `EventSource` 不可靠），逐帧解析 §3.5 的帧；字节安全（按 `\n\n` 分帧、`data:` 多行拼接），二进制忽略。
- 请求须带 `Authorization: Bearer <token>`；连接为**请求作用域**：一次连接绑定一个 origin（tailscale 单实例 或 relay 单实例），帧内 `sessionId` 决定归属。
- 断开重连按 §5.4；重连间隔指数退避（1s→30s 封顶），`stream/error` 帧不致命、只记录并展示。

### 5.6 新鲜度门控（fresh/stale）

- **fresh**：网关可达（`/mobile/health` 或最近请求成功）、下行流已连、实例 `online`（relay 模式 `/relay/api/targets` 的 `online:true`）。
- **stale**：任一失败（网络断、401 外的连接失败、relay 实例 offline、流长时间无帧）。
- **门控**：UI 显著展示 fresh/stale（如顶部状态条）；**stale 时禁用「发送」**（只读渲染），允许重试/重连按钮；401 走 §4.1 重配对而非 stale。

## 6. 审批

1. **渲染**：`approval/requested` 帧在**会话视图内**渲染审批卡片（`sessionId`、`approvalId`、`toolName`、`reason?`），accept/reject 两个动作。
2. **应答**：`POST /api/respond`，value `{ sessionId, approvalId, outcome:'allowed-once'|'rejected' }`（§3.5）；`rpcId` 必须回显该 `approval/requested` 帧的 `rpcId`（稳定 id，重放复用）。
3. **收敛**：`approval/resolved`（`outcome`）到达后更新/移除卡片；`approval/resolved` 的 `outcome` 由服务端裁决（`allowed-once`/`rejected`/`cancelled`/`unavailable`），app 只展示。
4. **问题卡片**：`question/requested`（`questions[]`）同类处理，应答 value `{ sessionId, answer:{answers:[{id,selected,custom?}]} }`。
5. **呈现语义对齐官方**：卡片层级、文案、disabled 态、多卡并存/覆盖规则，一律以官方 Web 的表现为准（§7）。**一期无推送**——审批只在 app 前台且会话打开时可见。

### 6.1 二期通知（sketch，不实现）

- 审批待处理时推送到手机：**APNs（iOS）/ FCM（Android）**，触发点在 **gateway 侧**（实例在 `approval/requested` 时发推送）或 **relay 侧**（relay 观察到转发流中的审批帧时发推送，需 relay 理解 dsh 事件或由实例 gateway 显式上报）。
- 推送 payload 只含「有审批待处理 + sessionId + instanceId」，点击深链回 app 并打开对应会话。设备订阅、VAPID/APNs token 存储、免打扰策略均为二期内容。

## 7. UI/UX 语言（跟随官方 dsh Web）

- **视觉**：深色、极简，与官方 Web 同组件层级：**会话列表 → 聊天（消息流）→ 工具卡片 → 审批卡片 → 设置**。复用官方设计 token 色（`design-platform.css` 暗色段：底色 `neutral-bluish-950`、卡片 `-800`、输入 `-900`、品牌强调 `deepseek-450` 蓝、错误 `red-400`、成功 `green-500`），字体系统栈。
- **渲染**：消息内容按官方语义渲染（Markdown/代码块/KaTeX/工具卡片），**不做**超越官方的自定义重渲染。
- **明确禁止（WHAT NOT TO DO）**：
  1. 不做 opencode-mobile 风格 UI（其时间线/森林/模型选择器/diff 预览/问题预览等一律不引入）。
  2. 不做自定义聊天重设计（气泡、配色、布局、字体均不改官方观感）。
  3. 不做 markdown 重渲染器（不引入额外 markdown 库去「美化」；以官方 Web 现有渲染为上限）。
  4. 不新增官方 Web 没有的功能入口/导航层级。
  5. 审批/问题卡片不做第二套视觉，跟随官方呈现。

## 8. 验收清单

1. **配对**：扫 QR 得 `code` → `POST /mobile/pair` 拿到 `{deviceId,token,expiresAt}` → token 入 Keychain/Keystore；token 不出现在任何日志/state dump/截屏。
2. **会话列表**：`session.list` 渲染正确；空态/多会话/`running` 状态正确；列表项点击打开对应 `sessionId`。
3. **读流**：打开会话 → `session.history` 显示历史 → 下行流增量更新；消息/工具卡/审批卡正确渲染。
4. **发消息**：fresh 态可发（`session.prompt`），消息上屏并触发流式回复；stale 态发送按钮禁用且 UI 明确标 stale。
5. **审批**：`approval/requested` 渲染 accept/reject；accept → `allowed-once`、reject → `rejected`；`approval/resolved` 后卡片收敛；`question/requested` 同类。
6. **重连**：断网→恢复网后自动重拉 `session.list`+`session.history`+重开流，整体替换、无本地续播；无事件重放游标。
7. **401**：撤销设备后（owner `dsh mobile device revoke`）下一次请求/流 401 → 清 token → 引导重新配对。
8. **relay 模式**：`/relay/api/targets`（client token）列实例 → 选在线实例 → 用**实例** device token 走 `/relay/instance/<id>/api/...`；`unknown-instance`/`instance-offline`/`request-timeout` 分别映射到明确文案。
9. **传输安全**：tailscale 明文 HTTP 仅 tailnet host 放行（Android network config / iOS ATS 例外精确到域）；relay 强制 HTTPS + 证书校验；非 tailnet 明文 http、`file://`、伪造 origin 被拒。
10. **UI**：§7 全部条款满足；无 opencode 风格、无自定义聊天/审批重设计。
11. **phase 1 边界**：app 不提供新建/fork/删除会话、不提供 `/mobile/api/devices`、`/mobile/api/token`、无 push。

## 9. 非目标与二期

- **一期不做**：会话创建/fork/删除（§1）、推送通知（§6.1）、passkey（relay owner WebAuthn，属 relay 侧）、多 relay profile（app 一期单连接）、`/mobile/api/token` 重签入口、后台常驻。
- **二期候选**：APNs/FCM 审批推送、多 relay 实例多连接管理、生物识别强制门控、设备管理页（owner）、`/mobile/api/token` 丢失恢复 UI。
