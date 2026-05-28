# auth2api 架构与路由细节

本文档深入解释 auth2api 在收到一个请求后如何选 provider、如何选账号、协议如何翻译。**所有论断都附了源码行号**(基于当前 commit),代码改动时本文档需要同步更新。

> 文档定位:开发者 / 运维深入排错时看的资料;客户端接入步骤见 [`CLIENT_SETUP.md`](CLIENT_SETUP.md),日常运维见 [`OPERATIONS.md`](OPERATIONS.md)。

---

## 1. 整体数据流

```
                   ┌──────────────────────────────────────────────────────┐
   client  ──HTTP──→ /v1/chat/completions  │ /v1/messages │ /v1/responses │
                   └──┬───────────────────────────────────────────────────┘
                      ▼
                  ┌────────────────────────────┐
                  │ Express app + middleware   │   (src/server.ts)
                  │   • auth (api-key)         │
                  │   • per-IP / per-key RL    │
                  │   • request logging        │
                  └──┬─────────────────────────┘
                     ▼
                  ┌────────────────────────────┐
                  │ Handler                    │   (src/handlers/{anthropic,openai}.ts)
                  │   • parse body             │
                  │   • route by model name    │  ─── registry.forModel(model)
                  └──┬─────────────────────────┘
                     ▼
                  ┌────────────────────────────┐
                  │ Provider                   │   (src/providers/{anthropic,codex,cursor}.ts)
                  │   • match model regex      │
                  │   • get account from pool  │  ─── AccountManager.getNextAccount()
                  │   • translate protocol     │  ─── src/upstream/{*-translator}.ts
                  └──┬─────────────────────────┘
                     ▼
                  ┌────────────────────────────┐
                  │ Upstream API call          │   (src/upstream/{anthropic,codex,cursor}-api.ts)
                  │   • OAuth bearer token     │
                  │   • streaming + cloaking   │
                  └──┬─────────────────────────┘
                     ▼
                  ┌────────────────────────────┐
                  │ Response translator        │   将上游 wire format
                  │                            │   翻回客户端要的 wire format
                  └──┬─────────────────────────┘
                     ▼
                   client
```

四个关键决策点(顺时针顺序):
1. **请求路由**:模型名 → provider(本文 §2)
2. **账号选择**:provider 内多账号怎么挑(本文 §3)
3. **协议翻译**:客户端 wire format ↔ 上游 wire format(本文 §4)
4. **失败处理**:cooldown / failover / 优先级(本文 §3.3)

---

## 2. 路由:模型名 → provider

实现:`src/providers/registry.ts:30-53` 的 `forModel(model)`。

### 2.1 决策顺序(自上而下,先匹配先返回)

```
1. 显式 cursor 前缀 (cursor-* | cr/*)        → cursor    provider
2. Cursor exclusive 模式(仅 cursor 有账号)→ cursor    provider
3. codex 系列 (gpt-5* | o\d* | codex-*)      → codex     provider
4. claude 系列 (claude-*)                     → anthropic provider
5. 都不匹配                                   → anthropic provider (fallback)
```

源码:

```ts
forModel: (model) => {
  const resolved = resolveModel(model);
  if (cursor.matchesModel(resolved)) return cursor;          // ①
  if (cursorOnlyMode()) return cursor;                       // ②
  if (codex.matchesModel(resolved)) return codex;            // ③
  if (anthropic.matchesModel(resolved)) return anthropic;    // ④
  return anthropic;                                          // ⑤
}
```

### 2.2 每个 provider 的匹配正则

| Provider | 正则 | 源码 |
|---|---|---|
| `cursor` | `/^(cursor[-/:]\|cr\/)/i` | `src/providers/cursor.ts:16` |
| `codex` | `/^(gpt-5(\.\|-)\|gpt-5$\|o\d\|codex-)/i` | `src/providers/codex.ts:21` |
| `anthropic` | `/^claude-/i` | `src/providers/anthropic.ts:25` |

### 2.3 模型名别名

裸名也接受,内部映射后再走前缀匹配。源码 `src/upstream/translator.ts:38-46`:

