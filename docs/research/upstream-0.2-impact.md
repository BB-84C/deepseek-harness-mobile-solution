# 上游 dsh 0.2.x 升级影响评估（0.1.0-rc.6 → 0.2.1-rc.2）

> 内部文档（中文）。评估日期：2026-10-25。
> 目的：回答一个问题——上游 dsh 已从我们测试基线 `0.1.0-rc.6`（2026-08-13）推进到
> `0.2.1-rc.2`（2026-10-17，npm `latest`；`0.2.1-rc.3` 在 `next`），移动方案还能不能跑，
> 哪些地方必须改。
>
> 方法：静态比对（installed 0.1.0-rc.6 vs 最新 tarball 的 `lib` / `d.ts` / bundle patch）+
> **实测**（在隔离 `$DSH_HOME` 里用 `0.2.1-rc.2` 全新安装跑我们的两个 profile）。
> 未改动本机常驻实例（3080/3081 全程未被占用）。

## 0. 结论（TL;DR）

| 级别 | 项 | 状态 |
| --- | --- | --- |
| 🔴 P0 | **浏览器启动令牌认证**（`GET /` 需 `?token=` 换 30 天签名 cookie，否则 401） | 0.1.2-rc.1 起新增；**手机进不去官方 UI**，必须改 gateway |
| 🔴 P0 | `--trusted-host` 变成**严格校验**（非规范 authority 直接 plugin load 失败） | relay URL 带路径前缀时，我们会喂进带路径的 `base` → **常驻实例起不来**（本机当前无路径，属潜伏 bug） |
| 🟠 P1 | 官方 HTML 响应改为 **gzip** → 我们的 `crypto.randomUUID` polyfill 注入静默失效 | tailscale 明文 HTTP 下手机可能白屏/功能报错 |
| 🟡 P2 | installer 只播种 `@deepseek-ai/dsh-base`，新机器上 `web` profile **没有 `dsh-web-app`** | 本仓库既有缺口，被 0.2 的模板机制放大；实测复现 |
| 🟡 P2 | 新增**插件版本兼容闸门**（`engines.dsh` / dsh peers + `compatibility.json` + `dsh plugin allow-version`） | 我们未声明任何约束 → **不会被拒**（实测通过），但要台账化 |
| 🟡 P2 | 官方 Web UI 新增 **Plugins 页 / 插件市场 / Config Editor**（Typert Remote） | 手机可装插件、改配置、重组合树 → 新副作用与攻击面 |
| 🟢 P3 | `dsh-host-apiproxy` 停更（0.1.1-rc.2 后不再发布），web API 改为 `dsh-api-*` controllers over **Typert Remote** | 我们的 `session-hydrate` 注释里的前提（apiproxy 合并冷会话）需复验；`sessions` / `sessionPersistence` 服务形状未变，实测 hydrate 正常 |

**一句话**：CLI 侧（`dsh --profile mobile`）和插件卸载/组合机制**没坏**（实测全通）；
坏的是**「官方 web 不再裸奔，浏览器必须先拿令牌」**这一条 —— gateway 是唯一需要重写的部件。

## 0.1 M8 修复结果（2026-10-25）

