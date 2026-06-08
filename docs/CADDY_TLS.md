# Caddy + TLS 前置:给 Cowork / 桌面客户端用

> 给 admin / 运维看的部署手册。同事侧只需要做一次「装 CA + 改 baseUrl」,见末尾 §6。

## 1. 为什么需要

新版 Claude 桌面客户端(Cowork / Claude.ai 桌面 3P enterprise 模式)对自定义 baseUrl 有**强制安全检查**:

```
message: Invalid custom3p enterprise config: baseUrl: must use https (or http on loopback)
failingField: baseUrl
```

- `https://*` → 接受
- `http://127.0.0.1:*` → 接受(loopback,本机内)
- `http://<内网 IP>:*` → **拒绝**(明文跨设备)

auth2api 默认监听 `0.0.0.0:8318` 明文 http,被 Cowork 拒。两条路:

| 方案 | 思路 | 工作量 |
|---|---|---|
| **方案 1:SSH 端口转发** | 客户端用 `http://127.0.0.1:8318`,SSH 隧道穿到 auth2api host | 简单但每次开机要建隧道 |
| **方案 3:Caddy + TLS**(本文)| 前置 Caddy 终结 https,反代到 auth2api。客户端用 `https://host` | 装一次永远不动 |

团队 ≥ 3 人 → 推荐方案 3。

## 2. 架构

```
┌────────────────────┐          https://auth2api.<domain>:8443
│ Cowork @ Mac A     │ ─────────────────────────────────────────┐
│ Cowork @ Mac B     │                                          │
│ Claude Code @ ...  │                                          ▼
└────────────────────┘                              ┌──────────────────────┐
                                                    │  Caddy :8443 (新)    │
                                                    │  • TLS 终结           │
                                                    │  • tls internal       │
                                                    │     (Caddy 自建 CA)   │
                                                    └────────┬─────────────┘
                                                             │  http://127.0.0.1:8318
                                                             ▼
                                                    ┌──────────────────────┐
                                                    │  auth2api :8318       │
                                                    │  绑回 loopback        │
                                                    └────────┬─────────────┘
                                                             │ https
                                                             ▼
                                                          Anthropic
```

**特点**:
- auth2api 一行代码不动
- TLS cert 由 Caddy 自动生成 + 续期(`tls internal`)
- 客户端只需要信任 Caddy 的本地 CA(每个机器一次性操作)
- 端口默认 8443(无需 root)

## 3. 准备工作

### 3.1 选 hostname

证书绑 hostname 比绑 IP 兼容性好。给 auth2api 起个内网域名,例如:

- `auth2api.local`(简单,但 macOS 的 `.local` 走 mDNS,可能冲突)
- `ai.team`、`auth2api.corp`、`auth2api.internal`(推荐)

如果不能上公司 DNS,就用 `/etc/hosts` 一行解析(下面 §6.1)。

### 3.2 选端口

| 端口 | 优 | 劣 |
|---|---|---|
| **8443**(推荐)| 非特权,普通用户能起 | URL 多一个 `:8443` |
| 443 | URL 干净(`https://host` 不带端口)| 需要以 root 跑 Caddy(LaunchDaemon)|

下面默认走 8443。

## 4. Host 侧:装 Caddy + 起服务

### 4.1 装 Caddy

```bash
# 方案 a:Homebrew(若有)
brew install caddy

# 方案 b:mise(本仓库 host 已有 mise)
mise install caddy@latest
ln -sf "$(mise where caddy)/caddy" ~/.local/bin/caddy

# 方案 c:直接下二进制
curl -sSfLo /usr/local/bin/caddy \
  "https://github.com/caddyserver/caddy/releases/latest/download/caddy_$(uname -s | tr A-Z a-z)_amd64"
chmod +x /usr/local/bin/caddy

# 验证
caddy version
```

### 4.2 写 Caddyfile

```bash
# 从仓库模板复制
mkdir -p /usr/local/etc
cp scripts/Caddyfile.example /usr/local/etc/Caddyfile

# 改占位符(把 auth2api.team 改成你选的 hostname,IP 改成实际)
$EDITOR /usr/local/etc/Caddyfile
```

