# auth2api-team 运维与使用手册

本手册面向团队**运维人员与使用者**,覆盖从部署到日常运维、客户端使用、观测与管理的完整流程。代码本身的功能介绍见 [`README_CN.md`](../README_CN.md);改动历史见 [`CHANGELOG.md`](../CHANGELOG.md)。

> **Heads-up**:本文档示例使用占位符(`<HOST>`、`<user>`、`<your-user>` 等),请按你自己的部署环境替换。launchd 例子仅适用于 macOS;Linux / Docker 用户参考 `Dockerfile` 与 `docker-compose.yml`。

> 当前线上实例:`<HOST>:8317`,以 launchd 用户代理常驻运行。

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
git clone git@github.com:<your-user>/auth2api-team.git auth2api
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

复用 `~/Library/LaunchAgents/com.<user>.auth2api.plist`(已就位):

```xml
<key>ProgramArguments</key>
<array>
  <string>~/.local/share/mise/installs/node/24.14.1/bin/node</string>
  <string>~/path/to/auth2api/dist/index.js</string>
</array>
<key>WorkingDirectory</key>
<string>~/path/to/auth2api</string>
<key>KeepAlive</key><true/>
<key>RunAtLoad</key><true/>
<key>ThrottleInterval</key><integer>10</integer>
<key>StandardOutPath</key><string>~/.claude-token-owner/auth2api.launchd.out.log</string>
<key>StandardErrorPath</key><string>~/.claude-token-owner/auth2api.launchd.err.log</string>
```

加载/启停:

```bash
launchctl load   ~/Library/LaunchAgents/com.<user>.auth2api.plist   # 启动
launchctl unload ~/Library/LaunchAgents/com.<user>.auth2api.plist   # 停止
```

`KeepAlive: true` 会在进程崩溃时自动拉起;`RunAtLoad: true` 会在登录时自启。

### 2.4 更新发版(部署新代码)

```bash
cd ~/work/github/auth2api
git pull                                                          # 拉新代码
npm install                                                       # 若依赖有变
npm run build                                                     # 重新编译 dist/
npm test                                                          # 可选,跑一下回归
launchctl unload ~/Library/LaunchAgents/com.<user>.auth2api.plist
launchctl load   ~/Library/LaunchAgents/com.<user>.auth2api.plist
sleep 2 && curl -s http://<HOST>:8317/health                 # 验证
```

重载会产生**几秒停机**,旧 PID 被 kill、新 PID 从新 dist/index.js 启动。

### 2.5 回滚

```bash
git log --oneline -10                # 找上个稳定 commit / tag
git checkout v1.0.0                  # 或具体 commit
npm run build
launchctl unload ~/Library/LaunchAgents/com.<user>.auth2api.plist
launchctl load   ~/Library/LaunchAgents/com.<user>.auth2api.plist
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
curl -sS http://<HOST>:8317/v1/chat/completions \
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
curl -sS http://<HOST>:8317/v1/messages \
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
curl -sS http://<HOST>:8317/v1/responses \
  -H "Authorization: Bearer $API_KEY" -H "Content-Type: application/json" \
  -d '{
    "model": "gpt-5.5",
    "reasoning": { "effort": "high" },
    "input": "..."
  }'
```

Claude Code / Codex CLI / Cursor 都可以把 base URL 指到 `http://<HOST>:8317`,然后用你的 api-key 当 token,即可"借"团队的订阅账号用。

---

## 4. 观测

### 4.1 健康与账号

```bash
# 健康(无鉴权)
curl -s http://<HOST>:8317/health

# 每个 provider 的账号健康(token 过期、最近成功/失败、当下是否冷却)
curl -s http://<HOST>:8317/admin/accounts -H "Authorization: Bearer $API_KEY"
```

`accounts.<provider>.accounts[*]` 包含:`email`、`available`、`cooldownUntil`、`failureCount`、`lastError`、`lastSuccessAt`、`lastRefreshAt`、`expiresAt`、累计 token 用量等。

### 4.2 调用统计(含成本)

```bash
curl -s http://<HOST>:8317/admin/stats -H "Authorization: Bearer $API_KEY"
```

返回三个聚合视图,**每个桶都带 `totalCostUsd`**(按事件自己的 model 精确计价,改单价对历史立即生效):

