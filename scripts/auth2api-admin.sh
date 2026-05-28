#!/usr/bin/env bash
# auth2api-admin.sh — 团队 API key 全生命周期管理
#
# 子命令:
#   add <user>              开通新用户 + 生成专属手册 + 重启服务
#   list                    列出所有用户(label / 权限 / 配额 / 本月用量)
#   usage [<user>]          查看用量(单个用户或全部)
#   quota <user> [opts]     设置月度配额(--usd N 和/或 --tokens N)
#   unquota <user>          清除配额(无限制)
#   enable <user>           启用账号
#   disable <user>          禁用账号(请求会被 403 拒掉)
#   delete <user>           删除账号(需要 --yes 确认)
#   doc <user>              重新生成某用户的专属手册(key 从 config 读)
#
# 通用选项:
#   <user> 可以是完整 label("zhangsan/dev")或唯一 username("zhangsan")
#   --help / -h 显示完整帮助

set -euo pipefail

# ─── 常量 ────────────────────────────────────────────────────────────────
REPO_DIR="/Users/admin04/work/github/auth2api"
CONFIG="$REPO_DIR/config.yaml"
PLIST="$HOME/Library/LaunchAgents/com.admin04.auth2api.plist"
OUT_DIR="$REPO_DIR/out/onboarding"
ADMIN_ENV="$REPO_DIR/.auth2api-admin.env"
YAML_UTIL="$REPO_DIR/scripts/_yaml_util.py"
LAN_URL="http://172.16.13.205:8317"
VPN_URL="http://172.16.2.31:8317"
LOCAL_BASE="http://127.0.0.1:8317"

# ─── 颜色(终端有 tty 时才用)─────────────────────────────────────────────
if [[ -t 1 ]]; then
  C_RED=$'\e[31m'; C_GRN=$'\e[32m'; C_YLW=$'\e[33m'; C_BLU=$'\e[34m'
  C_GRY=$'\e[90m'; C_BLD=$'\e[1m'; C_RST=$'\e[0m'
else
  C_RED=""; C_GRN=""; C_YLW=""; C_BLU=""; C_GRY=""; C_BLD=""; C_RST=""
fi

die() { echo "${C_RED}Error:${C_RST} $*" >&2; exit 1; }
info() { echo "${C_BLU}→${C_RST} $*"; }
ok() { echo "${C_GRN}✓${C_RST} $*"; }
warn() { echo "${C_YLW}!${C_RST} $*" >&2; }

# ─── 加载 admin key ──────────────────────────────────────────────────────
load_admin_env() {
  if [[ ! -f "$ADMIN_ENV" ]]; then
    cat >&2 <<EOF
${C_RED}Error:${C_RST} 找不到 admin 配置文件: $ADMIN_ENV

首次使用,从模板复制一份并填入真实 admin key:

  cp $REPO_DIR/.auth2api-admin.env.example $ADMIN_ENV
  chmod 600 $ADMIN_ENV
  # 然后用编辑器把 ADMIN_API_KEY 改成真实值

找 admin key 的快捷命令(在 config.yaml 里找 admin: true 的那把):

  grep -B1 'admin: true' $CONFIG | grep '  - key:' | awk '{print \$3}'

$ADMIN_ENV 已在 .gitignore 中,不会被 commit。
EOF
    exit 1
  fi
  # shellcheck source=/dev/null
  source "$ADMIN_ENV"
  if [[ -z "${ADMIN_API_KEY:-}" ]]; then
    die "ADMIN_API_KEY 未定义于 $ADMIN_ENV"
  fi
  if [[ ! "$ADMIN_API_KEY" =~ ^sk- ]]; then
    die "ADMIN_API_KEY 格式不对(应以 sk- 开头),from $ADMIN_ENV"
  fi
}

