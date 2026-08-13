# deepseek-harness-mobile-solution — 项目规划

> 本文档是项目的唯一权威规划：架构、决策、里程碑与进度追踪。任何重大变更先改这里。
> 状态更新规则：每完成一个里程碑/重要阶段，更新「当前进度」并 commit。
> 内部文档用中文；面向用户文档（README、deployment 指南）用英文。

## 1. 目标

让本地常驻的 DeepSeek Harness（dsh）进程可从第三方设备（手机/平板/其他电脑）远程控制，
远程界面 = 官方 dsh Web UI/UX（含移动端适配）与 Android/iOS 原生 app（app 由其他 agent 按
`docs/specs/` 实现，本仓库只出 spec）。

两种传输：

1. **Tailscale 点对点**：单机 dsh + 手机同 tailnet，WireGuard 加密直连。
2. **VPS relay fan-in**：多台设备的多个 dsh 实例注册到用户自己的 VPS relay，客户端按实例目录选择。

约束（用户给定）：

- 所有 dsh 侧改造 = **dsh 插件**（npm 包，`dsh.bundle.patch`），不 fork、不改官方包、不改官方 preset。
- 统一入口 `dsh mobile [options] [args]`。
- 三平台：Windows / macOS / Linux；必须上脚本的只写 `.ps1` + `.sh`（.sh 通用于 macOS/Linux），
  Windows 另附 `.cmd` 转发壳。
- 参考 opencode-mobile-solution 的**连接与管理逻辑**，禁止抄其 UI/UX。
- 仓库私有（BB-84C），保持可公开状态（README/LICENSE/docs 按公开口径写）。

## 2. DSH 源码调研结论（关键事实，决定架构）

调研对象：本机安装的 `@deepseek-ai/dsh` 0.1.0-rc.6
（`C:\Users\Administrator\AppData\Roaming\npm\node_modules\@deepseek-ai\dsh`）。

1. **启动器**（`lib/bin.js`）：`dsh` 只认识 `--profile` / `--patch` / `web` 子命令 / `plugin` 子命令；
   其余参数原样透传给 profile 的 app 树，由挂载的插件用 `@deepseek-ai/dsh-cmdline` 的
   `parseCmdline(ctx, program)` 自行解析（`cmdlineArgs` 服务 + `appExit`）。
   → **结论**：裸 `dsh mobile ...` 会被启动器拒绝（`--profile <name> is required`），
   必须用 PATH 前置的 wrapper 拦截 `mobile` 并改写为 `dsh --profile mobile ...`。
2. **插件机制**（`lib/plugin-*.js` + `dsh-app-boot`）：`dsh plugin --profile <name> add <pkg>`
   在 profile 目录跑 pnpm，然后把声明了 `dsh.bundle.patch` 的依赖自动追加进
   `package.json` 的 `dsh.profile.bundles` 层栈。bundle patch 是 loader patch 条目列表
   （同 `cordis.patch.yml` 方言，支持 `!!js` 表达式、insert、按 id 覆盖、disabled）。
   → **结论**：插件 = npm 包 + `dsh.bundle.patch` 字段；安装/升级完全走官方 `dsh plugin`。
3. **profile 模板**（`dsh-app-boot/lib/index.js`）：内置模板只有 `web`（base+web-app）与
   `headless`；未知名字走 `DEFAULT_PROFILE_BUNDLES = [dsh-base]`，缺失时启动报
   “create it with `dsh plugin --profile <name> add <package>`”。
   → **结论**：新建 `mobile` profile（CLI 控制面）= base + 我们的 CLI bundle。
4. **Web 服务**（`dsh-web-app/cordis.patch.yml` + `lib/startup.js` + `dsh-host-webserver`）：
   - `webserver` row：`host: ctx.webStartup.host ?? '127.0.0.1'`，`port: ?? 3080`；
     schema 只允许 `127.0.0.1` 或 `0.0.0.0`。
   - **官方明确拒绝 `--host 0.0.0.0`**（startup.js 报 “would expose remote code execution
     to the network”）。→ 官方 web 必须保持 loopback。
   - `--trusted-host <authority...>`：/api 浏览器信任围栏接受额外 host/host:port；
     `webRuntime.trustedHosts` = 绑定地址 LAN 字面量（仅 0.0.0.0 时）+ extras，
     最终进 `connection` 客户端 row 的 `trustedHosts`。
   → **结论**：dsh web 保持 `127.0.0.1:3080`；移动暴露由我们的 **mobile gateway**
   （插件内自建 node:http 反代 + 设备认证）承担；启动 web 时用 `--trusted-host` 把
   tailscale/relay 对外 authority 喂进信任围栏。这是整案唯一不触碰官方行为的方案。