- `byClient`:按 sha256(api-key) 哈希分桶,显示哪个客户端用了多少
- `byAccount`:按上游账号(provider + email)分桶,看负载分布
- `byApi`:按 `endpoint | model | provider` 分桶,看模型分布
- `totals`:全局汇总

### 4.3 各 key 当月用量 vs 配额

```bash
curl -s http://<HOST>:8317/admin/usage/keys -H "Authorization: Bearer $API_KEY"
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
curl -s http://<HOST>:8317/admin/keys -H "Authorization: Bearer $ADMIN" | jq

# 新建一个带配额和限流的 key —— 响应里 .key 是一次性明文,务必复制保存
curl -sS http://<HOST>:8317/admin/keys \
  -H "Authorization: Bearer $ADMIN" -H "Content-Type: application/json" \
  -d '{
    "label": "alice / dev",
    "owner": "alice@example.com",
    "quota":      { "monthly-tokens": 50000000, "monthly-cost-usd": 200 },
    "rate-limit": { "rpm": 120, "concurrency": 8 }
  }' | jq

# 改某 key(用返回的 id,前 12 位 hex)—— null 可清除字段
curl -sS -X PATCH http://<HOST>:8317/admin/keys/<id> \
  -H "Authorization: Bearer $ADMIN" -H "Content-Type: application/json" \
  -d '{ "enabled": false }'           # 临时禁用
# -d '{ "quota": { "monthly-tokens": 100000000 } }'   # 提高额度
# -d '{ "quota": null }'                              # 清掉配额

# 吊销
curl -sS -X DELETE http://<HOST>:8317/admin/keys/<id> \
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
curl -s http://<HOST>:8317/admin/accounts -H "Authorization: Bearer $API_KEY"

# 重新从磁盘加载 token(`--login` 完成后会自动调,手动改 token 文件后用)
curl -sS -X POST http://<HOST>:8317/admin/reload -H "Authorization: Bearer $API_KEY"
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

### 5.8 5h 窗口 Prewarm 自动调度

Anthropic Pro/Max 订阅的 5h 速率限制窗口**不是定时滚动**,而是**"发出第一条消息那一刻"开始计时**。窗口结束后还要等下一条消息才会开新窗口。

也就是说:**可以人为提前发 ping 把窗口重置点挪到工作时段中间**,让工作时段跨越 2 个完整窗口,理论上限 +80% 配额。

> **✅ 推荐方式(v2.3+):页面内置调度器。** 暖机已内建到服务进程,可在管理页 **账号 → ⚡ 窗口暖机调度 (Prewarm)** 卡片里直接配置:开关、触发时间(可多点)、套用推荐、立即暖机,并实时显示每次暖机结果(哪些账号成功/失败、延迟)。配置经 SettingsStore 持久化、热生效、跨平台,**无需 launchd / cron**。
>
> 下面的 launchd / crontab 方式(§5.8.2–§5.8.6)是旧部署的备选;**已用 launchd 的实例升级后请按 §5.8.8 卸载,避免与内置调度重复触发。**

#### 5.8.1 数学

工作时段 `[start, end]`(长度 W 小时)、ping 时刻 P,Anthropic 窗口长度 5h:

- 不优化 → 工作时段触及窗口数 = `ceil(W / 5)`(W ≤ 5h 时 = 1,5 < W ≤ 10 时 = 2)
- ping 在工作开始前(P < start)→ 让重置点 `P + 5h` 落在 `[start, end]` 内 = 工作时段跨 2 个窗口

**最优 ping 时刻 = 工作中点 - 5h**。对工作时段 8:30-17:30(W=9h):
- 中点 13:00,P = 13:00 - 5h = **8:00 AM**
- 窗口 1: 8:00-13:00,窗口 2: 13:00-18:00
- 工作时段覆盖每窗口 4.5h(90%)→ 单账号有效配额 1.8X

对 N 个账号:**总配额 ≈ N × 1.8X**(vs 不优化时 N × 1X)= **+80%**。

#### 5.8.2 安装

仓库下 `scripts/com.example.auth2api.prewarm.example.plist` 是默认 8:00 AM **每天**(含周末)触发的 plist 模板:

```bash
# 复制模板到 LaunchAgents,改路径/用户名(模板里所有 <user> 都要替换)
cp scripts/com.example.auth2api.prewarm.example.plist \
  ~/Library/LaunchAgents/com.<user>.auth2api.prewarm.plist

