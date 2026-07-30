# 在 Claude Code 里用 GPT-5.5

> 适用对象:已经在用 AICoding 网关(`http://172.16.13.203:8318`)的同事。
> 你已有的 Claude 配置**不用动**,下面是在原有基础上**加两个环境变量**,让你能在 Claude Code 里随时切到 GPT-5.5。

---

## 为什么不能直接 `/model gpt-5.5`

Claude Code 的 `/model` 命令只认它自己白名单里的名字(`opus` / `sonnet` / `haiku` 这些)。直接敲 `/model gpt-5.5` 会报:

```
Unknown model 'gpt-5.5' – type /model to see options
```

**不是配错了,是 Claude Code 不接受自定义模型名。** 解决办法是把白名单里的 `opus` 槽位**重定向**到 GPT-5.5 —— 之后 `/model opus` 显示的还是 Opus,但实际跑的是 GPT-5.5。

---

## 配置

### 方式 A:写进 `~/.claude/settings.json`(推荐)

一次写好,所有项目、所有终端都生效,不依赖 shell 配置。

**macOS / Linux** — 编辑 `~/.claude/settings.json`;**Windows** — 编辑 `%USERPROFILE%\.claude\settings.json`。文件不存在就新建:

```json
{
  "env": {
    "ANTHROPIC_BASE_URL": "http://172.16.13.203:8318",
    "ANTHROPIC_AUTH_TOKEN": "换成你自己的 Key",
    "ANTHROPIC_DEFAULT_OPUS_MODEL": "gpt-5.5",
    "ANTHROPIC_DEFAULT_HAIKU_MODEL": "gpt-5.4-mini"
  }
}
```

> 文件里**已经有内容**的话,只把 `env` 块里缺的两行加进去,别整个覆盖掉。JSON 不允许多余的逗号,加完可以用 `python3 -m json.tool ~/.claude/settings.json` 检查格式。

改完**重开一个终端**再启动 `claude`。

### 方式 B:环境变量

如果你之前就是用 `export` 配的 BASE_URL 和 TOKEN,那就在同一个地方(`~/.zshrc` 或 `~/.bashrc`)补两行:

```bash
export ANTHROPIC_DEFAULT_OPUS_MODEL="gpt-5.5"
export ANTHROPIC_DEFAULT_HAIKU_MODEL="gpt-5.4-mini"
```

```powershell
# Windows PowerShell(User 级别,设完关掉窗口重开)
[Environment]::SetEnvironmentVariable("ANTHROPIC_DEFAULT_OPUS_MODEL", "gpt-5.5", "User")
[Environment]::SetEnvironmentVariable("ANTHROPIC_DEFAULT_HAIKU_MODEL", "gpt-5.4-mini", "User")
```

改完 `source ~/.zshrc`(或关掉终端重开)。

---

## 怎么用

启动 `claude`,在会话里:

| 命令 | 实际用的模型 |
|---|---|
| `/model opus` | **GPT-5.5** |
| `/model sonnet` | Claude Sonnet 4.6(不变) |

来回切随时可以,不用重启。**菜单里显示的名字还是 Opus** —— 这是正常的,它只是个槽位名。

### 确认真的切过去了

浏览器打开 `http://172.16.13.203:8318/ui`,用你的 Key 登录 →「我的」页,看模型那一列。跑过 GPT-5.5 就会出现 `gpt-5.5` 的记录。

命令行也行:

```bash
curl -s -H "Authorization: Bearer 你的Key" \
  "http://172.16.13.203:8318/admin/usage/keys" | python3 -m json.tool
```

---

## 两个变量分别管什么

| 变量 | 作用 |
|---|---|
| `ANTHROPIC_DEFAULT_OPUS_MODEL` | `/model opus` 时实际请求哪个模型 —— 这是你切 GPT-5.5 的开关 |
| `ANTHROPIC_DEFAULT_HAIKU_MODEL` | Claude Code 的**后台小任务**(生成对话标题、命令描述这些)用哪个模型 |

第二行是可选的,但建议加:默认这些后台请求会打 Claude 的 Haiku,吃团队的 Claude 额度。指到 `gpt-5.4-mini` 就转到 GPT 那边,又快又便宜。

不想动后台任务的话,只加第一行也能用。

---

## 想反过来

如果你平时主力就想用 GPT-5.5、偶尔才用 Claude,把 `sonnet` 槽位也占掉:

```json
"ANTHROPIC_DEFAULT_SONNET_MODEL": "gpt-5.5"
```

这样 `/model sonnet` 和 `/model opus` 都是 GPT-5.5。**注意**:Claude Code 启动时默认用 sonnet 槽位,所以这么配等于「开箱就是 GPT-5.5」。

---

## 可用的 GPT 模型

以 `http://172.16.13.203:8318/v1/models` 返回为准。当前:

| 模型名 | 说明 |
|---|---|
| `gpt-5.5` | 主力,推理能力最强 |
| `gpt-5.4` | 上一代 |
| `gpt-5.4-mini` | 快、省,适合后台小任务 |
| `gpt-5.3-codex` | Codex 变体,偏代码 |
| `gpt-5.2` | 更老 |

任意一个都可以填进上面的变量。

---

## 常见问题

| 现象 | 处理 |
|---|---|
| `Unknown model 'gpt-5.5'` | 你直接敲了 `/model gpt-5.5`。要敲 `/model opus`,GPT-5.5 是映射上去的 |
| `/model opus` 之后还是 Claude 在答 | 变量没生效。退出 `claude`,`echo $ANTHROPIC_DEFAULT_OPUS_MODEL` 确认有值;用 settings.json 的话检查 JSON 格式对不对 |
| `400 Unsupported parameter: user` | 网关版本太旧,找管理员升级(这个问题在新版本已修) |
| `503 no_account_for_provider` | 网关上没有可用的 GPT 账号,找管理员 |
| `429 Rate limited on the configured account` | GPT 账号额度用满了。**GPT 侧目前是整个团队共用一个订阅**,配额比 Claude 那边紧张得多,撞到就先切回 `/model sonnet` 用 Claude,过一会儿再试 |
| 上下文占用显示不准 | 已知现象。GPT 后端没有 token 计数接口,Claude Code 退回本地估算,不影响使用 |

---

## 注意

GPT-5.5 走的是**团队共用的一个 ChatGPT 订阅**,不像 Claude 那边有十几个账号可以轮换 —— 打满了没有备用的,会直接报 429。所以:

- 日常开发建议还是以 Claude 为主,GPT-5.5 用在它确实更合适的场景(比如需要另一个模型的思路做交叉验证)
- 别拿它跑大批量的自动化任务
- 撞 429 就切回 `/model sonnet`,不用等

有问题找管理员。
