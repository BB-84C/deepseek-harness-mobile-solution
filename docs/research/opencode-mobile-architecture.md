# OpenCode Mobile Solution 架构分析报告

> 分析对象：`reference/opencode-mobile-solution`（`https://github.com/BB-84C/opencode-mobile-solution` 的 checkout）。
> 本报告只做技术/架构分析，不复制其 UI/UX；所有结论均附仓库内相对路径作为证据。

---

## 0. 概览与仓库结构

该仓库是一个「模板 / 起步套件」，让用户能用自己的手机或另一台机器远程控制跑在自己工作站上的 OpenCode 会话。它不是托管服务：用户自备域名、token、凭据。整体拆成三个互相独立、可单独采用的部件（见 `README.md` 第 7–18 行）：

| 部件 | 目录 | 作用 |
|------|------|------|
| **relay** | `relay/` | VPS 上运行的小型 Node 服务，是「前台」：把手机 bearer token 翻译成后端 Basic 认证，做 per-device 目标/目录范围强制，并提供 passkey 保护的管理面板（配对手机、授权机器）。 |
| **app** | `app/` | Expo / React Native 客户端（iOS/Android/Web）。通过扫配对二维码或手动输入 relay URL + 凭据连接。 |
| **clients** | `clients/` | 本地启动器：让工作站的 `opencode` 要么 attach 到「共享的、连到 relay 的后端」，要么完全本地运行。Windows 与 macOS 实现遵循同一生命周期契约。 |

顶层 `README.md` 第 20–32 行的总体数据流图（关键）：

```
 iOS/Android (app)  --bearer-->  TLS 反代 :443 (Caddy/nginx)  -->  relay :4097  --Basic-->  opencode serve :4096
                                                                      │
                                                     tunnel (ssh -R 或 frp)  ← clients/ 包装
```

权威架构说明在 `docs/architecture.md`、`docs/mobile-spec.md`、`relay/README.md` 与 `docs/windows-relay-oauth-spec.md`；历史设计文档在 `docs/design-history/`。

---

## 1. 本地持久进程模型（本地 opencode 进程如何保持运行）

### 1.1 核心模型：**一个持久后端 + 一次性 TUI 客户端**

每台工作站只跑**一个**持久 `opencode serve`，监听 `127.0.0.1:4096`，并受 HTTP Basic 认证保护（`OPENCODE_SERVER_USERNAME` / `OPENCODE_SERVER_PASSWORD`）。本地的交互式 TUI 不是各自起服务，而是 attach 到这个共享后端（`docs/architecture.md` 第 18–23 行；`docs/design-history/opencode-relay-server-design.md` 第 20 行）。

关键决策（`docs/design-history/opencode-relay-server-design.md` 第 30–31 行）：

> 通过一个跨平台的小型 Node helper，用 `child_process.spawn()` + `detached: true` + 直接调用原生可执行文件 + 文件重定向 stdio + `unref()` 来启动持久后端。**不要**用 WMI、Task Scheduler、`cmd.exe`、PowerShell 或操作系统服务管理器作为 daemon 化边界。

也就是说：**没有 systemd/launchd/Windows 服务来守护本地 opencode**。本地后端的「守护」由 `clients/` 里的一套「生命周期控制器」脚本 + 一个**脱离进程的 Node 启动器**完成，服务管理器只用于 VPS 上的 relay（见第 3 节）。

### 1.2 生命周期命令面（launcher contract）

`clients/` 包装器按第一个参数分类（`docs/architecture.md` 第 87–95 行；`clients/windows/README.md` 第 53–68 行）：

```
opencode                              # attach 到共享后端（必要时先启动它）
opencode --dir <path>                 # 带目录 scope 的 attach
opencode --local [args...]            # 逃生舱：完全绕过 relay，纯原生 opencode
opencode --relay_server start|status|restart|stop|doctor|rename
opencode --relay_server restart tunnel
```

Windows 参考实现的文件分工（`clients/windows/README.md` 第 16–30 行）：

- `opencode.cmd`：外层 PATH 分发器（先于真 opencode 解析），只路由 `--relay_server` / `--local` / 交互 attach / 透传。
- `opencode-relay-server.ps1`：生命周期控制器入口（`start/status/restart/stop/doctor/rename` + `restart tunnel`）。
- `opencode-relay-common.psm1`：共享库 —— 配置、健康探测、状态、**命名互斥锁（named mutex）**、监听器/PID 归属、lease、启动/重启机制。
- `opencode-relay-machine.psm1`：机器身份 + 传输（relay origin、SSH alias、FRP client 配置、直连数据面模式）+ 常驻隧道 supervisor 生命周期。
- `opencode-relay-supervisor.ps1`：常驻 watchdog，隧道断线后自动重建（只重建隧道，不碰后端）。
- `opencode-daemon-launcher.mjs`：跨平台「脱离后台进程」启动 helper（见 1.4）。
- `opencode-machine-auth.mjs` / `opencode-machine-agent.mjs`：机器 OAuth 注册客户端 / 心跳 agent。

macOS 用 zsh 脚本实现同一契约（`clients/macos/README.md` 第 74–89 行），文件如 `opencode`、`opencode-relay-server`、`opencode-relay-server-core`、`common.sh`、`opencode-frp-tunnel`、`opencode-machine-auth.mjs`、`opencode-daemon-launcher.mjs`、`opencode-client-launcher.mjs`、`install.sh`。

### 1.3 状态机与进程归属（安全关键）