5. **Web 无认证**：官方 webserver 是裸 HTTP，无任何认证层（因为它只允许 loopback）。
   → gateway 的认证是我们必须补齐的核心。
6. **沙箱提示**：本机 dsh 进程内插件不受 agent 工具沙箱限制；但本 agent 的 pwsh 工具
   受沙箱约束（曾挡住 tailscale 命名管道、git 管道、gh 网络），测试时需要按需升级重试。

opencode-mobile-solution 调研结论见 `docs/research/opencode-mobile-architecture.md`，要点：

- 三件套：relay（VPS，只监听 127.0.0.1）/ 移动 app（Expo RN）/ 本地 launcher。
- 它实际没用 Tailscale：SSH 反向隧道 + FRP，直连/双层可切换；我们反过来 —— Tailscale 是第一选项。
- 本地进程守护：`spawn(detached:true)` + PID/创建时间/可执行文件 三重身份校验；一次性 attach。
- relay fan-in：每实例独占回环端口反接，`X-OpenCode-Target` 路由，目录只暴露 targetID+显示名。
- 认证：实例 OAuth 设备授权（user_code 轮询）；手机一次性 QR 配对→Bearer（Keychain）；
  relay 只存 SHA-256 哈希、可即时撤销；owner 用 WebAuthn passkey + bootstrap secret。
- 移动端定位：只监督/控制已有会话，不新建/删除。

## 3. 架构总览

```
                        ┌──────────────────────────── 用户设备（第三方） ───────────────────────────┐
                        │  浏览器（官方 dsh Web UI/UX）          Android/iOS app（按 specs/ 实现）      │
                        └───────────────┬──────────────────────────────────┬─────────────────────────┘
                                        │                                  │
              Tailscale 点对点（WireGuard）                        VPS relay fan-in（HTTPS）
                                        │                                  │
                                        ▼                                  ▼
                        ┌─ tailscale tailnet ─────────────┐   ┌─ https://relay.example.com ──┐
                        │  100.101.132.89:3081            │   │  owner dashboard / instance  │
                        └───────────────┬─────────────────┘   │  directory / ws mux         │
                                        │                      └───────────────┬──────────────┘
                                        │                                      │ 实例隧道（出站 wss，
                                        │                                      │ 实例 token 认证）
                                        ▼                                      ▼
                        ┌────────────────── dsh mobile gateway ──────────────────┐
                        │ 设备认证（cookie/bearer）· 会话 · 撤销 · 健康检查          │
                        │ 反代 → 127.0.0.1:3080（SSE/WebSocket 透传）               │
                        └──────────────────────────────┬──────────────────────────┘
                                                       ▼
                                   官方 dsh web（127.0.0.1:3080，--trusted-host 已配置）
```

组件与归属：

| 组件 | 形态 | 安装位置 |
| --- | --- | --- |
| `@bb-84c/dsh-mobile-cli` | dsh 插件（bundle patch） | `dsh plugin --profile mobile add ...` |
| `@bb-84c/dsh-mobile-server` | dsh 插件（bundle patch） | `dsh plugin --profile web add ...`（常驻实例内） |
| `@bb-84c/dsh-relay` | 独立 Node 服务（VPS） | pnpm 全局/目录安装；systemd unit 模板 |
| wrapper（`dsh` 前置壳） | `.ps1` / `.sh` / `.cmd` | `~/.dsh/mobile/bin` + PATH 前置（installer 做） |
| scripts | `.ps1` / `.sh` | 仓库 `scripts/`，installer 复制使用 |

### 3.1 `dsh mobile` CLI（mobile profile = dsh-base + dsh-mobile-cli）

命令族（超集于用户要求的 a/b/c，补充项标注 ★）：

```
dsh mobile install                      一键安装 wrapper + 两个插件 ★
dsh mobile uninstall                    完整卸载（不碰非 mobile 实例）★
dsh mobile status                       总览：service/tailscale/relay/device 四块状态 ★
dsh mobile service start|stop|restart|status|logs    (a) 本地常驻服务上线与重启
dsh mobile tailscale status|ip|connect|ping         (b) tailscale 连接与状态
dsh mobile relay connect|disconnect|status|ping     (c) VPS relay 连接与状态
dsh mobile device pair|list|revoke                  设备配对与管理（1.4 认证核心）
dsh mobile url                           打印手机访问 URL/二维码 ★
dsh mobile config get|set|show            配置（模式/端口/relay 地址/主机名）★
dsh mobile doctor                        诊断：版本、端口冲突、连通性 ★
dsh mobile update                        升级两个插件（转发 dsh plugin update）★
```