# ─── 解析 user 简写为完整 label ──────────────────────────────────────────
# 输入:可以是 "zhangsan" 或 "zhangsan/dev"
# 输出:完整 label,或退出报错
resolve_label() {
  local input="$1"
  local json
  json=$(python3 "$YAML_UTIL" --config "$CONFIG" list)
  # 直接全匹配
  if echo "$json" | python3 -c "
import sys, json
d = json.load(sys.stdin)
labels = [x['label'] for x in d if x['label']]
target = '''$input'''
if target in labels:
    print(target)
    sys.exit(0)
# username only — match unique
matches = [l for l in labels if l.split('/')[0] == target]
if len(matches) == 1:
    print(matches[0])
    sys.exit(0)
elif len(matches) > 1:
    sys.stderr.write('ambiguous:\\n')
    for m in matches: sys.stderr.write('  ' + m + '\\n')
    sys.exit(2)
else:
    sys.stderr.write('no match for: ' + target + '\\n')
    sys.exit(3)
" 2>&1; then
    return 0
  else
    local rc=$?
    if (( rc == 2 )); then
      die "用户名不唯一,请用完整 label(例如 zhangsan/dev)"
    elif (( rc == 3 )); then
      die "找不到用户: $input"
    else
      die "解析 label 失败"
    fi
  fi
}

# ─── YAML 写入封装 ───────────────────────────────────────────────────────
# 用法: yaml_mutate <subcommand> [args...]
# 自动 backup → tmp 写入 → 校验行数 → 替换。失败时回滚。
yaml_mutate() {
  local subcmd="$1"
  shift
  local ts
  ts="$(date +%Y%m%d-%H%M%S)"
  local backup="$CONFIG.bak.$ts"
  cp "$CONFIG" "$backup"
  if ! python3 "$YAML_UTIL" --config "$CONFIG" --out "$CONFIG.tmp" "$subcmd" "$@"; then
    rm -f "$CONFIG.tmp"
    die "yaml mutation failed ($subcmd)"
  fi
  # 简单校验:文件至少有 host: 行
  if ! grep -q "^host:" "$CONFIG.tmp"; then
    rm -f "$CONFIG.tmp"
    die "yaml mutation produced bad output (missing host:)"
  fi
  mv "$CONFIG.tmp" "$CONFIG"
  echo "$backup"   # 返回 backup 路径供调用者使用
}

# ─── 重启服务 + 健康检查 ─────────────────────────────────────────────────
reload_service() {
  info "Reloading launchd service..."
  launchctl unload "$PLIST"
  launchctl load   "$PLIST"
  local i
  for i in {1..15}; do
    if curl -fs --max-time 1 "$LOCAL_BASE/health" >/dev/null 2>&1; then
      ok "Service healthy"
      return 0
    fi
    sleep 1
  done
  return 1
}

# 失败回滚:把 $1 backup 恢复回去,再重载
rollback() {
  local backup="$1"
  warn "Rolling back config from $backup"
  cp "$backup" "$CONFIG"
  launchctl unload "$PLIST" 2>/dev/null || true
  launchctl load   "$PLIST" 2>/dev/null || true
}

# ─── 调用 /admin/usage/keys 拿用量 JSON ──────────────────────────────────
fetch_usage_json() {
  curl -fs -H "Authorization: Bearer $ADMIN_API_KEY" "$LOCAL_BASE/admin/usage/keys" \
    || die "/admin/usage/keys 调用失败,检查 ADMIN_API_KEY 是否正确 + 服务是否在跑"
}