模板关键内容:
```caddyfile
{ auto_https off; admin off }

https://auth2api.team:8443, https://172.16.13.203:8443 {
    tls internal
    reverse_proxy 127.0.0.1:8318 {
        flush_interval -1   # 必须 — 流式 SSE 不缓冲
    }
}
```

`flush_interval -1` 是**关键** — Claude Code / Cowork 用 SSE 流,Caddy 默认缓冲会让流式回包变成"等全部完成再吐",体验崩。

### 4.3 起 Caddy(launchd)

```bash
# 复制 plist 模板,改占位符
cp scripts/com.example.caddy.example.plist \
   ~/Library/LaunchAgents/com.$(whoami).caddy.plist
# 用 sed 一把替换(或手改)
sed -i '' "s|<user>|$(whoami)|g; s|<CADDY-BIN>|$(which caddy)|g; s|<CADDYFILE>|/usr/local/etc/Caddyfile|g" \
  ~/Library/LaunchAgents/com.$(whoami).caddy.plist

# 日志目录
mkdir -p ~/.auth2api-logs

# load + 验证
launchctl load ~/Library/LaunchAgents/com.$(whoami).caddy.plist
launchctl list | grep caddy             # 应看到 PID > 0
```

### 4.4(推荐)把 auth2api 绑回 loopback

外网直连 8318 端口失去意义(走 Caddy 了),关掉减小攻击面:

```bash
# 编辑 config.yaml
sed -i '' "s|host: '0.0.0.0'|host: '127.0.0.1'|" /Users/$(whoami)/work/github/auth2api/config.yaml

# 重启 auth2api
launchctl unload ~/Library/LaunchAgents/com.$(whoami).auth2api.plist
launchctl load   ~/Library/LaunchAgents/com.$(whoami).auth2api.plist
```

如果还想保留 ssh tunnel 用户使用方案 1,**别**改这一步(保持 0.0.0.0)。

### 4.5 端到端测试

```bash
# 直连 8318 应不可达(若已绑 loopback)
curl -m 2 http://172.16.13.203:8318/health        # connection refused 或 timeout

# 走 Caddy 应通
curl -k https://172.16.13.203:8443/health         # 期望 {"status":"ok"}
#    -k 因为你本机还没装 Caddy 的 root CA,后面装了就不用 -k 了

# 真实业务请求
curl -k -H "Authorization: Bearer <你的 admin key>" \
  https://172.16.13.203:8443/v1/models | python3 -m json.tool
```

### 4.6 拿出 root CA 给客户端

```bash
# Caddy internal CA 位置(macOS):
CA=~/Library/Application\ Support/Caddy/pki/authorities/local/root.crt
ls -la "$CA"                                       # 确认存在

# 复制到一个方便分发的地方,比如 Slack 上传 / 飞书文档附件
cp "$CA" ~/Desktop/auth2api-caddy-root.crt
```

这是个 PEM 文件(~1.5 KB),分发给每个客户端机器。

## 5. 同事侧:每个客户端机器一次性

### 5.1 加 hostname → IP 解析(如果用了 hostname)

```bash
# macOS
sudo bash -c 'echo "172.16.13.203 auth2api.team" >> /etc/hosts'

# Windows(管理员 PowerShell)
Add-Content "C:\Windows\System32\drivers\etc\hosts" "172.16.13.203 auth2api.team"

# Linux
sudo sh -c 'echo "172.16.13.203 auth2api.team" >> /etc/hosts'
```

(如果不用 hostname,直接用 IP 形式 `https://172.16.13.203:8443` 也行,跳过这步)

### 5.2 装信任 Caddy 的 root CA

把 admin 发给你的 `auth2api-caddy-root.crt` 拖到机器上,然后:

**macOS**:
```bash
# 加进系统 keychain,标记为 SSL 始终信任
sudo security add-trusted-cert -d -r trustRoot \
  -k /Library/Keychains/System.keychain \
  ~/Downloads/auth2api-caddy-root.crt

# 验证
security find-certificate -c "Caddy Local Authority" /Library/Keychains/System.keychain
```

或者图形界面操作:双击 `.crt` → 添加到「系统钥匙串」→ 在 Keychain Access 找到它 → 右键「显示简介」→「信任」展开 → 「使用此证书时」选「始终信任」。