生命周期聚合状态为 `Ready / Stopped / Degraded / Conflict / Error`（`docs/windows-relay-oauth-spec.md` 第 84–103 行的状态机表格）：

- `start` 是**幂等的 ensure**：已 Ready 则无副作用返回；部分降级时只收敛缺失组件；credential 缺失/被 revoke 才走一次 OAuth 设备授权。
- `restart` 是有意的「替换一代运行时」：优雅退出 attach TUI → 中止仍在跑的 session → 停后端进程树 → 起新一代后端 → 起隧道 → 起心跳 agent；generation 恰好 +1。
- `stop` 是收敛式停止，**保留** machine credential；`restart tunnel` 只重启隧道，不碰后端和 TUI。
- `--local` 是**无条件的逃生舱**：不 import 任何 relay 模块、不做探测、不注入凭据（`clients/windows/README.md` 第 19 行；`docs/windows-relay-oauth-spec.md` 第 165–168 行）。

所有破坏性动作前都重新校验**进程身份 = PID + 创建时间 + 可执行文件路径（+ 父进程/进程组）**；被回收的 PID 视为「外来进程」，永不 kill（`clients/windows/opencode-relay-common.psm1` 第 415–510 行 `Test-ManagedBackendIdentity`；`docs/windows-relay-oauth-spec.md` 第 10 章）。后端就绪要求对 `/global/health` 与 `/config` 的**已认证 HTTP 200**（匿名 401 不算就绪，`clients/macos/README.md` 第 103–104 行）。

### 1.4 daemon 化的实际机制

`opencode-daemon-launcher.mjs`（`clients/windows/opencode-daemon-launcher.mjs`，全文 14 行）是进程原语，不是第二个 supervisor：通过 stdin 收一个 JSON「launch envelope」`{ executable, args, stdoutPath, stderrPath }`，用 `spawn(..., { detached: true, shell: false, windowsHide: true, stdio: ['ignore', out, err] })` 启动，收到 `spawn` 事件后向 stdout 输出一行 `{ pid }` 握手，然后 `unref()` 退出。凭据只通过进程环境传给子进程，绝不进 argv（`docs/windows-relay-oauth-spec.md` 第 10 章）。

后端真实启动命令是 `opencode serve --hostname 127.0.0.1 --port 4096`（`clients/windows/opencode-relay-common.psm1` 第 800 行）。Windows 上控制器会把 `opencode.cmd` 解析成真实 `opencode.exe` 再启动，避免长驻 cmd 外壳。

### 1.5 心跳与隧道 supervisor

- **心跳 agent**（`opencode-machine-agent.mjs`）：每 30 秒（`OPENCODE_MACHINE_HEARTBEAT_MS`）用机器 bearer 调 `POST /api/machine/heartbeat`，上报 `{ lifecycle, localHealth, opencodeVersion, controllerVersion, lastError }`；它先对 `127.0.0.1:4096/global/health` 做 Basic 探测。收到 401 时自标 revoke 并退出；停止时发 `lifecycle=stopped` 的最终心跳（`clients/windows/opencode-machine-agent.mjs` 第 51–97、116–139 行）。
- **隧道 supervisor**（`opencode-relay-supervisor.ps1`）：常驻 watchdog，在共享互斥锁下每 30 秒（下限 10 秒）检查隧道状态，`Degraded/Stopped` 时重新收敛隧道；只用短超时抢锁避免与用户命令打架（`clients/windows/opencode-relay-supervisor.ps1` 第 1–15、82–135 行）。

---

## 2. Tailscale 集成

**结论：本仓库完全没有使用 Tailscale。** 对 `tailscale`、`tsnet`、`MagicDNS`、`Funnel`、`tailnet` 的全仓 grep 返回零命中。参考实现的可达性传输是 **SSH 反向隧道 与 FRP（frp）**，而非 Tailscale。

证据链：

- `README.md` 第 34–38 行与 `docs/architecture.md` 第 25–35 行明确列出两种传输：**SSH reverse tunnel**（`ssh -N -R 4096:localhost:4096 your-vps`，简单但一个后端占一个远程端口）与 **FRP**（SSH 本地转发到 FRP 服务器 + `frpc` 客户端；Windows 推荐路径，支持多命名机器目标、不同远程端口）。
- `clients/windows/README.md` 第 38 行的前置依赖是 PowerShell 7+、Node 22+、OpenSSH client、`frpc`，无任何 Tailscale 客户端。
- `relay/README.md` 第 32–40 行、`docs/design-history/opencode-relay-server-design.md` 第 118–136 行的拓扑图全部是 SSH/FRP。
- `relay/lib/passkey-pairing.mjs` 第 150–161 行向机器签发的传输配置是 `{ type: 'frp-ssh', frpServerHost, frpServerPort, localForwardPort, frpToken }`。
- `relay/opencode-relay.service` 第 23 行读取 `FRPS_CONFIG_PATH=/etc/frp/frps.toml`，即 VPS 上另有 FRP 服务器端 `frps`。

### 2.1 远程设备如何到达本地实例（实际机制）

```
工作站: opencode serve 127.0.0.1:4096
        └─ frpc (本地 localPort=4096) ──►  通过 SSH 本地转发 或 直连 ──►  VPS frps
                                                                        (分配 remotePort 4100–4199 之一)
VPS:    frps 把 remotePort 绑到 127.0.0.1:<port>
        relay :4097 按 target 路由到 127.0.0.1:<port>  →  Basic 认证 →  frp → 工作站 opencode
```

两段式 vs 直连（`clients/windows/opencode-machine-auth.mjs` 第 138–146 行、`clients/windows/README.md` 第 77 行）：