# ─── 子命令: add ─────────────────────────────────────────────────────────
cmd_add() {
  local username="" email="" role="dev" admin_flag="false" include_vpn="false"
  local quota_usd="" quota_tokens=""

  while [[ $# -gt 0 ]]; do
    case "$1" in
      --email)   email="$2"; shift 2 ;;
      --role)    role="$2"; shift 2 ;;
      --admin)   admin_flag="true"; shift ;;
      --vpn)     include_vpn="true"; shift ;;
      --quota-usd)    quota_usd="$2"; shift 2 ;;
      --quota-tokens) quota_tokens="$2"; shift 2 ;;
      -*) die "Unknown flag: $1" ;;
      *)
        if [[ -z "$username" ]]; then username="$1"; shift
        else die "Unexpected positional: $1"
        fi
        ;;
    esac
  done

  [[ -n "$username" ]] || die "username is required"
  [[ "$username" =~ ^[a-zA-Z0-9._-]+$ ]] || die "username must match [a-zA-Z0-9._-]+"
  [[ -z "$email" || "$email" =~ ^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]+$ ]] \
    || die "email format invalid"

  local label="$username/$role"

  # 重名检查
  if python3 "$YAML_UTIL" --config "$CONFIG" list | grep -q "\"label\": \"$label\""; then
    die "label '$label' 已存在,换一个 --role 或先 delete 旧的"
  fi

  local new_key
  new_key="sk-$(openssl rand -hex 32)"

  # 写 YAML
  local args=(--label "$label" --key "$new_key" --admin "$admin_flag")
  [[ -n "$email" ]] && args+=(--owner "$email")
  local backup
  backup=$(yaml_mutate add "${args[@]}")
  ok "Added entry to $CONFIG (backup: $backup)"

  # 顺手设配额
  if [[ -n "$quota_usd" || -n "$quota_tokens" ]]; then
    local qargs=(--label "$label")
    [[ -n "$quota_usd" ]]    && qargs+=(--cost-usd "$quota_usd")
    [[ -n "$quota_tokens" ]] && qargs+=(--tokens "$quota_tokens")
    yaml_mutate set-quota "${qargs[@]}" >/dev/null
    ok "Set quota: ${quota_usd:+\$$quota_usd}${quota_tokens:+ + ${quota_tokens} tokens}/month"
  fi

  # 重启 + 自测
  if ! reload_service; then
    rollback "$backup"
    die "service did not become healthy"
  fi
  local code
  code=$(curl -s -o /dev/null -w "%{http_code}" \
    -H "Authorization: Bearer $new_key" "$LOCAL_BASE/v1/models" || true)
  if [[ "$code" != "200" ]]; then
    rollback "$backup"
    die "new key rejected (HTTP $code)"
  fi
  ok "New key accepted by running service"

  # 生成手册
  generate_doc "$username" "$label" "$new_key" "$email" "$admin_flag" "$include_vpn" "$quota_usd" "$quota_tokens"
  local doc_file="$OUT_DIR/$username.md"

  echo
  echo "${C_BLD}═══ User onboarded ═══${C_RST}"
  printf "  %-10s %s\n" "Label:"  "$label"
  printf "  %-10s %s\n" "Email:"  "${email:-—}"
  printf "  %-10s %s\n" "Admin:"  "$admin_flag"
  printf "  %-10s %s\n" "Quota:"  "$( [[ -n "$quota_usd$quota_tokens" ]] && echo "${quota_usd:+\$$quota_usd}${quota_tokens:+ + $quota_tokens tokens}/month" || echo "unlimited" )"
  printf "  %-10s %s\n" "Key:"    "$new_key"
  printf "  %-10s %s\n" "Manual:" "$doc_file"
  echo
  echo "Next: 把 ${C_BLU}$doc_file${C_RST} 私聊发给 $username"
}

# ─── 子命令: list ────────────────────────────────────────────────────────
cmd_list() {
  local json_only="false"
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --json) json_only="true"; shift ;;
      *) die "Unknown flag: $1" ;;
    esac
  done

  local usage_json
  usage_json=$(fetch_usage_json 2>/dev/null || echo '{"keys":[]}')

  if [[ "$json_only" == "true" ]]; then
    echo "$usage_json" | python3 -m json.tool
    return
  fi

  # 表格输出
  python3 - "$usage_json" <<'PYEOF'
import json, sys
data = json.loads(sys.argv[1])
keys = data.get("keys", [])

def fmt_tokens(n):
    if n is None or n == 0: return "—"
    if n >= 1_000_000: return f"{n/1_000_000:.1f}M"
    if n >= 1_000:     return f"{n/1_000:.1f}K"
    return str(n)

