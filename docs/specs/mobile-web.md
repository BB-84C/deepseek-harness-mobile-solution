# Mobile Web 规范（移动浏览器访问官方 dsh Web）

> 本文档是**移动浏览器**远程访问官方 dsh Web UI 的实现契约，交给实现 agent。
> 状态：M6 定稿。内部文档（中文）。
> 依赖契约：`docs/design/gateway.md`（网关端点/认证模型）、`docs/research/relay-protocol.md`（relay 隧道）。
> 唯一铁律：**官方 dsh Web UI/UX 原样，不做任何重设计**。本规范只覆盖认证门、移动视口就绪清单、配对/深链/登出/设备管理/错误态与二期 PWA；绝不改官方 UI。

## 1. 定位与原则

1. **官方 UI 原样**：移动浏览器打开的是 gateway 反代出来的**官方 dsh Web 前端**（`dsh-web-frontend` 静态资源 + 官方 `/api` 面），字节级复用官方构建产物。本仓库**不 fork、不改写、不重新打包**官方前端。
2. **同源**：浏览器与 gateway 同源。两种模式下浏览器都只与一个 origin 对话：
   - tailscale：`http://<tailnet-host>:<gatewayPort>/`（默认 `:3081`，WireGuard 已加密，一期明文 HTTP）。
   - relay：`https://<relay-host>/instance/<instanceId>/`（Caddy TLS 终结，隧道到实例 loopback gateway）。
3. **本规范的实际改动面只有一处**：gateway 自营的 `/mobile/*` 端点中，`GET /mobile/auth` 返回的**极简暗色登录/配对页**。官方 UI 本身只要求「移动视口可用」（§3 就绪清单），不要求改官方代码。
4. **认证边界**：未认证浏览器导航 → `302 /mobile/auth?next=<url>`；未认证的 `/api` 或 `Accept: application/json` 客户端 → `401` JSON。认证后浏览器持有 `HttpOnly` 会话 cookie `dsh_mobile_sid`。

## 2. 认证门 UX（`GET /mobile/auth` 登录/配对页）

> 这是本规范唯一要求「新建 UI」的地方。页面必须**极简、中性、暗色**，视觉语言对齐官方 dsh 深色主题；不发明设计系统。

### 2.1 视觉语言（复用官方 token，禁止自创色板）

登录页 CSS 必须引用以下官方设计 token（见 `dsh-client-ui-theme/lib/styles/design-platform.css` 的 `body[data-ds-dark-theme]` 段），不得硬编码任意色值：

| 用途 | token | 暗色值 |
| --- | --- | --- |
| 页面底色 | `--dsw-alias-bg-base` | `rgb(21,21,23)` |
| 卡片/表单面板底色 | `--dsw-alias-bg-layer-3` | `rgb(53,54,56)` |
| 输入框底色 | `--dsw-specific-login-input` | `rgb(27,27,28)` |
| 主按钮/品牌强调 | `--dsw-static-deepseek-450` | `rgb(86,134,254)` |
| 主文字 | `--dsw-alias-label-primary` | `rgb(249,250,251)` |
| 次要文字 | `--dsw-alias-label-secondary` | `rgb(207,211,214)` |
| 边框 | `--dsw-alias-border-l2` | `rgba(255,255,255,0.12)` |
| 错误 | `--dsw-static-red-400` | `rgb(242,90,90)` |
| 成功 | `--dsw-static-green-500` | `rgb(34,197,94)` |
| 字体 | `--dsw-font-family` | 系统栈（见 `base.css`） |

要求：纯 CSS、无第三方 UI 库；页面上只放标题（`DeepSeek Harness` / 实例 `displayName` 若可用）、一个输入框、一个提交按钮、一个错误提示位。布局：垂直居中，单列，最大宽度 `420px`，移动端满宽。

### 2.2 两种登录输入

页面必须同时支持两种凭据（与 `POST /mobile/auth` 的 `{code}` / `{token}` 对应）：

