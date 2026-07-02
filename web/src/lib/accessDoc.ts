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
  coworkBaseUrl?: string | null,
): string {
  const base = baseUrl || window.location.origin;
  const cowork = coworkBaseUrl || "https://<管理员提供的-https-地址>";
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

⚠️ Cowork **强制 https**,会拒绝明文 \`http://\` 地址并报 \`baseUrl: must use https\`。所以要走这条路,需用 **https 地址**(\`${cowork}\`)+ 安装**根证书**(向管理员索取证书文件,如 \`auth2api-aicoding.crt\`)。

### 第 1 步:安装并信任根证书

#### 🍎 macOS

**方法 A — 命令行(最快)**
\`\`\`bash
sudo security add-trusted-cert -d -r trustRoot \\
  -k /Library/Keychains/System.keychain \\
  ~/Downloads/auth2api-aicoding.crt
\`\`\`
输开机密码即可(\`-r trustRoot\` = 作为受信任根证书)。

**方法 B — 图形界面**
1. 双击 \`auth2api-aicoding.crt\` → 打开「钥匙串访问」
2. 左侧选 **「系统」(System)** 钥匙串(**不要**选「登录」),把证书拖进去
3. 双击该证书 → 展开「信任」→「使用此证书时」改为 **「始终信任」**
4. 关窗口,输密码确认

**验证**
\`\`\`bash
curl -s ${cowork}/health
# 不加 -k 也返回 {"status":"ok"} 即成功
\`\`\`
浏览器打开 \`${cowork}/health\`,地址栏锁头无红叉(Chrome / Safari 需**完全退出重开**才会重读系统证书)。

#### 🪟 Windows

**方法 A — PowerShell(必须「以管理员身份运行」)**
\`\`\`powershell
Import-Certificate -FilePath "$env:USERPROFILE\\Downloads\\auth2api-aicoding.crt" -CertStoreLocation Cert:\\LocalMachine\\Root
\`\`\`
不是管理员身份的话写不进 \`LocalMachine\`,会失败。

**方法 B — 图形界面**
1. 双击 \`auth2api-aicoding.crt\` →「安装证书」
2. 存储位置选 **「本地计算机」(Local Machine)** → 下一步(弹 UAC,同意)
3. 选「将所有的证书放入下列存储」→ 浏览 → 选 **「受信任的根证书颁发机构」**
4. 下一步 → 完成 → 安全警告点「是」

**验证**
\`\`\`powershell
curl.exe -s ${cowork}/health
# 返回 {"status":"ok"} 即成功(注意是 curl.exe,不是 curl 别名)
\`\`\`
Edge / Chrome 打开 \`${cowork}/health\` 锁头正常(浏览器需**重启**才会重读系统证书)。

> **Firefox** 用自己的证书库,不读系统的:设置 → 隐私与安全 → 证书 → 查看证书 → 证书颁发机构 → 导入,勾「信任此 CA 标识网站」。Chrome / Edge / Safari / Cowork 走系统库,按上面做即可。

### 第 2 步:在 Cowork 里填服务地址 + Key

- **Base URL**:\`${cowork}\`(必须带 https、用这个完整地址;填别的 IP 或 http 会报 \`hostname mismatch\` 或 \`must use https\`)
- **API Key**:你的 Key(见文首)

填完点 Save / Apply。

### 排错

| 现象 | 处理 |
|---|---|
| 还报 \`must use https\` | baseUrl 没改成 https,或没点 Save / Apply |
| \`cert invalid / untrusted\` | 根证书没装或没信任,回第 1 步 |
| \`hostname mismatch\` | 证书域名与所填地址不一致,找管理员确认 |
| 流式输出卡住 | 找管理员检查反代(Caddy)配置 |

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

## 🧩 MCP 工具(聚合网关)

auth2api 还暴露一个**统一 MCP 端点**,聚合团队注册的多个 MCP 服务(GitLab、Jira…)。你用同一个 key 接入,能用到的「类目」由管理员按 key 授权(**默认拒绝**,需管理员勾选)。

- MCP 端点:\`${base}/mcp\`(Streamable HTTP)
- 鉴权:\`Authorization: Bearer ${key}\`

**Claude Code 添加**:
\`\`\`bash
claude mcp add --transport http auth2api ${base}/mcp \\
  --header "Authorization: Bearer ${key}"
\`\`\`

**通用客户端**:MCP 类型选 Streamable HTTP,URL 填 \`${base}/mcp\`,加头 \`Authorization: Bearer ${key}\`。工具名形如 \`<类目>__<工具>\`(如 \`gitlab__create_issue\`)。看不到工具通常是**未被授权任何类目** —— 找管理员在「用户」页给你的 key 勾选。

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
  coworkBaseUrl?: string | null,
): void {
  const md = buildAccessDoc(key, label, baseUrl, coworkBaseUrl);
  const blob = new Blob([md], { type: "text/markdown" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `auth2api-接入手册-${(label || idForName).replace(/[^a-zA-Z0-9@._-]/g, "_")}.md`;
  a.click();
  URL.revokeObjectURL(url);
}