实现要点：

- bundle patch 加一个 cmdline 行：注入 `cmdlineArgs`，`args[0]==="mobile"` 时剥掉前缀，
  用 commander 解析剩余参数，action 内执行命令并 `ctx.appExit(code)`；非 mobile 参数时完全惰性
  （避免与 web profile 的 `web-startup` 抢解析——防御性，正常情况两个插件装在不同 profile）。
- 命令实现全部走 `$DSH_HOME/mobile/`（配置 config.json、pid、日志、设备哈希库），
  永不写 profile 或官方目录。

### 3.2 mobile gateway / 常驻服务（web profile + dsh-mobile-server）

- 官方 web 保持 `127.0.0.1:3080`。`service start` 由 CLI 以 detached 方式 spawn：
  `dsh --profile web --trusted-host <authorities> [--port 3080]`，env 打
  `DSH_MOBILE_INSTANCE=1`；pidfile 记录 PID+进程创建时间+启动令牌。
  stop/restart 只杀通过三重校验的进程（防误伤非 mobile 实例——用户明确要求）。
- gateway 插件行（web profile 内）：
  - 自建 `node:http` 服务：tailscale 模式绑 tailnet IP（或 0.0.0.0+防火墙/ACL 兜底）:3081；
    relay 模式只绑 127.0.0.1:3081，由隧道客户端出站连接 relay。
  - 认证：配对码一次性兑换 → 长期设备 token（SHA-256 哈希存 `$DSH_HOME/mobile/devices.json`，
    可撤销并踢活会话）；浏览器发 HttpOnly cookie，app 用 Bearer。
  - 反代 127.0.0.1:3080：HTTP + SSE + WebSocket upgrade 全透传；未认证一律 302 到认证页/401。
  - 自有端点：`/mobile/health`、`/mobile/auth`、`/mobile/pair`、`/mobile/devices`（owner）。
- relay 隧道客户端（同插件）：出站 wss 到 relay，实例 token 认证，注册
  {instanceId, displayName, machine}，常驻重连；把 relay 转发来的 HTTP 请求本地转发给 gateway。
- `--trusted-host` 参数由 `service start` 按当前模式计算（tailscale IP/hostname 或 relay 域名），
  使官方客户端信任围栏接受手机浏览器 origin——不改官方任何 row。

### 3.3 relay（独立 Node 服务，VPS）

- 无外部服务依赖：node:http + ws（自实现或轻量依赖），反向多路复用：
  实例出站 wss 注册 → 客户端请求 `/instance/<id>/...` → relay 经对应 wss 通道转发 →
  实例侧本地回环网关。无需给实例开公网端口。
- 数据面：目录 `/relay/targets`（仅 instanceId+displayName）、健康检查、按实例限速。
- 认证：实例 token（用户手动下发，哈希存储）；客户端设备 token 同款哈希+撤销；
  owner dashboard 支持 bootstrap secret + 可选 passkey（opencode 经验）。
- 部署：`scripts/relay-deploy.sh`（Caddy+Let's Encrypt 或 tailscale 可选）、systemd unit 模板、
  `docs/deployment/relay.md`。监听 127.0.0.1，TLS 交给 Caddy。

### 3.4 wrapper 与 installer

- wrapper 拦截 `dsh mobile ...` → exec 真 dsh `--profile mobile mobile ...`（其余参数原样透传，
  含 `dsh web`、`dsh --profile tui` 等）。真 dsh 路径在安装时记录。
- `.ps1`（Windows PowerShell）/ `.sh`（macOS/Linux bash/zsh 通用）/ `.cmd`（cmd.exe 转 .ps1）。
- installer（`scripts/install-mobile.ps1` / `.sh`）：装 wrapper 到 `~/.dsh/mobile/bin`、
  修改用户 PATH、执行 `dsh plugin --profile mobile add @bb-84c/dsh-mobile-cli` 与
  `dsh plugin --profile web add @bb-84c/dsh-mobile-server`。
- 已知取舍：官方启动器不可扩展（插件不能加顶层子命令），wrapper 是唯一合规入口方式，
  文档中如实说明。

### 3.5 设备认证与 1.4 的两种界面

- 两种界面 = 同一 gateway 后面的两个客户端：
  1. **官方 dsh web**：手机浏览器直接开 `http(s)://<tailnet-host>:3081` 或
     `https://relay.example.com/instance/<id>/`，UI/UX 与本地完全一致（官方前端原样服务）。
  2. **原生 app**：spec（`docs/specs/mobile-app.md`）定义配对、Bearer、会话监督/控制、
     重连、Keychain 与通知要求；实现交给其他 agent（本机无 iOS 开发环境，且由用户指定）。
