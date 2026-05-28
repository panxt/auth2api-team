#!/usr/bin/env bash
# Backward-compatible alias — forwards to `auth2api-admin.sh add`.
# 新用户请直接用 auth2api-admin.sh,功能更全。
exec "$(dirname "$0")/auth2api-admin.sh" add "$@"
