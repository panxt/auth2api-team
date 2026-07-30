# 在 Claude Code 里用 GPT-5.5

> 适用对象:已经在用 AICoding 网关(`http://172.16.13.203:8318`)的同事。
> 你已有的 Claude 配置**不用动**,下面是加一个环境变量,让 `/model` 菜单里直接出现 GPT-5.5。

---

## 一句话版本

在你原有的两个环境变量之外,**再加一个**:

```bash
export CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY=1
```

重开终端启动 `claude`,然后 `/model` —— 菜单里会多出网关支持的全部模型(标注 `From gateway`),包括 `gpt-5.5`。选它就行。

之后 `/model gpt-5.5`、`/model claude-sonnet-4-6` 都能直接敲,随时来回切。

---

## 完整配置

### 方式 A:写进 `~/.claude/settings.json`(推荐)

一次写好,所有项目、所有终端生效。

**macOS / Linux** — `~/.claude/settings.json`;**Windows** — `%USERPROFILE%\.claude\settings.json`。文件不存在就新建:

```json
{
  "env": {
    "ANTHROPIC_BASE_URL": "http://172.16.13.203:8318",
    "ANTHROPIC_AUTH_TOKEN": "换成你自己的 Key",
    "CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY": "1"
  }
}
```

> 文件里**已有内容**的话,只往 `env` 块里加缺的那一行,别整个覆盖。JSON 不允许多余逗号,加完可以 `python3 -m json.tool ~/.claude/settings.json` 检查格式。
>
> 注意值要写成字符串 `"1"`,不是数字 `1`。

改完**重开一个终端**再启动 `claude`。

### 方式 B:环境变量

如果你之前是用 `export` 配的,在同一个地方(`~/.zshrc` / `~/.bashrc`)补一行:

```bash
export CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY=1
```

```powershell
# Windows PowerShell(User 级别,设完关掉窗口重开)
[Environment]::SetEnvironmentVariable("CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY", "1", "User")
```

改完 `source ~/.zshrc`(或关掉终端重开)。

---

## 怎么用

启动 `claude`,敲 `/model`:

- 菜单上半部分是 Claude Code 自带的 `Default` / `Opus` / `Sonnet` / `Haiku`
- 下半部分是网关拉过来的模型,描述里写着 **`From gateway`** —— `gpt-5.5`、`gpt-5.4`、`gpt-5.4-mini`、`gpt-5.3-codex` 都在这儿

选中即生效,不用重启。也可以直接敲 `/model gpt-5.5` 精确指定。

启动时就想用 GPT:`claude --model gpt-5.5`。

### 确认真的切过去了

浏览器打开 `http://172.16.13.203:8318/ui`,用你的 Key 登录 →「我的」页看模型那一列,跑过就会出现 `gpt-5.5` 的记录。

---

## 可用的 GPT 模型

以 `/model` 菜单(或 `http://172.16.13.203:8318/v1/models`)为准。当前:

| 模型名 | 说明 |
|---|---|
| `gpt-5.5` | 主力,推理能力最强 |
| `gpt-5.4` | 上一代 |
| `gpt-5.4-mini` | 快、省 |
| `gpt-5.3-codex` | Codex 变体,偏代码 |
| `gpt-5.2` | 更老 |

---

## 备选方案:槽位重定向

`CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY` 是 Claude Code 的内部开关,官方文档里没有写,**未来版本有可能改名或去掉**。如果哪天升级后菜单里的 `From gateway` 那批模型消失了,用这个办法顶上:

```bash
export ANTHROPIC_DEFAULT_OPUS_MODEL="gpt-5.5"
```

原理是把 `opus` 这个**槽位**重定向到 GPT-5.5 —— 之后 `/model opus` 菜单上显示的还是 Opus,但实际跑的是 GPT-5.5。同理还有 `ANTHROPIC_DEFAULT_SONNET_MODEL` 和 `ANTHROPIC_DEFAULT_HAIKU_MODEL`。

这个办法的缺点是**菜单名和实际模型不一致**,容易看错,所以只在上面那个开关失效时用。

### 顺带一个优化(可选)

不管用哪种方案,都可以加这一行:

```bash
export ANTHROPIC_DEFAULT_HAIKU_MODEL="gpt-5.4-mini"
```

Claude Code 的**后台小任务**(生成对话标题、命令描述这些)默认打 Claude 的 Haiku,吃团队的 Claude 额度。指到 `gpt-5.4-mini` 就转到 GPT 那边,又快又便宜。

---

## 常见问题

| 现象 | 处理 |
|---|---|
| `/model` 里没有 `From gateway` 那批 | 变量没生效。退出 `claude` 后 `echo $CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY` 确认有值;用 settings.json 的话检查 JSON 格式、值是否写成了字符串 `"1"` |
| `Unknown model 'gpt-5.5'` | 同上,开关没生效。生效后这个名字就能直接敲 |
| 菜单里模型列表是旧的 | Claude Code 会缓存网关的模型列表,管理员新加了模型的话重启一下 `claude` |
| `400 Unsupported parameter: user` | 网关版本太旧,找管理员升级(新版本已修) |
| `503 no_account_for_provider` | 网关上没有可用的 GPT 账号,找管理员 |
| `429 Rate limited on the configured account` | GPT 账号额度用满了。**GPT 侧目前整个团队共用一个订阅**,配额比 Claude 那边紧张得多,撞到就先切回 Claude 用,过一会儿再试 |
| 上下文占用显示不准 | 已知现象。GPT 后端没有 token 计数接口,Claude Code 退回本地估算,不影响使用 |

---

## 注意

GPT-5.5 走的是**团队共用的一个 ChatGPT 订阅**,不像 Claude 那边有十几个账号可以轮换 —— 打满了没有备用的,会直接报 429。所以:

- 日常开发建议还是以 Claude 为主,GPT-5.5 用在它确实更合适的场景(比如需要另一个模型的思路做交叉验证)
- 别拿它跑大批量的自动化任务
- 撞 429 就切回 Claude,不用等

有问题找管理员。
