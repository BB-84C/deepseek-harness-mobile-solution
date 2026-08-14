# Mobile Gateway 设计（M2：dsh-mobile-server 插件）

> 状态：设计定稿。实现契约：本文件 + `docs/research/relay-protocol.md`（relay 隧道侧）。
> 内部文档（中文）。

## 1. 定位

官方 dsh web **故意拒绝**非 loopback 绑定（`dsh-web-app/lib/startup.js` 直接报错），且其
HTTP 层**没有任何认证**。Mobile Gateway 是唯一网络暴露面：它是运行在常驻 web profile 进程内的
插件行（`@bb-84c/dsh-mobile-server`），自建 `node:http` 服务，完成三件事：

1. **设备认证**（cookie/Bearer，配对码一次性兑换，只存 SHA-256 哈希，可撤销）；
2. **反向代理** 到官方 web（`127.0.0.1:<webPort>`，SSE/WebSocket 全透传）；
3. **传输适配**：tailscale 模式绑 tailnet 可达地址；relay 模式只绑 loopback 并维护出站隧道。

```
手机浏览器/app
   │  tailscale: http://<tailnet-host>:<gatewayPort>/
   │  relay:     https://<relay>/instance/<instanceId>/ → 隧道 → 本进程 loopback
   ▼
mobile gateway (node:http, 本插件)
   ├─ /mobile/*      认证、配对、设备管理、健康检查（自营端点）
   └─ 其余全部        认证后反代 → http://127.0.0.1:<webPort>（官方 dsh web，UI/UX 原样）
```

## 2. 进程与生命周期

- 插件行在 web profile 内激活；**仅在** env `DSH_MOBILE_INSTANCE=1` 时绑定网络端口
  （由 `service start` 拉起）；否则只提供惰性能力（不 bind）——保证普通 `dsh web` 用户零影响。
- 启动顺序：bind gateway → 写实例侧车文件 `$DSH_HOME/mobile/instances/<pid>.json`
  `{pid, startedAt, token}`（token=env `DSH_MOBILE_TOKEN`）→ relay 模式则连隧道。
  侧车文件是 `service stop` 防误杀三重校验的第三重。
- 插件 dispose：关 server（含活跃 socket）、断开隧道、清理临时配对态。

## 3. 配置

复用 `$DSH_HOME/mobile/config.json`（schema 见 dsh-mobile-common 的 config.js）：

```json
{
  "version": 1,
  "mode": "tailscale",
  "webPort": 3080,
  "gatewayPort": 3081,
  "hostname": "",
  "tailscale": { "interfaceIp": "" },
  "relay": { "url": "", "instanceId": "", "instanceToken": "", "displayName": "" },
  "auth": { "sessionTtlDays": 30 }
}
```

- gateway 端口：env `DSH_MOBILE_GATEWAY_PORT` 优先，其次 config.gatewayPort。
- tailscale 模式 bind 地址：config.tailscale.interfaceIp 非空则绑该 IP，否则 `0.0.0.0`
  （依赖 tailscale ACL/防火墙作为外围，文档明示）。
- relay 模式 bind：`127.0.0.1`（只有隧道能触达）。

## 4. HTTP 面

### 4.1 自营端点（/mobile/*，网关自己处理，永不代理）

| 方法/路径 | 认证 | 行为 |
| --- | --- | --- |
| GET `/mobile/health` | 无 | `{ok:true, version, mode, instanceId, uptimeSec}` |
| GET `/mobile/auth` | 无 | 极简暗色登录页（配对码/设备 token 两种输入；风格中性，后续对齐 dsh 观感） |
| POST `/mobile/auth` | 无 | `{code}` 或 `{token}` → 校验 → `Set-Cookie: dsh_mobile_sid`（HttpOnly, SameSite=Lax, secure 当 https, TTL=sessionTtlDays）；`{redirect}` 可带 |
| GET `/mobile/pair?code=<6位>` | 无 | 配对码一次性兑换：消耗配对记录→签发设备（存哈希）→ 建立会话并 302 到 `/` |
| POST `/mobile/logout` | 会话 | 清会话 cookie（浏览器） |
| GET `/mobile/api/devices` | 会话且设备为 owner | 设备列表 |
| DELETE `/mobile/api/devices/<id>` | 会话且设备为 owner | 撤销：置 revoked、踢掉该设备全部活跃会话与流 |
| GET `/mobile/api/status` | 会话 | 网关/传输状态（tailscale ip、relay 隧道态、dsh web 健康）——app 用 |
| POST `/mobile/api/token` | 会话且 owner | 给已配对设备重新签发长期 token（丢失恢复） |

