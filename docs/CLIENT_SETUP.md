# auth2api 客户端接入手册

> 通过本地代理服务以**统一 API**调用 Claude / Codex 等模型,无需各自登录、共享团队订阅。
> Base URL 与 API Key 请联系管理员获取,本文中以 `<BASE_URL>` 和 `<API_KEY>` 占位。

---

## 0. 接入信息(联系管理员)

| 项 | 说明 |
|---|---|
| **Base URL** | 公司内网地址,联系管理员获取(形如 `http://172.16.x.x:8317`)|
| **API Key** | 管理员单独发给你,形如 `sk-xxxxxxxx...`,**仅限本人使用,不要外发** |

接入前先用 `curl` 自测:

```bash
curl -s <BASE_URL>/health
# 期望响应:{"status":"ok"}

curl -s -H "Authorization: Bearer <API_KEY>" <BASE_URL>/v1/models
# 期望响应:{"data":[{"id":"claude-sonnet-...",...}, ...]}
```

两条都通 → 网络和 key 都没问题,可以进下面任一客户端的配置环节。

---

## 0.5 前置:安装 CLI

只需要装你自己要用的那一个,不必两个都装。

### Claude Code CLI(`claude`)

**macOS** — 任选一种:

```bash
# 方式 ①:官方一键脚本(推荐,自动管理升级)
curl -fsSL https://claude.ai/install.sh | bash

# 方式 ②:Homebrew
brew install --cask claude-code

# 方式 ③:npm(需要本机已装 Node.js ≥ 18)
npm install -g @anthropic-ai/claude-code
```

装完验证:`claude --version`

**Windows** — 任选一种:

```powershell
# 方式 ①:官方一键脚本(PowerShell,推荐)
irm https://claude.ai/install.ps1 | iex

# 方式 ②:winget
winget install Anthropic.Claude

# 方式 ③:npm(需要先装 Node.js LTS:https://nodejs.org)
npm install -g @anthropic-ai/claude-code
```

装完打开**新的** PowerShell / CMD 窗口,运行 `claude --version` 验证。

> 装完先**不要**直接 `claude login`(那样会用你私人 Anthropic 账号);跳到 §1 配置环境变量,直接走代理。
> 如果之前已经登录过,执行 `claude logout` 清掉本地凭据,再按 §1 设置环境变量。

### OpenAI Codex CLI(`codex`)

**macOS** — 任选一种:

```bash
# 方式 ①:Homebrew(推荐)
brew install codex

# 方式 ②:npm
npm install -g @openai/codex
```

装完验证:`codex --version`

**Windows** — 任选一种:

```powershell
# 方式 ①:winget
winget install OpenAI.Codex

# 方式 ②:npm(需要 Node.js LTS)
npm install -g @openai/codex
```

装完打开**新窗口**,运行 `codex --version` 验证。

> 同样,**不要** `codex login`(会绑你个人 ChatGPT 账号);走 §2 的环境变量配置直接接代理。
> 已登录的话:删除 `~/.codex/auth.json`(Win 在 `%USERPROFILE%\.codex\auth.json`)清掉。

### 安装常见问题

| 现象 | 处理 |
|---|---|
| `command not found: claude` / `codex` | 装完没重开终端,或 npm global bin 不在 `PATH`。Mac:`echo $PATH` 看是否含 `/usr/local/bin`;Win:重启 PowerShell |
| `npm: permission denied`(Mac/Linux) | 别用 `sudo`,改用 nvm / fnm 管理 Node 用户态安装 |
| `EACCES: permission denied`(Win) | 以管理员身份打开 PowerShell 重试,或用 winget / 官方安装包 |
| Mac 上 `claude` 提示 quarantine | `xattr -dr com.apple.quarantine $(which claude)` |
| 公司网络装不上 | npm 换镜像:`npm config set registry https://registry.npmmirror.com`,然后重装;或叫管理员帮 |

---

## 1. Claude Code(Anthropic 官方 CLI / IDE 插件)

通过两个环境变量切换后端,**无需改任何配置文件**:

| 变量 | 值 |
|---|---|
| `ANTHROPIC_BASE_URL` | `<BASE_URL>` |
| `ANTHROPIC_API_KEY` | `<API_KEY>` |

### 1.1 macOS — 永久写入(推荐)

```bash
# zsh(macOS 默认)
cat >> ~/.zshrc <<'EOF'

# auth2api proxy
export ANTHROPIC_BASE_URL="<BASE_URL>"
export ANTHROPIC_API_KEY="<API_KEY>"
EOF

source ~/.zshrc      # 立即生效
claude               # 启动
```

