# Changelog

本文档记录 `panxt/auth2api-team`(团队私有版)在上游 `AmazingAng/auth2api` 基础上的改动。
格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/),版本号遵循 [SemVer](https://semver.org/lang/zh-CN/)。

## [1.0.0] — 2026-05-28

首个团队版正式发布。基线 = 上游 `AmazingAng/auth2api` @ `840fa10`(已含 codex + cursor provider、多账号粘性轮换 + 故障转移、`/admin/stats` 持久化统计)。本版本在此之上新增以下团队自研能力。

### Added(新增)

- **API key 身份化** — `config.yaml` 的 `api-keys` 从扁平字符串数组升级为对象形式,支持 `label`/`owner`/`enabled`/`admin`/`quota`/`rate-limit` 字段,完全向后兼容裸字符串。中间件 `requireApiKey` 把命中的 entry 挂到 `res.locals.apiKey`,供下游使用。
- **per-model 成本核算**(`src/usage/pricing.ts`)— `computeCost(model, usage, provider, overrides?)` 按 provider 区分计费:Anthropic 独立桶(input/output/cacheWrite/cacheRead)分别计费;Codex(OpenAI 口径)`cacheReadInputTokens ⊂ inputTokens`、`reasoningOutputTokens ⊂ outputTokens`,**不重复计费**。Codex gpt-* 单价是估算,可通过 `config.yaml` 的 `pricing:` 段覆盖。
- **当月用量追踪**(`src/usage/quota.ts`)— `QuotaTracker` 按 UTC 自然月统计 per-key 的 token 与成本,从 EventLog replay 持久化,跨月自动重置。
- **月度额度拦截 + per-key 限流**(`src/server.ts` + `src/ratelimit/per-key.ts`)— 在 `/v1` 推理路由前置 `requireQuota`(超 `monthly-tokens`/`monthly-cost-usd` 返回 `429 + Retry-After`)和 `enforceKeyRateLimit`(per-key `rpm` + `concurrency`,并发槽在 `finish`/`close` 两路径都释放,确保流式断连时归还)。
- **运行时 API key 管理**(`src/keys/store.ts` + `/admin/keys` CRUD)— UI/运维可通过 admin 鉴权的 `GET/POST/PATCH/DELETE /admin/keys` 增删改 key,持久到 `managed-keys.json`/SQLite。`config.yaml` 静态 key 标记为 read-only(不可经 API 修改),避免改写带注释的 YAML。
- **`/admin/usage/keys` 报表端点** — 每个 key 当月已用 token + cost vs 配额(remaining/percent),admin key 看全部、非 admin 仅看自己。
- **`/admin/stats` 增强为成本感知** — 三个聚合维度(byClient/byAccount/byApi)都带 `totalCostUsd`,通过依赖注入的 costFn 在 record 时按事件自己的 model 精确计价,replay 时按当前单价回算,改单价对历史立即生效。
- **可插拔存储**(`src/storage/`)— 抽象出 `EventLog` 与 `KeyRepository` 接口,提供 file 与 sqlite(`better-sqlite3`)两个后端,默认 sqlite(单 DB 文件 + WAL 模式)。sqlite 通过动态 `import` 加载,**加载失败自动回退 file** 并打 warn,保证默认开箱可用。`sqlite-path` 支持 `~` 展开与相对 auth-dir 解析。

### Fixed(修复)

- **403/额度耗尽现在跨账号 failover**(`src/utils/http.ts`)— 上游账号 third-party extra usage 额度耗尽通常返回 403,先前 `403 ∉ RETRYABLE_STATUSES` 会立即 break,导致单点失败,**即便有其他健康账号也不切换**。现在 403 同请求内 failover 到下一个可用账号(冷却的账号不会被重选),跳过 backoff 等待立即重试,受 `maxRetries` 限制;**全部账号耗尽时透传上游真实错误**(而不是笼统的 `503 forbidden`)。
- **rpm=0 现在正确表示"全阻断"**(`src/ratelimit/per-key.ts`)— 滑窗 reset 分支先前无条件 `return true`,使 `rpm:0` 仍放行每窗口首个请求;现修正为 `return rpm >= 1`。
- **额度持久化漏洞** — 先前若 `stats.enabled: false` 但某 key 配了 `quota`,`statsRecorder` 不创建 → 无人写 stats 日志,而 `QuotaTracker` 依赖 replay 该日志恢复月度用量;**重启即清零,可通过重启绕过额度**。现在配了 quota 必启 stats 日志,启动时清晰提示。
- **配置静默丢弃风险** — `normalizeApiKeys` 遇到格式不合法的对象条目(缺 `key` 字段)现在 `console.warn`,而不是静默跳过让用户因 403 困惑。
- **per-key 限流 map 长期增长** — `cleanupRpm()` 先前定义未调用,挂入 server.ts 已有的 5 分钟清理 timer。

### Changed(行为变化)

- **`Config["api-keys"]`** 从 `Set<string>` 改为 `Map<string, ApiKeyEntry>`。`.has()`/`.size` 用法等价,但 `.get(key)` 返回完整 entry。`Array.from(set)[0]` 这种取首 key 的写法需改为 `map.keys().next().value`。
- **`StatsRecorder.record()`** 现在返回构造好的 `StatsEvent`(原 void),并接受可选构造参数 `costFn` 注入每事件成本。
- **`StatsRecorder.start` / `QuotaTracker.start`** 签名从 `(authDir: string)` 改为 `(log: EventLog)`,由 `index.ts` 的 `openStorage()` 统一选后端再注入。
- **`ManagedKeyStore`** 构造器从 `(authDir, live)` 改为 `(repo: KeyRepository, live)`。
- **`createServer`** 签名新增第 4、5 参数 `quotaTracker?` / `keyStore?`(都可选)。
- **`config.yaml`** 新增字段:`storage.backend`(默认 `sqlite`)、可选 `storage.sqlite-path`、可选 `pricing:`(per-model 单价覆盖)。`api-keys` 的对象形式新增 `label`/`owner`/`admin`/`quota`/`rate-limit`,旧的字符串数组写法仍可用。

### Internal(开发/工程)

- **测试**:`tests/` 新增 `pricing.test.ts`、`quota.test.ts`、`quota-ratelimit.test.ts`、`usage-report.test.ts`、`keys-store.test.ts`、`admin-keys.test.ts`、`storage-sqlite.test.ts`,从 196 个上游测试扩到 **244 个**,全绿。
- **代码审核**:每个主要阶段都过了 high 强度多 finder + verify 流程的 code-review,发现的 3 个真实问题(quota 持久化、rpm=0、malformed key 警告 / sqlite 加载回退、cleanupRpm、相对路径)全部在主线修复并补测。
- **新增依赖**:`better-sqlite3 ^12.10.0`(预编译原生模块,Node 20+ 有 prebuild,无需编译)。

### 升级注意

- 仅靠 `config.yaml` 配置过 `api-keys` 字符串数组的用户**无需任何改动即可升级**。
- 想用 quota/rate-limit:把对应的 key 改成对象形式并加 `quota`/`rate-limit` 字段。
- 想用 `/admin/keys` 在线管理:把至少一个 key 标 `admin: true`,然后用它调 CRUD。
- 想保留旧文件后端:`config.yaml` 设 `storage.backend: file`。
- 默认 sqlite 后端会在 `<auth-dir>/auth2api.db` 自建库,WAL 伴随 `auth2api.db-wal` / `auth2api.db-shm`;首次启动自动建表,无需迁移。

---

## 上游基线参考

本仓库 fetch 远程 `upstream`(`AmazingAng/auth2api`)同步上游进展。基线提交 `840fa10` 包含但不限于:codex (ChatGPT OAuth) provider、cursor 实验性 provider、provider 抽象层、多账号粘性轮换 + 自动 token 刷新 + 失败冷却、`/admin/stats` 持久化统计、`/admin/accounts`、`/admin/reload`、per-IP 限流、OpenAI ↔ Anthropic 格式互转、流式 SSE、claude-cli 头透传与请求伪装。完整上游历史见 https://github.com/AmazingAng/auth2api/commits/main 。