- **legacy 两层**：frpc 通过 `ssh -L 17000:127.0.0.1:7000` 到 frps（frps 仅监听回环）。
- **直连数据面**：当 relay 签发公网 `frpsHost`（`FRP_SERVER_PUBLIC_HOST`）或本机设了 `OPENCODE_FRP_DIRECT_HOST`，frpc 直接拨 frps:7000，跳过 SSH 本地转发层。

对 dsh 的意义：Tailscale 是**本参考实现缺失、而 dsh 方案要新增**的传输选项（见第 8 节）。

---

## 3. relay 组件

### 3.1 它是什么、跑在哪

`relay/relay.mjs`（344 行）是一个**零业务依赖（仅 Node 22+ 内置模块）的 HTTP 反向代理 + 认证网关**，`relay/package.json` 中仅两个依赖：`@simplewebauthn/server`（WebAuthn/passkey）与 `qrcode`（生成配对二维码）。它**只监听 `127.0.0.1:4097`**（`relay.mjs` 第 316 行），TLS 完全交给外层反代（Caddy/nginx，见 `relay/reverse-proxy/`）。

四个职责（`docs/architecture.md` 第 36–52 行）：

1. **Token 翻译**：手机 `Authorization: Bearer <device-token>` → 校验 → 改写为对选定后端的 `Authorization: Basic <user:pass>`（`relay/lib/proxy.mjs` 第 15–19 行）。
2. **多目标路由**：一个客户端可被授权多个后端；请求用 `X-OpenCode-Target` 选机器；`GET /relay/targets` 只返回 targetID + 显示名，绝不返回地址/凭据（`relay.mjs` 第 266–276 行）。
3. **目录 scope**：`directory` query 参数与 `X-OpenCode-Directory` 头都要按客户端 pin/allowlist 校验，冲突或不允许就 403（`relay.mjs` 第 280–298 行；`relay/lib/auth.mjs` 第 19–30 行）。
4. **配对与机器授权**：passkey 保护的管理面板（WebAuthn），签发一次性配对 QR，批准机器注册。

### 3.2 协议

- 面向手机/客户端：普通 **HTTP(S) REST + SSE**。流式识别规则在 `relay/lib/proxy.mjs` 第 5–11 行：path 为 `/event` 或 `/global/event` 或 `Accept: text/event-stream` 时视为流式（不设超时、逐帧透传）；普通请求 300s 超时，上游不可达回 502、超时回 504。
- 面向机器：**OAuth 2.0 device authorization** 风格的 JSON REST（见 3.5）。
- 面向 owner：**WebAuthn passkey** + 同源 HttpOnly session cookie（见第 4 节）。

### 3.3 多个本地 opencode 进程如何注册到一个 relay（fan-in）

核心机制是「**每台机器在 relay 主机回环上独占一个端口**」+「**target 注册表**」：

1. 每台机器本地都是 `127.0.0.1:4096`，但通过 frp 把该端口映射到 VPS frps 分配的**唯一 remotePort**（动态池 `MACHINE_REMOTE_PORT_MIN=4100` .. `MAX=4199`，`relay.mjs` 第 60–61 行；`relay/lib/passkey-pairing.mjs` 第 130–148 行的端口分配/冲突检测）。
2. relay 维护一个**target 注册表** `targetRegistry()`（`relay.mjs` 第 114–128 行）：静态 target（来自 `tokens.json` v2 的 `targets`）+ 机器 target（来自 `passkeys.json` 的 machines，host 固定 `127.0.0.1`、port 为分配的 remotePort、basicUser/basicPass 来自机器注册时上报的本地 Basic 凭据）。
3. 机器注册后，relay 删掉同名静态 target、把机器 target 注入注册表（`relay.mjs` 第 117–125 行 `managedTargetIDs` / `machineTargets`）。

因此「一个 relay 汇聚多个本地 opencode」不是靠 relay 主动连出去，而是靠**每台机器的 frpc 反向接入**；relay 只是按 targetID 把请求代理到对应回环端口。

### 3.4 客户端如何在多机器间选择 + fan-in 复用

- 客户端先调 `GET /relay/targets`（Bearer），拿到该 device 被授权（`targetIDs` allowlist）的 targetID + 显示名列表（`relay.mjs` 第 266–276 行；`app/src/opencode/client.ts` 第 241–243 行）。
- 后续每个请求带 `X-OpenCode-Target: <targetID>`，relay 用 `resolveScope()` 校验 `requestedTargetID ∈ client.targetIDs`，不合法回 `target_forbidden`（`relay/lib/auth.mjs` 第 19–30 行；`relay.mjs` 第 277–303 行）。
- app 侧把「机器选择」落到**复合身份** `(connectionID, targetID, sessionID)` 上，跨机器枚举会话、每个 session 打上 `relayTargetID` 标签，后续操作都回送同一 target（`app/src/opencode/client.ts` 第 256–282、662–665 行；`docs/mobile-spec.md` 第 13.1/14.1 节）。
- 因为每个 target 是独立回环端口，多机器天然并行复用，relay 本身是无状态透传（无会话状态、无事件日志、无序列/游标，`docs/mobile-spec.md` 第 13.1 节）。

### 3.5 本地进程 ↔ relay 之间的认证（machine auth）

机器不是拿静态 token，而是走 OAuth 设备授权（`docs/architecture.md` 第 68–83 行；`relay/lib/passkey-pairing.mjs` 第 913–945、947–985 行；`clients/windows/opencode-machine-auth.mjs`）：

