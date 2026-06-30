/** Build a ready-to-send personal access doc (markdown) for a key. Base URL is
 *  the dashboard origin (= the proxy's address). Shared by the key-creation
 *  modal and the self-service "我的" page (after rotate). */
export function buildAccessDoc(key: string, label: string | null): string {
  const base = window.location.origin;
  const who = label ? ` —— ${label}` : "";
  return `# auth2api 接入手册${who}

> 含你的专属 API key,请勿外发 / 提交到 Git。key 仅此一次明文可见。

| 项 | 值 |
|---|---|
| Base URL | ${base} |
| API 前缀 | ${base}/v1 |
| API Key | ${key} |
| 用量看板 | ${base}/ui |

## 1. Claude Code
\`\`\`bash
export ANTHROPIC_BASE_URL="${base}"
export ANTHROPIC_AUTH_TOKEN="${key}"
\`\`\`
\`\`\`powershell
[Environment]::SetEnvironmentVariable("ANTHROPIC_BASE_URL", "${base}", "User")
[Environment]::SetEnvironmentVariable("ANTHROPIC_AUTH_TOKEN", "${key}", "User")
\`\`\`
> 新版 Claude Code 用 ANTHROPIC_AUTH_TOKEN;旧版用 ANTHROPIC_API_KEY,本服务两者都收。
> 启动 claude 若弹登录菜单,选「Anthropic Console account · API usage billing」,切勿选订阅登录(会绕过代理)。

## 2. OpenAI Codex CLI(~/.codex/config.toml)
\`\`\`toml
model_provider = "auth2api"
model = "gpt-5.5"
[model_providers.auth2api]
name = "auth2api"
base_url = "${base}/v1"
wire_api = "responses"
env_key = "OPENAI_API_KEY"
\`\`\`
\`export OPENAI_API_KEY="${key}"\`,启动后选「Provide your own API key」。

## 3. 第三方 GUI / SDK(OpenAI 兼容)
- Base URL:\`${base}/v1\`
- API Key:\`${key}\`
- 模型:claude-sonnet-4-6 / claude-opus-4-8 / gpt-5.5(以 /v1/models 为准)

## 4. 烟测
\`\`\`bash
curl -s ${base}/health
curl -s -H "Authorization: Bearer ${key}" ${base}/v1/models
\`\`\`
`;
}

/** Trigger a browser download of the access doc as a .md file. */
export function downloadAccessDoc(key: string, label: string | null, idForName: string): void {
  const md = buildAccessDoc(key, label);
  const blob = new Blob([md], { type: "text/markdown" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `auth2api-接入手册-${(label || idForName).replace(/[^a-zA-Z0-9@._-]/g, "_")}.md`;
  a.click();
  URL.revokeObjectURL(url);
}
