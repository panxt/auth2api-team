# Changelog

本文档记录 `<your-user>/auth2api-team`(fork)在上游 `AmazingAng/auth2api` 基础上的改动。
格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/),版本号遵循 [SemVer](https://semver.org/lang/zh-CN/)。

## [2.3.1] — 2026-07-02

打磨 v2.3.0 的接入文档生成:预览真正渲染 Markdown、内容大幅充实、地址可配置。基线 = v2.3.0,含 3 个 commit。**向后兼容**,无 schema 变化。

### Added / Changed

- **接入文档渲染 Markdown**(`web/src/lib/accessDoc.ts` + `web/src/index.css`)— 建 key / 自助重置 key 弹窗里的预览从原始 md 文本改为真正渲染(引入 \`marked\` + \`.md-body\` 暗色样式:标题 / 表格 / 代码块 / 引用 / 列表),默认展开。
- **文档内容充实**— 合并团队现场手册:30 秒自测、Claude Code(安装 + 环境变量 + 弹登录菜单处理 + IDE + 误登录清理)、**Claude 桌面 Cowork 的 macOS + Windows 双端根证书安装步骤**(命令行 + 图形 + 验证 + Firefox 单独导入 + 排错表)、Codex CLI + 第三方 GUI、SDK/curl、看板查用量、模型选择表、常见问题表、安全提醒。
- **可配置对外地址**(`src/config.ts` + `src/server.ts` whoami)— 新增 \`public-base-url\`(成员使用的对外地址)与 \`cowork-base-url\`(Cowork 的 https 反代地址),经 \`/admin/ui/whoami\` 下发前端;文档地址优先用配置值、否则回退浏览器 origin。管理员在本地看板生成的文档也能正确指向生产地址,而非 localhost。

### Fixed

- **重新认证弹窗卡在「请求中…」**(`web/src/components/AddAccountModal.tsx`)— 自动发起 OAuth 的 useEffect 把 \`busy\` 放进依赖导致自取消,结果被丢弃、状态不复位。改为仅依赖 \`[open, reauthProvider]\`。
- **账号导出 / 导入找不到 token 文件**— 直接用了未展开 \`~\` 的 auth-dir,改用 \`resolveAuthDir()\`。

## [2.3.0] — 2026-07-01

在 v2.2.0 基础上把服务从「能用的共享网关」推进到「**多租户 AI 接入平台**」:三角色 RBAC + 成员自助门户(ROADMAP ⑤⑭)、上游账号全生命周期运维(主动续期 / 跨实例迁移 / 重新认证)、5h 窗口暖机内置调度器 + 定时执行审计、5h/7d 额度池汇总、以及配置/日志的权限化重构。基线 = v2.2.0,含 12 个 commit。**向后兼容**:旧 `admin: true` 键自动映射为 `admin` 角色;`prewarm_runs` 表 + `scheduled_time` 列经 `PRAGMA table_info` 轻量迁移自动创建;账号 token 文件格式不变。

### Added(新增)

- **三角色 RBAC + 成员自助门户**(`src/config.ts` `KeyRole`/`effectiveRole`/`canReadAll` + `src/keys/store.ts` + `web/src/pages/Self.tsx`)— 权限从 admin 布尔细化为 `admin`(全权)/ `auditor`(全局只读,禁写与配置)/ `member`(仅限自己)。新增「🙋 我的」自助页:查看身份/角色、本月用量、**自助重置自己的 key**(`POST /admin/keys/self/rotate`,保留 label/角色/配额,旧 key 立即失效;config.yaml 键只读)。建/改 key 弹窗的 admin 复选框改为角色下拉。
- **Web 建 key 同步生成接入文档**(`web/src/lib/accessDoc.ts` + `web/src/pages/Users.tsx`,ROADMAP ⑤)— 创建 key 的对话框即时生成该用户专属接入手册(base URL = 面板地址、明文 key、Claude Code/Codex/GUI/curl 接入步骤,用 `ANTHROPIC_AUTH_TOKEN`):复制 key / 复制文档 / 下载 .md / 预览。免管理员手工跑脚本。
- **跨实例账号无缝转移**(`src/server.ts` + `src/auth/token-storage.ts`)— `GET /admin/accounts/:provider/:email/export` 导出完整凭据 bundle(token + uuid + 预算/档位/权重),`POST /admin/accounts/import` 导入(同 email 覆盖=重认证语义)。UI 每账号「导出」下载 JSON + header「⇄ 导入账号」弹窗。admin 专属。
- **单账号主动续期 + 全局刷新**(`src/server.ts` + `web/src/pages/Accounts.tsx`)— 每账号「↻ 刷新」`POST /admin/accounts/:provider/:email/refresh` 主动续 OAuth token(成功清认证冷却);header「↻ 刷新状态」= reconcile 整池。
- **5h 窗口暖机内置调度器**(`src/accounts/prewarm.ts` + `src/storage`,ROADMAP)— 取代外部 launchd cron。UI 可配开关/多时间点/套用推荐/立即暖机(设置页);运行历史持久化到 `prewarm_runs` 表(sqlite)+ JSONL(file 后端),跨重启保留。历史以**「按天 × 计划时刻」执行审计表**呈现:✓按时 / ⚠部分 / ✗失败 / ✗漏跑 / ·待跑,直接核对定时任务是否到点执行。
- **5h/7d 额度池汇总**(`src/accounts/manager.ts` `quotaPool()` + `web/src/pages/Accounts.tsx`)— 把全部启用账号的 5h/7d 滚动窗口按 `concurrencyWeight` 聚合成「加权等效窗口」:剩余% + 等效份数 + 最早重置。诚实标注为估算(Anthropic 只暴露利用率%、不公开绝对配额)。
- **设置页**(`web/src/pages/Config.tsx`)— 负载均衡 / 窗口暖机 / 日志策略集中到独立「⚙️ 设置」页,admin 专属(路由 `RequireAdmin` 守卫)。
- **日志按人名展示 + 搜索**(`src/server.ts` + `web/src/pages/Logs.tsx`)— key hash 解析为人名(label/owner)行内展示;admin/auditor 可按人名模糊搜索(解析为 hash 集合过滤,`RequestLogFilter` 增 `apiKeyHashes`)。

### Fixed(修复)

- **重新认证弹窗卡死**(`web/src/components/AddAccountModal.tsx`)— 自动发起 OAuth 的 `useEffect` 把 `busy` 放进依赖数组:`setBusy(true)` 触发 effect 清理 → `cancelled=true` → `startOAuth` 成功结果被丢弃、busy 不复位 → 永远停在「请求中…」。改为仅依赖 `[open, reauthProvider]`。
- **导出/导入找不到 token 文件**(`src/server.ts`)— 直接用了 config 里的原始 `auth-dir`(`~/.auth2api` 未展开 `~`),`fs.existsSync` 失败。改用 `resolveAuthDir()` 展开。

### Changed / Security(行为与权限变化)

- **账号写操作全部锁定 admin**:`reload` / `import` / `export` / `refresh` / `delete` / `patch` 均 `requireAdmin`;`notifyServerReload` 改为优先选 admin key(`/admin/reload` 变 admin-only 后 `--login` 自动 reload 仍可用)。
- **日志按角色隔离**:`/admin/logs` 对 admin/auditor 返回全局、对 member 硬限本人 key 的行;前端 member 隐藏「用户」搜索框。(原 v2.3 开发中期一度对全员开放,经审查收敛。)
- `ApiKeyEntry` 增 `role`;`AccountSnapshot`/`/admin/accounts` 增 `quota_pool`;`PrewarmRunRecord` 增 `scheduledTime`;whoami 增 `role`/`source`。
- 重新认证优化:凭据失效账号顶部红色告警条 + 行内「需重新认证」徽章 + 按钮高亮。
- 运维文档 §5.8 改为推荐内置暖机调度器,新增 §5.8.8 launchd 迁移(卸载旧 `*.prewarm.plist`)。

## [2.2.0] — 2026-06-16

在 v2.1.0 基础上引入**自适应加权并发调度**(让多账号在瞬时高并发下真正并行分摊,而非全挤一个),**日志按来源分类降噪**(区分模型/上游报错 vs 本服务报错,默认隐藏非真错噪音),以及**上游容量告警**(打满时管理页主动提示并给出解决办法)。基线 = v2.1.0,含 3 个 commit。**完全向后兼容,无破坏性 schema 迁移**(request_logs 自动加 `category` 列;账号 `concurrencyWeight` 可选)。

### Added(新增)

- **自适应加权并发调度**(`src/accounts/manager.ts` + `src/accounts/routing.ts`)— 取代原全局 sticky 指针。单一打分函数 `load = 处理中数 / 权重 (+ 可选 5h 利用率)`,三种策略只是旋钮:`adaptive`(默认,低并发粘账号保 prompt 缓存、高并发自动溢出分摊)、`weighted-least-inflight`(始终按权重分摊)、`sticky`(旧行为)。每账号可标 `concurrencyWeight`(异构 $25/$125 档位按容量加权);`acquireSlot`/`releaseSlot` 一次性句柄配对杜绝 in-flight 泄漏。配置三层合并(默认 < config.yaml < SettingsStore)+ `GET/PUT /admin/routing/config` 热生效。
- **日志来源分类**(`src/logging/logger.ts` + `src/storage`)— 每条日志打 `category`:`upstream`(模型/上游报错)、`service`(本服务报错)、`policy`(配额/白名单/限流拒绝)、`client`(客户端断开/坏请求)、`ok`(成功)。**默认只记 upstream+service**,policy/client 噪音默认不记;四类开关在设置卡可调。`GET /admin/logs` 支持 `?category=` 过滤;`request_logs` 经 `PRAGMA table_info` 轻量迁移加 `category` 列 + 索引。
- **上游容量告警**(`src/server.ts` `capacitySummary` + `web/src/pages/Accounts.tsx`)— `/admin/accounts` 派生每 provider 容量摘要(可用账号数、最早恢复时间、最高 5h 利用率、饱和拒绝数、分级 level)。账号页顶部分级告警条:🔴 全部不可用 / 🟠 接近打满 / 🟡 5h 窗口将尽,每条附最早恢复时间 + 三步解决办法(等窗口重置 / 加账号 / 降并发)。
- **并发可视化 + 设置卡**(`web/src/pages/Accounts.tsx`)— 实时并发分布堆叠条、每账号处理中/峰值 gauge + 权重 + 5h 利用率%、负载均衡设置卡(策略/粘性阈值/并发上限/5h 打分热调)、可选 2s 实时轮询;窗口面板术语专业化(5 小时/7 天滚动窗口)+ ⓘ 悬浮提示解释滚动窗口与各路由旋钮。

### Fixed(修复)

- **瞬时高并发全挤一个账号**(`src/utils/http.ts` + `src/upstream/streaming-failover.ts`)— 原全局 sticky 指针使 ~100 并发压在单账号 → 撞 429 → 冷却 → 才轮下一个,呈串行退化。改为加权最少处理中分摊,N 账号真正并行;故障转移先释放槽再选账号。
- **非真错污染日志**— 客户端断开(499)、配额 429、模型白名单 403、per-key 限流 429 等过去都按失败记录,混入大量噪音;现归入 policy/client 类别默认不记。失败转移后最终成功的请求强制记为 `ok`,不再误判为错误。

### Changed(行为变化)

- `AccountSnapshot` 增 `concurrencyWeight` / `inFlight` / `peakInFlight`;`/admin/accounts` 响应增 `capacity` 摘要;`PATCH /admin/accounts/:provider/:email` 接受 `concurrencyWeight`。
- `LoggingConfig` 增 `categories` 开关;`RequestLogRecord` / `RequestLogFilter` 增 `category`。
- UI 术语统一:`在飞` → `处理中`,`5h/7 天窗口` → `5 小时/7 天滚动窗口`。

## [2.1.0] — 2026-06-13

在 v2.0.0 的看板基础上补齐**用量分析、精细化限额、按模型管控、请求日志**,并修复影响 Claude 桌面 App 的 cache_control 报错。基线 = v2.0.0(`2208adf`),含 10 个 commit。**完全向后兼容,无 schema 迁移,旧 Key 无需改动。**

### Added(新增)

- **统计时间窗 + 自定义区间**(`src/stats/recorder.ts`)— Stats 页顶部 `当天 / 当月 / 全部 / 自定义日期区间` 段控,联动整页(KPI / Top 客户端 / 模型分布 / 明细)。recorder 新增 `dayFacts` 细粒度每日事实表(保留 120 天)+ `getSnapshot(window)` / `getSnapshotRange(from,to)`;`/admin/stats` 与 `/admin/stats/timeseries` 支持 `?window=` 或 `?from=&to=`。
- **per-user × per-model 用量明细** — 新增 `byClientModel`(client × model 交叉维度),前端出"每人·各模型 成本/Token"表;Top 客户端表改为成本 + Token + 请求数 + 占比%。
- **per-key 模型白名单 / 黑名单**(`src/usage/model-access.ts`)— `ApiKeyEntry` 新增 `allowed-models` / `denied-models`(deny 优先于 allow)。`requireModelAccess` 中间件在打到上游前对不允许的模型返回 `403 model_not_allowed`;别名与规范 id 经 `resolveModel` 归一比较。
- **per-key / per-model · 日 + 月 限额**(`src/usage/quota.ts`)— `ApiKeyQuota` 扩展 `daily-tokens` / `daily-cost-usd` 及 `per-model` 子表。QuotaTracker 升级为 `{月,日} × {key 总,per-(key,model)}` 四类桶;`requireQuota` 按"key 月→key 日→模型月→模型日"顺序校验,命中返回 429 + 对应月/日边界的 `Retry-After`。
- **上游账号自助管理**(`src/accounts/manager.ts`)— UI 内停用 / 删除 / 重新认证账号(`PATCH`/`DELETE /admin/accounts/:provider/:email`,`setDisabled` / `removeAccount` / `setBudget`);每账号可标 `monthlyBudgetUsd` + `tierLabel`($25/$125),账号页画本月利用率进度条。
- **请求日志**(`src/logging/logger.ts` + `src/storage`)— 独立于 stats/quota 的 `RequestLogStore`(sqlite 索引表 / file 滚动 JSONL),记录每请求结果与失败原因。`GET /admin/logs`(过滤:状态/账号/模型/端点/时间区间/关键字 + 游标分页,key 脱敏为 12 位前缀)。`/ui/logs` 页(仅 admin)+ 可视化设置卡:记录范围(全部/仅失败)、错误详情(全文/片段/不记)、脱敏、request_id、保留(天数/行数/清理间隔)。配置三层合并(默认 < config.yaml < SettingsStore 持久化),UI 改完热生效;定时按保留策略清理。
- **`PUT` HTTP helper** + 前端 `/ui` 日志页、账号预算、自定义区间等对应 UI。

### Fixed(修复)

- **Claude 桌面 App `cache_control` 400**(`src/upstream/cloaking.ts`)— Anthropic 要求 `ttl='1h'` 断点不能排在 `ttl='5m'` 之后(顺序 tools→system→messages)。`fixCacheControlOrder` 收集 tools/system/messages 上所有 `cache_control` 并按 TTL 降序重排(保留断点位置,仅交换 TTL 归属),在 cloaking 末尾执行(含注入的 CLI prefix 块),消除该 400。
- **模型限制重启丢失**(Codex 复核 P1,`src/storage/types.ts`)— `normalizeKeyEntry`(file + sqlite 两后端的磁盘加载路径)漏带 `allowed-models` / `denied-models`,重启后限制被静默清除。已补字段 + 回归测试(重开 SqliteStorage 后仍在)。
- **配额无法清空**(Codex 复核 P2,`src/keys/store.ts`)— 编辑弹窗删光配额后 `?? undefined` 把字段从 PATCH 漏掉,旧配额仍生效。现以 `null` 显式清除,`update()` 把 null 当"清除"。
- 上游 prewarm 结果不再吐原始 429 JSON,改为「成功·Nms / 已限流 / 认证失效 / 未加载冷却」可读状态。

### Changed(行为变化)

- `AccountSnapshot` 增 `disabled` / `monthlyBudgetUsd` / `tierLabel`;`StatsSnapshot` 增 `byClientModel` / `window`,`/admin/stats` 默认 `window=all`(兼容旧行为)。
- 非 admin 在 Users/Accounts 页为只读(隐藏管理按钮),被绕过的写操作后端返回 403;查看类分析对任意有效 key 开放。

### Internal(开发/工程)

- 两轮独立代码复核:Claude `/code-review` + OpenAI Codex CLI `codex review`,合计修复 15+ 项。
- 新增存储抽象:`RequestLogStore` + `SettingsStore`(file + sqlite 双后端);新模块 `src/logging/logger.ts`、`src/usage/model-access.ts`。
- 测试从 246 扩到 **264**,全绿(新增窗口 rollup、per-model/日配额、模型 allow/deny、请求日志查询/分页/清理、脱敏、配置持久化、键重启往返等用例)。

### 升级注意

- v2.0.0 → v2.1.0 **无 schema 迁移**;请求日志独立存储,其保留策略不影响配额重放。
- 首次启动需 build 前端(`cd web && npm run build`),生产 tarball 已含 `web/dist/`。
- 想用模型白/黑名单或 per-model/日限额:在 `/ui/users` 编辑对应 Key 即可,或在 config.yaml 的 `quota` / `allowed-models` / `denied-models` 配置。
- 想开请求日志面板:默认已开(`capture: failures`),在 `/ui/logs` 设置卡按需调整。

---

## [2.0.0] — 2026-06-09

第二个 major,主线把 v1.0.0 的命令行管理向 **Web Dashboard + 流稳定性** 推进。基线 = v1.0.0(`e6225c5`),含 19 个 commit。

### Added(新增)

- **Admin Dashboard `/ui`**(Vite + React + Tailwind,`web/`) — 单页 SPA 嵌入 auth2api 主进程(`express.static('/ui')`),零跨域、单端口。三大页面:
  - **Users**(`/ui/users`):API key CRUD、配额、当月用量、启停;config.yaml 来源的 key 标灰只读
  - **Accounts**(`/ui/accounts`):上游账号状态表 + 5h/7d 窗口倒计时 + `⚡ 立即 Prewarm` 按钮 + **UI 内新增账号(OAuth manual mode)**,Anthropic / Codex 支持,Cursor 仅 CLI 提示
  - **Stats**(`/ui/stats`):Chart.js 看板,KPI 卡 / 折线 / 饼图 / TopN / 配额进度条 / 账号健康表;30s 自动刷新
- **Non-admin 只读模式** — 非 admin key 登入后自动隐藏所有管理按钮(新增 / 编辑 / 删除 / 启停 / Prewarm / 新增账号),sidebar 显示"只读"角标。被绕过的请求(devtools / 缓存页)统一回 `权限不足,请联系管理员`。
- **Mid-SSE-stream failover**(`src/upstream/streaming-failover.ts`) — 流到一半 upstream 报错(`event: error` / `response.failed` / 网络断)时,后端在客户端无感知的情况下切到**同 provider 下一个可用账号**续传;切换优先同 provider,失败回退跨 provider。translator state 采用 per-attempt factory 模式,避免序号 / respId 错乱。
- **Anthropic 5h / 7d 窗口监控** — 抓 `unified-5h-utilization` / `unified-5h-reset` / `unified-7d-utilization` / `unified-7d-reset` headers,`AccountSnapshot` 暴露 `windowStartedAt` / `windowResetAt` / `rateLimit`,UI Account 页有专属 panel。
- **Prewarm 调度** — `POST /admin/prewarm`(已存在)+ 新增 launchd `com.<user>.auth2api-prewarm.plist`,每天 08:00 自动 prewarm 所有 anthropic 账号,把 5h 窗口起点对齐到工作时间。工作日 5h × 2 个窗口 = 全天覆盖 8:30-17:30。
- **Opus 4.8 支持** — `claude-opus-4-8` 在 model registry / aliases / pricing 全 wire 到位。
- **Caddy + TLS 反代文档** — `docs/CADDY_TLS.md` + 推荐 launchd plist,给 Cowork 等强制 https 的企业桌面客户端用。HTTP/HTTPS 同时可达。
- **config.yaml → SQLite 迁移工具** — `scripts/migrate-config-keys-to-managed.py`,纯 stdlib(无 PyYAML),`--dry-run` / `--force` / `--include-admin` 三个 flag,把非 admin key 从只读 yaml 迁到可 CRUD 的 `managed_keys` 表,保留原始 raw key string,客户端无需重新发 key。
- **新增 admin endpoints**:
  - `GET /admin/ui/whoami` — 当前 key 的 label / admin / enabled,SPA 登录后探活用
  - `POST /admin/oauth/:provider/start` / `exchange` — UI manual-mode OAuth(in-memory pending Map,10min TTL)
  - `POST /admin/prewarm` — 主动 prewarm(配合上面的调度)
- **OPERATIONS.md** — 团队运维手册:管理脚本、launchd 部署、Caddy、key 迁移、回滚 recipe 全覆盖。

### Fixed(修复)

13 项 code review 修复(Claude `/code-review high` 10 项 F1-F10 + Codex CLI `codex review` 3 项 C1-C3):

- **F1 mid-stream failover 状态泄漏** — translator state 在 failover 多次 attempt 间共享导致 sequence_number 跳号 / respId 错位。改 `makeTransformEvent: () => fn` factory,每次 attempt 拿一份新闭包。
- **F2 mid-stream usage 丢统计** — usage 没写到 `res.locals.stats.usage`,导致 mid-stream 切换后的请求在 byClient/byApi 维度计费为 0。done/disconnected/committed-error 三路径都补 `statsCtx.usage = usage`。
- **F3 mid-stream accountEmail/provider 丢失** — 同上,recordAttempt 后立即写到 stats slot。
- **F4 pre-stream retry 缺失** — `proxyStreamingWithFailover` 没有 401-refresh-once / RETRYABLE_STATUSES / isAnthropicExtraUsageError / waitForRetry backoff,跟 `proxyWithRetry` 行为不一致。从 `utils/http.ts` 导出辅助并补齐。
- **F5 committed-error 不计 failure** — 流已提交后断,recordFailure 没被调用,账号"假装健康"。补 `recordFailure(email, "network", "stream terminated post-commit")`。
- **F6 translator 崩在 undefined data** — emitTransformed 加 try/catch,异常落回 close-with-error 而不是抛栈。
- **F7 windowStartedAt 给非 anthropic provider 也打** — codex/cursor 没有 5h 窗口概念,误打了。`recordAttempt` 里 gated 到 `this.provider === "anthropic"`。
- **F8 EOF flush 合并多事件** — SSE 流末尾未 newline 时,缓冲里多个连续 event 被并成一个。done 分支按 blank-line 切分逐个 emit。
- **F9 SPA RequireAuth 不 gate** — whoami 探活 401 后,localStorage 不清,React 把死 key 抓在手里反复请求。AuthProvider 在 probe 返 null 时清 localStorage + setKey(null),路由自动跳 /login。
- **F10 recordRateLimit 写死 Anthropic schema** — `unified-5h-*` 是 anthropic 字段,但所有 provider 都进这条路径,污染了 codex/cursor 的快照。gated 到 anthropic。
- **C1 classifier 漏触发** — `proxyStreamingWithFailover` 只在 `ev.event === "error"` 时 invoke classifier,`response.failed` 这种 OpenAI Responses 错误事件被透传给客户端。改为总是 invoke,由 classifier 决定。
- **C2 /v1/chat/completions usage chunk 丢** — translator 不带 usage,Codex 路径的 usage chunk 全部为 0。transformEvent 签名改 `(ev, usage) => ...`,把跑动累加的 usage 注入。
- **C3 /v1/responses response.completed.usage 全 0** — 同上,Anthropic 路径下的 OpenAI Responses 翻译漏传 usage,fix 后真实数字。

其他:

- **smoke test count_tokens** 因 opus 4.8 注入 `model` 字段断言失败,更新 mock 断言匹配新 body 形状。
- **Anthropic extra-usage 400 failover** — 上游 third-party extra-usage 余额耗尽返回 `400 { error: { type: "extra_usage_*" } }`,先前未识别,现 `isAnthropicExtraUsageError` 检测后纳入 failover。

### Changed(行为变化)

- **`AccountSnapshot`** 新增 `windowStartedAt` / `windowResetAt` / `windowExpired` / `rateLimit: RateLimitSnapshot | null` 字段;调用方读这些字段不会破坏老 snapshot 反序列化。
- **`AccountManager`**:`recordAttempt(email)` 仅 anthropic 时锚 windowStartedAt;`recordRateLimit(email, headers)` 仅 anthropic 时解析 unified-* headers。`getAvailableAccount(email)` / `listEmails()` 加旁路绕过 sticky routing(给 prewarm 用,均匀打到所有账号)。
- **`/admin/stats`** + **`/admin/stats/timeseries`** 当前对**所有**有效 key 开放(非 admin 也能看全量聚合)。如需收紧到 admin-only,见 OPERATIONS.md §权限。
- **package.json scripts** — 根 + `web/` 都加 `node ./node_modules/<tool>/bin/...` 直调 path,绕过 macOS `/bin/sh` 对 ESM shebang 的不友好。

### Internal(开发/工程)

- **新增前端工程** — `web/`(Vite + React 18 + TypeScript + Tailwind + Chart.js + react-router),独立 `package.json`,build 产物 `web/dist/` gitignored。生产部署只多一步 `cd web && npm install && npm run build`。Dockerfile 多阶段已适配。
- **新模块** — `src/upstream/streaming-failover.ts` (~700 行),`src/admin/oauth.ts`(in-memory pending),`scripts/migrate-config-keys-to-managed.py`(迁移工具)。
- **代码审核两道关** — Claude `/code-review high`(F1-F10)+ OpenAI Codex CLI `codex review`(C1-C3),合计 13 项 P0/P1/P2 修复,全部上主线 + 补测。
- **测试** — 全部既有测试保持绿;mid-stream failover 集成测试在 `tests/` 内补充。

### 升级注意

- v1.0.0 升 v2.0.0 **不需要 schema 迁移**,SQLite 表结构兼容;原 `managed_keys` 数据保留。
- 第一次启动需要 build 前端:`cd web && npm install && npm run build`(生产 tarball 已带 `web/dist/`,免此步)。
- 想用 5h 窗口对齐:在 launchd 配 `com.<user>.auth2api-prewarm.plist`,详见 OPERATIONS.md §5.9。
- 想给同事开看板:不要直接发 admin key — 用 `scripts/auth2api-admin.sh add <name>` 给一把 non-admin key,他们登入后是只读模式,看用量足够。
- 想 https:跟 Caddy 配,见 `docs/CADDY_TLS.md`,plist 模板已经备好。

---

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