> 如果你的 shell 是 bash,把 `~/.zshrc` 换成 `~/.bashrc`。

### 1.2 macOS — 临时一次性

```bash
ANTHROPIC_BASE_URL=<BASE_URL> \
ANTHROPIC_API_KEY=<API_KEY> \
claude
```

### 1.3 Windows — PowerShell(永久,推荐)

```powershell
[Environment]::SetEnvironmentVariable("ANTHROPIC_BASE_URL", "<BASE_URL>", "User")
[Environment]::SetEnvironmentVariable("ANTHROPIC_API_KEY",  "<API_KEY>",  "User")

# 关掉这个 PowerShell 窗口,重开一个新窗口,然后:
claude
```

### 1.4 Windows — CMD(临时)

```cmd
set ANTHROPIC_BASE_URL=<BASE_URL>
set ANTHROPIC_API_KEY=<API_KEY>
claude
```

### 1.5 VSCode / JetBrains 的 Claude Code 插件

插件读同一套环境变量。完成上面"永久写入"的步骤后**重启 IDE**即可。

注意:
- macOS:从 Dock / Spotlight 启动的 GUI 默认不读 shell rc,需要从终端启动 `code .` / `idea .`,或者用 `launchctl setenv` 写到 launchd 环境
- Windows:`SetEnvironmentVariable(..., "User")` 写入注册表,GUI 启动的 IDE 也能读到,**重启 IDE 即可**

### 1.6 首次启动 Claude Code 遇到登录选择界面怎么办

第一次跑 `claude` 时,如果出现下面这种登录方式选择菜单:

```
Welcome to Claude Code v2.x.x
...
Select login method:
  1. Claude account with subscription · Pro, Max, Team, or Enterprise
  2. Anthropic Console account · API usage billing
  3. 3rd-party platform · Amazon Bedrock, Microsoft Foundry, or Vertex AI
```

→ **用上下箭头选第 2 项**(`Anthropic Console account · API usage billing`),回车。

理由速查:

| 选项 | 适用场景 | 你的情况 |
|---|---|---|
| 1. Claude account with subscription | 直连 claude.ai,用个人 Pro/Max 订阅 | ❌ 我们走代理,不走 claude.ai |
| **2. Anthropic Console account · API usage billing** | 用 `ANTHROPIC_API_KEY` 走 Anthropic API(或兼容代理) | ✅ **就选这个** |
| 3. 3rd-party platform | AWS Bedrock / GCP Vertex / Azure | ❌ 完全不同的协议 |

代理 auth2api 暴露的 `/v1/messages` 与 Anthropic API 同协议,Claude Code 把 `ANTHROPIC_BASE_URL` 改向代理 + `ANTHROPIC_API_KEY` 当 token 就直接通。

**理论上**:只要环境变量正确设置好,Claude Code 应该**跳过这个界面直接进对话**。看到这个界面通常说明环境变量没生效,先按下面排查再选 2。

#### 排查 1:确认环境变量在当前窗口里能读到

**Windows PowerShell**:
```powershell
echo $env:ANTHROPIC_BASE_URL
echo $env:ANTHROPIC_API_KEY
```

**macOS / Linux**:
```bash
echo $ANTHROPIC_BASE_URL
echo $ANTHROPIC_API_KEY
```

两条都该回显刚才设置的值。如果是空 → 进排查 2。

#### 排查 2:常见原因

| 现象 | 原因 | 解决 |
|---|---|---|
| `echo` 输出空 | 改环境变量**之前**就开着的窗口,没继承新值 | **关掉这个窗口,新开一个**再 `claude` |
| 新窗口里 `echo` 仍为空(Win)| `SetEnvironmentVariable` 写错位置(用了 Process 而不是 User) | 重新执行 `[Environment]::SetEnvironmentVariable("ANTHROPIC_BASE_URL", "<BASE_URL>", "User")`,第三个参数必须是 `"User"` |
| 新窗口里 `echo` 仍为空(Mac)| `~/.zshrc` 改了但没 `source` | `source ~/.zshrc` 或重开一个新终端 |
| 环境变量都对,还是弹这个界面 | 之前点过订阅登录、本地有缓存 | 先 `claude logout`,然后删除用户目录下的 `.claude` 凭证缓存,再 `claude` |

#### 选完 2 之后会发生什么

可能依次问你(不同版本略有差异):

