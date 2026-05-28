# auth2api-team 运维与使用手册

本手册面向团队**运维人员与使用者**,覆盖从部署到日常运维、客户端使用、观测与管理的完整流程。代码本身的功能介绍见 [`README_CN.md`](../README_CN.md);改动历史见 [`CHANGELOG.md`](../CHANGELOG.md)。

> 当前线上实例:`172.16.2.31:8317`,以 launchd 用户代理常驻运行。

## 目录

- [1. 项目简介](#1-项目简介)
- [2. 部署](#2-部署)
- [3. 客户端使用](#3-客户端使用)
- [4. 观测](#4-观测)
- [5. 管理](#5-管理)
- [6. 故障排查](#6-故障排查)
- [7. 命令速查](#7-命令速查)

---

## 1. 项目简介

auth2api-team 是基于上游开源 `AmazingAng/auth2api` 的私有团队版,定位为**单进程轻量 OAuth-to-API 网关**:把 Claude / ChatGPT(Codex)/ Cursor 的 OAuth 订阅账号统一暴露成 OpenAI 兼容 API + Anthropic 原生 API,供团队 30 人共用,同时提供 per-key 额度/成本/限流和运行时管理。

**架构一句话**:Node + Express 单进程,文件 + SQLite 持久化,无外部数据库;前端管理 UI 没做,管理走 HTTP API + 配置文件。

**与上游的关系**:`upstream` 远程对应原始开源仓库,会持续 fetch 同步;团队自研在 `origin/main` 上线。详见 [`CHANGELOG.md`](../CHANGELOG.md)。

---

## 2. 部署

### 2.1 系统要求

- **macOS / Linux**(launchd 流程仅 macOS;Linux 用 systemd 等同思路)
- **Node 20+**(本机用 mise 装的 24.14.1)
- 至少 1 个 Claude(或 Codex)账号

### 2.2 一次性初始安装

```bash
# 1. 取代码
cd ~/work/github
git clone git@github.com-panxt:panxt/auth2api-team.git auth2api
cd auth2api

# 2. 装依赖 + 编译
npm install
npm run build

# 3. 复制配置模板并编辑
cp config.example.yaml config.yaml
chmod 600 config.yaml
$EDITOR config.yaml    # 至少留一个有 admin: true 的 api-key

# 4. 登录 OAuth(挑要用的 provider 都做一遍)
npm run login                          # claude(默认)
npm run login -- --provider=codex      # codex(需要 ChatGPT Plus/Pro)
npm run login -- --provider=cursor     # cursor(实验性,可选)
# token 写到 ~/.auth2api/<provider>-<email>.json,mode 0600

# 5. 启动验证
npm run start    # 前台跑,前台跑 OK 后 Ctrl-C 改用 launchd 后台
```

### 2.3 macOS launchd 后台守护

复用 `~/Library/LaunchAgents/com.admin04.auth2api.plist`(已就位):

```xml
<key>ProgramArguments</key>
<array>
  <string>/Users/admin04/.local/share/mise/installs/node/24.14.1/bin/node</string>
  <string>/Users/admin04/work/github/auth2api/dist/index.js</string>
</array>
<key>WorkingDirectory</key>
<string>/Users/admin04/work/github/auth2api</string>
<key>KeepAlive</key><true/>
<key>RunAtLoad</key><true/>
<key>ThrottleInterval</key><integer>10</integer>
<key>StandardOutPath</key><string>/Users/admin04/.claude-token-owner/auth2api.launchd.out.log</string>
<key>StandardErrorPath</key><string>/Users/admin04/.claude-token-owner/auth2api.launchd.err.log</string>
```

加载/启停:

```bash
launchctl load   ~/Library/LaunchAgents/com.admin04.auth2api.plist   # 启动
launchctl unload ~/Library/LaunchAgents/com.admin04.auth2api.plist   # 停止
```

`KeepAlive: true` 会在进程崩溃时自动拉起;`RunAtLoad: true` 会在登录时自启。

### 2.4 更新发版(部署新代码)

```bash
cd ~/work/github/auth2api
git pull                                                          # 拉新代码
npm install                                                       # 若依赖有变
npm run build                                                     # 重新编译 dist/
npm test                                                          # 可选,跑一下回归
launchctl unload ~/Library/LaunchAgents/com.admin04.auth2api.plist
launchctl load   ~/Library/LaunchAgents/com.admin04.auth2api.plist
sleep 2 && curl -s http://172.16.2.31:8317/health                 # 验证
```

重载会产生**几秒停机**,旧 PID 被 kill、新 PID 从新 dist/index.js 启动。

### 2.5 回滚

```bash
git log --oneline -10                # 找上个稳定 commit / tag
git checkout v1.0.0                  # 或具体 commit
npm run build
launchctl unload ~/Library/LaunchAgents/com.admin04.auth2api.plist
launchctl load   ~/Library/LaunchAgents/com.admin04.auth2api.plist
```

> `dist/` 不在 git 里,所以回滚到老 commit 后必须 rebuild。建议给每次部署的 commit 打 tag(`git tag deploy-YYYYMMDD`)便于回退。

### 2.6 移动项目目录

如果要挪本地路径(同卷 `mv` 即可),同时**必须同步更新 plist 的两处路径**(`ProgramArguments[1]` + `WorkingDirectory`),改完 `launchctl unload && load` 让新路径生效。运行中的进程在 `mv` 后仍正常服务(macOS 不会因为目录改名 kill 它),但崩溃自启会用旧路径失败。

---

## 3. 客户端使用

### 3.1 端点一览

| 端点 | 协议格式 | 说明 |
|---|---|---|
| `POST /v1/chat/completions` | OpenAI Chat | 跨 provider 通用最常用 |
| `POST /v1/responses` | OpenAI Responses | 推理模型 + 工具调用首选 |
| `POST /v1/messages` | Anthropic Messages | 原生 Claude 协议 |
| `POST /v1/messages/count_tokens` | Anthropic | token 计数 |
| `GET /v1/models` | OpenAI | 可用模型列表 |
| `GET /health` | — | 无鉴权健康检查 |

### 3.2 鉴权

两种风格都收:

```bash
-H "Authorization: Bearer sk-xxx"      # OpenAI 风格
-H "x-api-key: sk-xxx"                 # Anthropic 风格
```

### 3.3 模型与别名

| 别名 | 解析到 | provider |
|---|---|---|
| `opus` | `claude-opus-4-7` | anthropic |
| `sonnet` | `claude-sonnet-4-6` | anthropic |
| `haiku` | `claude-haiku-4-5-20251001` | anthropic |
| `claude-*` | 同名 | anthropic |
| `gpt-5*` / `o\d*` / `codex-*` | 同名 | codex |
| `cursor-*` / `cr/*` | 同名 | cursor |

省略 `model` 默认 `claude-sonnet-4-6`。完整动态列表:`GET /v1/models`。

### 3.4 推理力度 / Thinking

`reasoning_effort` 在我们这边映射到 Anthropic 的 `thinking.budget_tokens`(上限,模型自行决定是否吃满):

| effort | budget tokens |
|---|---|
| `none` | 0(关闭思考) |
| `minimal` | 512 |
| `low` | 1024 |
| `medium` | 8192 |
| `high` | 24576 |
| `xhigh` | 32768 |

按端点字段名:

- `/v1/chat/completions`:`"reasoning_effort": "high"`
- `/v1/responses`:`"reasoning": { "effort": "high" }`
- `/v1/messages`:`"thinking": { "type": "enabled", "budget_tokens": 8192 }`(可精确指定)

**Haiku 不支持 thinking**,设了也会被忽略。

### 3.5 完整调用示例

OpenAI Chat 风格(最常用):

```bash
curl -sS http://172.16.2.31:8317/v1/chat/completions \
  -H "Authorization: Bearer $API_KEY" -H "Content-Type: application/json" \
  -d '{
    "model": "sonnet",
    "reasoning_effort": "medium",
    "max_tokens": 1024,
    "stream": true,
    "messages": [
      { "role": "user", "content": "解释一下 CAP 定理。" }
    ]
  }'
```

Anthropic 原生:

```bash
curl -sS http://172.16.2.31:8317/v1/messages \
  -H "x-api-key: $API_KEY" -H "Content-Type: application/json" \
  -d '{
    "model": "opus",
    "max_tokens": 2048,
    "thinking": { "type": "enabled", "budget_tokens": 16384 },
    "messages": [{ "role": "user", "content": "..." }]
  }'
```

Codex(gpt-5 系列,需 ChatGPT Plus/Pro 账号):

```bash
curl -sS http://172.16.2.31:8317/v1/responses \
  -H "Authorization: Bearer $API_KEY" -H "Content-Type: application/json" \
  -d '{
    "model": "gpt-5.5",
    "reasoning": { "effort": "high" },
    "input": "..."
  }'
```

Claude Code / Codex CLI / Cursor 都可以把 base URL 指到 `http://172.16.2.31:8317`,然后用你的 api-key 当 token,即可"借"团队的订阅账号用。

---

## 4. 观测

### 4.1 健康与账号

```bash
# 健康(无鉴权)
curl -s http://172.16.2.31:8317/health

# 每个 provider 的账号健康(token 过期、最近成功/失败、当下是否冷却)
curl -s http://172.16.2.31:8317/admin/accounts -H "Authorization: Bearer $API_KEY"
```

`accounts.<provider>.accounts[*]` 包含:`email`、`available`、`cooldownUntil`、`failureCount`、`lastError`、`lastSuccessAt`、`lastRefreshAt`、`expiresAt`、累计 token 用量等。

### 4.2 调用统计(含成本)

```bash
curl -s http://172.16.2.31:8317/admin/stats -H "Authorization: Bearer $API_KEY"
```

返回三个聚合视图,**每个桶都带 `totalCostUsd`**(按事件自己的 model 精确计价,改单价对历史立即生效):

- `byClient`:按 sha256(api-key) 哈希分桶,显示哪个客户端用了多少
- `byAccount`:按上游账号(provider + email)分桶,看负载分布
- `byApi`:按 `endpoint | model | provider` 分桶,看模型分布
- `totals`:全局汇总

### 4.3 各 key 当月用量 vs 配额

```bash
curl -s http://172.16.2.31:8317/admin/usage/keys -H "Authorization: Bearer $API_KEY"
```

admin key 看全部、非 admin 只看自己。每条返回:
```json
{
  "apiKeyShort": "5e3b2c1d0f...",
  "label": "alice / dev",
  "owner": "alice@example.com",
  "admin": false,
  "enabled": true,
  "quota": { "monthly-tokens": 5000000, "monthly-cost-usd": 50 },
  "consumed": { "tokens": 1234567, "costUsd": 7.89 },
  "usage": {
    "tokens": { "used": 1234567, "cap": 5000000, "remaining": 3765433, "percent": 0.246 },
    "cost":   { "used": 7.89, "cap": 50, "remaining": 42.11, "percent": 0.157 }
  }
}
```

### 4.4 直接查 SQLite 数据

```bash
sqlite3 ~/.auth2api/auth2api.db
# 表:usage_events(id, ts, data JSON)  +  managed_keys(key, data JSON)
```

常用查询:

```sql
-- 今天每个模型的 token 数与请求数
SELECT
  json_extract(data,'$.model')       AS model,
  json_extract(data,'$.provider')    AS provider,
  COUNT(*)                           AS requests,
  SUM(json_extract(data,'$.usage.inputTokens'))  AS in_tok,
  SUM(json_extract(data,'$.usage.outputTokens')) AS out_tok
FROM usage_events
WHERE ts >= date('now','start of day')
GROUP BY model, provider
ORDER BY requests DESC;

-- 最近 10 条失败
SELECT ts, json_extract(data,'$.endpoint'), json_extract(data,'$.statusCode'),
       json_extract(data,'$.failureKind')
FROM usage_events
WHERE json_extract(data,'$.status') = 'failure'
ORDER BY id DESC LIMIT 10;

-- 按客户端 top 用量
SELECT
  json_extract(data,'$.apiKeyHash') AS key_hash,
  COUNT(*) AS requests,
  SUM(json_extract(data,'$.usage.inputTokens') + json_extract(data,'$.usage.outputTokens')) AS tokens
FROM usage_events
GROUP BY key_hash
ORDER BY tokens DESC LIMIT 10;
```

### 4.5 launchd 日志

```bash
tail -f ~/.claude-token-owner/auth2api.launchd.out.log    # 启动 banner + 控制台输出
tail -f ~/.claude-token-owner/auth2api.launchd.err.log    # 错误堆栈
```

---

## 5. 管理

### 5.1 API key 两种模式 + 用哪种

| 模式 | 来源 | 改动方式 | 适合 |
|---|---|---|---|
| **静态(config)** | `config.yaml` 的 `api-keys:` | 编辑 yaml + 重启/重载 | bootstrap key、admin key、稳定不变的核心 key |
| **托管(managed)** | `/admin/keys` API,存 SQLite | HTTP CRUD,即时生效 | 日常给新成员发 key、改额度、临时禁用 |

**关键不变量**:程序**永远不会改写 `config.yaml`**(保护你的注释)。托管 key 与静态 key 同 key 字符串时,**托管覆盖**。删除静态 key 必须改 yaml 重启;托管 key 用 API 删即可。

### 5.2 配 admin key(必备,否则没法用 `/admin/keys`)

在 `config.yaml` 把至少一个 key 改成对象形式 + `admin: true`:

```yaml
api-keys:
  - key: "sk-existing-bootstrap-key"
    label: "ops bootstrap"
    admin: true
  - "sk-other-team-key"   # 字符串形式仍可用,默认非 admin
```

`launchctl unload && load` 后生效。**或者**调 `/admin/reload` 重新读 token(注意 reload 只重读 token 文件,**不重读 config.yaml**;改 api-keys 必须整进程重启)。

### 5.3 用 `/admin/keys` 增删改 key

```bash
ADMIN=sk-your-admin-key

# 列出所有 key(只回 id + 策略,不回明文)
curl -s http://172.16.2.31:8317/admin/keys -H "Authorization: Bearer $ADMIN" | jq

# 新建一个带配额和限流的 key —— 响应里 .key 是一次性明文,务必复制保存
curl -sS http://172.16.2.31:8317/admin/keys \
  -H "Authorization: Bearer $ADMIN" -H "Content-Type: application/json" \
  -d '{
    "label": "alice / dev",
    "owner": "alice@example.com",
    "quota":      { "monthly-tokens": 50000000, "monthly-cost-usd": 200 },
    "rate-limit": { "rpm": 120, "concurrency": 8 }
  }' | jq

# 改某 key(用返回的 id,前 12 位 hex)—— null 可清除字段
curl -sS -X PATCH http://172.16.2.31:8317/admin/keys/<id> \
  -H "Authorization: Bearer $ADMIN" -H "Content-Type: application/json" \
  -d '{ "enabled": false }'           # 临时禁用
# -d '{ "quota": { "monthly-tokens": 100000000 } }'   # 提高额度
# -d '{ "quota": null }'                              # 清掉配额

# 吊销
curl -sS -X DELETE http://172.16.2.31:8317/admin/keys/<id> \
  -H "Authorization: Bearer $ADMIN"
```

托管 key 持久到 `~/.auth2api/auth2api.db` 的 `managed_keys` 表,**所有变更对正在跑的服务立即生效**(同步更新内存里的 live map)。

### 5.4 配额超额时下游看到什么

超 `monthly-tokens` 或 `monthly-cost-usd`:

```http
HTTP/1.1 429 Too Many Requests
Retry-After: <seconds-until-UTC-month-end>
Content-Type: application/json

{ "error": { "message": "Monthly token quota exceeded", "type": "quota_exceeded" } }
```

超 per-key `rpm` 或 `concurrency`:

```http
HTTP/1.1 429 Too Many Requests
{ "error": { "message": "Per-key request rate limit exceeded", "type": "rate_limit" } }
```

### 5.5 OAuth 上游账号管理

```bash
# 添加新账号(浏览器自动回调)
npm run login                          # claude
npm run login -- --provider=codex      # codex

# 远程服务器(无浏览器),用手动模式
npm run login -- --manual

# 查看账号状态
curl -s http://172.16.2.31:8317/admin/accounts -H "Authorization: Bearer $API_KEY"

# 重新从磁盘加载 token(`--login` 完成后会自动调,手动改 token 文件后用)
curl -sS -X POST http://172.16.2.31:8317/admin/reload -H "Authorization: Bearer $API_KEY"
```

多账号自动**粘性轮换 + 故障转移**:同一个客户端会粘在同一上游账号一段时间(默认 20–60 分钟),账号被限流/出错时自动切到下一个;**403/额度耗尽现在也会同请求内 failover 到其他账号**(需要 ≥2 个账号且其中至少一个有额度才有效)。

### 5.6 成本单价覆盖

默认表在 `src/usage/pricing.ts` 的 `DEFAULT_PRICING`(Anthropic 是公开价,Codex `gpt-*` 是估算)。覆盖某个 model 的单价,在 `config.yaml` 加:

```yaml
pricing:
  gpt-5.5:
    inputPerMTok: 1.25
    outputPerMTok: 10
    cacheWritePerMTok: 0       # codex 没有 cache write
    cacheReadPerMTok: 0.125
```

重启后生效,**对历史数据也立即生效**(stats 会按当前单价回算)。

### 5.7 存储后端切换

默认 `sqlite`(单 DB 文件,`WAL` 模式,自带 `-wal`/`-shm` 伴随文件)。回退 file:

```yaml
storage:
  backend: file
  # sqlite-path: "..."   # 仅 sqlite 时生效;支持 ~ 与相对 auth-dir
```

切换后重启即可。**数据不互通**(file → sqlite 不自动迁移);如需保留历史 stats,先备份 `~/.auth2api/` 再切。

---

## 6. 故障排查

### 6.1 服务起不来 / 立即崩溃

```bash
tail -100 ~/.claude-token-owner/auth2api.launchd.err.log
```

常见原因:

- **better-sqlite3 加载失败**(原生模块版本不匹配):看到 `sqlite backend unavailable; falling back to file backend` 是**正常回退**,服务继续可用(用 file 后端);`stats.jsonl` 会取代 `auth2api.db`。
- **端口 8317 被占**:`lsof -nP -iTCP:8317 -sTCP:LISTEN` 看是谁,旧实例没退干净 → `launchctl unload` 再 load。
- **config.yaml 语法错**:js-yaml 报错会在 stderr。
- **没账号可用**:`No accounts found. Run with --login` → 跑一次 `npm run login`。

### 6.2 客户端老报 403 / 上游额度

- 看 `/admin/accounts`:**所有账号都进 cooldown 了?** `lastError` 通常包含具体信息。
- 通常上游 403 = third-party extra usage 没额度。本版本会**自动跨账号 failover**(若有别的账号),全部耗尽时透传真实上游错误给下游。
- **解决路径**:加额度(Claude/Codex 后台)或加账号(`npm run login` 再来一个)。

### 6.3 token 刷新失败 / RefreshTokenExhaustedError

`/admin/accounts` 里看到某账号 `cooldownUntil` 是 24 小时后,`lastError` 提示 refresh token 被作废 → **需要手动重新登录该 provider**:

```bash
npm run login -- --provider=<provider>     # claude / codex / cursor
```

特别提醒:codex 每次刷新都会轮转 refresh token,**多实例同时刷新会触发 `refresh_token_reused`**。不要在多台机器同时跑同一个 codex 账号的 auth2api。

### 6.4 数据库锁住 / WAL 残留

WAL 模式下若进程异常退出可能留下 `-wal` 文件。正常下次启动 sqlite 会自动恢复。要硬重置:

```bash
# 停服务
launchctl unload ~/Library/LaunchAgents/com.admin04.auth2api.plist
# 检查
sqlite3 ~/.auth2api/auth2api.db "PRAGMA integrity_check;"
# 极端情况备份后删 WAL
mv ~/.auth2api/auth2api.db{,.bak}
mv ~/.auth2api/auth2api.db-wal ~/.auth2api/auth2api.db-wal.bak 2>/dev/null
mv ~/.auth2api/auth2api.db-shm ~/.auth2api/auth2api.db-shm.bak 2>/dev/null
# 启动会自建新库
launchctl load ~/.../com.admin04.auth2api.plist
```

### 6.5 用量统计与上游账单不符

- **codex 估算单价不准**:覆盖 `pricing:` 段(见 5.6)。
- **流式中断 / 客户端断开**:这些请求记 `status: "failure"`,usage 可能为空或部分;token 已被上游消耗但我们看不全。可接受的微差。
- **/admin/stats 是从启用 stats 后开始累计**,旧的运行未启用时数据缺失。

---

## 7. 命令速查

| 场景 | 命令 |
|---|---|
| 启动 | `launchctl load ~/Library/LaunchAgents/com.admin04.auth2api.plist` |
| 停止 | `launchctl unload ~/Library/LaunchAgents/com.admin04.auth2api.plist` |
| 重启(部署新版/重载配置) | `launchctl unload ... && launchctl load ...` |
| 看实时日志 | `tail -f ~/.claude-token-owner/auth2api.launchd.{out,err}.log` |
| 看是否在跑 | `lsof -nP -iTCP:8317 -sTCP:LISTEN` |
| 编译 | `npm run build` |
| 跑测试 | `npm test`(244 个) |
| 新增 claude 账号 | `npm run login` |
| 新增 codex 账号 | `npm run login -- --provider=codex` |
| 重新加载 token(无需重启) | `curl -X POST -H "Authorization: Bearer $K" .../admin/reload` |
| 健康检查 | `curl http://172.16.2.31:8317/health` |
| 看账号状态 | `curl -H "Authorization: Bearer $K" .../admin/accounts` |
| 看用量+成本 | `curl -H "Authorization: Bearer $K" .../admin/stats` |
| 看各 key 额度 | `curl -H "Authorization: Bearer $K" .../admin/usage/keys` |
| 新建托管 key | `curl -X POST -H "Authorization: Bearer $ADMIN" -d '{...}' .../admin/keys` |
| 查 sqlite | `sqlite3 ~/.auth2api/auth2api.db "..."` |
| 同步上游 | `git fetch upstream && git merge upstream/main` |
| 发新版 | `git pull && npm install && npm run build && launchctl unload && launchctl load` |
| 回滚 | `git checkout v1.0.0 && npm run build && launchctl unload && launchctl load` |