| 项 | 改动 | 证据 |
| --- | --- | --- |
| P0 令牌握手 | gateway：导航请求被上游 401 时 302 到本网关同源的 `/?token=<launchToken>`；token 由 `ctx.get('connection').authenticatedUrl()` 逐次惰性获取（**不能**在 `inject` 里声明：本 cordis 把 `inject` 当字符串数组，对象形式会导致插件永远 pending、整个 web profile 启动失败） | 模拟手机 E2E 打真 0.2.1-rc.2：`7/7` 通过（配对 → 401 → token → 303+`dsh-auth-*` cookie → 200 UI → `/api` Origin 匹配不再 403） |
| P0 `--trusted-host` | `computeAuthorities()` 只产出裸 `host[:port]`（`canonicalAuthority()`，IPv6 补括号、去 scheme/path/userinfo） | 单测 8 例（`url.test.js`）；relay 模式不再喂出带路径的 base |
| P1 HTML gzip | 导航类请求（`GET` + `accept: text/html`）不透传 `accept-encoding` → 上游返回 identity HTML，polyfill 注入恢复；静态资源仍压缩 | E2E 断言 200 页面含 `crypto.randomUUID`（37.6 KB 未压缩） |
| P2 installer | `web` profile 按官方模板播种 `[dsh-base, dsh-web-app]`，并对**已有** profile 补齐缺失的 shipped bundle | 隔离 home 全新安装后 web profile 三 bundle 就位，`dsh --profile web` 正常起 |
| P2 doctor | 打印 dsh 版本 + 是否在「已实测清单」内 + 当前处于令牌闸门的哪一侧 | `checkDshVersion` 单测；`doctor` 直接给出 `0.1.0-rc.6 (verified) — no browser token` 之类结论 |
| P2 设备清理 | 新增 `pruneDevices()`：删撤销/无有效哈希/**同名旧记录**/30 天未见的设备；`status`、`device list`、网关启动、devices API 自动执行；新增 `device prune [--days n]` | 单测 3 例 + gateway 启动清理用例；`status` 只列活跃设备并提示清理数 |
| P2 弹窗（Windows） | 常驻实例以 `node --require no-console-window.cjs` 启动，进程内所有 spawn 默认 `windowsHide: true`（CREATE_NO_WINDOW） | 探针验证：ESM 具名导入能看到补丁、`windowsHide:true` 抵达 native、显式 `false` 不被覆盖；**需重启常驻实例生效** |
| P3 hydrate 前提 | 0.2.x 的 `dsh-api-session-controller` 已把 persisted 会话（cold）并入列表（`list()` 里 live + `summaryCold` 合并），SSE 页面不再依赖 apiproxy | 源码核对（`lib/index.js` list 投影）；我们的 hydrate 保留为**只读诊断**（逐会话 `inspect` + 报错原因），ATTACH 仍默认关闭 |

回归面：`npm test` 154/154 通过；同一份新代码在**本机安装的 0.1.0-rc.6** 上照样启动正常
（web profile 起、gateway 监听、hydrate 报告正常）——即升级前后都能跑。

## 0.2 目录选择器事故与修复（2026-10-25，用户升级到 0.2.1-rc.2 后发现）

现象：停掉 mobile、直接跑本地 `dsh web`，**无法新建 workspace**（选择目录的对话框根本不出现）。

根因（我们自己的插件，两个错误叠加）：
1. `dsh-mobile-server` 的 bundle patch 把 shipped `directory-picker`（auto）行**无条件**禁掉并插入
   `-browse` 行。该 patch 属于 `web` profile 的 bundle 层，**本地 `dsh web` 同样会应用**，
   于是本地也失去原生选择器。
2. 0.2.x 把选择器的**浏览器对话框**拆成独立包 `dsh-client-ui-directory-picker-browse`
   （通过 `dsh.client` 声明进入客户端模块表），host 行
   `dsh-host-directory-picker-browse` 只剩文件系统原语 —— 我们只 compose 了 host 行，
   于是有 RPC、没有 UI，等于完全没有对话框。

修复：
- mobile 的三个行改为 `disabled: !!js "process.env.DSH_MOBILE_INSTANCE !== '1'"` 门控；
  auto 行改为 `disabled: !!js "process.env.DSH_MOBILE_INSTANCE === '1'"` → 本地运行恢复出厂行为。
- 新增 `directory-picker-browse-ui` 行，门控在 `DSH_MOBILE_PICKER_UI === '1'`；
  `service start` 用 `hasPickerUi()`（在安装目录里探测该包）决定是否设置这个 env。
- 实测（隔离 home + 真 0.2.1-rc.2，读服务端渲染的 boot HTML）：本地运行
  `nativeUi=true browseUi=false`；mobile 运行 `nativeUi=false browseUi=true`。

## 1. 验证环境