# 编辑修改路径(REPO_DIR、HOME、StandardOutPath 等)
# 然后 load
launchctl load ~/Library/LaunchAgents/com.<user>.auth2api.prewarm.plist

# 验证
launchctl list | grep prewarm   # 应该出现一行,LastExitStatus=0
launchctl start com.<user>.auth2api.prewarm   # 手动立即跑一次,验证

# 日志
tail -f ~/.<your-log-dir>/auth2api.prewarm.out.log
```

plist 关键字段:
```xml
<key>StartCalendarInterval</key>
<dict>
  <key>Hour</key><integer>8</integer>
  <key>Minute</key><integer>0</integer>
</dict>
```

**省略 `Weekday`** = 每天都跑(用户要求周末也激活,避免周一冷启动)。如果你只想工作日跑,把上面改成:
```xml
<key>StartCalendarInterval</key>
<array>
  <dict><key>Weekday</key><integer>1</integer><key>Hour</key><integer>8</integer><key>Minute</key><integer>0</integer></dict>
  <!-- ... 2-5 同样 -->
</array>
```

#### 5.8.3 手动触发

```bash
# 立即给所有上游账号发一条 ping
./scripts/auth2api-admin.sh prewarm

# 或直接打 HTTP(admin key)
curl -X POST -H "Authorization: Bearer <ADMIN_KEY>" http://127.0.0.1:8317/admin/prewarm | jq

# Dry-run:只列出会被 ping 的账号
./scripts/auth2api-admin.sh prewarm --dry-run
```

成功输出形如:
```
═══ anthropic ═══
  ✓ a@example.com    1101ms  (in=8, out=1)
  ✓ b@example.com     980ms  (in=8, out=1)
  ✓ c@example.com    1240ms  (in=8, out=1)
Total: 3/3 accounts prewarmed
```

每次 ping 消耗 ≈ **9 token**(haiku),价格基本可忽略(0.0001 USD)。

#### 5.8.4 调整 ping 时刻

ping 时刻应**落在工作中点 - 5h**。常见工作时段对应:

| 工作时段 | 工作中点 | ping 时刻 | 窗口覆盖 |
|---|---|---|---|
| 8:30 - 17:30 | 13:00 | **8:00** | 8:00-13:00, 13:00-18:00 |
| 9:00 - 18:00 | 13:30 | **8:30** | 8:30-13:30, 13:30-18:30 |
| 10:00 - 19:00 | 14:30 | **9:30** | 9:30-14:30, 14:30-19:30 |

改 plist 里的 `Hour` / `Minute` 后 `launchctl unload + load` 生效。

#### 5.8.5 工作时段 ≤ 5h 的情况

如果你工作时段比一个窗口短(比如下午 2-6 PM 共 4h):

- 不优化:1 个窗口(start 时触发,end 时还没满 5h)
- ping 在工作前 1h(13:00 ping → 工作 14:00,窗口 1 用 14-18 = 4h)
- ping 在工作前 3h(11:00 ping → 窗口 1: 11-16,窗口 2: 16-21;工作 14-18 跨 2 个窗口)→ **配额翻倍**

短工作时段时,文章说的"工作前 3h"是对的。长工作时段(≥ 5h)按 §5.8.4 的"工作中点 - 5h"。

#### 5.8.6 跨平台(给同事自己的本地代理)

如果同事在自己机器上跑了本地代理,他们配自己的 prewarm:

**Linux**(crontab):
```bash
# 每天 8:00 触发本地代理的 prewarm endpoint
0 8 * * * curl -fsS -X POST -H "Authorization: Bearer $(cat ~/.auth2api-admin.key)" \
  http://127.0.0.1:8317/admin/prewarm > /tmp/auth2api.prewarm.log 2>&1
