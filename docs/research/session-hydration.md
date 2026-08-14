# 会话同步（session sync）调研与原型

> 内部调研文档。目标：让驻留 dsh web 实例（`dsh --profile mobile service start` 拉起的进程）能看到并恢复**另一实例**（部署自带实例）持久化在共享 `$DSH_HOME/sessions` 下的会话。

## 0. 结论速览（TL;DR）

1. 会话存储服务名是 **`"sessions"`**（`@deepseek-ai/dsh-session`），持久化后端服务名是 **`"sessionPersistence"`**（`@deepseek-ai/dsh-session-persistence`）。
2. `sessions` 是纯内存注册表，**启动时不枚举任何磁盘日志**；冷会话是"首次触碰时按需恢复"的。
3. **官方 web 列表本来就会合并冷会话**：`session.list` → `listVisibleSessionSummaries` 同时读 `ctx.sessions.list()`（内存）和 `ctx.sessionPersistence.list()`（磁盘头索引）。所以理论上驻留实例本应能看到另一实例的会话。
4. 官方恢复（点击/输入）也是按需的：`session.create`/`session.prompt` → `ctx.agents.resume({ resumeSessionId })` → `sessionPersistence.prepare(id)`。
5. **关键风险**：把冷会话"提前灌进" `ctx.sessions`（enter + announce）会把它变成"live"，而官方恢复路径 `PersistenceCoordinator.prepare()` 会对 live 会话抛 `cannot prepare session ... while it is live`，导致该会话在 web 上**无法被恢复**。因此本插件的默认行为是"枚举 + 校验 + 预热 + 上报"，而非"灌入内存 store"。

---

## 1. SessionStore 服务（`@deepseek-ai/dsh-session`）

文件：`node_modules/@deepseek-ai/dsh-session/lib/index.js`

- 服务名：`super(ctx, "sessions")` —— **`index.js:1584`**。
- `SessionStore` 类定义：`index.js:1580`；内部就是 `store = new Map()`（`index.js:1581`）。
- 公开方法（全部在 `SessionStore` 上）：
  - `create(id, options)` —— `index.js:1616`：`prepare` + `ctx.effect` 里 `enter` + `announce`，返回已发布 session。`options.seed`（重放/fork 事件）、`options.meta`（header：`cwd`/`createdAt`/`parentSession`/`seedLength`/`origin`/`delegationDepth`/`agentPreset`）。
  - `prepare(id, options)` —— `index.js:1644`：只构建不发布；`options.seedSource === "persistence"` 时走 `Session.fromRestore`（校验 + 原地冻结）。
  - `enter(session)` —— `index.js:1689`：放进 store，返回 detach 释放函数。
  - `announce(session)` —— `index.js:1737`：触发 `session/created`（供持久化协调器绑定）。
  - `get(id)` —— `index.js:1816`；`list()` —— `index.js:1823`（内存会话，创建顺序）。
  - `fork(source, boundary, childSessionId)` —— `index.js:1840`；`flush(session)` —— `index.js:1787`。
- **没有任何启动枚举**：全文件 grep 不到对 `$DSH_HOME/sessions` 或 `.jsonl` 的扫描；注释明确"Persistence is intentionally not implemented here"（`index.js:1575-1579`）。这就是"冷会话首次触碰才恢复"的根源。

## 2. JSONL 持久化后端（`@deepseek-ai/dsh-session-persistence-jsonl`）

文件：`node_modules/@deepseek-ai/dsh-session-persistence-jsonl/lib/index.js`（+ `lib/types/format.js` 内联在 index.js 里）

- 服务名：继承 `SessionPersistence`，基类 `super(ctx, "sessionPersistence")` —— **`@deepseek-ai/dsh-session-persistence/lib/index.js:1351`**；JSONL 后端 `static inject = ["sessions"]`（`session-persistence-jsonl/lib/index.js:769`）。
- **文件布局**（`format.js`，即 `session-persistence-jsonl/lib/index.js:23-158`）：
  - `root/<projectKey(cwd)>/<encodeSegment(id)>/session.jsonl.zstd`（默认 zstd），或 `session.jsonl`（`compression: "none"`）。
  - `projectKey(cwd)`（`index.js:106-125`）把 `D:\deepseek-harness-mobile-solution` 变成 `--D-deepseek-harness-mobile-solution--`；`encodeSegment(id)`（`index.js:84-96`）对 id 做路径安全转义。
  - 根目录由 `dsh-base/cordis.patch.yml:98-101` 配为 `root: !!js dshHomePath('sessions')`，即 `$DSH_HOME/sessions`——**两个实例共享同一个根**。