1. **workspace 目录** — 默认就行,回车
2. **是否发送遥测** — 随意
3. 进入对话提示符

接下来**立刻**输入 `/status` 回车,看输出里:
- `API base URL:` 应该是**你的代理地址**(`http://172.16.x.x:8317`),不是 `api.anthropic.com`
- `Authentication:` 应该显示 API key

确认后随便问一句 `hello` 测试,能正常回 = 接入成功。

如果选 2 之后**仍然弹出浏览器要求 OAuth 登录**,99% 是环境变量没传到 `claude` 进程。按上面"排查 1"重新验证。

### 1.7 Claude Code CLI ↔ IDE 插件:共享 `~/.claude/`

**先澄清一个常见误解**:Claude 桌面 App / Claude.ai 网页版 跟 Claude Code 是**两个完全独立的产品**,各用各的数据目录,互不干扰。本节只讨论 Claude Code(CLI 与 IDE 插件)。

| 产品 | 数据目录 | 跟 Claude Code 共享? |
|---|---|---|
| Claude Desktop App / Claude.ai 网页 | Mac: `~/Library/Application Support/Claude/`<br>Win: `%APPDATA%\Claude\` | ❌ 互不影响 |
| Claude Code CLI(`claude`)| `~/.claude/` | ✅ |
| Claude Code VSCode / JetBrains 插件 | `~/.claude/`(底层就是同一个 `claude` 引擎)| ✅ **跟 CLI 共享** |

#### CLI 和插件共享什么

```
~/.claude/                       ← Win: %USERPROFILE%\.claude\
├── settings.json                ← 共享:主题、模型偏好、permissions
├── .credentials.json            ← 共享:OAuth 订阅登录态
├── projects/                    ← 共享:per-project 会话历史
└── plugins/                     ← 共享:已安装插件
```

| 操作 | 副作用 |
|---|---|
| CLI 里 `claude logout` | 插件下次起来也变成未登录态 |
| CLI 里走订阅 OAuth 登录(选 1)| 插件下次也用这个订阅账号 |
| 插件里点订阅登录 | CLI 下次也用这个订阅账号 |
| 环境变量 `ANTHROPIC_BASE_URL` / `ANTHROPIC_API_KEY` | 两边都看,只要进程能读到 |

#### 同样的优先级陷阱:OAuth 缓存高于环境变量

如果 `~/.claude/.credentials.json` 里有有效的 OAuth 凭据,Claude Code 会**优先用它,忽略 `ANTHROPIC_API_KEY` 环境变量,直连 `api.anthropic.com`** —— 体现为"环境变量明明对,请求却没走代理"。

**检查是否有 OAuth 缓存:**

macOS:
```bash
ls -la ~/.claude/.credentials.json 2>/dev/null && \
  cat ~/.claude/.credentials.json | head -3
```

Windows PowerShell:
```powershell
Get-Item $env:USERPROFILE\.claude\.credentials.json -ErrorAction SilentlyContinue
Get-Content $env:USERPROFILE\.claude\.credentials.json -ErrorAction SilentlyContinue | Select-Object -First 3
```

| 内容形态 | 状态 |
|---|---|
| 文件不存在 | 未登录,走环境变量(✅ 你想要的)|
| 含 `access_token` / `refresh_token` 等 | OAuth 订阅模式(❌ 会绕过代理)|

**清理:**

```bash
# macOS
claude logout       # 推荐,一并清理状态
rm -f ~/.claude/.credentials.json   # 兜底
```

```powershell
# Windows
claude logout
Remove-Item "$env:USERPROFILE\.claude\.credentials.json" -ErrorAction SilentlyContinue
```

清掉后再 `claude`,弹出来的登录界面选 2(API usage)即可。

#### 推荐工作流(CLI + 插件都走代理)

1. **环境变量写到系统级**(GUI 启动的 IDE 才读得到):
   - Win:`[Environment]::SetEnvironmentVariable(..., "User")`
   - macOS:写 `~/.zshrc`(CLI 用) **加上** `launchctl setenv ANTHROPIC_BASE_URL "..."` / `launchctl setenv ANTHROPIC_API_KEY "..."`(IDE GUI 启动用)
2. **永远不点订阅登录**(不管是 CLI 的选项 1 还是插件里同样的按钮)
3. **任何配置大改之后** `claude logout` 兜底
4. 首次启动遇到登录界面 → **选 2(API usage)**,绝不选 1

---

## 2. OpenAI Codex CLI(`codex` 命令)

| 变量 | 值 |
|---|---|
| `OPENAI_BASE_URL` | **`<BASE_URL>/v1`**(注意末尾必须加 `/v1`)|
| `OPENAI_API_KEY` | `<API_KEY>` |

### 2.1 macOS

```bash
cat >> ~/.zshrc <<'EOF'