```

**Windows**(任务计划程序):创建任务 → 触发器每天 8:00 → 操作:
```
powershell.exe -Command "Invoke-RestMethod -Method POST -Uri http://127.0.0.1:8317/admin/prewarm -Headers @{Authorization='Bearer YOUR_KEY'}"
```

#### 5.8.7 注意

- ping 失败**不进 cooldown**(best-effort,失败只是当天少跨一个窗口)
- **周配额**也是 Anthropic 的硬限,prewarm 不能突破。但每天 1 个 ping × 9 tokens × 7 天 ≈ 63 tokens / 周,几乎零成本
- 服务必须在触发时刻处于 healthy 状态;内置调度器随主进程运行,主进程 healthy 即可(launchd 守护已保证常驻)

#### 5.8.8 从 launchd 迁移到内置调度器(v2.3+)

升级到含内置调度器的版本后,内置调度器默认即 **启用、08:00**(等同原 launchd 配置)。此时旧的 launchd prewarm 任务会**重复触发**——无害(多发一次 ≈9 token 的 ping),但应卸载以免混淆:

```bash
# 1) 卸载并删除旧的 prewarm launchd 任务(注意:是 prewarm 那个,不是主服务 plist)
launchctl unload ~/Library/LaunchAgents/com.<user>.auth2api.prewarm.plist
rm        ~/Library/LaunchAgents/com.<user>.auth2api.prewarm.plist

# 2) 确认已不在运行
launchctl list | grep prewarm   # 应无输出

# 3) 在管理页 账号 → ⚡ 窗口暖机调度 里确认 enabled + 时间,点「立即暖机一次」验证
#    或命令行:./scripts/auth2api-admin.sh prewarm
```

> 只删 `*.prewarm.plist`,**不要动主服务 plist**(`com.<user>.auth2api.plist`)。
> 若想继续用 launchd(例如想让暖机独立于主进程的崩溃窗口),也可保留 launchd 而在页面里把内置调度 **停用**,二选一即可。

### 5.9 TLS 前置:给 Cowork / 桌面 enterprise 客户端用

新版 Claude 桌面客户端(Cowork 3P)对自定义 baseUrl **强制要求 https 或 http://loopback**,直接拒绝 `http://172.16.x.x:xxxx` 形式的明文 URL。

解决方案:在 auth2api 前面放一个 **Caddy** 反代,Caddy 终结 TLS,反代到本地的 auth2api。

完整部署手册(数学原理、Caddyfile / plist 模板、客户端信任 CA、回滚)见 **[`docs/CADDY_TLS.md`](CADDY_TLS.md)**。

仓库里提供的入库模板:
- `scripts/Caddyfile.example` — Caddy 配置模板(`tls internal` + 反代 + 流式 `flush_interval -1`)
- `scripts/com.example.caddy.example.plist` — launchd 守护模板

工作量:host 侧 ~30 分钟,每个客户端 ~5 分钟(装 root CA + 改 baseUrl)。

### 5.10 管理看板 `/ui/`

浏览器里完成 80% 日常运维 — API key CRUD、配额管理、上游账号 5h/7 天窗口监控、用量大屏、新增 Anthropic / Codex 账号(manual OAuth)。

#### 5.10.1 入口

| 入口 | URL | 说明 |
|---|---|---|
| 本机 | `http://127.0.0.1:8317/ui/` | host 自身 |
| 内网 | `http://<HOST>:8317/ui/` | 公司内网同事 |
| TLS 走 Caddy | `https://<HOSTNAME>:8443/ui/` | 走 §5.9 部署的 Caddy,可被 Cowork 共用 |

#### 5.10.2 登录

第一次进入 `/ui/` → 提示输入 **admin API key**(`admin: true` 的)。粘贴 → 后端 `GET /admin/ui/whoami` 校验 → 成功后 key 存 `localStorage`,后续 fetch 自动带 `Authorization: Bearer <key>`。"退出登录"按钮清掉 localStorage。

> 普通(非 admin)key 也能登,但只看得到自己一条 key + 不能改 / 删别人。所有 `/admin/*` 端点的权限模型在 UI 层重用,不另起一套。

#### 5.10.3 五个页面