```ts
const MODEL_ALIASES: Record<string, string> = {
  opus:   "claude-opus-4-7",
  sonnet: "claude-sonnet-4-6",
  haiku:  "claude-haiku-4-5-20251001",
  // ...
};
export function resolveModel(model: string): string {
  return MODEL_ALIASES[model] ?? model;
}
```

例:客户端发 `model: "opus"` → 内部解析为 `claude-opus-4-7` → 命中 `^claude-` → 路由到 anthropic。

### 2.4 不传 / 空 model 的默认值

三个端点都要求 body 里有 `model`,但 translator 在两处加了兜底(`src/upstream/translator.ts:157,541`):

```ts
const model = resolveModel(body.model || "claude-sonnet-4-6");
```

即:`model = null` / `""` / 缺字段 → 默认 **`claude-sonnet-4-6` → anthropic**。

### 2.5 Cursor exclusive 模式

`src/providers/registry.ts:40-44`:

```ts
const cursorOnly =
  cursor.manager.accountCount > 0 &&
  anthropic.manager.accountCount === 0 &&
  codex.manager.accountCount === 0;
if (cursorOnly) return cursor;
```

这是个**人性化设计**:如果整个 auth2api 只有 cursor 账号,那么任何模型名(包括 `claude-*` / `gpt-*` 裸名)都自动走 cursor,客户端不用改 model 前缀。否则只有显式 `cursor-` / `cr/` 前缀才会走 cursor。

### 2.6 跨协议路由(重要)

**路由只看 model 名,不看请求是从哪个端点进来的**。这意味着:

- Codex CLI(OpenAI Responses 协议)发请求,model 写 `claude-opus-4-7` → 路由到 anthropic 上游
- Claude Code(Anthropic Messages 协议)发请求,model 写 `gpt-5.5` → 路由到 codex 上游
- 任意客户端发 `cursor-xxx` → 路由到 cursor 上游

中间的 wire format 转换由对应的 translator 完成,详见 §4。

### 2.7 完整路由矩阵

| 客户端 wire format | 请求体 `model` | 路由到 | 上游协议 |
|---|---|---|---|
| Anthropic Messages | `claude-opus-4-7` | anthropic | Anthropic Messages |
| Anthropic Messages | `opus` | anthropic | Anthropic Messages |
| Anthropic Messages | `gpt-5.5` | codex | OpenAI Responses |
| Anthropic Messages | `cursor-premium` | cursor | Cursor native |
| OpenAI Chat | `claude-sonnet-4-6` | anthropic | Anthropic Messages |
| OpenAI Chat | `gpt-5.5` | codex | OpenAI Responses |
| OpenAI Responses | `claude-opus-4-7` | anthropic | Anthropic Messages |
| OpenAI Responses | `gpt-5.5` | codex | OpenAI Responses |
| 任意 | `cursor-fast` / `cr/x` | cursor | Cursor native |
| 任意 | 空 / null / 缺字段 | anthropic | (model 默认为 sonnet) |
| 任意(仅 cursor 登录) | 任意 | cursor | Cursor native |

---

## 3. 账号选择算法

每个 provider 都有自己独立的 `AccountManager`(`src/accounts/manager.ts`),管理一组登录账号(token 文件)。请求落到某 provider 后,由该 provider 的 manager 决定具体用哪个账号。

### 3.1 核心:**粘性 + 轮询**(sticky + round-robin)

**不是**"一个账号用完再换下一个",而是:

- 选中一个账号后,在该账号上**粘 20–60 分钟随机区间**(`STICKY_MIN_MS = 20分钟`,`STICKY_MAX_MS = 60分钟`,`src/accounts/manager.ts:144-148`)
- 粘性窗口内的所有请求**都用同一个账号**
- 窗口到期 → 从 `lastUsedIndex + 1` 起轮询找下一个未冷却账号

实现核心(`src/accounts/manager.ts:333-385`):

```ts
getNextAccount(): AccountResult {
  // ① 当前粘性账号未过期且没冷却 → 继续用
  if (this.lastUsedIndex >= 0 && now < this.stickyUntil) {
    if (currentAccount.cooldownUntil <= now) return currentAccount;
  }
  // ② 轮询找下一个未冷却的
  for (let i = 0; i < count; i++) {
    const idx = (startIdx + i) % count;
    if (account.cooldownUntil <= now) {
      this.lastUsedIndex = idx;
      this.stickyUntil = now + randomStickyDuration();   // 重新粘 20-60min
      return account;
    }
  }
  // ③ 全部冷却中 → 挑最容易恢复的(见 §3.3)
}
```