| 端点 | 认证 | 作用 |
|------|------|------|
| `POST /api/oauth/device/code` | 限流 | 开始授权，返回 `device_code` / `user_code`(8 位) / `verification_uri_complete` / `expires_in`(10 分钟) / `interval`(5s) |
| `POST /api/oauth/token` | 一次性 device_code | 轮询，批准后**一次性**返回机器 bearer + FRP transport 配置 |
| `GET /api/machine/me` | 机器 bearer | 校验持久凭据 |
| `DELETE /api/machine/me` | 机器 bearer | 自撤销 |
| `POST /api/machine/heartbeat` | 机器 bearer | 上报本地健康 |

流程：`opencode --relay_server start` → `POST /device/code`（携带 installationID、hostname、platform、clientVersion、本地 Basic 用户名/密码、requestedTargetID/Port）→ 打开浏览器 `verification_uri_complete` → owner 用 passkey 登录批准 → CLI 轮询 `/api/oauth/token` → 原子落盘 `machine.json`（mode 600）+ `frpc.toml`（`clients/windows/opencode-machine-auth.mjs` 第 166–230、126–164 行）。relay 只存 bearer 的 SHA-256 哈希（`relay/lib/pairing-store.mjs` 第 505–543 行）。

### 3.6 机器状态判定

relay 用**机器自己的心跳 + VPS 侧独立探测**两条线索判态：`online / degraded / offline / stopped / revoked`（`relay.mjs` 第 130–192 行 `probeTarget`/`machineStatuses`）。探测是对 target 的 `/global/health` 做 Basic 请求，4s 超时，**连续两次失败**才从 online 翻 degraded（避免数据面瞬时抖动），恢复 online 立即生效（`relay/README.md` 第 213–214 行）。

---

## 4. 设备/客户端认证（第三方设备如何认证到本地 opencode 实例）

分两种身份，两种凭据，统一原则是「**relay 只存哈希、原文只回一次、可即时撤销**」。

### 4.1 owner（WebAuthn passkey + 同源会话）

- 首次注册：`RELAY_PUBLIC_ORIGIN` 的 `/#setup=<bootstrap-secret>` 链接，secret 只存在于 URL fragment（浏览器导航/Referer 不发送 fragment），页面仅把 secret 提交给同源 relay；**第一个 passkey 落盘后 bootstrap secret 即失效**（`relay/README.md` 第 168–179 行；`relay/lib/pairing-store.mjs` 第 239–243 行 `canBootstrap`）。
- 会话：passkey 验证成功后发 `oc_relay_session` cookie：`HttpOnly; SameSite=Strict; Max-Age=43200(12h); Secure(仅 https)`（`relay/lib/passkey-pairing.mjs` 第 11、729–731 行）。会话 token 只存哈希（`pairing-store.mjs` 第 319–336 行）。
- 所有管理面板变更既要求该 HttpOnly 会话，又要求**精确同源 `Origin` 头**（`requireSameOrigin`，`passkey-pairing.mjs` 第 725–727 行）。

### 4.2 手机/设备（一次性配对 QR → 可撤销 Bearer）

1. owner 在 Dashboard 点 **Connect phone** → `POST /api/pairing/create` 生成一个随机 32 字节 code，**只存 relay 内存**，2 分钟过期、单次使用（`relay/lib/pairing-store.mjs` 第 6、338–347 行；`passkey-pairing.mjs` 第 840–855 行）。
2. QR 内容是 HTTPS 落地页 `/pair/mobile#code=...`（code 在 fragment 里，`passkey-pairing.mjs` 第 846 行）；落地页 250ms 后跳 `opencode://pair?origin=...&code=...` 深链（`passkey-pairing.mjs` 第 679–694 行）。
3. app 调 `POST /api/pairing/exchange { code, deviceName }`（无 Authorization 头）换回一次性 Bearer token + clientID；relay 落盘 **SHA-256(token)**，token 原文只回这一次（`relay/lib/pairing-store.mjs` 第 349–382 行 `exchangePairingCode`；`app/src/opencode/pairing.ts` 第 32–82 行）。
4. app 把 token 存进设备安全存储（`expo-secure-store`：iOS Keychain / Android EncryptedSharedPreferences），连接元数据存 AsyncStorage（`app/src/store/connection-storage.ts` 第 85–111 行）。
5. 该凭据**无时间过期**、跨 relay/app 重启存活，直到 owner 撤销；撤销会删凭据并**立即关闭该设备的活跃流**（`relay.mjs` 第 80–102 行 `closeRevokedStreams`/`closeStreamsForClient`；`relay/README.md` 第 28 行）。

### 4.3 凭据的签发 / 存储 / 撤销汇总

| 身份 | 签发 | 客户端存哪 | relay 存哪 | 撤销 |
|------|------|-----------|-----------|------|
| owner passkey | WebAuthn 注册 | 认证器（resident key, UV required） | `passkeys.json` 公钥 | —（不可撤销单身份，可换） |
| 机器 | OAuth device flow | `~/.config/opencode-relay/machine.json` (600) | `passkeys.json` 中 tokenHash | Dashboard revoke / `DELETE /api/machine/me` |
| 手机 | 配对 QR exchange | iOS Keychain（expo-secure-store） | `passkeys.json` 中 tokenHash | Dashboard revoke（立即关流） |
| 静态设备（v1） | 手工 `tokens.json` | app 手动输入 | `tokens.json` 明文（legacy） | 编辑 tokens.json（60s 热加载） |