| 路径 | 主要内容 |
|---|---|
| `/ui/stats` | KPI 卡片(总成本 / 总 token / 成功率 / 平均延迟 / 账号健康)+ 近 30 天每日成本堆叠折线 + 成本按模型 / 请求按端点饼图 + Top 10 客户端 + 配额完成度进度条 + 账号健康表。30s 自动刷新 |
| `/ui/users` | API key 列表(merge config + managed)+ 新增 / 编辑 / 启停 / 删除。config 来源的 key 灰显只读(改它要编辑 yaml + 重启)|
| `/ui/accounts` | 每个上游账号一张配额面板:5h 窗口用量条 + reset 倒计时(来自 Anthropic `unified-*` headers)、7 天周窗口、Retry-After 横幅;⚡立即 Prewarm 按钮;+ 新增账号按钮(manual OAuth)|
| `/ui/oauth-add-modal` | 在 `/ui/accounts` 触发的 manual OAuth 模态:三步向导,粘贴 callback URL 完成添加 |

#### 5.10.4 构建 + 部署

UI 是独立 npm 工程 `web/`,build 产物落 `web/dist/`。Express 启动时 `app.use('/ui', express.static(web/dist))`。

```bash
# 首次安装:装 web 依赖 + 构建
cd ~/path/to/auth2api/web
npm install
npm run build           # 输出 web/dist/index.html + bundle

# 后端发版后顺手 build UI(分别需要时再跑)
cd web && npm run build && cd ..

# 重启服务让新 bundle 生效
launchctl unload ~/Library/LaunchAgents/com.<user>.auth2api.plist
launchctl load   ~/Library/LaunchAgents/com.<user>.auth2api.plist
```

> Dockerfile / 多阶段 build:还没接(plan 里的 v0.4 项),目前是手工 build。

#### 5.10.5 注意

- **不要把 admin key 群发**。同事不需要看后台,他们只要 `sk-` 业务 key(非 admin)就够调用 API
- localStorage 存 admin key 等价于"浏览器内常驻凭证";关浏览器、退电脑前注意是不是公用机器
- UI bundle 是无鉴权静态托管的(JS / CSS 公开),所有 `/admin/*` API 才是鉴权的;别在 UI bundle 里塞秘密(代码里没有)

### 5.11 失败转移 / Failover 模型

代理对上游错误有 **两层失败转移**机制:

#### 5.11.1 Pre-stream(HTTP 状态码层)

实现:`src/utils/http.ts` 的 `proxyWithRetry`。

上游返 4xx / 5xx / 网络错误 / 超时 ─→ 当前账号 cooldown(按 §3.1 表)─→ `getNextAccount()` 自动换下一个 ─→ 重试。

可失败转移的状态码:
- **401** Auth 失败:刷新 token,刷新后还 401 → cooldown 当前 + 换下一个
- **403** Forbidden(额度耗尽 / 权限问题):cooldown + 换
- **400 with "extra usage" 错误体**:同 403 处理(Anthropic 把账号超额信号写在 400 里,内容含 `third-party apps now draw from extra usage` 字符串)
- **429** Rate-limited:cooldown(短),换
- **5xx** 上游故障:cooldown(短),换
- 网络错误 / 连接拒绝 / 超时:cooldown,换

不失败转移的(直接转发给客户端):
- 4xx 客户端错误(messages 缺失、model 不支持等)— 业务问题,跟账号无关

#### 5.11.2 Mid-SSE-stream(SSE 流内事件层)

实现:`src/upstream/streaming-failover.ts`。

上游返 **200 OK** 后开始流 SSE,但中间塞 `event: error`(Anthropic 越来越多用这种方式表达限流):

```
HTTP/1.1 200 OK
event: message_start
data: {"type":"message_start",...}

event: error
data: {"type":"error","error":{"type":"rate_limit_error","message":"..."}}
```

之前这种情况 `proxyWithRetry` 已经不管(状态码 200 → success callback),客户端看到坏掉的流。

**现在**:加新的 `proxyStreamingWithFailover` helper,在 SSE 流开头**缓冲** 字节,看到首个 content delta 才 commit + flush 给客户端。期间如果碰到可失败转移的 error event(`rate_limit_error` / `overloaded_error` / `authentication_error` / "extra usage" 文本)→ 丢缓冲、cooldown 当前账号、自动用下一个账号重发 → 客户端透明。

接入端点:

| 端点 | 上游 | 流式失败转移 |
|---|---|---|
| `/v1/messages` | anthropic | ✓ |
| `/v1/messages` | codex(经协议翻译)| ✓ |
| `/v1/chat/completions` | anthropic(经翻译)| ✓ |
| `/v1/responses` | anthropic(经翻译)| ✓ |
| 上述 | cursor | 仅 pre-stream(协议特殊,后续)|

#### 5.11.3 边界

- **commit 后不再转移**:一旦字节流到客户端,新账号的输出会跟旧的拼不上,后续 error 只能转发
- **64 KB 缓冲上限**:极端情况(上游卡着不吐 content delta)强制 commit 切 passthrough,避免内存爆
- **粘性窗口**:`getNextAccount()` 仍尊重粘性策略(20-60min 锚定);失败转移强制释放粘性

#### 5.11.4 如何观察失败转移在工作

```bash
# launchd 日志会打 "mid-stream failover from xxx@..." 这样的行
tail -f ~/.<your-log-dir>/auth2api.launchd.out.log | grep -iE "failover|cooldown"
```

或者看 `/ui/accounts` 页:某个账号被打了几次 mid-stream 失败,会反映在 `totalFailures` 数和 cooldown 状态上。

### 5.12 把 config.yaml 里的 key 迁到 managed(SQLite)

`config.yaml` 里手写的 key 是**只读**的(程序永不改写 yaml,见 §5.1)。如果想让某些 key 通过 UI / `POST /admin/keys` 增删改,就要把它们**迁移到 SQLite 的 `managed_keys` 表**。**Key 字符串保持不变**,同事客户端不用动。

#### 5.12.1 一次性迁移脚本

仓库自带 `scripts/migrate-config-keys-to-managed.py`,纯标准库(只依赖 sqlite3 + 文件 IO),无需额外依赖。

```bash
cd ~/path/to/auth2api

# 1. 预览要迁哪些(不写库)
./scripts/migrate-config-keys-to-managed.py --dry-run
# 输出会列出:
#   - admin 标记的 key → skip(留在 yaml 当 bootstrap)
#   - 非 admin key → 待迁,显示 yaml 行号

# 2. 停服务(脚本默认会拒绝在服务运行时写库,避免被 ManagedKeyStore.persist() 反向覆盖)
launchctl unload ~/Library/LaunchAgents/com.$USER.auth2api.plist

# 3. 执行迁移
./scripts/migrate-config-keys-to-managed.py
# → INSERT OR REPLACE INTO managed_keys (key, data) VALUES (...)
# → 打印还要手动删的 yaml entries(脚本不动 yaml,避免破坏注释)

# 4. 按脚本提示编辑 config.yaml,删掉迁过去的 entries
#    (留 admin: true 那条不要删)
$EDITOR config.yaml

# 5. 重启服务
launchctl load ~/Library/LaunchAgents/com.$USER.auth2api.plist

# 6. 验证 — managed key 现在在 UI 里可编辑
curl -s -H "Authorization: Bearer <admin>" http://127.0.0.1:8317/admin/keys | jq
# 应该看到迁过去的 key,source: "managed"
```

> 不停服务也能跑(加 `--force`),但**有竞态风险**:如果迁移期间有任何
> `/admin/keys` POST/PATCH/DELETE,运行中的 `ManagedKeyStore.persist()` 会
> 用内存里的 managed set 全量重写表(`replaceAll` 语义),我们刚 INSERT
> 的行会被丢掉。10s 重启窗口换确定性,值。

#### 5.12.2 为什么不动 yaml

`migrate-config-keys-to-managed.py` **写 SQLite,不动 yaml**。原因:

- yaml 里有手写注释、字段顺序、缩进风格,程序写会破坏
- 让人手动改 yaml,留 git diff 痕迹,知道哪几行被删了
- 脚本只打印 "你要删第 N 行起的 entry",不替你按 enter

如果你确定 yaml 没注释要保,自己写个 sed / yq 二次处理也行:
```bash
# 用 yq 删 label="lei/dev" 那行(YAML 风格保留靠 yq -y)
yq -y 'del(."api-keys"[] | select(.label == "lei/dev"))' config.yaml > config.tmp.yaml
mv config.tmp.yaml config.yaml
```