- 认证协议（两界面统一）：一次性配对码（`dsh mobile device pair` 输出 URL+QR）→ 兑换
  长期设备 token；服务端只存哈希；`dsh mobile device revoke` 即时生效并断开活跃连接。

## 4. 里程碑与当前进度

| # | 里程碑 | 内容 | 状态 |
| --- | --- | --- | --- |
| M0 | 基础 context + 规划 | 调研 dsh 源码与 opencode-mobile；git 仓库脚手架；本 plan | ✅ 进行中（本 commit 收尾） |
| M1 | dsh-mobile-cli 插件 | `dsh mobile` 命令族骨架 + service 管理 + config/status/url/doctor | ⬜ |
| M2 | dsh-mobile-server 插件 | gateway 反代 + 设备认证 + tailscale 绑定 + 常驻服务联调 | ⬜ |
| M3 | relay + 隧道 | dsh-relay 服务 + 实例隧道客户端 + 目录/多路复用 | ⬜ |
| M4 | 设备配对与安全加固 | 配对码兑换、哈希存储、撤销踢会话、限速、文档化威胁模型 | ⬜ |
| M5 | 部署与文档 | tailscale/VPS relay 部署脚本与教程、插件安装说明、三平台自启模板 | ⬜ |
| M6 | 移动 UI/UX specs | mobile-web / mobile-app（Android+iOS）specs（交其他 agent） | ⬜ |
| M7 | 端到端验收 | 本机 tailscale P2P 实测 + relay 模拟实测；README 完善；发布前检查 | ⬜ |

当前进度：M0 收尾（本机 git 仓库已 init、安全目录例外已配、README/LICENSE/AGENTS/plan 就绪，
待与用户确认 §6 决策后进入 M1）。

## 5. 仓库布局

```
deepseek-harness-mobile-solution/
├── README.md                  # 公开口径（英文）
├── LICENSE                    # MIT
├── AGENTS.md                  # gitignored，agent 内部约定
├── packages/
│   ├── dsh-mobile-cli/        # dsh 插件：mobile profile 的 CLI 控制面
│   ├── dsh-mobile-server/     # dsh 插件：gateway + 认证 + tailscale/relay 传输
│   └── dsh-relay/             # 独立 Node 服务：VPS relay
├── scripts/
│   ├── install-mobile.ps1/.sh # wrapper + 插件一键安装
│   ├── relay-deploy.ps1/.sh   # VPS relay 部署
│   └── *.service / *.plist / .xml   # 三平台自启模板
├── docs/
│   ├── plan.md                # 本文档（唯一权威规划）
│   ├── research/              # 调研报告（opencode-mobile 架构分析）
│   ├── plugin-install.md      # 插件安装/升级/卸载说明（用户文档）
│   ├── deployment/            # tailscale.md / relay.md / service.md
│   └── specs/                 # mobile-web.md / mobile-app.md（交其他 agent）
└── reference/                 # gitignored：opencode-mobile-solution clone
```

## 6. 待确认决策（讨论后回填结论）

1. `dsh mobile` 入口：wrapper 前置 PATH（推荐）vs 仅文档化 `dsh --profile mobile`。
2. 设备认证模型：opencode 式全量（设备 token + passkey owner）vs 精简（token 配对 + 可撤销）。
3. 常驻服务形态：detached spawn（推荐）+ 可选登录自启模板 vs 强制系统服务化。
4. relay 传输：出站 WebSocket 多路复用（推荐）vs FRP 兼容 vs 双模。
5. TLS：tailscale 模式先 HTTP-over-tailnet（WireGuard 已加密）还是上 `tailscale serve` HTTPS；
   relay 模式是否默认 Caddy 方案。
6. 移动 web 通知：第一阶段是否需要 PWA+Web Push 审批推送。

## 7. 风险与注意

- **官方 dsh 升级破坏兼容**：依赖 rc.6 的插件机制与启动器行为；doctor 检查版本；CI 无（私有仓库）。
- **Windows PATH 劫持**：wrapper 前置 PATH 可能与 npm 全局 dsh 冲突；installer 幂等并写清文档。
- **网关即新增攻击面**：认证先于一切路由、限速、审计日志；安全模型文档化（docs/deployment 内含 threat model 节）。
- **误杀非 mobile 实例**：pidfile + 创建时间 + 启动令牌三重校验（用户红线要求）。
- **沙箱限制**：本 agent 测试 tailscale/gh/git 网络类命令可能被沙箱挡，按需升级重试。
