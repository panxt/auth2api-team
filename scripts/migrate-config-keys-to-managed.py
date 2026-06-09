#!/usr/bin/env python3
"""
Migrate non-admin keys from config.yaml into the SQLite managed_keys table.

Why
---
Keys in `config.yaml` are read-only via the admin API + UI (program never
rewrites the YAML, see src/keys/store.ts:155-163). Keys in the SQLite
`managed_keys` table are CRUD-able via `POST/PATCH/DELETE /admin/keys`
and the dashboard's Users page.

This script moves the SOURCE-OF-TRUTH for selected keys from yaml → sqlite,
**preserving the existing raw `sk-...` string** so colleagues' clients
don't need to change anything. After migration the UI shows those keys as
`source: managed`, edit/delete buttons unlock.

What it does
------------
1. Reads `config.yaml`, filters non-admin keys (admin: true is bootstrap,
   leave it in yaml so you can always log in even if SQLite is wiped).
2. For each candidate, INSERT OR REPLACE INTO `managed_keys` (key, data).
3. Prints the YAML lines you should manually delete + the launchd commands
   to restart. Does NOT touch config.yaml (preserves your comments / order).

Safety
------
- Run with `--dry-run` first to see what would happen.
- Won't write while the service is running by default (managed_keys is a
  shared file; `ManagedKeyStore.persist()` could clobber our INSERT).
  Pass `--force` to skip the running-service check.
- INSERT OR REPLACE: re-running the script is idempotent.

Usage
-----
    ./scripts/migrate-config-keys-to-managed.py --dry-run
    launchctl unload ~/Library/LaunchAgents/com.$USER.auth2api.plist
    ./scripts/migrate-config-keys-to-managed.py
    # Edit config.yaml manually as instructed
    launchctl load ~/Library/LaunchAgents/com.$USER.auth2api.plist
"""

import argparse
import json
import os
import sqlite3
import subprocess
import sys
from pathlib import Path


def parse_yaml_api_keys(yaml_path):
    """Parse config.yaml's api-keys array WITHOUT a yaml library.

    The file is small + structured. We just hand-parse the api-keys block
    so the script has zero non-stdlib deps. Supports both bare-string and
    object forms; only the object form has metadata we care about.
    """
    text = Path(yaml_path).read_text()
    lines = text.splitlines()
    in_keys = False
    entries = []  # each: dict with at minimum 'key'
    current = None
    current_indent = None
    current_lineno_start = None

    def flush():
        nonlocal current, current_lineno_start
        if current is not None and current.get("key"):
            current["_yaml_start_line"] = current_lineno_start
            entries.append(current)
        current = None
        current_lineno_start = None

    for i, raw in enumerate(lines, start=1):
        line = raw.rstrip()
        if line.startswith("api-keys:"):
            in_keys = True
            continue
        if not in_keys:
            continue
        # End of api-keys block: next top-level key.
        if line and not line.startswith(" ") and not line.startswith("-"):
            flush()
            in_keys = False
            continue
        # New list entry
        stripped = line.lstrip()
        if stripped.startswith("- "):
            flush()
            current = {}
            current_indent = len(line) - len(stripped)
            current_lineno_start = i
            # The dash line is one of:
            #   - "sk-..."          (bare string)
            #   - key: sk-...       (object, first field is key)
            content = stripped[2:].strip()
            if content.startswith("key:"):
                current["key"] = content.split(":", 1)[1].strip().strip('"').strip("'")
            elif content.startswith("sk-"):
                current["key"] = content.strip('"').strip("'")
        elif current is not None and stripped:
            # Subsequent indented line: a field of the current entry
            if ":" in stripped:
                k, _, v = stripped.partition(":")
                k = k.strip()
                v = v.strip().strip('"').strip("'")
                # Coerce booleans
                if v == "true":
                    v_typed = True
                elif v == "false":
                    v_typed = False
                else:
                    v_typed = v
                current[k] = v_typed

    flush()
    return entries