1. **配对码**（6 位数字，一次性）：`dsh mobile device pair` 输出的 URL/QR 中携带。
2. **设备 token**（长期 bearer 原文）：已配对设备的恢复入口（浏览器侧可选，主要给桌面第二浏览器使用）。

交互：默认显示「配对码」输入；提供一行切换「使用设备 token 登录」。输入框按需切换 `inputmode="numeric"`（配对码）与 `text`（token）。提交即 `POST /mobile/auth`，body 为 `{code}` 或 `{token}`，可选带 `{redirect}`（从 `?next=` 透传）。

### 2.3 必须的状态与错误提示（用户可见文案，中文）

| 状态 | 触发 | 文案（示意，须可本地化） |
| --- | --- | --- |
| 成功 | `POST /mobile/auth` 200 且 `Set-Cookie` | 跳转 `redirect`（默认 `/`） |
| 配对码无效/已用/过期 | 401 | 「配对码无效、已被使用或已过期，请重新生成。」 |
| 连续失败 5 次 | 401（网关作废配对码） | 「尝试次数过多，请重新生成配对码。」 |
| token 无效/已撤销 | 401 | 「设备 token 无效或已被撤销，请重新配对。」 |
| 限速 | 429 | 「请求过于频繁，请稍后再试。」 |
| 网络/网关不可达 | 连接失败 | 「无法连接网关，请检查网络或实例是否在线。」 |

实现约束：错误提示不得泄漏内部堆栈；必须区分「配对码」与「token」两类错误文案。

## 3. 移动视口就绪清单（官方 UI 必须通过，不改官方代码）

> 官方前端已是响应式单页应用（`index.html` 带 `viewport` meta），但移动端仍须逐项验收。若某项不达标，**优先级是报告给上游/最小化修复，而不是在本仓库 fork 官方 UI**；本清单是验收标准。

1. **无水平滚动**：320px–1024px 视口内，页面 `overflow-x` 不得出现水平滚动条（代码块/表格允许内部横向滚动，但不得撑破页面）。
2. **会话列表（侧栏）**：窄屏下会话列表可折叠/抽屉化或占满；列表项至少 `44px` 高；`session.list` 数据正确渲染会话标题、`running`/`blank` 状态。
3. **聊天（会话视图）**：消息流在窄屏可读；`session.history` 分页（`beforeSeq`/`maxMessages`）在手机上可触达「加载更多」；长代码块与 KaTeX/Shiki 渲染不破版。
4. **输入/composer**：输入框在**虚拟键盘弹出**时不被遮挡（`visualViewport` 或 `position: sticky/fixed` 适配）；发送按钮触达面积 ≥ `44×44px`。
5. **工具卡片**：工具调用/结果卡片（`tool/call`、`tool/result` 事件）在窄屏单列堆叠、可折叠、可滚动查看长输出。
6. **审批卡片**：`approval/requested` 渲染的 accept/reject 卡片在窄屏可见，按钮 ≥ `44px`，不因键盘/滚动错位。
7. **权限/设置页**：settings 各命名空间页在窄屏可用；表单控件触达面积 ≥ `44px`。
8. **触摸目标**：所有可点击/可操作元素最小命中区 `44×44px`（iOS HIG / Android Material 标准），间距足够防误触。
9. **横竖屏**：横屏与竖屏均不破版；横屏时输入区不被键盘占据整屏。
10. **安全区**：刘海/圆角/底部手势条（`env(safe-area-inset-*)` 或 `viewport-fit=cover`）不遮挡顶部栏与底部输入/审批按钮。
11. **SSE 重连**：网络抖动时官方 SSE/WebSocket 断开后**自动重连**，重连后会话流恢复（官方前端已有该行为，需在移动端验真：断网→恢复网→会话继续流式更新，无需手动刷新）。若官方前端无自动重连，记录为已知问题并上报，**不**在本仓库改官方逻辑。