print()
print(f"{'LABEL':<22} {'ADMIN':<6} {'EN':<4} {'QUOTA (monthly)':<20} {'COST MTD':<16} {'TOKENS':<10} {'EMAIL'}")
print("─" * 108)
for k in keys:
    label   = k.get("label") or "(unlabeled)"
    admin   = "✓" if k.get("admin") else "·"
    enabled = "✓" if k.get("enabled") else "✗"

    q = k.get("quota") or {}
    quota_parts = []
    if q.get("monthly-cost-usd") is not None:
        quota_parts.append(f"${q['monthly-cost-usd']}")
    if q.get("monthly-tokens") is not None:
        quota_parts.append(f"{fmt_tokens(q['monthly-tokens'])}t")
    quota = " + ".join(quota_parts) if quota_parts else "unlimited"

    c = k.get("consumed") or {}
    cost_used = c.get("costUsd", 0) or 0
    tok_used  = c.get("tokens", 0) or 0

    cost_col = f"${cost_used:.2f}"
    if q.get("monthly-cost-usd"):
        pct = cost_used / q["monthly-cost-usd"] * 100
        cost_col = f"${cost_used:.2f} ({pct:.0f}%)"

    tok_col = fmt_tokens(tok_used)
    email = k.get("owner") or "—"

    print(f"{label:<22} {admin:<6} {enabled:<4} {quota:<20} {cost_col:<16} {tok_col:<10} {email}")

print()
print(f"Total: {len(keys)} key(s)  •  month-to-date UTC  •  pct shown when quota is set")
PYEOF
}

# ─── 子命令: usage ───────────────────────────────────────────────────────
cmd_usage() {
  local target="" json_only="false"
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --json) json_only="true"; shift ;;
      -*) die "Unknown flag: $1" ;;
      *) target="$1"; shift ;;
    esac
  done

  local usage_json
  usage_json=$(fetch_usage_json)

  if [[ -z "$target" ]]; then
    if [[ "$json_only" == "true" ]]; then
      echo "$usage_json" | python3 -m json.tool
    else
      cmd_list
    fi
    return
  fi

  local label
  label=$(resolve_label "$target")

  python3 - "$usage_json" "$label" "$json_only" <<'PYEOF'
import json, sys
data = json.loads(sys.argv[1])
target = sys.argv[2]
json_only = sys.argv[3] == "true"
for k in data.get("keys", []):
    if k.get("label") != target:
        continue
    if json_only:
        print(json.dumps(k, indent=2))
        sys.exit(0)
    print()
    print(f"  \033[1m{k['label']}\033[0m" + ("  [admin]" if k.get("admin") else "") + ("  [disabled]" if not k.get("enabled") else ""))
    if k.get("owner"):
        print(f"  Owner:        {k['owner']}")
    print()
    c = k.get("consumed") or {}
    q = k.get("quota") or {}
    u = k.get("usage") or {}
    print(f"  Month-to-date 用量:")
    print(f"    Requests:     {c.get('requests', 0):,}")
    print(f"    Input tokens: {c.get('inputTokens', 0):,}")
    print(f"    Output tokens:{c.get('outputTokens', 0):,}")
    print(f"    Cache create: {c.get('cacheCreationTokens', 0):,}")
    print(f"    Cache read:   {c.get('cacheReadTokens', 0):,}")
    print(f"    Total tokens: {c.get('tokens', 0):,}")
    print(f"    Cost (USD):   ${c.get('costUsd', 0):.4f}")
    print()
    if q:
        print(f"  配额:")
        if q.get("monthly-cost-usd") is not None:
            limit = q["monthly-cost-usd"]
            used = c.get("costUsd", 0) or 0
            pct = used / limit * 100 if limit else 0
            print(f"    Cost:   ${used:.2f} / ${limit:.2f}  ({pct:.1f}%)")
        if q.get("monthly-tokens") is not None:
            limit = q["monthly-tokens"]
            used = c.get("tokens", 0) or 0
            pct = used / limit * 100 if limit else 0
            print(f"    Tokens: {used:,} / {limit:,}  ({pct:.1f}%)")
    else:
        print(f"  配额:        unlimited")
    print()
    sys.exit(0)
print(f"\033[31mno data for {target}\033[0m", file=sys.stderr)
sys.exit(1)
PYEOF
}

