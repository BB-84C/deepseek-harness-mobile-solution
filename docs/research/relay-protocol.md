# dsh-relay 线协议规范（relay protocol）

> 本文档是 **relay 与 dsh 侧隧道客户端** 之间、以及 **客户端与 relay** 之间的契约。
> 隧道客户端在后续里程碑（M3）实现，必须严格按本文档对接。
> 内部文档，中文。

## 0. 定位与边界

- relay 是一个 **零依赖、只监听 127.0.0.1** 的 Node ≥ 22 服务，TLS 由外层
  Caddy/反代终止。relay 本身只认明文 HTTP / WS。
- 数据面：**实例出站 WebSocket 多路复用**。每个 dsh 实例用一条常驻 wss 隧道连到
  relay；客户端 HTTP 请求被 relay 拆成带 `streamId` 的 JSON 帧，经该隧道转发到实例，
  实例把响应分帧回传，relay 再还原成 HTTP 响应。
- 认证模型：三种凭据 —— `instance`（实例）、`client`（客户端设备）、
  `owner-bootstrap`（一次性 owner 引导密钥）。relay **只存 SHA-256 哈希**，原文只回一次。

## 1. 部署与监听

- 监听 `127.0.0.1:<port>`（默认 4097），绝不直接暴露公网。
- 目录 `<data-dir>/tokens.json` 存凭据哈希，格式：
  ```json
  {
    "version": 1,
    "tokens": [
      {
        "hash": "<sha256 hex>",
        "label": "<label>",
        "kind": "instance|client|owner-bootstrap",
        "createdAt": 1710000000000,
        "revoked": false,
        "lastUsedAt": 1710000000000
      }
    ]
  }
  ```

## 2. 端点总览

| 端点 | 方法 | 认证 | 说明 |
| --- | --- | --- | --- |
| `/relay/health` | GET | 无 | `{ok, uptime, instances}` |
| `/relay/` | GET | 无 | owner 仪表盘（纯 HTML/JS） |
| `/relay/instance-tunnel` | Upgrade (WS) | instance token（query） | 实例出站隧道 |
| `/relay/api/targets` | GET | client token \| owner cookie | `[{id,name,online,lastSeenMs}]` |
| `/relay/instance/<id>/<path...>` | 任意 | 无（实例 gateway 自行认证） | 经隧道转发 |
| `/relay/api/setup` | POST | bootstrap token | 一次性建立 owner 会话 |
| `/relay/api/tokens` | GET/POST | owner cookie | 列出 / 创建凭据 |
| `/relay/api/tokens/<hashPrefix>` | DELETE | owner cookie | 撤销凭据并踢活连接 |
| `/relay/api/logout` | POST | 无 | 清除 owner 会话 cookie |
| `/relay/api/passkey/register-options` | POST | owner cookie | 发起 passkey 注册，返回 `{challenge, rp, user}` |
| `/relay/api/passkey/register-verify` | POST | owner cookie | 校验并存储凭据公钥 → `{ok:true}` |
| `/relay/api/passkey/login-options` | POST | 无 | 返回登录 `{challenge}` |
| `/relay/api/passkey/login-verify` | POST | 无 | 校验断言，建立 owner 会话 → `{ok:true}` |

## 3. 认证

### 3.1 客户端（Bearer）

```
Authorization: Bearer <client-token>
```

- client token 为 32 字节随机数的 64 位 hex 小写。
- relay 校验 `sha256(token)` 是否命中且未撤销。
- client token 保护**目录**（`/relay/api/targets`）；owner 接口另需 owner 会话。
- **转发路径不做 relay 认证**：`/relay/instance/<id>/...` 的凭据（`Authorization`
  bearer 或实例 gateway 的会话 cookie）原样转发，由实例侧 gateway 校验——gateway
  是 tailscale / relay 两种传输模式共同的设备认证边界，relay 只是传输。

### 3.2 owner（HttpOnly 会话 cookie）

```
Cookie: dsh_relay_owner=<32-byte-hex>
```

- 会话 ID 是 32 字节随机数 hex，只存内存，7 天过期。
- `HttpOnly; SameSite=Strict; Path=/; Max-Age=604800`，经 `X-Forwarded-Proto: https`
  时追加 `Secure`。