# auth2api proxy (Codex CLI)
export OPENAI_BASE_URL="<BASE_URL>/v1"
export OPENAI_API_KEY="<API_KEY>"
EOF
source ~/.zshrc

codex
```

### 2.2 Windows — PowerShell

```powershell
[Environment]::SetEnvironmentVariable("OPENAI_BASE_URL", "<BASE_URL>/v1", "User")
[Environment]::SetEnvironmentVariable("OPENAI_API_KEY",  "<API_KEY>",     "User")
# 重开 PowerShell
codex
```

### 2.3 Codex CLI 配置文件(可选)

不想全局污染环境变量时,改 `~/.codex/config.toml`(Windows 在 `%USERPROFILE%\.codex\config.toml`):

```toml
[model_providers.auth2api]
name = "auth2api"
base_url = "<BASE_URL>/v1"
wire_api = "responses"
env_key = "OPENAI_API_KEY"

model_provider = "auth2api"
model = "gpt-5.5"            # 或其它,见 /v1/models 列出的模型
```

`OPENAI_API_KEY` 仍然要设置(环境变量或 `codex login`)。

### 2.4 验证

```bash
codex --help
codex exec "say hi"
```

### 2.5 首次启动 Codex 遇到登录选择界面怎么办

第一次跑 `codex` 时,如果出现登录方式选择菜单(不同版本措辞略不同),典型形态:

```
Sign in to Codex
  > 1. Sign in with ChatGPT
    2. Provide your own API key
```

→ **选第 2 项**(`Provide your own API key` / `Use API key` / `API key authentication`),回车。

理由速查:

| 选项 | 适用场景 | 你的情况 |
|---|---|---|
| Sign in with ChatGPT | 用个人 ChatGPT Plus/Pro 订阅 OAuth 登录,直连 OpenAI | ❌ 我们走代理,不直连 OpenAI |
| **Provide your own API key** | 用 `OPENAI_API_KEY` 走 OpenAI API(或兼容代理) | ✅ **就选这个** |

代理 auth2api 暴露的 `/v1/responses` 与 `/v1/chat/completions` 都是 OpenAI 兼容协议,Codex CLI 把 `OPENAI_BASE_URL` 改向代理 + `OPENAI_API_KEY` 当 token 就直接通。

**理论上**:`OPENAI_API_KEY` 环境变量正确设置好后,Codex 应该**跳过这个界面直接进对话**。出现这个界面通常说明环境变量没生效,先按下面排查再选。

#### 排查 1:确认环境变量在当前窗口里能读到

**Windows PowerShell**:
```powershell
echo $env:OPENAI_BASE_URL
echo $env:OPENAI_API_KEY
```

**macOS / Linux**:
```bash
echo $OPENAI_BASE_URL
echo $OPENAI_API_KEY
```

两条都该回显刚才设置的值。`OPENAI_BASE_URL` **必须以 `/v1` 结尾**(`http://172.16.x.x:8317/v1`),漏了 `/v1` 会报 `404`。

#### 排查 2:常见原因

| 现象 | 原因 | 解决 |
|---|---|---|
| `echo` 输出空 | 改环境变量**之前**就开着的窗口,没继承新值 | **关掉这个窗口,新开一个**再 `codex` |
| 新窗口里 `echo` 仍为空(Win)| `SetEnvironmentVariable` 第三参数写成 `"Process"` 了 | 重新执行,确保第三个参数是 `"User"` |
| 新窗口里 `echo` 仍为空(Mac)| `~/.zshrc` 改了但没 `source` | `source ~/.zshrc` 或重开新终端 |
| 环境变量都对,还是弹这个界面 | 之前点过 ChatGPT 登录、本地有 `auth.json` 缓存 | 删除 `~/.codex/auth.json`(Win 在 `%USERPROFILE%\.codex\auth.json`),再 `codex` |
| 选了 2 之后报 `404 /chat/completions` | `OPENAI_BASE_URL` 末尾忘了加 `/v1` | 重新设置环境变量,加上 `/v1` |

#### 选完 2 之后会发生什么

可能依次问你(不同版本略有差异):