#### 5.12.3 迁移后的 admin / managed 分工

建议保留如下结构:

| 来源 | 适合放的 key | 改动方式 |
|---|---|---|
| `config.yaml`(只读) | **1 把 bootstrap admin key**(防止 SQLite 损坏时把自己锁外面)、可选少量"绝不变"的 key | 编辑 yaml + 重启 |
| `managed_keys`(SQLite)| 日常给同事增删的 non-admin key、临时配额 / 启停 | UI / `/admin/keys` API,即时生效 |

#### 5.12.4 万一迁错了,怎么回滚

迁移前先 git commit 或 cp 备份 `config.yaml` + `~/.auth2api/auth2api.db`,然后:

```bash
# 完全回滚:把 yaml 还原 + 删 sqlite 行
cp config.yaml.bak config.yaml
sqlite3 ~/.auth2api/auth2api.db \
  "DELETE FROM managed_keys WHERE key IN ('sk-xxx', 'sk-yyy');"
launchctl unload ~/Library/LaunchAgents/com.$USER.auth2api.plist
launchctl load   ~/Library/LaunchAgents/com.$USER.auth2api.plist
```

或者只回滚 SQLite 那边(yaml 改动保留):
```bash
sqlite3 ~/.auth2api/auth2api.db \
  "DELETE FROM managed_keys WHERE key IN ('sk-xxx', 'sk-yyy');"
# 然后把删过的 entries 加回 yaml,重启
```

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
launchctl unload ~/Library/LaunchAgents/com.<user>.auth2api.plist
# 检查
sqlite3 ~/.auth2api/auth2api.db "PRAGMA integrity_check;"
# 极端情况备份后删 WAL
mv ~/.auth2api/auth2api.db{,.bak}
mv ~/.auth2api/auth2api.db-wal ~/.auth2api/auth2api.db-wal.bak 2>/dev/null
mv ~/.auth2api/auth2api.db-shm ~/.auth2api/auth2api.db-shm.bak 2>/dev/null
# 启动会自建新库
launchctl load ~/.../com.<user>.auth2api.plist
```

### 6.5 用量统计与上游账单不符

- **codex 估算单价不准**:覆盖 `pricing:` 段(见 5.6)。
- **流式中断 / 客户端断开**:这些请求记 `status: "failure"`,usage 可能为空或部分;token 已被上游消耗但我们看不全。可接受的微差。
- **/admin/stats 是从启用 stats 后开始累计**,旧的运行未启用时数据缺失。

---

## 7. 命令速查

| 场景 | 命令 |
|---|---|
| 启动 | `launchctl load ~/Library/LaunchAgents/com.<user>.auth2api.plist` |
| 停止 | `launchctl unload ~/Library/LaunchAgents/com.<user>.auth2api.plist` |
| 重启(部署新版/重载配置) | `launchctl unload ... && launchctl load ...` |
| 看实时日志 | `tail -f ~/.claude-token-owner/auth2api.launchd.{out,err}.log` |
| 看是否在跑 | `lsof -nP -iTCP:8317 -sTCP:LISTEN` |
| 编译 | `npm run build` |
| 跑测试 | `npm test`(244 个) |
| 新增 claude 账号 | `npm run login` |
| 新增 codex 账号 | `npm run login -- --provider=codex` |
| 重新加载 token(无需重启) | `curl -X POST -H "Authorization: Bearer $K" .../admin/reload` |
| 健康检查 | `curl http://<HOST>:8317/health` |
| 看账号状态 | `curl -H "Authorization: Bearer $K" .../admin/accounts` |
| 看用量+成本 | `curl -H "Authorization: Bearer $K" .../admin/stats` |
| 看各 key 额度 | `curl -H "Authorization: Bearer $K" .../admin/usage/keys` |
| 新建托管 key | `curl -X POST -H "Authorization: Bearer $ADMIN" -d '{...}' .../admin/keys` |
| 查 sqlite | `sqlite3 ~/.auth2api/auth2api.db "..."` |
| 同步上游 | `git fetch upstream && git merge upstream/main` |
| 发新版 | `git pull && npm install && npm run build && launchctl unload && launchctl load` |
| 回滚 | `git checkout v1.0.0 && npm run build && launchctl unload && launchctl load` |