### 3.2 为什么是粘性而不是纯轮询

- **prompt cache**:Anthropic 和 OpenAI 的 prompt cache 是按账号 + 内容哈希,频繁换号会让 cache 命中率掉到 0
- **reasoning 模型上下文**:`gpt-5.5` / `o\d` 等 reasoning 模型在同账号同 session 里能复用前序推理 token
- **粘性又不至于压垮单账号**:20–60 分钟是经验值,在 cache 友好 + 多账号负载均衡之间取舍

随机化 (`Math.random() * (MAX - MIN)`) 让多个客户端不会**同时**到期切换,避免雪崩。

### 3.3 早期切换的触发条件

只有这两种情况会在粘性期内强制换号:

1. **当前账号进入 cooldown**(被上游打回 `rate_limit` / `5xx` / `403`),`acct.cooldownUntil > now` 时跳过它继续轮询
2. **同请求内 403 failover**(`src/handlers/*` + `src/upstream/anthropic-api.ts`):如果当前账号在请求中返回 403(常见于"账号额度耗尽"),不直接回错,**当场切到下一个账号重试**

### 3.4 全部账号冷却时:挑最容易恢复的

`src/accounts/manager.ts:385-410` + `FAILURE_PRIORITY`(行 152-158):

```ts
const FAILURE_PRIORITY: Record<AccountFailureKind, number> = {
  rate_limit:    0,  // 最容易恢复(限流过段时间就好)
  server:        1,  // 上游 5xx
  network:       2,  // 网络抖动
  // 终态错误(refresh token 失效等)在更高优先级
};
```

挑剩余冷却时间最短的(同优先级内)。这套优先级保证"软错误"账号先回归,"硬错误"账号最后再尝试。

### 3.5 503 no_account_for_provider

如果某个 provider **完全没有账号注册**(`account_count === 0`),请求会直接 503,响应里附带需要执行的 `--login` 命令(`src/providers/registry.ts` 的 fallback 行为 + handlers)。

---

## 4. 协议翻译

auth2api 同时支持 3 种客户端协议 + 3 种上游协议,9 种组合都通过 translator 桥接:

| 客户端 → 上游 | Translator 实现 |
|---|---|
| Anthropic Messages → Anthropic Messages | 透传(无翻译) |
| Anthropic Messages → OpenAI Responses | `src/upstream/responses-translator.ts`(双向) |
| Anthropic Messages → Cursor native | `src/upstream/cursor-api.ts` |
| OpenAI Chat → Anthropic Messages | `src/upstream/translator.ts` |
| OpenAI Chat → OpenAI Responses | `src/upstream/responses-translator.ts` |
| OpenAI Chat → Cursor native | `src/upstream/cursor-api.ts` |
| OpenAI Responses → Anthropic Messages | `src/upstream/responses-translator.ts` |
| OpenAI Responses → OpenAI Responses | 透传 |
| OpenAI Responses → Cursor native | `src/upstream/cursor-api.ts` |

### 4.1 翻译细节(关键点)

- **System prompt**:OpenAI Chat 的 `messages[0].role=="system"` ↔ Anthropic 的 `system` 字段 ↔ Codex 的 `instructions` 字段
- **Tool calls**:三种格式都支持,通过 translator 双向映射 `function_call` ↔ `tool_use` ↔ `tool_call`
- **Reasoning(thinking)**:
  - Anthropic 用 `thinking` content block
  - OpenAI Responses 用 `reasoning` item
  - Cursor 用 `reasoning_content` 字段
  - translator 在三者间映射
- **Streaming**:三种协议的 SSE 帧结构都不同,translator 实时转换。非流式请求由 handler 在本地把上游 SSE drain 成单条 JSON
- **Codex 后端特殊性**(`src/handlers/openai.ts` 和 Codex API 实现):
  - 强制 `stream: true`(上游不接受非流)、`store: false`、`instructions` 字段
  - 自动剥除 `max_output_tokens`、`parallel_tool_calls` 这类 codex 后端会 400 的字段