1. 提示**粘贴 API key** — 它可能自动从 `OPENAI_API_KEY` 读取并跳过;如果让你贴,就把 `<API_KEY>` 粘进去
2. 提示选择默认 model — 填 `gpt-5.5` 或 `gpt-5-codex` 等(下面命令可以查可用模型)
3. 进入对话提示符 / 直接退到 shell(看子命令)

可用模型清单:
```bash
curl -s -H "Authorization: Bearer <API_KEY>" <BASE_URL>/v1/models
```

烟测:
```bash
codex exec "say hi in one word"
```
有正常输出 = 接入成功。

#### 已经误登录了 ChatGPT 怎么办

如果之前一时手快点了 "Sign in with ChatGPT" 并用浏览器走完了 OAuth,本地会有缓存,这种状态下 Codex 会**优先用缓存的 ChatGPT 凭据,忽略 `OPENAI_BASE_URL` / `OPENAI_API_KEY` 环境变量**,直连 OpenAI,体现为"环境变量明明对,但请求没走代理"。

清理:

**macOS / Linux**:
```bash
rm ~/.codex/auth.json
# 如果存在 ~/.codex/config.toml 里有 chatgpt 相关配置也一并清掉
```

**Windows PowerShell**:
```powershell
Remove-Item "$env:USERPROFILE\.codex\auth.json" -ErrorAction SilentlyContinue
```

再 `codex`,这次它会重新弹登录选择 → 选 2 即可。

### 2.6 Codex CLI ↔ IDE 插件:共享 `~/.codex/`

