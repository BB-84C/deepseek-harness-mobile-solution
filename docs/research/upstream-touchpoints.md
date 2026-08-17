# 官方 dsh 依赖面清单（upstream touchpoints）

> 用途：官方 dsh 每次升级后，按本文清单检查我们的插件是否仍兼容。我们刻意把依赖面压到最小——
> **不 fork、不 patch 官方包**，只依赖少数稳定接口；本文档就是这份"最小依赖面"的台账。
> 内部文档，中文。

## 0. 原则

- 我们不修改任何 `@deepseek-ai/*` 包（shipped preset 只读）。
- 依赖只有三类：**composition 行**（profile 里的插件行）、**公开服务**（`ctx.get`）、**HTTP 面**
  （官方 web 的 `/api/*`、静态资源、SSE/WS 路径）。HTTP 面是浏览器契约，官方最不敢乱动；
  服务注入是 dsh 内部契约，升级后最需要复验。
- 验证手段：本仓库测试套件（143+ 用例，全离线）+ `docs/acceptance.md` 的 E2E 清单。

## 1. Composition 依赖（profile 行）

| 行/插件 | 我们做什么 | 官方改动风险 |
| --- | --- | --- |
| `web` profile 的 bundle 行集合 | `dsh --profile web` 直接复用 | 官方增删 web profile 内的行会影响 resident 的能力；升级后跑一次 `dsh --profile mobile service status` + 手机全流程 |
| 行 `directory-picker`（disabled） | 远程浏览器无法弹本机对话框，禁掉 auto 行 | 若官方移除该行/改 id，我们的 patch 会 no-op（无害，但远端换目录功能退化为 browse 行） |
| 行 `directory-picker-browse`（insert） | 钉住浏览器目录选择器供远程用 | 官方移除 `dsh-host-directory-picker-browse` 包则该行失效 → 远端无法换 workspace（session 列表不受影响） |
| `dsh.bundle.patch` 机制本身 | CLI/server 插件靠它挂进 profile | loader patch 语法若有破坏性变更 → 安装脚本需适配 |

## 2. 服务注入依赖（gateway / hydrate 插件）

| 服务 | 用途 | 风险/复验 |
| --- | --- | --- |
| `sessions` | hydrate 判断 live/冷 + session-live 守卫读 live 状态 | 服务名/形状变化 → hydrate 启动告警（有日志） |
| `sessionPersistence` | `list()`/`inspect()` 冷会话枚举与预检 | 方法签名变化 → hydrate 报 `not hydratable`（有日志，可观测） |
| `webServer`（经 dsh-web 内部） | 官方 `/api` 面由 web app 自己提供，我们只反代 | 我们**不注入**它——风险为零 |

> 复验方式：升级官方 dsh 后运行 `npm test`（hydrate/guard 有离线测试）+ 看
> `$DSH_HOME/mobile/logs/service.log` 里的 `[mobile-session-hydrate]` 报告是否 `ok:true`。

## 3. HTTP 面依赖（官方 web 的浏览器契约）

| 面 | 依赖点 | 升级后冒烟 |
| --- | --- | --- |
| `/api/*` RPC（`session.list`、`workspace.list`、`host.describe`、`session.prompt`、`session.history` 等） | 官方前端同款调用，我们只透传 | 手机打开会话列表 + 发消息（全流程） |
| `/api/events.mux` / `/api/events.host` 的 WS 升级 | relay 隧道字节管道 | 会话实时流式输出（肉眼确认 token 逐字出现） |
| `/plugins/events` SSE | 事件流透传 | 同上，顺带确认无控制台报错 |
| 信任围栏（`dsh-client-connection` 的 Host/Origin 校验） | gateway 以环回身份 + 剥离 Origin 呈现 | 围栏逻辑若加强（如新增头校验）→ 手机 `/api` 403 时优先查这里；见 `gateway.js` relay 分支 |
| 官方前端静态资源（`/assets/*`、`/plugins/*/client.js`、boot HTML 注入 polyfill） | 全透传 + HTML 注入 | 手机 UI 能打开即通过 |

## 4. 官方升级后的冒烟清单（10 分钟）

1. `dsh --profile mobile service restart`（或 `relay restart`）—— 确认无启动告警、`service.log` 无 hydrate 失败。
2. 手机/浏览器开 `https://<relay>/` 主菜单 → 进实例 → 会话列表完整。
3. 打开一个会话 → 发消息 → **流式输出实时**。
4. 配对一台新设备（新码）→ 直接进入 UI。
5. 桌面本机 127.0.0.1:3080 打开官方 UI 对比——行为应与手机一致。
6. 跑 `npm test`（本仓库，全离线）。

## 5. 已知官方变更的适配记录

| 日期 | 官方行为 | 我们的适配 |
| --- | --- | --- |
| 2026-08 | fetch 的 `redirect:'manual'` 在 undici 的表现 | 隧道客户端显式 manual，3xx+Set-Cookie 透传 |
| 2026-08 | 信任围栏对 Origin/Host 的比对 | gateway relay 模式改写 Host 为环回 + 剥离 Origin |
| 2026-08 | WS 升级被 relay 404 | relay 增加 wreq/wdata/wend 字节管道 |
| 2026-08 | 官方前端全路径相对化依赖 Host | 根路径改为服务端渲染菜单 + cookie 路由（不再依赖路径前缀） |