| 项 | 值 |
| --- | --- |
| 本机安装版 | `@deepseek-ai/dsh` **0.1.0-rc.6**（2026-08-13） |
| 上游 latest | **0.2.1-rc.2**（2026-10-17）；`next` = 0.2.1-rc.3（2026-10-23） |
| 跨过的发布 | ≥ 30 个（0.1.0-rc.7/8、0.1.1-rc.1/2、0.1.2…、0.1.3、0.1.5、0.1.6、0.1.7、0.2.0-rc.1/2、0.2.1-alpha.1-5、0.2.1-rc.1/2） |
| 实测方式 | `npm i @deepseek-ai/dsh@0.2.1-rc.2` 到 %TEMP% 独立前缀（611 包）；`DSH_HOME=%TEMP%\mobile-upstream-test\home` 全新 home；`node scripts/install-mobile.mjs` 装两个 profile |
| 依赖注入数 | 官方 0.1x → 0.2x 依赖从 `^0.1.0-rc.6` 浮动改为 **精确锁版本**（`0.2.1-rc.2`），新增 `@deepseek-ai/cordis`、`dsh-hmr`、`dsh-plugin-manager`、`dsh-package-manifest`、`dsh-home-paths`、`dsh-launch-environment`、`dsh-api-*` 等 ~20 个包 |

提示：官方发布的 `@deepseek-ai/dsh` 已**不再随包发 `config/` 目录**（preset/模板迁到各 bundle 包），
所以“抄官方 preset”这条老路彻底关闭——与我们“只做插件”的约束一致，无需调整。

## 2. 🔴 P0-A：浏览器启动令牌认证（唯一真正打穿移动链路的变更）

### 事实

- `0.1.2-rc.1`（2026-09-03）起，`@deepseek-ai/dsh-client-connection` 新增 `BrowserAuth`
  （`browser-auth.d.ts`）：**每个进程 mint 一个随机 launch token**，`dsh-web-app` 把它打进打印
  的 URL：
  ```
  dsh web: http://127.0.0.1:3099/?token=O4Av2naUbooXeOSZlQb-6l8KyMF6p3IZpA1mi0Udw7s
  ```
- `GET /`（index）**无有效令牌/有效 cookie → 401**（静态资源仍公开）。实测：
  ```
  GET /                      -> 401
  GET /?token=<launchToken>  -> 303  Location: ./
                               Set-Cookie: dsh-auth-3BwAN0Jz…=v1.eyJ2ZXJzaW9uIjoxLCJhdXRob3JpdHkiOiIxMjcuMC4wLjE6MzA5OSIs…;
                                           Max-Age=2592000; Path=/; HttpOnly; SameSite=Strict
  GET / (带该 cookie)         -> 200 (37 KB HTML)
  ```
- cookie 是**authority 绑定**的：名字与签名载荷都含 `host:port`（上面是 `127.0.0.1:3099`）；
  签名密钥持久化在 `$DSH_HOME/.credentials.yaml`（`client-connection/browser-session` 记录），
  所以重启进程后旧 cookie 仍有效，但把上游 authority 变来变去就会失效。
- `/api` 与 WS 升级：**必须有已认证的 browser 或 API Peer**；围栏仍先于认证判断，
  `Host` 必须是 loopback / 监听 bind IP / `trustedHosts`，`Origin` 必须与 `Host` 同 authority，
  `sec-fetch-site: cross-site` 直接拒。实测：
  ```
  GET /api  + cookie + Origin: http://127.0.0.1:3099   -> 404（过围栏，路由不存在）
  GET /api  + cookie + Origin: https://woody:3081      -> 403（Origin/Host 不匹配）
  ```
- 版本界限（实测 `npm pack` 逐版本查 `browser-auth.d.ts`）：

  | client-connection | 令牌认证 |
  | --- | --- |
  | 0.1.0-rc.6 / rc.7 / rc.8 | 无 |
  | 0.1.1-rc.1 / rc.2 | 无 |
  | **0.1.2-rc.1 及以后（含 0.2.x）** | **有** |

  即：**只要用户把 dsh 升到 0.1.2-rc.1 之后的任何版本，令牌闸门就生效**，不只是 0.2.x。

### 对移动链路的具体后果