目录 scope 继承：新手机继承 `PAIRING_SOURCE_CLIENT_ID` 所指定源 client 的 target/directory 授权，配对不会授予比源更宽的权限（`relay/lib/passkey-pairing.mjs` 第 88–101 行 `sourceScope`）。

---

## 5. 客户端结构（app/ 与 clients/）

### 5.1 `app/` —— Expo / React Native 移动端（web 亦是构建目标）

技术栈（`app/package.json`）：Expo 57 / React Native 0.86 / React 19 / **expo-router**（文件路由）/ **zustand**（状态）/ `expo-secure-store`（密钥）/ AsyncStorage（缓存）/ `expo-camera`（扫 QR）/ `expo-linking`（深链）/ `react-native-sse` 依赖存在但实际用的是**自写 fetch + SSE 解析**（`app/src/opencode/sse.ts`）。`app/app.json` 定义了 `scheme: "opencode"`、iOS bundleIdentifier、expo 插件（expo-router、expo-splash-screen、expo-secure-store、expo-camera、`./plugins/withOpenCodeAppIntents`）。

`docs/mobile-spec.md` 第 22–24 行明确：实际栈是 **Expo 57 / RN 0.86 / Expo Router / Zustand**，用 RN `StyleSheet`、`expo-secure-store`、AsyncStorage、fetch 版 SSE；NativeWind/Tamagui/MMKV/EventSource 都**不是**当前实现依赖（早期 spec 里的选择已被推翻）。

分层：

- `app/app/` 是 Expo Router 路由：`_layout.tsx`（根 Stack，注册 `(tabs)`、`session/[sessionKey]`、`pair`、`modal`）、`(tabs)/index.tsx` 与 `two.tsx`（主机/会话两页）、`pair.tsx`（配对结果页）、`session/[sessionKey].tsx`（会话详情）、`diff-preview.tsx`、`question-preview.tsx`、`subagent-preview.tsx`、`+native-intent.tsx`（App Intents）。
- `app/src/opencode/` 是数据面：`client.ts`（`OpenCodeClient`：全部 REST + SSE + 重试 + auth 头 + `X-OpenCode-Target`/`X-OpenCode-Directory`）、`pairing.ts`/`pairing-qr.ts`（配对解析/交换）、`sse.ts`（字节安全 SSE 解析器）、`types.ts`（类型）、`execution-contract.ts`（agent/model/variant 选择契约）、`model-ref.ts`。
- `app/src/store/` 是持久化与状态：`connection-storage.ts`（连接 + 密钥分层存储）、`mobile-store.ts`（Zustand 主 store）、`opencode-store.ts`、`session-cache-storage.ts`、`persistence-coordinator.ts`、`prompt-preferences-storage.ts`。
- `app/src/ux/` 是交互逻辑（会话列表/森林/时间线/模型选择/权限/question/中断/滚动/导出等），`app/src/ui/` 是主题（`opencode-theme.ts` 加载 `assets/opencode-themes/*.json`），`app/src/components/opencode/` 是渲染组件（MessageCard、VirtualizedTranscript、ActionModal、MarkdownText、ModelPickerModal 等）。

### 5.2 移动端 vs 本地 web UI 的架构差异（非视觉）

移动端被明确定位为**监督/控制面板，而非开发环境**（`docs/mobile-spec.md` 第 30 行 "supervision surface, not a development machine"）：

- **只控制已有会话，不新建/fork/删除**：`docs/mobile-spec.md` 第 14 节第 802–803 行、`app/src/opencode/client.ts` 注释 "session lifecycle management remains on the machine running OpenCode"。早期 spec 里的「新建会话」验收项被明确推翻（第 14 节）。
- **server-authoritative refetch 重连**：重连后重新拉 session 列表与打开 session 的消息页，整体替换（不 merge），再重订阅 `/event`；**没有事件重放游标**（`docs/mobile-spec.md` 第 13.5/14.4 节）。这与 `docs/design-history/opencode-relay-server-design.md` 里设计的 `/relay/v1/sync/*`「精确增量同步」协议不同——后者是**后续实现轮次**的 relay 增强，本仓库当前 relay 仍是无状态透明代理（见 `relay/lib/` 无 sync-broker），移动端按第 13 节的「refetch」契约工作。
- **复合身份** `(connectionID, targetID, sessionID)` 贯穿缓存键、路由、REST、SSE（`docs/mobile-spec.md` 第 14.1 节）；多机器会话合并显示、按更新时间排序。
- **机器执行契约（execution contract）**：打开会话时拉取该 target 的 agent/model 契约（`GET /config/providers`、`GET /agent`、`GET /command`），只有 `fresh` 状态才允许发请求，`stale` 只渲染不发（`docs/mobile-spec.md` 第 14.3 节；`app/src/opencode/execution-contract.ts`）。
- 密钥分层存储（`app/src/store/connection-storage.ts`）：token/password 走 `SecureStore`，非敏感的连接元数据走 AsyncStorage；web 平台回退到 localStorage/cookie。

### 5.3 `clients/` —— 本地启动器（Windows 参考 + macOS 自包含）

见第 1 节。要点：Windows 是「参考实现」，macOS 是「自包含实现」（含 `install.sh`，会下载并校验固定版本 FRP v0.69.1 的 SHA-256，`clients/macos/README.md` 第 50–59 行）。两者遵循同一命令与退出码契约。

退出码契约（`docs/windows-relay-oauth-spec.md` 第 9 章）：`0` Ready/达成、`3` 只读 status 报 Stopped、`6` 归属冲突/需要干预/revoked/denied、`7` 降级/超时/网络不可达、`10` 参数或契约错误。JSON 模式只在 stdout 输出一个紧凑对象且**无密钥**（`clients/windows/opencode-relay-server.ps1` 第 53–118 行）。