- **目录索引 / 列表 API**（官方，只读 header，不全量解析）：
  - `list(signal)` —— `session-persistence-jsonl/lib/index.js:1037` → `listArtifacts`（`index.js:1060`）→ 只读每目录 `session.jsonl.zstd` 的首帧 header 行。
  - `listSnapshots(signal)` —— `index.js:1041`（header + stat 修订号）。
  - 定点读取：`load(id)` / `inspect(id, signal)` / `readFrom(id, fromSeq, signal)` / `readRaw(id, signal)` / `loadStored(id)` / `readStoredRevision(id)` —— 均委托给 `PersistenceCoordinator`。
- **会话 id → 文件名**：`logPath(root, cwd, id, compression)`（`index.js:156-158`）= `sessionDir(root, cwd, id)/session.jsonl.zstd`；`findLog(id)`（`index.js:1315`）跨所有项目目录按 id 反查唯一日志。
- **存储记录格式**：首行是 header（`type:"session"`），后续每行是一个 `SessionEvent`，或（packChunks 开启时）打包成 `text-chunks` / `reasoning-chunks` / `tool-call-chunks` 行，读取端用 `decodeStorageRecord` 还原（`@deepseek-ai/dsh-session`，`session-persistence-jsonl/lib/index.js:275-300`）。

## 3. Web 会话列表路径

- **远程方法**（`@deepseek-ai/dsh-host-apiproxy`）：`session.list`、`session.search`、`session.create`、`session.history`、`session.fork`、`session.prompt`、`session.rename`、`session.selectModel`、`session.attachment`、`session.updateQueue`、`session.cancel`（`lib/index.js:4670-4714`、rpc-map `lib/types/api/rpc-map.d.ts:23-30`）。**没有 `session.resume` 方法**——恢复走 `session.create`/`session.prompt`。
- **`session.list` 实现**：`listVisibleSessionSummaries(signal)` —— `@deepseek-ai/dsh-host-apiproxy/lib/index.js:2212-2257`：
  - 先 `ctx.sessions.list()`（内存，`index.js:2222`），
  - 再 `persistence.list(signal)`（磁盘冷会话），过滤 `!attached.has(meta.id) && meta.cwd !== void 0`（`index.js:2227`），逐批 `summarizeCold` + `listProjectionsFor` 合成摘要，最后 `updatedAt` 倒序合并（`index.js:2255`）。
  - → **冷会话本来就在列表里**。
- **`session.history` 实现**：`historySourceFor`（`index.js:2043`）→ `inspectServable` → `inspectApiRemoteSession(ctx, id)`（`@deepseek-ai/dsh-api-remotes/lib/types/agent-lookup.js:53-67`）→ `persistence.list().find(...)` + `persistence.inspect(id)`（只读，不发布）。
- **侧边栏**（`@deepseek-ai/dsh-client-ui-sidebar`）只渲染 `sidebar.workspaces` 槽（`lib/client.js:200,246`），实际数据来自 `dsh-client-ui-workspace` 对 `session.list` 的消费。
- **投影缓存**（`@deepseek-ai/dsh-session-projection-cache`，服务名 `"sessionProjectionCache"`）：落在 `storages/session_projcache.json`（`lib/index.js:58-62`，`storage-domain` json 后端），启动 `Service.init` 打开域（`lib/index.js:107`）。它是**折叠加速，不是权威**（"a fold shortcut, never an authority"，`lib/index.js:65-75`）；冷读走 `cachedSnapshot`/`coldSnapshot`，失败都 fail-soft，不会影响列表是否正确。该文件是共享文件，但只影响投影列（标题/元数据），不影响"是否列出"。