| 路径 | 现状（0.1.0-rc.6） | 0.1.2+（含 0.2.1） |
| --- | --- | --- |
| 手机打开 `http(s)://<tailnet>:3081/` | 302 → `/mobile/auth` → 配对 → 官方 UI | 配对后跳到 `/`，gateway 透传上游 **401** → **白屏/错误页** |
| 会话列表 / 发消息（`/api`） | 透传即可 | 缺 cookie → 401；补了 token 但 Origin/Host 处理不对 → 403 |
| WS 实时流 | 透传即可 | 同上，需先拿到 browser cookie |
| 静态资源 `/assets/*` | 透传 | 仍公开，不受影响 |

### 修复设计（建议）

gateway 插件同进程，能直接拿到 launch token，不需要读日志解析：

1. `dsh-mobile-server/startup.js` 的 `inject` 增加**可选** `connection`（0.1.0.x 没有
   `authenticatedUrl`，做特性探测，缺失时保持现状 → 向后兼容）。
2. gateway 启动时（或首次用到时）调
   `ctx.connection.authenticatedUrl('http://127.0.0.1:<webPort>/')` 取 `?token=`，缓存；
   token 失效（上游回到 401）时重新取。
3. 代理到上游的「导航类请求」（`GET`，`accept` 含 `text/html`，且路径是 `/`）若返回 **401**，
   不要原样返回，而是 302 手机浏览器到 **本网关同源**的 `/?token=<launchToken>`
   （保留原有 query）：上游随后 303 + `Set-Cookie` 由我们透传，手机即持有 cookie，
   之后所有请求/WS 都带着它过闸门。gateway 自己的设备认证仍然是唯一对用户可见的认证。
4. `Set-Cookie` 透传时**不要重写域名/路径**；cookie 名依赖上游看到的 authority，
   所以 **Host 改写策略必须全程一致**（见 P0-B）。
5. relay 模式已把 `Host` 钉成 `127.0.0.1:<webPort>` 并剥离 `Origin`，与 cookie 的 authority
   绑定天然一致；tailscale 模式保留原 Host/Origin + `--trusted-host`，也一致。
6. 幂等：令牌是**每进程**的，`service restart` 后失效；但手机端 cookie 用
   `$DSH_HOME/.credentials.yaml` 的持久密钥签名，**不需要重新走 token**——所以正常重启对手机透明。

## 3. 🔴 P0-B：`--trusted-host` 严格校验（relay 模式会启动失败）

- 0.2.x `client-connection` 新增 `assertTrustedAuthority`：`trustedHosts` 项必须是**裸
  `host[:port]` 规范形式**（能被 WHATWG 解析后原样不变）。带 scheme、带路径、
  `user@host`、带尾斜杠、零填充端口等**直接抛错并导致 plugin load 失败**（不是忽略）。
- 我们的 `packages/dsh-mobile-cli/src/commands.js:94 computeAuthorities()` 在 relay 模式返回
  `unique([base, base.split("/")[0]])`，其中 `base` 保留了 relay URL 的路径前缀
  （如 `relay.example.com/dsh/abc`）。**只要 relay URL 带路径前缀**，这个非规范项在 0.2.x 上
  就会**让常驻 web 起不来**（本机当前用 `https://dsh.bb84.ai`（无路径）不会触发，属潜伏 bug）。
  另外 relay 模式其实根本不需要 trusted-host（我们已钉 loopback + 剥 Origin）。
- 修复：authority 只保留 `host[:port]`（去 scheme、去路径、去尾斜杠）；
  relay 模式其实根本不需要 trusted-host（我们已钉 loopback + 剥 Origin），可以只传规范值或干脆不传。
- tailscale 模式当前只给 `ip` / `ip:port` / `host` / `host:port`，均为规范值 → 不受影响。

## 4. 🟠 P1：官方 HTML 变 gzip，polyfill 注入静默失效

- 0.2.x `web-app` 的 `webserver` 行新增
  `compression: gzip, compressionLevel: 1, compressionThresholdBytes: 1024`（0.1.0-rc.6 没有压缩）。
  实测 `GET /`（带 cookie，`Accept-Encoding: gzip`）：
  ```
  status=200  content-encoding=gzip  content-type=text/html
  ```
- 我们的 `gateway.js:813` 逻辑是 `isHtml && !isEncoded` 才注入
  `SECURE_CONTEXT_POLYFILL`（`crypto.randomUUID` 在非安全上下文不可用的补丁）→ 现在**全局跳过**。