---

## 6. 安全模型

### 6.1 TLS 与监听边界

- relay **只绑 `127.0.0.1`**，从不直接暴露公网（`relay.mjs` 第 316 行）；TLS 由反代终止（`relay/reverse-proxy/Caddyfile.example`、`opencode-relay.nginx.conf` 均含 `flush_interval -1` / `proxy_buffering off` 以确保 SSE/流式不缓冲）。
- app 在 release 构建强制 HTTPS，仅 localhost/127.0.0.1 例外（`app/src/opencode/client.ts` 第 697–703 行 `assertTransportAllowed`）；配对要求 HTTPS origin（`app/src/opencode/pairing.ts` 第 28 行）。
- 机器→relay 的 OAuth/心跳全部走 HTTPS（`relayOrigin`）。

### 6.2 秘密存储

- **relay 侧**：只存 SHA-256 哈希（设备/机器 bearer、web session、配对 code 均哈希），原文只回一次（`relay/lib/pairing-store.mjs` 第 35–37 行 `hashToken`、319–382 行）；`tokens.json`/`passkeys.json`/`machine.json`/`frpc.toml`/`*.env` 是 git-ignored 的活秘密（顶层 `README.md` 第 57–61 行）。
- **机器侧**：`machine.json`、`frpc.toml`、`env` 都是 mode 600（Windows 上用 icacls 施加 user-only ACL），原子写（临时文件 + rename）（`clients/windows/opencode-machine-auth.mjs` 第 22–39 行）。
- **手机侧**：`expo-secure-store`（Keychain / EncryptedSharedPreferences）（`app/src/store/connection-storage.ts` 第 85–111 行）。
- systemd 单元安全硬化：`NoNewPrivileges`、`ProtectSystem=strict`、`ProtectHome`、`ReadWritePaths=/etc/opencode-relay`、`UMask=0077`、`MemoryMax=128M`、`RestrictAddressFamilies`（`relay/opencode-relay.service` 第 35–44 行）。

### 6.3 信任边界

```
手机 app ──bearer──▶ 反代(TLS) ──▶ relay ──Basic──▶ frp/SSH 隧道 ──▶ 本地 opencode serve
  │                                │                                        │
  keychain 存 bearer              只存 token 哈希 + target 注册表          Basic 密码只在本机 + relay target 注册表
```

- **手机 ↔ relay**：Bearer 认证；relay 是唯一知道「设备 bearer → 后端 Basic」映射的一方，**手机永远拿不到后端 Basic 密码**（`README.md` 第 38 行）。
- **relay ↔ 本地 opencode**：Basic 认证；relay 校验设备 token 后重写 Basic 头（`relay/lib/proxy.mjs` 第 15–19 行），并**剥掉**客户端原 Authorization、`X-OpenCode-Directory`、Host 头。
- **机器 ↔ relay**：机器 bearer（哈希存 relay）；机器本地 Basic 密码在 OAuth 注册时经 TLS 上报，relay 用它构造 target（`relay/lib/pairing-store.mjs` 第 511–532 行）。
- **反代**：唯一直接暴露公网的组件，是 TLS 与主机名的信任锚。
- 授权头不落日志（`relay.mjs`/`docs/architecture.md` 第 104 行）；relay 的 CORS 只对 `Authorization/Content-Type/X-OpenCode-*` 开放、`Access-Control-Allow-Origin: *`（无状态 bearer，`relay.mjs` 第 232–240 行）。
- 常量化比较：`crypto.timingSafeEqual`（`relay/lib/auth.mjs` 第 4–9 行）。

### 6.4 风险点（作者自述 + 代码可见）

- v1 静态 `tokens.json` 存的是**明文** token + 后端 Basic 密码（legacy 兼容，`relay/lib/config.mjs` 第 84–117 行 `migrateV1`；`tokens.example.json`）。
- CORS `*` 配合无状态 Bearer 意味着任意网页都能携带 token 调 relay（标准 risk；token 本身是密钥）。
- 手机侧的 `X-OpenCode-Target`/directory 由客户端声明，relay 只做 allowlist 校验，不做签名（但 token 本身已绑定 scope）。
- 隧道数据面（frp 的 SSH 本地转发段 / SSH `-R` 段）在 VPS 回环内，frps 不被直接暴露（`docs/windows-relay-oauth-spec.md` 第 297 行）。

---

## 7. 部署 / 运维 / 环境变量 / 新用户 onboarding

### 7.1 relay 部署

`relay/deploy/deploy-relay.sh` 通过 SSH 把 relay 源码打成 tar 推到 VPS，装依赖、写 `relay.env`、装 systemd 单元并 `enable/restart`，最后 curl `/health` 验证（第 100–110 行）。首次部署会在 VPS 上**远程生成、且不打印** `PASSKEY_BOOTSTRAP_TOKEN`（第 86–89 行）。`relay/opencode-relay.service` 是 systemd 单元（`Type=simple`、`Restart=always`、`RestartSec=5`、`EnvironmentFile=/etc/opencode-relay/relay.env`）。

### 7.2 环境变量（`relay/README.md` 第 232–249 行）