## 4. 配对流程 UX（浏览器）

> 目标：`dsh mobile device pair` 在桌面打印 URL + QR，手机浏览器扫 QR 或手输 → 一次性兑换 → cookie → 进入官方 UI。

1. **入口 URL**：`http(s)://<origin>/mobile/pair?code=<6位>`（tailscale/relay 两模式下 `<origin>` 即 §1 的同源 origin）。
2. **兑换（mint-at-redemption）**：`GET /mobile/pair?code=<6位>` 由 gateway 一次性消耗配对码 → 签发设备（服务端只存 SHA-256 哈希）→ `Set-Cookie: dsh_mobile_sid`（`HttpOnly; SameSite=Lax; Path=/; Secure`（https 时）; TTL=sessionTtlDays）→ `302` 到 `/`。
3. **失败**：配对码无效/已用/过期 → 302 到 `/mobile/auth?next=/&error=...`，登录页展示 §2.3 对应文案。
4. **UX 要求**：QR 内容 = 上述 URL（含 `code`）；扫 QR 后浏览器直接落地完成兑换，**无需用户再手动输入**。手输场景走 §2 登录页输入框。兑换成功后浏览器后续请求自动携带 cookie，用户无感。

## 5. relay 模式深链流程

> 目标：手机打开 `https://<relay>/instance/<instanceId>/` → relay 转发到实例 gateway → gateway 认证门 → 官方 UI。

1. relay 的 `/relay/instance/<id>/<path...>` 路径**不做 relay 认证**，把请求（含 `Authorization` 与实例 gateway 的 cookie `dsh_mobile_sid`）**原样转发**给实例侧 gateway（见 `relay-protocol.md` §3.1/§6）。
2. 因此浏览器视角的认证边界**仍是实例 gateway**：未认证访问 `/` 或其子路径 → gateway 302 到 `/mobile/auth?next=<url>`；未认证 `/api`/JSON 客户端 → 401。
3. 深链 `https://<relay>/instance/<instanceId>/` 的实际行为等价于 §1 同源访问，只是 origin 变成 relay 域名；`next` 参数与 cookie 的 `Path` 均落在该 origin 下，网关须保证 `/mobile/auth` 在 relay 前缀下也能正常返回登录页并回跳。
4. **离线实例**：若 `<instanceId>` 从未注册或离线，relay 返回 `404 {"error":"unknown-instance"}` / `502 {"error":"instance-offline"}`（见 `relay-protocol.md` §4.3）。浏览器须把这些映射到 §7 的用户可见错误态，而不是白屏。

## 6. 登出与设备管理页（owner 视角）

1. **登出**：`POST /mobile/logout`（需会话）清 `dsh_mobile_sid` cookie 并 302 回 `/mobile/auth`。登录页不提供「登出」入口（那是官方 UI 内的事）；登出能力由 gateway 端点保证。
2. **设备管理**：owner 设备可在官方 UI 之外的 gateway 页（或直接在官方 UI 的会话里）访问 `GET /mobile/api/devices` 列表与 `DELETE /mobile/api/devices/<id>` 撤销。撤销后该设备所有活跃 SSE/WS 与 cookie 会话即时断开。
3. **本规范范围**：只要求 gateway 提供这些端点（已在 `gateway.md` §4.1）；**浏览器侧不新建设备管理页面**——设备管理是 owner 在桌面用 `dsh mobile device list|revoke`（CLI）完成，或后续 M5 文档再决定是否加极简页。实现 agent 若加页面，必须复用 §2 的 token 体系、且只允许 owner 会话访问。

## 7. 错误状态映射（用户可见）

> 浏览器（尤其 relay 模式）必须把网关/relay/官方 web 的错误映射为明确中文文案，不得白屏或显示原始 JSON。