### 4.2 代理路径（其余一切）

- 校验顺序：`Authorization: Bearer <raw>`（app）→ 会话 cookie（浏览器）→
  无凭证则：`Accept: application/json` 或路径 `/api` → 401 JSON；否则 302 `/mobile/auth?next=<url>`。
- 验证通过后反代到 `http://127.0.0.1:<webPort>`：
  - 请求：原样转发 method/path/headers（剔除 hop-by-hop：connection、keep-alive、proxy-*、transfer-encoding、upgrade）；body 流式。
  - 响应：原样流回（含 SSE）；WebSocket：处理 `Upgrade` 握手，两向 pipe，一端断则双端销毁。
  - 增加响应头：`x-dsh-mobile-gateway: 1`；记录每个请求的设备 id 到访问日志。
- 认证状态缓存：每请求查内存 Map（sid→{deviceId, expiresAt}），TTL 惰性清理；bearer 每请求哈希比对
  （`sha256(raw)` 与设备表比对，timingSafeEqual）。

### 4.3 安全

- 所有含密钥的存储仅哈希；配对码 6 位数字、5 分钟、单次、连续失败 5 次作废。
- 登录端点限速：每 IP 10 次/分钟（429）。
- 会话 TTL 滑动续期；撤销即时断开该设备的活跃 WS/SSE（维护 deviceId→sockets 表）。
- 审计日志 `$DSH_HOME/mobile/logs/gateway.log`：登录成功/失败、配对兑换、撤销、隧道状态变迁。
- tailscale 模式的安全依赖 WireGuard 加密（一期无 TLS，决策 §6-5）；relay 模式由 Caddy TLS 终结，
  隧道为出站 wss。

## 5. 隧道客户端（relay 模式，M3）

- 连接 `wss://<relay-host>/relay/instance-tunnel?instanceToken=<raw>&id=<instanceId>&name=<displayName>`。
- 收 `{v:1,t:"req",id,method,url,headers,bodyBase64}` → 本地 fetch `http://127.0.0.1:<gatewayPort><url>`
  → 回 `{t:"res",...}` / `{t:"chunk",...}` / `{t:"end"}`（协议全定义见 `docs/research/relay-protocol.md`）。
- 心跳（relay ping 间隔内保持活跃）、指数退避重连（1s→30s 封顶）、状态落盘
  `$DSH_HOME/mobile/data/relay-status.json`（CLI `relay status` 读它）。
- Node ≥22 全局 WebSocket（客户端侧无需 ws 依赖）。

## 6. 与官方信任围栏的配合

`service start` 以 `--trusted-host` 注入 authority 列表（tailscale IP/hostname 及 `:gatewayPort` 形式、
relay 域名），官方 `connection` 客户端信任围栏放行手机浏览器的 origin——不改任何官方 row。

## 7. 验收（M2/M3 联调）

1. tailscale 模式：手机/第二设备浏览器开 `http://100.101.132.89:3081/` → 登录页 → 配对 → 官方 dsh web 可用（会话、SSE 流、审批卡片）。
2. 错误面：无凭证 302/401；错 token 401；撤销后活跃流立即断开；`service stop` 只杀三重校验通过者。
3. relay 模式：relay 目录可见本实例；浏览器经 relay 完成 1 的等价流程；断网重连自动恢复。
4. 回归：不带 `DSH_MOBILE_INSTANCE` 的普通 `dsh web` 行为零变化（不 bind、不写侧车文件）。