| 变量 | 默认 | 含义 |
|------|------|------|
| `RELAY_PORT` | 4097 | relay 监听端口 |
| `OC_HOST`/`OC_PORT` | 127.0.0.1 / 4096 | 上游（单 target 时代） |
| `TOKENS_PATH` | /etc/opencode-relay/tokens.json | 静态 token 配置 |
| `TOKEN_RELOAD_SEC` | 60 | 热加载间隔 |
| `RELAY_PUBLIC_ORIGIN` | http://localhost:4097 | WebAuthn 与配对链接的精确 HTTPS origin |
| `PASSKEY_STATE_PATH` | 同目录 passkeys.json | passkey/设备/机器状态 |
| `PASSKEY_BOOTSTRAP_TOKEN` | 无 | 首次注册 secret，首个 passkey 后失效 |
| `PAIRING_SOURCE_CLIENT_ID` | 首个 client | 新手机继承 scope 的源 client |
| `FRPS_CONFIG_PATH` | /etc/frp/frps.toml | 读取 frps token |
| `FRP_SERVER_PUBLIC_HOST` | 无 | 非空则签发直连 frps host |
| `MACHINE_REMOTE_PORT_MIN/MAX` | 4100/4199 | 机器动态端口池 |

客户端侧（`clients/windows/README.md` 第 70–81 行）：`OPENCODE_REAL_CMD`、`OPENCODE_RELAY_ORIGIN`、`OPENCODE_RELAY_SSH_ALIAS`、`OPENCODE_FRP_DIRECT_HOST`、`OPENCODE_SERVER_PORT`、`OPENCODE_FRPC_EXE`、`OPENCODE_RELAY_SUPERVISOR_INTERVAL_MS`、`OPENCODE_CONTROLLER_SCRIPT` 等。

### 7.3 新用户完整 onboarding 流

1. **部署 relay**：`RELAY_SSH_ALIAS=your-vps ./deploy/deploy-relay.sh`（可选首次 token seed 用 `DEPLOY_RELAY_TOKENS=1` + `OPENCODE_SERVER_PASSWORD`/`RELAY_DEVICE_TOKEN`）。
2. **反代**：配 Caddy/nginx 把 `opencode.example.com` 指到 `127.0.0.1:4097`。
3. **注册 owner passkey**：在 `relay.env` 写 `RELAY_PUBLIC_ORIGIN` + `PASSKEY_BOOTSTRAP_TOKEN`，浏览器打开 `https://…/#setup=<secret>` 建 passkey。
4. **装本地启动器**：Windows 把 `clients/windows/*` 拷到 `%USERPROFILE%\.config\opencode\bin\` 并置于 PATH 前、`setx OPENCODE_REAL_CMD` 与 relay origin/ssh alias；macOS 跑 `install.sh install --relay-origin … --ssh-alias …`。
5. **授权机器**：`opencode --relay_server start` → 浏览器批准 → 机器拿 bearer + frp 配置 → 起后端 + 隧道 + 心跳。
6. **配对手机**：Dashboard 点 Connect phone → 手机扫 QR → 深链 `opencode://pair` → 换 bearer → 存 Keychain → 开始用。
7. **日常管理**：`status/doctor` 看健康、Dashboard revoke 设备/机器、`--local` 逃生。

---

## 8. 对 deepseek-harness mobile solution 的设计启示

### 8.1 可直接迁移的模式（与后端无关）

1. **relay = 无状态「bearer→Basic」翻译代理 + target/directory scope 强制**（`relay/relay.mjs` + `lib/auth.mjs` + `lib/proxy.mjs`）。这是最可复用的核心：它只假设后端是「Basic 认证的 HTTP + SSE」，对 dsh 只要把 OpenCode 的 REST/SSE 面换成 dsh 暴露的移动 HTTP/SSE 面即可。**单进程、零业务依赖、只绑回环、TLS 交给反代**这套边界直接照搬。
2. **机器 OAuth 设备授权 + 只存哈希**（`lib/pairing-store.mjs`）与**手机一次性 QR 配对 + Keychain bearer + 即时撤销关流**（`lib/passkey-pairing.mjs` + `app/src/opencode/pairing.ts` + `connection-storage.ts`）。这套「签发一次、哈希落盘、可撤销」凭据模型与 dsh 完全无关，可直接复用。
3. **owner passkey（WebAuthn）Dashboard + 同源会话 + bootstrap secret 一次性**（`lib/passkey-pairing.mjs` 的 register/auth/status 路由）。dsh 版直接换 rpName/rpID。
4. **launcher 契约**：`一个持久后端 + 一次性 attach + --local 逃生舱 + --relay_server 生命周期控制器`，以及**进程身份 = PID + 创建时间 + 可执行文件**的 ownership-safe 停止/重启（`clients/windows/opencode-relay-common.psm1`）。对 dsh 同样需要「后台 dsh 服务 + 前台 attach + 逃生舱」的本地包装。
5. **客户端**：Expo/RN + expo-router + zustand + expo-secure-store + 自写 fetch-SSE，**server-authoritative refetch 重连**（无事件重放游标）、复合身份 `(connection, target, session)`、执行契约 `fresh/stale` 门控（`app/src/opencode/client.ts`、`execution-contract.ts`）。这些与「驱动哪个 agent」无关。
6. **隧道模式可插拔**：参考实现把「SSH 反向隧道 / FRP 两层 / FRP 直连」做成可切换选项（`OPENCODE_FRP_DIRECT_HOST` / `FRP_SERVER_PUBLIC_HOST`）。dsh 把 **Tailscale** 加为第一传输选项时，应沿用同样的「传输可插拔、与后端/TUI 生命周期解耦」边界。

### 8.2 opencode 特有、必须替换的部分