跟 Claude Code 一样,Codex CLI 和 OpenAI 官方的 Codex IDE 插件(VSCode / JetBrains)**共用同一个 `~/.codex/` 目录**(Win: `%USERPROFILE%\.codex\`):

```
~/.codex/
├── config.toml      ← 共享:provider、默认 model、wire_api 等
├── auth.json        ← 共享:OAuth (ChatGPT) 或 API key 模式标记
└── history.jsonl    ← 各自写各自的 session,不影响行为
```

| 操作 | 副作用 |
|---|---|
| CLI 里 `codex login`(点 ChatGPT)| 插件下次直接用这个 ChatGPT 账号,绕过你 config.toml 的 provider |
| 插件里点 "Sign in with ChatGPT" | CLI 下次也用 ChatGPT 账号,绕过 provider |
| CLI 里 `codex logout` | 插件下次也变未登录 |
| 改 `config.toml` 里的 `model_provider`/`base_url` | **两边都生效**(重启后)|

**好处**:你改一次 `~/.codex/config.toml` 加上 `[model_providers.auth2api]`,**CLI 和 IDE 插件下次都自动走代理**,不用分别配。

**坑**:**任何一端**点了 ChatGPT 登录,`auth.json` 会被写入 OAuth 凭据,而 OAuth 凭据**优先级高于 `OPENAI_BASE_URL` 环境变量**,体现为 base URL 设置完全失效、请求直连 `api.openai.com` 报 401(就是上面截图遇到的情况)。

### 2.7 **重要:Codex 推荐用 `config.toml`,不要只靠环境变量**

实践中发现:新版 Codex CLI / 插件**不一定可靠读取** `OPENAI_BASE_URL` 环境变量(很多代码路径默认走硬编码的 `https://api.openai.com/v1`)。

**主推方案 = `~/.codex/config.toml` 配 provider**(本文 §2.3 的方式),`OPENAI_BASE_URL` 环境变量可以**不设置**,完全靠 toml 里的 `base_url` 字段。

只需要 `OPENAI_API_KEY` 环境变量(或写到 `auth.json`)。

完整 `~/.codex/config.toml`(覆盖 CLI + 插件):

```toml
model_provider = "auth2api"
model = "gpt-5.5"

[model_providers.auth2api]
name = "auth2api"
base_url = "<BASE_URL>/v1"        # 必须 /v1 结尾
wire_api = "responses"            # 走 /v1/responses 协议最稳
env_key = "OPENAI_API_KEY"        # 从环境变量读 token
```

#### 推荐工作流(CLI + 插件都走代理)

1. **配 `~/.codex/config.toml`** 加 `[model_providers.auth2api]` block + 顶部 `model_provider = "auth2api"`
2. **`OPENAI_API_KEY` 写到系统级环境变量**(Win 用 `[Environment]::SetEnvironmentVariable(..., "User")`,Mac 用 `launchctl setenv` 让 GUI IDE 也读得到)
3. **永远不点 ChatGPT 登录**
4. **改完配置先清一次 auth.json**:
   ```bash
   # macOS
   rm -f ~/.codex/auth.json
   ```
   ```powershell
   # Windows
   Remove-Item "$env:USERPROFILE\.codex\auth.json" -ErrorAction SilentlyContinue
   ```
5. 关掉所有 `codex` / IDE 窗口,重开

验证(关键):

```bash
codex exec "say hi"
```

报错的话,**看错误里的 URL**:
- 走代理成功 → 正常输出
- 走代理失败 → 报错 URL 应该是 `<BASE_URL>/...`(你的代理),**不应该出现 `api.openai.com`**;出现 `api.openai.com` 说明 `auth.json` 没清干净 / `config.toml` 没生效

---

## 3. 第三方 GUI 客户端(Cherry Studio / ChatBox 等)

这类应用大都支持"自定义 OpenAI 兼容端点":

| 设置项 | 填写 |
|---|---|
| 接口类型 | OpenAI Compatible |
| Base URL / API URL | **`<BASE_URL>/v1`**(末尾要 `/v1`)|
| API Key | `<API_KEY>` |
| Model | 手填,例如 `claude-sonnet-4-5`、`claude-opus-4-7`、`gpt-5.5` 等 |

不知道有哪些模型可用 → 先跑:
```bash
curl -s -H "Authorization: Bearer <API_KEY>" <BASE_URL>/v1/models
```

---

## 4. 关于"桌面 App"

需要先澄清:**Claude.ai 桌面 app、ChatGPT 桌面 app 不能改 Base URL**,它们直连厂商服务器,无法转到本代理。能转的"客户端"是:

| 客户端 | 能转? |
|---|---|
| Claude Code CLI(`claude`) | ✅ |
| Claude Code VSCode 插件 | ✅ |
| Claude Code JetBrains 插件 | ✅ |
| OpenAI Codex CLI(`codex`) | ✅ |
| OpenAI Codex IDE 插件 | ✅ |
| Cherry Studio / ChatBox 等第三方 GUI | ✅(选 OpenAI 兼容)|
| Claude.ai 桌面 app | ❌(无 Base URL 设置项)|
| ChatGPT 桌面 app | ❌(同上)|

---

## 5. 常见问题速查

| 现象 | 排查 |
|---|---|
| `curl /health` 返回 connection refused | 网络不通,确认是否在公司内网,或重新检查 Base URL 拼写 |
| `Missing API key` | 没设环境变量,或者新开终端没继承到。重开终端 / 重启 IDE |
| `Invalid API key` | key 拼错;或者你的 key 被管理员禁用 / 轮换了,联系管理员 |
| `no_account_for_provider` | 你请求的模型对应上游账号池暂时没账号,联系管理员补充 |
| Codex CLI 报 `404 /chat/completions` | `OPENAI_BASE_URL` 末尾忘了加 `/v1` |
| Windows 改了环境变量但 `claude` 还连官方 | 没重开终端;或 IDE 是从 GUI 启动 → 用 `[Environment]::SetEnvironmentVariable(..., "User")` 写到用户级,然后重启 IDE |
| `429` / `503 upstream` | 上游账号被限流或冷却,稍等几分钟自动恢复;持续不恢复联系管理员 |

---

## 6. 自己看用量

```bash
curl -s -H "Authorization: Bearer <API_KEY>" \
  <BASE_URL>/admin/usage/keys | python3 -m json.tool
```

会列出本月你这把 key 的请求数、token 用量(只显示自己,不显示其他人)。

---

## 7. 安全提醒

- API Key 等同于团队订阅的访问凭据,**仅限本人使用,不要发到 Slack / 微信 / 邮件、不要 commit 到 Git、不要写在公开文档**
- 怀疑 key 泄漏 → 立刻联系管理员吊销并重发一把
- 不要把 Base URL 与 Key 拼在一起发图,二者拼齐 = 任何人都能消耗
- 离职 / 不再使用时主动联系管理员注销

---

## 8. 我应该用哪些模型?

`GET /v1/models` 列的就是当前可用的全部模型。常用:

| 任务 | 推荐模型 |
|---|---|
| 写代码 / Claude Code | `claude-sonnet-4-6`、`claude-opus-4-7` |
| 通用对话 / 推理 | `claude-sonnet-4-5`、`claude-haiku-4-5`(快、便宜)|
| OpenAI 系列(需要 Codex 后端) | `gpt-5.5`、`gpt-5-codex` |

具体名字以 `/v1/models` 返回为准,过段时间会更新。

---

有任何接入问题联系管理员。