| 状态码/来源 | 触发 | 用户文案（示意） |
| --- | --- | --- |
| 401（无凭证） | 未登录访问 `/api` 或 JSON 客户端 | 由 gateway 直接 401 JSON；浏览器导航场景则 302 到登录页 |
| 401（凭证无效/撤销） | token/cookie 失效 | 「登录已失效，请重新配对/登录。」（并跳登录页） |
| 502 `instance-offline` | relay 转发但实例离线 | 「实例当前离线，请稍后重试或检查 dsh 服务。」 |
| 504 `request-timeout` | relay 30s 无帧 | 「请求超时，实例可能无响应。」 |
| 404 `unknown-instance` | relay 未知实例 id | 「实例不存在，请检查连接地址。」 |
| 503 `stream-limit` | 单实例并发流超 32 | 「实例连接数已达上限，请稍后重试。」 |
| 429 `rate-limited` | 网关/relay 限速 | 「请求过于频繁，请稍后再试。」 |
| 网关不可达 / 断网 | 连接失败 | 「无法连接网关，请检查网络或实例是否在线。」 |

约束：错误展示必须区分「认证失败（跳登录）」与「传输/上游失败（保留页面、提示重试）」两类；不泄漏内部堆栈与 token。

## 8. 二期（phase 2，本阶段仅规划，不实现）

1. **PWA**：官方前端已有 `manifest.webmanifest`（`display: fullscreen`、name `DeepSeek Harness`）。二期补：Service Worker 静态资源缓存（**只缓存前端静态资源，绝不缓存聊天内容**）、`beforeinstallprompt` 安装提示。
2. **Web Push 审批通知**：浏览器后台也能收到 `approval/requested` 推送。路由：gateway/relay 侧生成 VAPID 订阅，实例侧在 `approval/requested` 时触发推送（APNs/FCM 见 `mobile-app.md` §6 的对称 sketch）。推送只含「有审批待处理」提示，点击深链回会话。**一期无推送**（`plan.md` §6-6）。

## 9. 验收清单

1. tailscale：手机浏览器开 `http://<tailnet-host>:3081/` → 未登录 302 到 `/mobile/auth?next=/`；登录页暗色、输入配对码/切 token 均可用。
2. 配对：`dsh mobile device pair` 出 QR → 手机扫 → 一次性兑换 → cookie 建立 → 302 到 `/` 且官方 UI 可用（会话列表/聊天/SSE 流/审批卡片全通）。
3. 配对码重放：同一配对码第二次使用被拒并跳登录页错误提示。
4. token 登录：桌面第二浏览器用设备 token 登录成功；错 token 提示「无效或已撤销」。
5. 未认证 `/api`：`curl` 不带 cookie/bearer 访问 `/api/...` 得 401 JSON。
6. 撤销：owner `dsh mobile device revoke` 后，被撤销浏览器会话与活跃 SSE/WS 即时断开，刷新跳登录页。
7. relay：手机开 `https://<relay>/instance/<id>/` 完成 1–6 等价流程；`unknown-instance`/`instance-offline`/`request-timeout` 分别映射 §7 文案。
8. 移动视口：§3 全部 11 项在 iOS Safari + Android Chrome（各一真机）逐条通过；320px 宽度无水平滚动；键盘弹出不遮 composer；横竖屏不破版；审批按钮 ≥44px。
9. 登出：`POST /mobile/logout` 清 cookie 并回登录页。
10. 回归：不带 `DSH_MOBILE_INSTANCE` 的普通 `dsh web` 行为零变化；官方 UI 在本仓库无任何 fork/改写。

## 10. 明确的非目标

- **不做任何官方 UI 重设计**（配色、布局、组件一律沿用官方）。
- **不做 opencode-mobile 风格 UI**（参考实现逻辑可借鉴，UI/UX 一律禁止）。
- **不做聊天内容离线缓存**（二期 PWA 只缓存静态资源）。
- **不在浏览器侧新建设备管理页面**（owner 管理走 CLI；如后续需要再单独评审）。
- **一期不做 PWA 安装/Web Push**（见 §8）。