1. **后端 API 面**：`/session`、`/session/:id/message`、`/event`、`/question`、`/permissions`、`/global/health`、`/config`、`/agent`、`/command`、`/project`、`/sync/*` 全是 OpenCode 专属（`app/src/opencode/client.ts`、`docs/mobile-spec.md` 第 4/13 节）。dsh 必须通过 dsh plugin 暴露等价的移动 HTTP + SSE 面（对应 dsh 的 agent preset/session/tool 事件），或适配 dsh web 已有的 API。
2. **`opencode serve` + `attach` + Basic 认证**：dsh 没有 OpenCode 的 serve/attach/Basic 概念，需自建「持久 dsh 服务 + attach/TUI + 认证」或复用 dsh web 进程。
3. **OpenCode 原生 sync history**（`/sync/history`、`relay/v1/sync` broker 设计，`docs/design-history/opencode-relay-server-design.md` 第 6 节）是 opencode 专属的持久事件语义。dsh 若无等价 durable-event 源，就沿用更简单的 **refetch 重连**模型；若有，再考虑增量同步。
4. **launcher 包装目标**：参考实现包装的是 `opencode` 二进制与其 `OPENCODE_SERVER_USERNAME/PASSWORD`；dsh 要包装的是 `dsh` 命令（AGENTS.md 约束：`dsh mobile [options]` 统一入口，走 wrapper 脚本或 profile alias）。
5. **execution contract 的 agent/model/variant 语义**：OpenCode 的 `mode!==subagent && !hidden`、`providerID/modelID/variant`（`execution-contract.ts`）要映射为 dsh 的 agent preset / 模型 / provider 概念。

### 8.3 dsh 版会面临的风险 / 未知项

1. **Tailscale 点对点 vs VPS relay 两套传输的认证模型不一致**：Tailscale 直连本地 dsh 时，MagicDNS + tailnet 本身提供了网络级信任，认证可能简化为「本机 Basic/bearer + tailnet 白名单」；而 relay 模式需要 bearer→Basic 翻译。两套要共用同一 app 连接模型，需提前定「连接 = origin + 传输类型 + 认证」的抽象。
2. **dsh 现有 web/API 面的形态未知**：参考实现严重依赖 OpenCode 稳定的 REST/SSE 契约；dsh 能否以「HTTP Basic + SSE」对外暴露同等能力（会话列表/消息/事件/权限/question/tool 输出），是最大不确定点，可能要先做一个 dsh 移动 API plugin。
3. **Windows/macOS/Linux 三平台进程监督**：参考实现 Windows 用 PowerShell 命名互斥锁 + Win32_Process 身份，macOS 用 zsh + Darwin 进程身份。dsh 按 AGENTS.md 要 `.ps1` + `.sh` 各一份覆盖 macOS/Linux，进程身份取证（PID+创建时间+可执行）在三 OS 上做法不同，是工程量与坑点所在。
4. **`dsh mobile` 命令路由**：dsh 官方 launcher 只认识 `--profile/--patch/web/plugin`，`dsh mobile` 如何路由（wrapper vs profile alias）尚未定，且 wrapper 必须能解析到「真实 dsh 二进制」而非递归回自己（参考实现的 `OPENCODE_REAL_CMD` 递归防护）。
5. **安全边界放大**：参考实现里 relay 是唯一持有「设备 bearer→后端 Basic」映射与多机器 target 注册表的信任中枢；dsh 若 Tailscale 直连则省掉 relay，但「多 dsh 实例 fan-in 到单 relay」仍需 relay 的 target 注册表 + 端口/主机路由，且要重新评估 frp vs Tailscale 下「机器动态端口池」是否仍必要。
6. **凭据与密钥的发布安全**：参考实现明确 `tokens.json`/`passkeys.json`/`machine.json`/`frpc.toml`/`*.env` 是活秘密且 git-ignored；dsh 是私有但需 publish-ready 的仓库，插件/脚本里绝不能硬编码任何 relay 地址或凭据（参考实现连 app 都不内置 relay 地址，`app/README.md` 第 20–23 行）。

---

## 附：关键文件索引

- 架构总览：`README.md`、`docs/architecture.md`
- relay 服务：`relay/relay.mjs`、`relay/lib/{auth,config,proxy,pairing-store,passkey-pairing,directory-path}.mjs`、`relay/opencode-relay.service`、`relay/deploy/deploy-relay.sh`、`relay/reverse-proxy/*`
- 本地启动器（Windows 参考）：`clients/windows/opencode.cmd`、`opencode-relay-common.psm1`、`opencode-relay-machine.psm1`、`opencode-relay-server.ps1`、`opencode-relay-supervisor.ps1`、`opencode-machine-auth.mjs`、`opencode-machine-agent.mjs`、`opencode-daemon-launcher.mjs`
- 本地启动器（macOS）：`clients/macos/{opencode,opencode-relay-server,opencode-relay-server-core,common.sh,opencode-frp-tunnel,opencode-machine-auth.mjs,opencode-daemon-launcher.mjs,install.sh,env.example}`
- 移动端：`app/app.json`、`app/package.json`、`app/app/_layout.tsx`、`app/app/pair.tsx`、`app/app/session/[sessionKey].tsx`、`app/src/opencode/{client,sse,pairing,pairing-qr,types,execution-contract}.ts`、`app/src/store/{connection-storage,mobile-store,opencode-store,session-cache-storage,persistence-coordinator}.ts`
- 规范/设计：`docs/mobile-spec.md`、`docs/windows-relay-oauth-spec.md`、`docs/mobile-tui-ux-spec.md`、`docs/design-history/opencode-relay-server-design.md`