def is_service_running():
    """Best-effort check: is the auth2api launchd job currently active?"""
    try:
        out = subprocess.run(
            ["launchctl", "list"], capture_output=True, text=True, timeout=5
        ).stdout
        for line in out.splitlines():
            if "auth2api" in line and "prewarm" not in line and "caddy" not in line:
                # First col is PID; "-" means stopped, integer means running.
                pid = line.split("\t", 1)[0].strip()
                if pid not in ("-", ""):
                    return True
        return False
    except Exception:
        return False


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument(
        "--config",
        default=str(Path(__file__).resolve().parent.parent / "config.yaml"),
        help="Path to config.yaml (default: ../config.yaml relative to this script)",
    )
    ap.add_argument(
        "--db",
        default=os.path.expanduser("~/.auth2api/auth2api.db"),
        help="Path to SQLite database (default: ~/.auth2api/auth2api.db)",
    )
    ap.add_argument(
        "--dry-run",
        action="store_true",
        help="Print what WOULD be done; do not write to SQLite",
    )
    ap.add_argument(
        "--force",
        action="store_true",
        help="Skip the 'service is running' safety check",
    )
    ap.add_argument(
        "--include-admin",
        action="store_true",
        help="Also migrate admin keys (default: keep them in config.yaml as bootstrap)",
    )
    args = ap.parse_args()

    if not Path(args.config).exists():
        sys.exit(f"config.yaml not found at {args.config}")
    if not Path(args.db).exists():
        sys.exit(
            f"SQLite DB not found at {args.db} — make sure auth2api has been "
            f"started at least once so it creates the file"
        )

    entries = parse_yaml_api_keys(args.config)
    if not entries:
        sys.exit("No api-keys found in config.yaml")

    # Filter: non-admin only (unless --include-admin)
    candidates = []
    skipped = []
    for e in entries:
        is_admin = e.get("admin", False) is True
        if is_admin and not args.include_admin:
            skipped.append((e, "admin: true (kept in yaml as bootstrap)"))
            continue
        candidates.append(e)

    print(f"\nFound {len(entries)} key(s) in {args.config}:")
    for e in entries:
        label = e.get("label") or "(unlabeled)"
        marker = "✓" if e in candidates else "skip"
        print(f"  [{marker}]  {label:<24} {e['key'][:24]}…")
    for e, reason in skipped:
        print(f"         ↳ {reason}")
    print()

    if not candidates:
        print("Nothing to migrate.")
        return

    print(f"Will migrate {len(candidates)} key(s) → managed_keys:")
    for e in candidates:
        print(f"  • {e.get('label') or '(unlabeled)'}")
    print()

    # Safety: don't write while service is running.
    if not args.dry_run and not args.force and is_service_running():
        sys.exit(
            "✗ auth2api service appears to be RUNNING. The ManagedKeyStore "
            "would overwrite our INSERTs on its next persist() call.\n"
            "  Stop the service first:\n"
            "    launchctl unload ~/Library/LaunchAgents/com.$USER.auth2api.plist\n"
            "  Or pass --force to skip this check (only if you're confident "
            "no /admin/keys writes happen during the migration window)."
        )

    if args.dry_run:
        print("--dry-run: no changes written.")
        _print_yaml_cleanup_hint(args.config, candidates)
        return

    # Write to SQLite
    conn = sqlite3.connect(args.db)
    try:
        cur = conn.cursor()
        inserted = 0
        for e in candidates:
            # Build ApiKeyEntry shape — only include known fields, drop our
            # tracking metadata. Mirrors src/config.ts normalize logic.
            entry = {
                "key": e["key"],
                "label": e.get("label"),
                "owner": e.get("owner"),
                "enabled": e.get("enabled", True),
                "admin": e.get("admin", False),
            }
            if "quota" in e:
                entry["quota"] = e["quota"]
            if "rate-limit" in e:
                entry["rate-limit"] = e["rate-limit"]
            # Drop None values (matches yaml-deserialized shape)
            entry = {k: v for k, v in entry.items() if v is not None}

            cur.execute(
                "INSERT OR REPLACE INTO managed_keys (key, data) VALUES (?, ?)",
                (e["key"], json.dumps(entry)),
            )
            inserted += 1
            print(f"  ✓ INSERT {e.get('label') or e['key'][:20]}")
        conn.commit()
        print(f"\n✓ Inserted/replaced {inserted} row(s) in managed_keys.")
    finally:
        conn.close()

    _print_yaml_cleanup_hint(args.config, candidates)


def _print_yaml_cleanup_hint(config_path, candidates):
    print()
    print("═" * 60)
    print(" 还差两步(手动)")
    print("═" * 60)
    print()
    print(f"1. 编辑 {config_path},删掉以下 entries(从 - key: 行")
    print("   一直删到下一个 - key: 或 body-limit: 等下一个顶层字段):")
    for e in candidates:
        line = e.get("_yaml_start_line", "?")
        label = e.get("label") or "(unlabeled)"
        print(f"     - 第 {line} 行起,label={label}")
    print()
    print("   留 admin: true 的不要删 — 那是 bootstrap admin。")
    print()
    print("2. 重启服务让新 managed_keys 生效:")
    print("    launchctl unload ~/Library/LaunchAgents/com.$USER.auth2api.plist")
    print("    launchctl load   ~/Library/LaunchAgents/com.$USER.auth2api.plist")
    print()
    print("验证:打开 /ui/users 看 lei/dev、lishanpeng/dev 标 'managed'")
    print("(编辑/删除按钮变得可点)即成功。")
    print()


if __name__ == "__main__":
    main()
