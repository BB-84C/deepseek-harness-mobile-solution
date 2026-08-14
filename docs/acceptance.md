# 验收清单（M7 — end-to-end acceptance）

> 内部文档（中文）。本清单是「deepseek-harness mobile solution」整体验收依据。
> 每一节标注执行环境（本机/第二设备/VPS）；M7 逐项实测后勾选。

## A. 安装与入口（本机）

- [ ] A1 全新机器上按 `docs/plugin-install.md` 走完安装（`pnpm install` + `node scripts/install-mobile.mjs`），无报错
- [ ] A2 `dsh --profile mobile doctor` 全 ✓（config/node/dsh/端口/tailscale/目录可写）
- [ ] A3 `dsh --profile mobile --help` 与各子命令帮助可读、覆盖 a/b/c 三类功能（服务/tailscale/relay）及 device/config/url/doctor/update
- [ ] A4 重复执行 installer 幂等，bundle 列表不重复
- [ ] A5 官方 dsh 不受影响：普通 `dsh web` 启动/使用与未装插件前一致（web profile 多出的 gateway 行在无 `DSH_MOBILE_INSTANCE` 时完全惰性）

## B. 常驻服务（本机）

- [ ] B1 `service start` 拉起 detached 实例；`service status` 显示 running + gateway healthy
- [ ] B2 重复 `service start` 拒绝（already running，不产生第二个实例）
- [ ] B3 自行启动一个**非 mobile** 的 `dsh web`，`service stop` 绝不误杀它（红线）
- [ ] B4 正常 stop/restart 只停自己的实例；restart 后 gateway 重新上线
- [ ] B5 `service logs` 显示 dsh web + gateway 日志；日志轮转说明存在（M5 文档）

## C. Tailscale 点对点（本机 + 第二设备）

- [ ] C1 `tailscale status/ip/connect/ping <peer>` 正常（本机 tailnet：woody + bb84s-macbook-pro）
- [ ] C2 `service start` 后 gateway 绑定 tailnet 可达地址（或 0.0.0.0），本机 `curl http://127.0.0.1:3081/mobile/health` 返回 `{ok:true,...}`
- [ ] C3 **第二设备**（MacBook/手机）浏览器访问 `http://<tailnet-ip>:3081/`：
  - 未认证 → 302 登录页（暗色、极简）
  - 未认证 `/api/...` → 401 JSON
  - 配对（`device pair` 出的 URL/码）→ cookie → 落到**官方 dsh Web**，会话列表/聊天/工具卡/审批全部可用（UI/UX 与本地一致）
- [ ] C4 `device list` 显示该设备；`device revoke <id>` 后该浏览器下一次请求被踢回登录页、活跃 SSE 断开
- [ ] C5 登录页限速：连错 11 次 → 429

## D. VPS relay fan-in（本机 + VPS + 第二设备）

- [ ] D1 VPS 按 `docs/deployment/relay.md` 部署：relay 起在 127.0.0.1:4097、systemd 常驻、Caddy 签发 HTTPS
- [ ] D2 `curl https://<relay>/relay/health` → `{ok:true,uptime,instances}`
- [ ] D3 bootstrap 一次性：`/relay/api/setup` 首次 200 + cookie，二次 401；passkey 注册/登录可用（M4）
- [ ] D4 本机 `relay connect https://<relay> --token <instance-token>` + `service restart` 后 `relay status` 显示 tunnel connected；relay 目录 `online:true`
- [ ] D5 **第二设备**浏览器开 `https://<relay>/instance/<id>/` → 等价 C3 全流程（配对一次即可）
- [ ] D6 目录接口：`/relay/api/targets` 需 client token；撤销 instance token → 隧道断、在途请求 502、目录 offline
- [ ] D7 双实例 fan-in（本机 + 另一台 dsh 机器）目录同时可见两个实例，可分别打开（如无第二台 dsh 机器，用两个不同 instanceId 的隧道进程模拟）

## E. 安全

- [ ] E1 所有凭据存储只有 SHA-256 哈希（检查 `$DSH_HOME/mobile/data/*.json`、relay `tokens.json`/`passkeys.json`）
- [ ] E2 配对码 5 分钟过期、单次有效、连错作废
- [ ] E3 撤销即时生效（C4/D6）
- [ ] E4 token 验证为常量时间比较（代码审查确认）
- [ ] E5 网关审计日志有 login/pair/revoke/tunnel 事件，且不含凭据明文
- [ ] E6 开放重定向防护：`/mobile/auth?next=//evil.com` 被拒

## F. 三平台

- [ ] F1 Windows（本机实测）
- [ ] F2 macOS：installer `.sh` + 自启 plist 在 Mac 上可用（若用户提供环境实测；否则 code-review + 文档复核）
- [ ] F3 Linux：installer `.sh` + systemd user unit 可用（同上）

## G. 交付物完整性

- [ ] G1 `docs/plugin-install.md` 按文档可复现安装
- [ ] G2 `docs/deployment/{service,tailscale,relay}.md` 按文档可复现部署
- [ ] G3 `docs/specs/mobile-web.md` + `mobile-app.md` 完整、与 gateway/relay 实际端点一致（无 TODO 残留）
- [ ] G4 README 与仓库实际一致（入口命令、链接有效）
- [ ] G5 全仓 `npm test` 全绿；git 历史阶段性清晰