### 4.2 端点 × Provider 矩阵

更详细的端点支持矩阵见 [README_CN.md §端点 × Provider 支持矩阵](../README_CN.md)。

---

## 5. 关键时序常量速查

| 常量 | 值 | 位置 | 含义 |
|---|---|---|---|
| `STICKY_MIN_MS` | 20 分钟 | `accounts/manager.ts:144` | 粘性窗口下限 |
| `STICKY_MAX_MS` | 60 分钟 | `accounts/manager.ts:145` | 粘性窗口上限 |
| token refresh 提前量 | 10 分钟 | `accounts/manager.ts` | 离过期还剩 10min 时主动刷新 |
| stats 输出间隔 | 5 分钟 | `accounts/manager.ts` | 控制台 stats log 频率 |
| Codex models cache | 5 分钟 | `upstream/codex-models.ts` | `/v1/models` 中 codex 部分的缓存 |
| messages timeout | 120s | `config.yaml: timeouts.messages-ms` | 非流式默认 |
| stream-messages timeout | 600s | `config.yaml: timeouts.stream-messages-ms` | 流式默认 |
| count-tokens timeout | 30s | `config.yaml: timeouts.count-tokens-ms` | |

---

## 6. 实战:Codex CLI 用 Claude opus 4.7

把这套架构串起来的一个典型场景:在 OpenAI Codex CLI 里使用 Anthropic 的 opus 4.7。

```toml
# ~/.codex/config.toml
model_provider = "auth2api"
model = "claude-opus-4-7"

[model_providers.auth2api]
name = "auth2api"
base_url = "http://<auth2api-host>:8317/v1"
wire_api = "responses"
env_key = "OPENAI_API_KEY"
```

发生的事:

1. Codex CLI 发 `POST /v1/responses`,body `{"model": "claude-opus-4-7", "input": [...], "stream": true}`(OpenAI Responses wire format)
2. auth2api 收到请求,`registry.forModel("claude-opus-4-7")` 命中 `^claude-` → **anthropic provider**
3. anthropic provider 的 `AccountManager.getNextAccount()` 返回当前粘性账号(或轮换的下一个)
4. **关键**:wire format 不匹配 — 客户端是 Responses,上游是 Anthropic Messages → `responses-translator.ts` 翻译请求
5. 上游 Anthropic 返回 Messages SSE → translator 翻回 Responses SSE → Codex CLI 收到熟悉的 Responses 格式
6. Codex CLI 完全不知道背后跑的是 Anthropic,认为这是个标准的 OpenAI Responses 端点

反向同样成立:Claude Code 用 `model: "gpt-5.5"` 走 Codex 上游也通。

---

## 7. 排错切入点

| 现象 | 看哪里 |
|---|---|
| 请求路由到了错的 provider | model 名是否命中预期前缀?跑 `curl -H 'Bearer …' /v1/models` 看实际可用列表 |
| 一直用同一个账号、不轮换 | 粘性 20–60 分钟正常;想强制轮换 → 让当前账号触发 cooldown(限流即可)|
| 所有请求都报 503 no_account | `/admin/accounts` 看对应 provider 的 `account_count`,为 0 就 `--login` |
| 403 但其它账号有额度 | 看日志里有没有 `failover to next account` —— 403 同请求内 failover 实现在 `src/upstream/anthropic-api.ts` |
| stream 卡死 / 提前断 | `timeouts.stream-messages-ms` 默认 600s;reasoning 长任务可能要再调大 |
| `claude-opus-4-7` 在 Codex CLI 里报"unknown model" | Codex CLI 自己白名单了模型名 → 改用 `gpt-5-codex` 路由到 anthropic 行不通,因为路由按 model 字段;**让 Codex 接受非 GPT 模型名**:`config.toml` 里加 `model_providers.auth2api.model = "claude-opus-4-7"` 后不要再 `--model gpt-...`,或者在 auth2api 加 model 别名 |

---

## 8. 相关文档

- [`README_CN.md`](../README_CN.md):用户视角的功能与端点总览
- [`CLIENT_SETUP.md`](CLIENT_SETUP.md):同事接入手册
- [`OPERATIONS.md`](OPERATIONS.md):团队运维手册