# ─── 子命令: quota ───────────────────────────────────────────────────────
cmd_quota() {
  local target="" usd="" tokens=""
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --usd)    usd="$2"; shift 2 ;;
      --tokens) tokens="$2"; shift 2 ;;
      -*) die "Unknown flag: $1" ;;
      *) target="$1"; shift ;;
    esac
  done
  [[ -n "$target" ]] || die "需要指定用户"
  [[ -n "$usd" || -n "$tokens" ]] || die "需要 --usd 或 --tokens 至少一个"

  local label
  label=$(resolve_label "$target")

  local args=(--label "$label")
  [[ -n "$usd" ]]    && args+=(--cost-usd "$usd")
  [[ -n "$tokens" ]] && args+=(--tokens "$tokens")

  local backup
  backup=$(yaml_mutate set-quota "${args[@]}")
  ok "Set quota for $label: ${usd:+\$$usd}${tokens:+ + $tokens tokens}/month  (backup: $backup)"
  reload_service || { rollback "$backup"; die "service unhealthy"; }

  echo
  cmd_usage "$label" 2>/dev/null || true
}

# ─── 子命令: unquota ─────────────────────────────────────────────────────
cmd_unquota() {
  local label
  label=$(resolve_label "${1:-}")
  local backup
  backup=$(yaml_mutate unset-quota --label "$label")
  ok "Removed quota for $label (backup: $backup)"
  reload_service || { rollback "$backup"; die "service unhealthy"; }
}

# ─── 子命令: enable / disable ────────────────────────────────────────────
cmd_set_enabled() {
  local val="$1"
  local label
  label=$(resolve_label "${2:-}")
  local backup
  backup=$(yaml_mutate set-field --label "$label" --field enabled --value "$val")
  ok "$( [[ "$val" == "true" ]] && echo Enabled || echo Disabled ) $label (backup: $backup)"
  reload_service || { rollback "$backup"; die "service unhealthy"; }
}

# ─── 子命令: delete ──────────────────────────────────────────────────────
cmd_delete() {
  local target="" confirm="false"
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --yes|-y) confirm="true"; shift ;;
      -*) die "Unknown flag: $1" ;;
      *) target="$1"; shift ;;
    esac
  done
  local label
  label=$(resolve_label "$target")

  if [[ "$confirm" != "true" ]]; then
    echo "${C_YLW}!${C_RST} 即将删除 ${C_BLD}$label${C_RST},此操作不可逆"
    echo "  确认请加 --yes:  $0 delete $target --yes"
    exit 1
  fi

  local backup
  backup=$(yaml_mutate delete --label "$label")
  ok "Deleted $label (backup: $backup,可恢复)"
  reload_service || { rollback "$backup"; die "service unhealthy"; }

  # 把对应的手册文件也清掉(可选)
  local username="${label%%/*}"
  if [[ -f "$OUT_DIR/$username.md" ]]; then
    rm "$OUT_DIR/$username.md"
    ok "Removed $OUT_DIR/$username.md"
  fi
}

# ─── 子命令: doc ─────────────────────────────────────────────────────────
cmd_doc() {
  local target="" include_vpn="false"
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --vpn) include_vpn="true"; shift ;;
      *) target="$1"; shift ;;
    esac
  done
  local label
  label=$(resolve_label "$target")

  # 从 yaml 读出 key/email/admin
  local entry_json
  entry_json=$(python3 "$YAML_UTIL" --config "$CONFIG" list \
    | python3 -c "import sys,json; d=json.load(sys.stdin); print(json.dumps([x for x in d if x['label']=='$label'][0]))")
  local key email admin_flag username
  key=$(echo "$entry_json" | python3 -c "import sys,json; print(json.load(sys.stdin)['key'])")
  email=$(echo "$entry_json" | python3 -c "import sys,json; print(json.load(sys.stdin).get('owner') or '')")
  admin_flag=$(echo "$entry_json" | python3 -c "import sys,json; print('true' if json.load(sys.stdin)['admin'] else 'false')")
  username="${label%%/*}"

  generate_doc "$username" "$label" "$key" "$email" "$admin_flag" "$include_vpn" "" ""
  ok "Regenerated $OUT_DIR/$username.md"
}

