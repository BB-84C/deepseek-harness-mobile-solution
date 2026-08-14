# 验收清单（M7 — end-to-end acceptance）

> 内部文档（中文）。本清单是「deepseek-harness mobile solution」整体验收依据。
> **验收状态**：2026-08-14 于 Windows 本机（woody / tailnet 100.101.132.89）完成本地实测；
> 标注 [待用户] 的项目需在第二设备 / VPS / macOS / Linux 上由用户或后续 agent 复核。

## A. 安装与入口（本机）

- [x] A1 全新机器上按 `docs/plugin-install.md` 走完安装（`pnpm install` + `node scripts/install-mobile.mjs`），无报错
- [x] A2 `dsh --profile mobile doctor` 全 ✓（config/node/dsh/端口/tailscale/目录可写）
- [x] A3 `dsh --profile mobile --help` 与各子命令帮助可读，覆盖服务/tailscale/relay 及 device/config/url/doctor/update
- [x] A4 重复执行 installer 幂等，bundle 列表不重复
- [x] A5 官方 dsh 不受影响：普通 `dsh --profile web --port 3095`（含 gateway 行、无 `DSH_MOBILE_INSTANCE`）正常 200 服务（B3 测试中验证）

## B. 常驻服务（本机）

- [x] B1 `service start` 拉起 detached 实例；`service status` 显示 running + gateway healthy
- [x] B2 重复 `service start` 拒绝（already running，不产生第二个实例）
- [x] B3 自行启动**非 mobile** 的 `dsh web`（3095），`service stop` 只杀自己的实例、3095 全程 200（红线实测通过）
- [x] B4 正常 stop/restart 只停自己的实例；restart 后 gateway 重新上线（实测多次）
- [x] B5 `service logs` 显示 dsh web + gateway 日志（审计与运行日志可见）

## C. Tailscale 点对点（本机 + 第二设备）

- [x] C1 `tailscale status/ip/connect` 正常；`ping bb84s-macbook-pro` → pong（DERP + 直连路径均通）
- [x] C2 `service start` 后 gateway 可达：`http://127.0.0.1:3081/mobile/health` 与 `http://100.101.132.89:3081/mobile/health` 均 `{ok:true,...}`
- [ ] C3 **第二设备**（MacBook/手机）浏览器访问 `http://100.101.132.89:3081/` 全流程（未认证 302 登录页 / 401 JSON / 配对 → 官方 UI）——本机已完成等价 HTTP 流程实测（配对 → SPA 200 + `x-dsh-mobile-gateway:1` + `__DSH_BOOT__`），**真机浏览器项待用户** [待用户]
- [x] C4 `device list` 显示设备；`device revoke` 后该设备 Bearer 请求即时 401（实测）；活跃 SSE 断开（自动化测试覆盖）
- [x] C5 登录页限速：连错 10 次后 429（实测）

## D. VPS relay fan-in（本机 + VPS + 第二设备）

> 本机以 loopback 起了真实 relay（127.0.0.1:4097）完成全链路；HTTPS/Caddy 与公网 VPS 部署待真实环境 [待用户]。

- [ ] D1 VPS 部署（systemd + Caddy HTTPS）——文档齐备（`docs/deployment/relay.md` + `scripts/autostart/dsh-relay.service`），未经真实 VPS 验证 [待用户]
- [x] D2 `GET /relay/health` → `{ok:true,uptime,instances}`（本机 relay 实测）
- [x] D3 bootstrap 一次性（setup 200 + cookie，二次 401——自动化测试覆盖）；passkey 注册/登录（webauthn 测试 10 项全绿）
- [x] D4 `relay connect` + `service restart` 后 tunnel connected、目录 `online:true`（实测）
- [x] D5 深链流程实测：`http://<relay>/relay/instance/woody/` → 配对（JSON 200 + token）→ SPA 200 + `x-relay-instance` + `x-dsh-mobile-gateway:1` + `__DSH_BOOT__`
- [x] D6 `/relay/api/targets` 需 client token（401 无凭据——测试覆盖）；撤销 instance token → 隧道断/在途 502（测试覆盖）
- [ ] D7 双实例 fan-in（两台 dsh 机器同目录）——协议与实现支持，未经第二台真实机器验证 [待用户]

## E. 安全

- [x] E1 凭据存储只有 SHA-256 哈希（devices.json 实测三设备全 64-hex；relay tokens.json/passkeys.json 同理；测试断言原文不落盘）
- [x] E2 配对码 5 分钟过期、单次有效（实测重放 pair_fail；TTL 单测覆盖）
- [x] E3 撤销即时生效（C4/D6）
- [x] E4 token 验证为常量时间比较（relay tokens.js + devices.js 代码审查）
- [x] E5 网关审计日志（bind/login/pair/revoke 事件实测可见，不含凭据明文）
- [x] E6 开放重定向防护（`next=//evil.com` 不进入响应——实测 + 单测）

## F. 三平台

- [x] F1 Windows（本机全项实测）
- [ ] F2 macOS：installer `.sh` + launchd plist——代码走查完成，未经 Mac 实测 [待用户]
- [ ] F3 Linux：installer `.sh` + systemd user unit——代码走查完成，未经 Linux 实测 [待用户]

## G. 交付物完整性

- [x] G1 `docs/plugin-install.md` 按文档可复现安装（A1 实测）
- [x] G2 `docs/deployment/{service,tailscale,relay}.md` 内容与实测行为一致（relay 部分本机模拟验证）
- [x] G3 `docs/specs/mobile-web.md` + `mobile-app.md` 与 gateway/relay 实际端点一致（对齐 TODO 已消解）
- [x] G4 README 与仓库实际一致（入口命令、链接有效）
- [x] G5 全仓 `npm test` 115/115 绿；git 历史阶段性清晰