## 4. 点击/恢复流程（open/resume）

- 点击会话（打开对话）→ `session.history` → `inspectServable` → `persistence.inspect(id)`（只读冷读，`agent-lookup.js:62`）。
- 继续对话（输入）→ `session.prompt` → `turnAgentFor` → `agentFor` = `createApiRemoteAgentResolver`（`dsh-host-apiproxy/lib/index.js:1830`）：
  - 复用 live agent（`agent-lookup.js:78-86`），否则对冷会话走 `ctx.agents.resume({ resumeSessionId })`（`agent-lookup.js:114`）。
- 新建/指定会话 → `session.create` → `ensureSession(sessionId, cwd, checkPersistedIdentity, presetId)`（`dsh-host-apiproxy/lib/index.js:2130-2190`）：
  - `persistence.list().find(id)` 命中且 `meta.cwd === cwd` → `ctx.agents.resume(...)`（`index.js:2150`）。
- 最终都收敛到 `ctx.agents.resume` → `AgentLoop.resumeWith`（`@deepseek-ai/dsh-agent-loop/lib/index.js:1262`）→ `persistence.prepare(id)`（`index.js:1277`）→ `setupAndPublish` 里 `sessions.enter` + `sessions.announce`（`index.js:1159-1161`）。

## 5. 真实日志 schema（实测）

读 `C:\Users\Administrator\.dsh\sessions\--D-deepseek-harness-mobile-solution--\session-094f0d5b-ea68-4c8a-8f64-cd0b9a53a383\session.jsonl.zstd`（zstd 帧，首帧 = header，后续帧 = 事件批次）：

```
HEADER: {"type":"session","version":0,"id":"session-094f0d5b-ea68-4c8a-8f64-cd0b9a53a383",
         "createdAt":1786681084569,"cwd":"D:\\deepseek-harness-mobile-solution",
         "delegationDepth":0,"agentPreset":"standard"}
EVENT : {"type":"permission/preset","seq":0,"time":1786681084765,"data":{"preset":"workspace-write"}}
```

- **Header**（`toHeaderLine`/`fromHeaderLine`，`session-persistence-jsonl/lib/index.js:36-68`）：`type:"session"`、`version:0`、`id`、`createdAt`(ms)、`cwd`(绝对路径，可选但项目目录依赖它)、`parentSession?`、`seedLength?`、`origin?`、`delegationDepth`(必填，顶层为 0)、`agentPreset?`。
- **事件信封**：`type`、`seq`（从 0 连续，`events[i].seq === i`）、`time`(ms)、`data`、可选 `surfaceOp` / `sourceEventSeqs` / `ignorable`。
- **最小可恢复的冷会话**：一个合法 header 行 + 0 或更多合法事件行（`seq` 连续）。`delegationDepth` 缺失会拒绝（`isHeaderLine`，`index.js:70-72`）。`agentPreset` 决定恢复时的工具/提示词（README `index.js`/README.md 均说明）。

## 6. 为什么"灌进内存 store"是错误做法（关键）

官方有完整的"冷→活"发布原语：`sessionPersistence.prepare(id)` 返回 `SessionPreparation`（内含已校验/已修复的脱机 `session`），再 `ctx.sessions.enter(session)` + `announce(session)` 发布（这正是 `dsh-agent-loop` 恢复时做的，`index.js:1277, 1159-1161`）。

但**提前灌入会破坏恢复**：

- `PersistenceCoordinator.prepare()` 开头：
  `if (this.ctx.sessions.get(id) !== void 0) throw new Error('cannot prepare session "<id>" while it is live')`
  —— `@deepseek-ai/dsh-session-persistence/lib/index.js:852`。
- 点击/输入恢复路径会先查 `ctx.sessions.get(id)` 再决定是否 `agents.resume`，而 `agents.resume` 内部必然 `persistence.prepare(id)`。因此：插件把会话 enter 进 store（live）、却不创建 agent 之后，用户点击该会话并输入会得到 `resume failed: cannot prepare session ... while it is live`（`agent-lookup.js:144-149`）。