- 影响：tailscale 明文 HTTP 模式下手机浏览器缺 `crypto.randomUUID`，官方前端 RPC id / 目录选择器
  会报错（这正是当初写 polyfill 的原因）。relay 模式是 HTTPS（Caddy/CF）也不受影响，
  但 `tailscale serve` 之外的明文场景会退化。
- 修复（择一）：
  - 对「导航类请求」不透传 `accept-encoding`（上游返回 identity → 注入生效，静态资源仍压缩）；
  - 或在 gateway 内解压/重压缩 HTML（成本高，不建议）。

## 5. 🟡 P2：installer 在全新机器上造不出可用的 `web` profile

- 官方 0.2.x 的 shipped 模板：`web = [dsh-base, dsh-web-app]`、`headless`、`acp`、`sdk`、
  `sdk-minimal`（`PROFILE_TEMPLATES`，**没有 `mobile`**，与我们不撞名 ✅）；
  首次 `dsh web`/`dsh plugin --profile web …` 会按模板初始化 profile。
- 我们的 `scripts/install-mobile.mjs` 自己 `initProfile(dir, name)`，bundles 固定写
  `["@deepseek-ai/dsh-base"]` + 我们的包 → **在干净机器上 `web` profile 里没有 `dsh-web-app`**。
  实测：这样起 `dsh --profile web` 会挂住（没有 app 行解析 `--help`、也不 bind），
  `service start` 起来等于空转。
- 修复：installer 初始化 `web` profile 时用官方模板（`@deepseek-ai/dsh-app-boot` 的
  `PROFILE_TEMPLATES.web.bundles`，或直接让 `dsh plugin --profile web install` 触发官方 init），
  `mobile` profile 保持 `[dsh-base] + cli`。本机之所以没暴露，是因为 `web` profile 早就存在了。

## 6. 🟡 P2：插件版本兼容闸门（新机制，我们不触发但需台账）

- 0.2.x `dsh-app-boot` 引入 `evaluatePluginCompatibility`：
  - 声明了 `engines.dsh` → **只**看它；否则逐个校验 `@deepseek-ai/dsh` / `@deepseek-ai/dsh-*`
    的 **peerDependencies**（prerelease 参与匹配；`workspace:*` 等视为当前 runtime）；
    两者都没声明 → **无约束**（不拦）。
  - 不兼容的 **bundle** 会被 `skippedBundles` 跳过；不兼容的 **row** 被置 `disabled`；
    豁免写进 profile 的 `compatibility.json`，命令是
    `dsh plugin --profile <p> allow-version <pkg@ver> --dsh-version <exact> --accept-risk`。
- 我们三个包的 `package.json` **只有 `dependencies`（`@deepseek-ai/dsh-cmdline` 等），
  既无 `engines.dsh` 也无 dsh peers** → 判定为「无约束」→ **实测未被拒**
  （`dsh --profile mobile --help` / `doctor` / `config show` 全部正常；web 侧 gateway 正常挂载）。
- 待决策：是否**主动声明** `engines.dsh`。优点：档位清晰、用户升级 dsh 时会被明确告知；
  缺点：以后每次上游升级都要同步 bump，否则会被 skip/deny（宁可 deny 也不要静默跑错）。
  建议：**等 P0 修完并实测通过某个具体版本后，再声明 `engines.dsh: "0.2.1-rc.2"`（精确值）**，
  并在 `doctor` 里把「当前 dsh 版本 / 已实测版本」打出来。
- 另外 `dsh plugin` 现在会**加 profile 写锁**（12 万 ms）并在兼容性拒绝时回滚 manifest+lockfile，
  我们 `update` 命令转发的 `dsh plugin --profile <p> update` 语义不变 ✅。

## 7. 🟡 P2：官方 Web UI 新增「插件市场 / Plugins 页 / Config Editor」

- 0.2.x 把插件管理做进了 web UI（`@deepseek-ai/dsh-plugin-manager` 的 Typert Remote 两半，
  外加 `dsh-api-settings-controller`、`dsh-cordis-client-runner`、`recomposeProfile`，
  以及 `dsh-experimental-plugin-market-bundle`）：**手机现在可以装/卸/启用插件、改配置、
  重组合 Loader 树**。