- owner-only 接口：`/relay/api/tokens` 的 GET/POST/DELETE。
- **401** = 未认证（无/无效凭据）；**403** = 已认证但权限不足（如用 client token
  访问 owner 接口）。

### 3.3 实例（升级 query）

```
GET /relay/instance-tunnel?instanceToken=<raw>&id=<id>&name=<name>
Upgrade: websocket
```

- `id`、`name` 必须匹配 `^[a-z0-9-]{1,64}$`。
- `instanceToken` 必须是 kind=`instance` 的未撤销 token；校验失败返回 HTTP 401 并拒绝升级。
- 注册为「在线」发生在握手成功时；断开即转「离线」（保留在目录，`online:false`）。
- 注册握手为同步（query 携带全部注册信息）；`TUNNEL_REGISTER_TIMEOUT_MS=10s`
  为握手完成的上界（node `upgrade` 事件在完整请求到达后触发，故实际即时完成）。

### 3.4 owner bootstrap（一次性）

- 首次启动若不存在未撤销的 `owner-bootstrap`，relay 生成并 **只打印一次**；
  也可用 `--bootstrap-token <hex>` 手工下发。
- `POST /relay/api/setup` body `{"bootstrapToken":"<raw>"}`：
  - 校验通过 → 建 owner 会话、写 `dsh_relay_owner` cookie，返回 `200 {ok:true}`；
  - 同时把该 bootstrap token 标记为 `revoked`（**一次性消耗**），再次使用返回 401。

## 4. 隧道线协议（relay ↔ 实例，JSON 文本帧）

- 所有帧都是 **WS 文本帧**，载荷为 UTF-8 JSON；二进制帧被忽略。
- 协议版本 `v:1`。

### 4.1 relay → 实例：`req`

```json
{ "v": 1, "t": "req", "id": 7, "method": "GET", "url": "/api/foo?x=1",
  "headers": { "accept": "*/*", "content-type": "application/json" },
  "bodyBase64": "<base64, 可选>"
}
```

- `id`：流 ID（relay 内单调递增的整数）。
- `method` / `url`：客户端请求方法与路径+查询（`/relay/instance/<id>` 之后的部分）。
- `headers`：转发给实例的请求头（见 §6 头处理）。
- `bodyBase64`：请求体 base64；无请求体时缺省。请求体上限 4 MB，超限 relay 回 413。

### 4.2 实例 → relay：`res` / `chunk` / `end`

```
{ "v":1, "t":"res",   "id":7, "status":200, "headers":{ "content-type":"application/json", "content-length":"13" } }
{ "v":1, "t":"chunk", "id":7, "bodyBase64":"eyJvayI6dHJ1ZX0=" }
{ "v":1, "t":"end",   "id":7 }
```

- 一个流必须先 `res`，再零到多个 `chunk`，最后 `end`。
- `res.headers` 会被 relay 原样写入 HTTP 响应；relay 额外追加：
  - `x-relay-instance: <id>`
  - `x-relay-latency-ms: <ms>`（从收到请求到收到 `res` 的耗时）
- `chunk.bodyBase64` 为响应分片 base64；relay 解码后 `write` 给 HTTP 客户端。
- `end` 后该流结束并回收。

### 4.3 错误语义

| 情况 | relay 返回 |
| --- | --- |
| 实例从未注册（`id` 未知） | `404 {"error":"unknown-instance"}` |
| 实例已注册但当前离线 | `502 {"error":"instance-offline"}` |
| 单实例并发流超 32 | `503 {"error":"stream-limit"}` |
| 请求体超 4 MB | `413 {"error":"body-too-large"}` |
| 转发头超 64 KB | `431 {"error":"headers-too-large"}` |
| 30s 无任何帧（idle） | `504 {"error":"request-timeout"}` |
| 实例凭据被撤销，隧道被关 | `502 {"error":"instance-offline"}`（在途请求一并终止） |

## 5. 时限

| 项 | 值 |
| --- | --- |
| 隧道注册握手 | 10 s |
| 请求空闲（`res`/`chunk` 之间无数据） | 30 s（每次收到帧重置） |
| 单实例并发流上限 | 32 |
| 转发请求头上限 | 64 KB |
| 转发请求体上限 | 4 MB |
| owner 会话 TTL | 7 天 |
| 默认限速 | 120 req/min / IP（令牌桶，内存） |