**Windows**(管理员 PowerShell):
```powershell
Import-Certificate -FilePath C:\path\to\auth2api-caddy-root.crt `
  -CertStoreLocation Cert:\LocalMachine\Root
```

**Linux**(以 Ubuntu/Debian 为例):
```bash
sudo cp auth2api-caddy-root.crt /usr/local/share/ca-certificates/auth2api.crt
sudo update-ca-certificates
```

### 5.3 验证浏览器能信

打开浏览器访问 `https://auth2api.team:8443/health` —— 应该看到 `{"status":"ok"}`,**且地址栏锁头没有红叉/警告**。如果有警告,root CA 没装到位,重做 §5.2。

## 6. 在 Cowork / 桌面客户端里配置

打开 Cowork app → Settings → Custom Provider(3P) → 改 baseUrl:

```
https://auth2api.team:8443         (推荐:用 hostname)
或
https://172.16.13.203:8443         (用 IP,证书也覆盖了)
```

API Key 填管理员发给你的 `sk-...`(原样不变)。

保存,Cowork 应不再报 "must use https" 的错。

## 7. Claude Code CLI / IDE 插件也可以走 https

Claude Code 之前接的是 `http://172.16.13.203:8318`,可以平滑切到 https:

**macOS**:
```bash
# ~/.zshrc
export ANTHROPIC_BASE_URL="https://auth2api.team:8443"
export ANTHROPIC_API_KEY="sk-..."
```

**Windows PowerShell**:
```powershell
[Environment]::SetEnvironmentVariable("ANTHROPIC_BASE_URL", "https://auth2api.team:8443", "User")
[Environment]::SetEnvironmentVariable("ANTHROPIC_API_KEY",  "sk-...", "User")
```

只要 root CA 装好,Claude Code 也认这个 https。

## 8. 常见问题

| 现象 | 排查 |
|---|---|
| 浏览器开 https 还是不信(锁头红叉) | root CA 没装好;Mac 看「钥匙串访问」里有没有 "Caddy Local Authority",信任状态是不是「始终信任」 |
| Cowork 仍报 "must use https" | baseUrl 没改对,或者还指着 http://;改完保存一定要点 Apply / Save |
| Cowork 报 cert invalid / untrusted | 客户端机器的 root CA 没装,或者证书的 SAN 没覆盖你输的 host(IP vs hostname 没都列)|
| Caddy 起不来,launchd err.log 报权限 | 8443 端口是好的;若用 443 必须以 LaunchDaemon(root)跑 |
| 流式响应卡 / 看不到逐字输出 | Caddyfile 里 `flush_interval -1` 没加;加上重启 Caddy(`launchctl unload + load`)|
| Caddy 起来了但 503 | 后端 auth2api 没跑;先 `curl http://127.0.0.1:8318/health` 直检 |
| 8443 端口被别的占了 | 改 Caddyfile 里 listen 端口,客户端 baseUrl 同步改 |

## 9. 维护

- **Caddy 自动续期** internal CA 签的证书(默认 server cert 90 天),你不用管
- root CA(在客户端 trust 的)有效期 10 年,基本永久
- Caddy 升级:`brew upgrade caddy` 或 `mise upgrade caddy`,然后 `launchctl unload + load`
- 看 Caddy 访问日志:`tail -f /var/log/caddy/auth2api.access.log`(本配置里写到这里)
- 看 Caddy 错误:`tail -f ~/.auth2api-logs/caddy.err.log`

## 10. 撤掉(回滚)

```bash
# Host 侧
launchctl unload ~/Library/LaunchAgents/com.$(whoami).caddy.plist
rm ~/Library/LaunchAgents/com.$(whoami).caddy.plist
# 把 auth2api 改回 host: '0.0.0.0',重启

# 客户端侧
sudo security delete-certificate -c "Caddy Local Authority - 2026 ECC Root" /Library/Keychains/System.keychain
# 或图形界面在 Keychain Access 里删

# /etc/hosts 那行
sudo sed -i '' '/auth2api.team/d' /etc/hosts
```

---

相关:
- [`OPERATIONS.md`](OPERATIONS.md):整体运维手册
- [`CLIENT_SETUP.md`](CLIENT_SETUP.md):同事侧客户端接入(Claude Code / Codex CLI / Cowork)