- 对我们的含义：
  1. 能力上是加分（用户可以在手机上开关功能），但**手机端从此有了「改宿主」的入口**，
     gateway 的设备认证就从“看 UI”升级为“能改机器”——威胁模型文档要补一节。
  2. 插件管理会写 profile 的 `package.json` / `compatibility.json` / `cordis.patch.yml`
     （官方 `saveManifest` 号称保留无关字段、原子写、持锁），但我们的 profile 是
     **手写 + junction link** 的，需实测「在手机上装一个插件后，我们的 bundle 是否还在」。
  3. `build-approval` / git 源插件安装审批等新流程在手机上会不会卡住，需实测。
- 结论：P2 观察项 + 一条验收用例（手机 → Plugins 页 → 装/卸任一官方插件 → `dsh --profile mobile status` 仍正常）。

## 8. 🟢 已确认**不受影响**的面（实测/静态双确认）

| 面 | 证据 |
| --- | --- |
| `dsh --profile mobile <cmd>` 入口 | 0.2.1 实测 `--help` / `doctor` / `config show` 全通；`parseCmdline`+`cmdlineArgs`+`appExit` 契约未变（仅新增可选 `appReady`、`exitOnStdinEnd`） |
| `dsh.bundle.patch` 机制 | `DshBundleManifest.patch: string \| string[]` 语义不变；我们两个 bundle 的 patch 都被正常应用 |
| 我们的 patch 行（`directory-picker` disable + `-browse` insert） | 0.2.1 上 web 正常 boot，未触发 `installFailLoud` / `auditStartupEntries` 报错 |
| profile 命名 | `PROFILE_TEMPLATES` 只有 acp/web/headless/sdk/sdk-minimal → **`mobile` 不被占用** |
| `sessions` / `sessionPersistence` 服务 | 实测 hydrate 插件启动：`sessions=true, persistence=true`，冷会话枚举 `{"found":0,…}` 正常（空 home）；`SessionStore.get/enter/announce/list` 形状未变 |
| web 默认绑定/端口 | `webserver` 行仍是 `host: 127.0.0.1`、`port: 3080`；`--port`/`--host`（单一字面量，拒绝通配）/`--no-open`/`--public-url`/`--tls-cert|key` |
| HTTP 透传 / SSE / WS 升级 | gateway 是字节级反代，官方 `/api` 走 WebSocket upgrade 的模式未变 |
| 信任围栏本身（Host/Origin） | 0.1.0-rc.6 就已存在并被我们适配；0.2.x 只是变严格（新增 token 层、authority 校验） |

## 9. 待办（按优先级，建议一个 PR 一条）

1. **[P0]** gateway 支持 launch token 握手（§2 修复设计 1–6），含离线单测：
   mock 上游返回 401 → 断言 302 到 `/?token=`；带 cookie 后 200 透传。
2. **[P0]** `computeAuthorities()` 规范化为裸 `host[:port]`，relay 模式不再传带路径的 base。
3. **[P1]** 导航类请求不透传 `accept-encoding`，恢复 polyfill 注入（或按场景判断）。
4. **[P2]** installer：`web` profile 用官方模板 bundles 初始化；`mobile` 保持 base+cli。
5. **[P2]** `doctor` 输出 dsh 版本 + 已实测版本对照；决定是否声明 `engines.dsh`。
6. **[P2]** 验收用例：手机 Plugins 页装/卸插件后我们的 bundle 仍在、`status` 正常。
7. **[P3]** 复验 `session-hydrate` 在 0.2.x 的真实必要性（apiproxy 退场后，冷会话是否仍不在
   `sessions` 里；`dsh-api-session-controller` 的 cold reads 是否已覆盖）。

## 10. 复验清单（升到 0.2.x 后 10 分钟）

沿用 `docs/research/upstream-touchpoints.md` §4，并补三条：

1. `dsh --profile mobile doctor` —— 应报出 dsh 版本，且无“版本未验证”告警。
2. 手机打开 UI —— 不应出现 401 白屏（令牌握手生效）。
3. 手机发一条消息 —— WS 实时流正常（cookie + Origin/Host 三者一致）。