# ─── 生成专属手册(从 add / doc 调用)────────────────────────────────────
generate_doc() {
  local username="$1" label="$2" key="$3" email="$4" admin_flag="$5" include_vpn="$6"
  local quota_usd="$7" quota_tokens="$8"

  mkdir -p "$OUT_DIR"
  local out_file="$OUT_DIR/$username.md"

  local chosen_url base_url_table
  if [[ "$include_vpn" == "true" ]]; then
    base_url_table="| 公司内网(优先)| \`$LAN_URL\` |
| 蒲公英组网(出差/居家)| \`$VPN_URL\` |"
  else
    base_url_table="| Base URL(公司内网)| \`$LAN_URL\` |"
  fi
  chosen_url="$LAN_URL"

  local role_desc
  if [[ "$admin_flag" == "true" ]]; then
    role_desc="管理员 key(可调 admin API、查看全员用量)"
  else
    role_desc="普通用户 key(只能调用业务接口、看自己的用量)"
  fi

  cat > "$out_file" <<EOF
# $username 专属 auth2api 接入手册

> 生成时间:$(date '+%Y-%m-%d %H:%M:%S')
> 本文档包含**专属于你**的 API key,**不要外发、不要 commit 到 Git**。

---

## 你的接入信息

| 项 | 值 |
|---|---|
| 用户标识(Label) | \`$label\` |
| 权限 | $role_desc |
$base_url_table
| API Key | \`$key\` |
EOF
  [[ -n "$email" ]] && echo "| 关联邮箱 | $email |" >> "$out_file"
  if [[ -n "$quota_usd" || -n "$quota_tokens" ]]; then
    local quota_str=""
    [[ -n "$quota_usd" ]]    && quota_str="\$${quota_usd}/月"
    [[ -n "$quota_tokens" ]] && quota_str="${quota_str:+$quota_str + }${quota_tokens} tokens/月"
    echo "| 月度配额 | $quota_str |" >> "$out_file"
  fi

  cat >> "$out_file" <<EOF

> ⚠️ **此 key 等同于团队订阅访问凭据**,泄漏会被滥用。如怀疑泄漏,立刻联系管理员吊销重发。

---

## 0. 接入前烟测

\`\`\`bash
curl -s $chosen_url/health
# 期望: {"status":"ok"}

curl -s -H "Authorization: Bearer $key" $chosen_url/v1/models
# 期望: {"data":[...]}
\`\`\`

---

## 1. Claude Code(\`claude\` CLI + IDE 插件)

**安装(macOS)**:\`curl -fsSL https://claude.ai/install.sh | bash\`
**安装(Windows)**:\`irm https://claude.ai/install.ps1 | iex\`

**环境变量**:
\`\`\`bash
# macOS — 写入 ~/.zshrc 然后 source
export ANTHROPIC_BASE_URL="$chosen_url"
export ANTHROPIC_API_KEY="$key"
\`\`\`
\`\`\`powershell
# Windows PowerShell — User 级别
[Environment]::SetEnvironmentVariable("ANTHROPIC_BASE_URL", "$chosen_url", "User")
[Environment]::SetEnvironmentVariable("ANTHROPIC_API_KEY",  "$key", "User")
\`\`\`

启动 \`claude\` 后若弹登录菜单,**选第 2 项** \`Anthropic Console account · API usage billing\`。
**绝对不要选 1**(订阅登录),会绕过代理。

误登录订阅后清理:\`claude logout && rm -f ~/.claude/.credentials.json\`(Win 删 \`%USERPROFILE%\\.claude\\.credentials.json\`)。

---

## 2. OpenAI Codex CLI(\`codex\`)

**安装**:\`brew install codex\` / \`winget install OpenAI.Codex\` / \`npm install -g @openai/codex\`

**主推 config.toml 方式**(环境变量不可靠),编辑 \`~/.codex/config.toml\`:

\`\`\`toml
model_provider = "auth2api"
model = "gpt-5.5"

[model_providers.auth2api]
name = "auth2api"
base_url = "$chosen_url/v1"
wire_api = "responses"
env_key = "OPENAI_API_KEY"
\`\`\`

设置 API key:
\`\`\`bash
# macOS
export OPENAI_API_KEY="$key"
\`\`\`
\`\`\`powershell
# Windows
[Environment]::SetEnvironmentVariable("OPENAI_API_KEY", "$key", "User")
\`\`\`

启动 \`codex\` 后若弹登录菜单,**选 \`Provide your own API key\`**(不要点 ChatGPT 登录)。

误登录 ChatGPT 后清理:\`rm -f ~/.codex/auth.json\`(Win 删 \`%USERPROFILE%\\.codex\\auth.json\`)。

---

## 3. 第三方 GUI(Cherry Studio / ChatBox 等)

- 接口类型:OpenAI Compatible
- Base URL:\`$chosen_url/v1\`
- API Key:\`$key\`
- Model 手填:\`claude-sonnet-4-6\` / \`gpt-5.5\` 等

---

## 4. 看自己的用量

\`\`\`bash
curl -s -H "Authorization: Bearer $key" $chosen_url/admin/usage/keys | python3 -m json.tool
\`\`\`

---

更详细的(VSCode 插件、JetBrains 插件、CLI ↔ 插件共享 \`~/.claude/\` ~/.codex/\` 缓存优先级陷阱、各种排错)见仓库 \`docs/CLIENT_SETUP.md\` 或找管理员。
EOF
}

# ─── help ────────────────────────────────────────────────────────────────
print_help() {
  cat <<EOF
${C_BLD}auth2api-admin.sh${C_RST} — 团队 API key 全生命周期管理

${C_BLD}用法${C_RST}:
  $0 <command> [args]

${C_BLD}子命令${C_RST}:
  ${C_GRN}add${C_RST} <user> [opts]      开通新用户 + 生成专属手册 + 重启服务
                            可选: --email E --role R --admin --vpn
                                  --quota-usd N --quota-tokens N

  ${C_GRN}list${C_RST}                    列出所有用户(label / 权限 / 配额 / 本月用量)
                            --json 输出原始 JSON

  ${C_GRN}usage${C_RST} [<user>]          查看用量(指定用户或全部)
                            --json 输出原始 JSON

  ${C_GRN}quota${C_RST} <user> [opts]     设置月度配额
                            --usd N (美元上限) 和/或 --tokens N (token 上限)

  ${C_GRN}unquota${C_RST} <user>          清除配额(变成无限)

  ${C_GRN}enable${C_RST} <user>           启用账号
  ${C_GRN}disable${C_RST} <user>          禁用账号(请求被 403 拒掉)

  ${C_GRN}delete${C_RST} <user> --yes     删除账号(--yes 确认,不可逆)

  ${C_GRN}doc${C_RST} <user>              重新生成某用户的专属手册

${C_BLD}<user> 简写${C_RST}:
  完整 label("zhangsan/dev")或唯一 username("zhangsan")

${C_BLD}配置文件${C_RST}:
  $ADMIN_ENV   (gitignore,首次运行时按提示创建)

${C_BLD}示例${C_RST}:
  $0 add wangwu --email wangwu@example.com
  $0 add wangwu --admin --vpn
  $0 list
  $0 usage lei/dev
  $0 quota lei/dev --usd 50
  $0 quota lei --usd 100 --tokens 5000000
  $0 disable lei/dev
  $0 delete oldguy --yes
EOF
}

# ─── 主入口 ──────────────────────────────────────────────────────────────
[[ $# -gt 0 ]] || { print_help; exit 0; }

# 预检
[[ -f "$CONFIG" ]] || die "config not found: $CONFIG"
[[ -f "$PLIST" ]]  || die "plist not found: $PLIST"
command -v python3   >/dev/null || die "python3 required"
command -v openssl   >/dev/null || die "openssl required"
command -v launchctl >/dev/null || die "launchctl required (macOS only)"
command -v curl      >/dev/null || die "curl required"
[[ -f "$YAML_UTIL" ]] || die "missing helper: $YAML_UTIL"

# help 不需要 admin env
case "$1" in
  -h|--help|help) print_help; exit 0 ;;
esac

# 所有其它子命令都加载 admin env(就算自身不需要,失败回滚 / 自检要用)
load_admin_env

case "$1" in
  add)     shift; cmd_add "$@" ;;
  list)    shift; cmd_list "$@" ;;
  usage)   shift; cmd_usage "$@" ;;
  quota)   shift; cmd_quota "$@" ;;
  unquota) shift; cmd_unquota "$@" ;;
  enable)  shift; cmd_set_enabled true "$@" ;;
  disable) shift; cmd_set_enabled false "$@" ;;
  delete)  shift; cmd_delete "$@" ;;
  doc)     shift; cmd_doc "$@" ;;
  *) die "unknown subcommand: $1\n\nRun '$0 help' for usage." ;;
esac