## 6. 头处理（relay 转发时）

请求头转发前剥离（hop-by-hop 及 relay 私有头）：

- `connection`、`keep-alive`、`proxy-*`、`te`、`trailer`、`transfer-encoding`、
  `upgrade`、`host`、`content-length`、请求侧 `x-relay-*`（防伪造 relay 追加的响应头）。
- `authorization` **原样转发**：携带的是实例设备凭据，由实例侧 gateway 校验。
- `cookie` 中的 `dsh_relay_owner=...` 会被剔除，其余 cookie（含实例 gateway 的
  会话 cookie `dsh_mobile_sid`）原样转发。

## 7. 限速

- 内存令牌桶，按 IP（优先 `X-Forwarded-For` 首个，否则 `socket.remoteAddress`）。
- 默认 120 req/min，超限返回 `429 {"error":"rate-limited"}`。
- 适用所有 HTTP 请求（含 `/relay/health` 与升级）。

## 8. CORS

- 所有 relay 生成与转发的响应带：
  `Access-Control-Allow-Origin: *`、
  `Access-Control-Allow-Methods: GET, POST, DELETE, OPTIONS`、
  `Access-Control-Allow-Headers: Authorization, Content-Type`。
- `OPTIONS` 预检回 204。
- 注意：`*` + 无状态 Bearer 意味着拿到 token 的任意页面可调用 relay（标准风险，
  token 即密钥，见 §10）。

## 9. WebSocket 帧层（RFC 6455 子集）

- 手写实现，无扩展、无 permessage-deflate、无压缩。
- 支持：文本/二进制、分片（FIN + continuation）、ping/pong（自动回 pong）、close
  握手（回显 close 帧）。
- 服务端强制要求客户端帧必须掩码；服务端发出帧不掩码。
- 拒绝：未掩码客户端帧、RSV 非零（表示扩展）、未知 opcode、超大帧（> 64 MB）
  —— 均以 close 1002/1009 断开。

## 10. 安全注意事项

1. **TLS 前置**：relay 只绑回环，公网暴露由 Caddy 负责；升级 query 中的
   `instanceToken` 依赖该 TLS 保证传输机密性（query 可能进入反代访问日志，部署时
   建议关闭对 query 的记录）。
2. **只存哈希**：所有凭据只存 SHA-256；原文仅在签发时回一次。
3. **撤销即时生效**：撤销 instance token 立即关闭其隧道并终止其全部在途请求
   （客户端收到 `502 instance-offline`）；撤销 client token 立即失效其目录访问
   （`/relay/api/targets` 返回 401）。
4. **比较**：校验使用 `crypto.timingSafeEqual` 的常量时间哈希比对（`tokens.js` 的
   `verify` 先哈希呈现的 token，再与全部存储哈希逐一 timing-safe 比较，不短路）。
5. **bootstrap 一次性**：owner 引导密钥只生效一次；泄漏后需重启生成新密钥。
6. **passkey（owner 登录）**：WebAuthn 无口令登录已实现（`src/webauthn.js` 手写
   CBOR/authData/COSE 解析，零依赖）。凭据**只存公钥**（`passkeys.json`，原子写）；
   challenge 为 32 字节随机数 base64url，单次使用、5 分钟过期；注册/登录的
   clientDataJSON 校验 `type`/`origin`/`challenge`，断言签名用 ES256（DER）或
   RS256（RSA-PSS, saltLen=32）验证；登录时比对签名计数器（signCount）防克隆。
   失败一律 `401 {"error":"passkey-invalid"}`，不泄露堆栈。
7. **审计**：授权头、cookie 不落日志；错误响应不含内部堆栈。

## 11. 测试用假实例

`src/server.js` 导出 `createFakeInstance({url, token, id, name, handler})`：
以出站 WS 连到 relay 的隧道端点，对每个 `req` 帧回 `res`/`chunk`/`end`
（默认回显请求元数据）。仅测试使用，dsh 侧真实隧道客户端按本文档另行实现。
