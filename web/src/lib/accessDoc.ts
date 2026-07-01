import { marked } from "marked";

/**
 * Build a ready-to-send personal access doc (Markdown) for a key. Base URL is
 * the dashboard origin (= the proxy's address). Shared by the key-creation
 * modal and the self-service "我的" page (after rotate).
 *
 * Content merged from the team's field-tested onboarding guides: smoke test,
 * Claude Code (CLI + IDE), Claude desktop (Cowork/https), Codex CLI, 3rd-party
 * GUIs, SDK/curl, usage dashboard, model picker, troubleshooting, security.
 */
export function buildAccessDoc(
  key: string,
  label: string | null,
  baseUrl?: string | null,
): string {
  const base = baseUrl || window.location.origin;
  const who = label ? `(${label})` : "";
  return `# 🚀 auth2api 接入与使用手册 ${who}

> 我们用内部代理 **auth2api** 把团队的 Claude / Codex 订阅统一成一个 API。你只需一个 **API Key**,就能在 Claude Code、Claude 桌面 App、各种客户端里用,**无需自己登录、无需自己付费**。

> ⚠️ **此 Key 等同于团队订阅的钥匙,仅限本人**:不要发微信 / Slack / 邮件、不要传到 Git、不要和 Base URL 拼在一张图里发出去。怀疑泄漏立刻找管理员吊销重发;离职 / 不用了主动注销。

---

## 你的接入信息

| 项 | 值 |
|---|---|
| Base URL | \`${base}\` |
| API 前缀 | \`${base}/v1\` |
| API Key | \`${key}\` |
| 用量看板 | \`${base}/ui\` |
| 权限 | 普通成员:调用业务接口 + 查看自己的用量(只读) |

---

## ✅ 第 0 步:30 秒自测(强烈建议先做)

打开终端(Mac 终端 / Windows PowerShell):

\`\`\`bash
# 1. 测网络通不通
curl -s ${base}/health
# 期望:{"status":"ok"}

# 2. 测 Key 对不对
curl -s -H "Authorization: Bearer ${key}" ${base}/v1/models
# 期望:一串模型列表 {"data":[{"id":"claude-sonnet-..."}, ...]}
\`\`\`

两条都通 → 往下任选你要用的客户端。不通 → 看文末「常见问题」。

---

## 🅰️ 方式一:Claude Code(写代码首选)

Anthropic 官方 CLI / IDE 插件,**只配两个环境变量**,不改任何配置文件。

**安装(装过可跳过)**
\`\`\`bash
# macOS
curl -fsSL https://claude.ai/install.sh | bash
\`\`\`
\`\`\`powershell
# Windows PowerShell
irm https://claude.ai/install.ps1 | iex
\`\`\`
> 装完**先别** \`claude login\`(那是用你私人账号)。之前登录过的先 \`claude logout\` 清掉。

**配置环境变量**
\`\`\`bash
# macOS / Linux — 写入 ~/.zshrc 或 ~/.bashrc 后 source
export ANTHROPIC_BASE_URL="${base}"
export ANTHROPIC_AUTH_TOKEN="${key}"
\`\`\`
\`\`\`powershell
# Windows — User 级别,设完关掉窗口重开
[Environment]::SetEnvironmentVariable("ANTHROPIC_BASE_URL", "${base}", "User")
[Environment]::SetEnvironmentVariable("ANTHROPIC_AUTH_TOKEN", "${key}", "User")
\`\`\`
> 新版 Claude Code 用 \`ANTHROPIC_AUTH_TOKEN\`(以 \`Authorization: Bearer\` 发送);旧版用 \`ANTHROPIC_API_KEY\`(以 \`x-api-key\` 发送)。本服务两者都收。若之前设过旧的 \`ANTHROPIC_API_KEY\`,建议先 \`unset ANTHROPIC_API_KEY\` 避免歧义。

**启动**:\`claude\`

**若启动后弹「选择登录方式」菜单**:说明环境变量没生效(先 \`echo $ANTHROPIC_BASE_URL\` 确认)。若要继续,**选第 2 项 \`Anthropic Console account · API usage billing\`**,**绝不要选第 1 项订阅登录**(会绕过代理直连官方)。

**IDE 插件(VSCode / JetBrains)**:读同一套环境变量,永久写入后**重启 IDE** 即可。

**误登录清理**:\`claude logout && rm -f ~/.claude/.credentials.json\`(Windows 删 \`%USERPROFILE%\\.claude\\.credentials.json\`)。

---

## 🅱️ 方式二:Claude 桌面 App(Cowork 企业模式)

> 仅适用新版 Claude 桌面客户端的 **Cowork / 3P enterprise** 模式(支持自定义服务地址);普通 Claude.ai 聊天 App 没有该设置项。

⚠️ Cowork **强制 https**,会拒绝明文 \`http://\` 地址并报 \`baseUrl: must use https\`。这条路需**管理员提供一个 https 地址 + 根证书**:
1. 装管理员发的根证书(macOS 拖进「系统」钥匙串设「始终信任」,或 \`sudo security add-trusted-cert -d -r trustRoot -k /Library/Keychains/System.keychain <cert>\`;Windows 以管理员 PowerShell \`Import-Certificate -CertStoreLocation Cert:\\LocalMachine\\Root\`)。
2. 客户端 baseUrl 填管理员给的 https 地址(必须完全一致,否则证书 SAN 对不上报 hostname mismatch),API Key 填你的 Key。
> Firefox 用自己的证书库需单独导入;Chrome / Edge / Safari / Cowork 走系统库。找不到 https 地址就联系管理员。

---

## 🅲 方式三:Codex CLI / 第三方 GUI

**OpenAI Codex CLI** — 推荐 \`~/.codex/config.toml\`(比环境变量稳):
\`\`\`toml
model_provider = "auth2api"
model = "gpt-5.5"

[model_providers.auth2api]
name = "auth2api"
base_url = "${base}/v1"
wire_api = "responses"
env_key = "OPENAI_API_KEY"
\`\`\`
\`export OPENAI_API_KEY="${key}"\`,启动 \`codex\` 后选 **Provide your own API key**(不要点 ChatGPT 登录)。误登录清理:\`rm -f ~/.codex/auth.json\`。

**第三方 GUI(Cherry Studio / ChatBox / NextChat 等)** — 选「OpenAI 兼容」类型:
- 接口地址 / Base URL:\`${base}/v1\`
- API Key:\`${key}\`
- 模型:手填(见下方「该用哪个模型」)

---

## 🧑‍💻 方式四:直接用 SDK / curl

**OpenAI 兼容(Chat Completions)**
\`\`\`bash
curl -s ${base}/v1/chat/completions \\
  -H "Authorization: Bearer ${key}" \\
  -H "Content-Type: application/json" \\
  -d '{"model":"claude-sonnet-4-6","messages":[{"role":"user","content":"你好"}]}'
\`\`\`

**Anthropic 原生(Messages)**
\`\`\`bash
curl -s ${base}/v1/messages \\
  -H "Authorization: Bearer ${key}" \\
  -H "Content-Type: application/json" \\
  -d '{"model":"claude-sonnet-4-6","max_tokens":1024,"messages":[{"role":"user","content":"你好"}]}'
\`\`\`

**Python(OpenAI SDK)**
\`\`\`python
from openai import OpenAI
client = OpenAI(base_url="${base}/v1", api_key="${key}")
resp = client.chat.completions.create(
    model="claude-sonnet-4-6",
    messages=[{"role": "user", "content": "你好"}],
)
print(resp.choices[0].message.content)
\`\`\`
可用端点:\`/v1/models\`、\`/v1/chat/completions\`、\`/v1/responses\`、\`/v1/messages\`、\`/v1/messages/count_tokens\`。

---

## 📊 查自己的用量

浏览器打开 **\`${base}/ui\`**,用你的 API Key 登录 →「我的」页看请求数、Token、成本(普通成员只读)。命令行:
\`\`\`bash
curl -s -H "Authorization: Bearer ${key}" ${base}/admin/usage/keys | python3 -m json.tool
\`\`\`

---

## 🤖 该用哪个模型?

以 \`${base}/v1/models\` 返回为准。常用:

| 任务 | 推荐模型 |
|---|---|
| 写代码 / Claude Code | \`claude-sonnet-4-6\`、\`claude-opus-4-8\` |
| 通用对话 / 推理 | \`claude-sonnet-4-6\`、\`claude-haiku-4-5\`(快、省) |
| OpenAI 系列(需 Codex 后端) | \`gpt-5.5\`、\`gpt-5-codex\` |

省略 \`model\` 默认 \`claude-sonnet-4-6\`。

---

## ❓ 常见问题速查

| 现象 | 排查 / 处理 |
|---|---|
| \`/health\` connection refused / 超时 | 不在公司内网或未连 VPN;确认能访问 Base URL 主机 |
| \`Missing API key\` | 没设环境变量,或没重开终端 / 没重启 IDE |
| \`401 / Invalid API key\` | Key 填错或漏了 \`Bearer\`;或被禁用 / 轮换 → 找管理员 |
| 启动弹「选择登录方式」 | 环境变量没生效,见方式一排查 |
| \`403 model_not_allowed\` | 你的 Key 被限制了可用模型,换模型或找管理员开通 |
| \`429\`(限流 / 配额) | 上游限流或月度配额用满,看 \`Retry-After\` 或找管理员 |
| Codex 报 \`404 /chat/completions\` | base 地址末尾忘了加 \`/v1\` |
| Windows 改了变量还连官方 | 用 \`SetEnvironmentVariable(..., "User")\` 写用户级并重启 IDE |

---

> 有任何接入问题,联系管理员。
`;
}

/** Render an access doc's Markdown to HTML for in-page preview. Content is our
 *  own generated template (trusted); rendered inside a \`.md-body\` container. */
export function renderAccessDocHtml(md: string): string {
  return marked.parse(md, { async: false, gfm: true, breaks: false }) as string;
}

/** Trigger a browser download of the access doc as a .md file. */
export function downloadAccessDoc(
  key: string,
  label: string | null,
  idForName: string,
  baseUrl?: string | null,
): void {
  const md = buildAccessDoc(key, label, baseUrl);
  const blob = new Blob([md], { type: "text/markdown" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `auth2api-接入手册-${(label || idForName).replace(/[^a-zA-Z0-9@._-]/g, "_")}.md`;
  a.click();
  URL.revokeObjectURL(url);
}