所以"冷注册进 store"与官方恢复流程互斥。**安全等价物 = 枚举 + 校验 + 预热 + 上报**（见下），不改动 store、不破坏恢复。

## 7. 选型：插件 `src/session-hydrate.js`

- **触发条件**：仅 `DSH_MOBILE_INSTANCE === "1"`（与 gateway 同门）。
- **注入**：`inject: ["sessions"]`（等待 store 服务出现）；`sessionPersistence` 用 `ctx.get` 优雅获取（缺失则告警跳过）。
- **默认（安全）行为**：`sessionPersistence.list(signal)` 枚举所有持久化 header → 对每个不在 `ctx.sessions` 里的会话调用**官方只读** `sessionPersistence.inspect(id, signal)`（跑完整冷读：zstd 解压 + chunk 行还原 + header/事件校验 + 内存中断尾巴修复，且预热协调器 prepared 缓存），逐会话记录 `{id, cwd, ok, error}` 并上报。
  - 作用：让"启动时"就把冷读/校验跑一遍，把真正的同步断点（损坏、格式版本不兼容、未知事件类型、缺 preset 等）以逐会话原因打到日志；同时不发布、不落盘修复、不破坏恢复。
- **可选 ATTACH 模式**（`DSH_MOBILE_SESSION_ATTACH=1`）：额外走官方 `prepare` + `enter` + `announce` 把冷会话发布进 store（字面满足"冷注册进 store"），并在 doc 里标注第 6 节的恢复风险。
- **生命周期**：`AbortController` 由返回的 disposer 中止；attach 模式下收集的 `enter` detacher 也由 disposer 逐个释放；reconcile 为 fire-and-forget + 逐会话 try/catch（单会话失败不中断整体），无泄漏。
- 清单：`packages/dsh-mobile-server/src/session-hydrate.js`、`test/session-hydrate.test.js`、`package.json`（新增 `./session-hydrate` 导出与 files 条目）、`cordis.patch.yml`（新增 `mobile-session-hydrate` 行）。

## 8. 回退建议（fallback）

若驻留实例仍看不到另一实例的会话，按优先级排查（本插件默认模式的逐会话日志能直接定位）：

1. **共享根/编码不一致**：确认 `$DSH_HOME/sessions` 根相同、压缩模式一致（`checkRootEncoding`/`listSessionDirs` 会对相反压缩/旧扁平布局抛错，`session-persistence-jsonl/lib/index.js:1389-1407`）。
2. **格式版本/事件类型不兼容**：另一实例若是更新的 dsh，写的 header `version>0` 或含未知事件类型，`inspect`/`summarizeCold` 会拒绝；本插件日志会指出具体会话与原因。
3. **`session.list` 被单个冷会话拖垮**：`listVisibleSessionSummaries` 对任一冷会话 `summarizeCold`/`listProjectionsFor` 失败会整体抛错（`dsh-host-apiproxy/lib/index.js:2242-2250`）。本插件逐会话校验可先找出"坏"会话，删/隔离该日志即可恢复列表。
4. **不要靠"灌进 store"修可见性**：列表本就合并 `persistence.list()`；若一定要"热"会话，正确做法是完整 `ctx.agents.resume()`（会创建 agent 并正确绑定持久化），而不是只 enter+announce（那样破坏恢复）。

## 9. 风险 / 待验证（host 上验证）

- 冷会话恢复需要其 `agentPreset` / 模型 / 工具在当前组合里可用；另一实例的 preset 若不在驻留实例 roster，恢复会退化或失败。
- `session_projcache.json` / `workspace.json` 是两个进程共享的 storage-domain json 文件，多写者并发可能互相覆盖（缓存 fail-soft，但 workspace 注册表是权威）。
- 本插件默认模式只读，不落盘；ATTACH 模式需在 host 上验证"点击 + 输入"恢复流程（预期会因第 6 节冲突失败，故默认关闭）。

## 10. 验证

`node --test "packages/dsh-mobile-server/test/*.test.js"` → **32/32 通过**（含新增 9 个针对 mock store 的 session-hydrate 测试）。真实 store 的验证在 host 上由部署者执行。
