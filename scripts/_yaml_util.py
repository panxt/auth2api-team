#!/usr/bin/env python3
"""
Internal helper — line-level mutation of auth2api's config.yaml api-keys block.

Why not pyyaml: macOS system python doesn't ship pyyaml, and the api-keys
structure is regular enough (2-level indentation) that we don't need a full
parser.

Subcommands (all read CONFIG, write to CONFIG.tmp; caller atomically moves):
  add        --label L --key K [--owner E] [--admin B]
  set-field  --label L --field F --value V    # F: enabled | admin | owner
  set-quota  --label L [--tokens N] [--cost-usd N]
  unset-quota --label L
  delete     --label L
"""
import sys
import argparse
import re


INDENT_ENTRY = "  "     # 2 spaces — list item dash
INDENT_FIELD = "    "   # 4 spaces — fields under a list item


def load(path):
    with open(path) as f:
        return f.read().splitlines()


def save(path, lines):
    with open(path, "w") as f:
        f.write("\n".join(lines) + "\n")


def find_block_range(lines):
    """Return (start, end_exclusive) of the api-keys block content (the list itself, excluding the 'api-keys:' header)."""
    start = None
    for i, line in enumerate(lines):
        if line.startswith("api-keys:"):
            start = i + 1
            break
    if start is None:
        raise SystemExit("api-keys: block not found")

    end = len(lines)
    for j in range(start, len(lines)):
        line = lines[j]
        if not line:
            continue
        # next top-level key (alpha at col 0)
        if line and line[0].isalpha():
            end = j
            break
    return start, end


def parse_entries(lines, start, end):
    """Return list of (entry_start, entry_end, fields_dict)."""
    entries = []
    i = start
    while i < end:
        line = lines[i]
        if line.startswith(INDENT_ENTRY + "- "):
            entry_start = i
            fields = {}
            # parse the dash line: usually `  - key: sk-...`
            m = re.match(r"^  - (\w[\w-]*): (.*)$", line)
            if m:
                fields[m.group(1)] = m.group(2).strip()
            j = i + 1
            while j < end:
                nxt = lines[j]
                if nxt.startswith(INDENT_ENTRY + "- "):
                    break
                if nxt.startswith(INDENT_FIELD) and ":" in nxt:
                    # might be a nested block like "    quota:" or a regular field
                    key_match = re.match(r"^    (\w[\w-]*): ?(.*)$", nxt)
                    if key_match:
                        k = key_match.group(1)
                        v = key_match.group(2).strip()
                        if v == "":
                            # nested block (e.g. quota:) — capture sub-fields
                            sub = {}
                            k2 = j + 1
                            while k2 < end:
                                sub_line = lines[k2]
                                sub_match = re.match(r"^      (\w[\w-]*): (.*)$", sub_line)
                                if sub_match:
                                    sub[sub_match.group(1)] = sub_match.group(2).strip()
                                    k2 += 1
                                else:
                                    break
                            fields[k] = sub
                            j = k2
                            continue
                        else:
                            fields[k] = v
                j += 1
            entries.append((entry_start, j, fields))
            i = j
        else:
            i += 1
    return entries


def find_entry_by_label(entries, label):
    for s, e, f in entries:
        if f.get("label") == label:
            return s, e, f
    raise SystemExit(f"no entry with label '{label}'")


def render_entry(fields):
    """Render a fields dict back to yaml lines."""
    order = ["key", "label", "owner", "enabled", "admin", "quota", "rate-limit"]
    out = []
    first = True
    for k in order:
        if k not in fields:
            continue
        v = fields[k]
        if isinstance(v, dict):
            if not v:
                continue
            out.append(f"{INDENT_FIELD}{k}:" if not first else f"{INDENT_ENTRY}- {k}:")
            first = False
            for sk in ("monthly-tokens", "monthly-cost-usd", "rpm", "concurrency"):
                if sk in v:
                    out.append(f"      {sk}: {v[sk]}")
        else:
            if first:
                out.append(f"{INDENT_ENTRY}- {k}: {v}")
                first = False
            else:
                out.append(f"{INDENT_FIELD}{k}: {v}")
    # any leftover keys not in order
    for k, v in fields.items():
        if k in order:
            continue
        if isinstance(v, dict):
            continue
        if first:
            out.append(f"{INDENT_ENTRY}- {k}: {v}")
            first = False
        else:
            out.append(f"{INDENT_FIELD}{k}: {v}")
    return out


def cmd_add(args, lines):
    start, end = find_block_range(lines)
    fields = {"key": args.key, "label": args.label}
    if args.owner:
        fields["owner"] = args.owner
    fields["admin"] = args.admin
    new_lines = render_entry(fields)
    # insert at end of block
    return lines[:end] + new_lines + lines[end:]


def cmd_set_field(args, lines):
    start, end = find_block_range(lines)
    entries = parse_entries(lines, start, end)
    s, e, fields = find_entry_by_label(entries, args.label)
    fields[args.field] = args.value
    new_block = render_entry(fields)
    return lines[:s] + new_block + lines[e:]


def cmd_set_quota(args, lines):
    start, end = find_block_range(lines)
    entries = parse_entries(lines, start, end)
    s, e, fields = find_entry_by_label(entries, args.label)
    quota = fields.get("quota") if isinstance(fields.get("quota"), dict) else {}
    if args.tokens is not None:
        quota["monthly-tokens"] = args.tokens
    if args.cost_usd is not None:
        quota["monthly-cost-usd"] = args.cost_usd
    if not quota:
        raise SystemExit("at least one of --tokens or --cost-usd is required")
    fields["quota"] = quota
    new_block = render_entry(fields)
    return lines[:s] + new_block + lines[e:]


def cmd_unset_quota(args, lines):
    start, end = find_block_range(lines)
    entries = parse_entries(lines, start, end)
    s, e, fields = find_entry_by_label(entries, args.label)
    fields.pop("quota", None)
    new_block = render_entry(fields)
    return lines[:s] + new_block + lines[e:]


def cmd_delete(args, lines):
    start, end = find_block_range(lines)
    entries = parse_entries(lines, start, end)
    s, e, fields = find_entry_by_label(entries, args.label)
    return lines[:s] + lines[e:]


def cmd_list(args, lines):
    """Dump entries as JSON for the bash caller to format."""
    import json
    start, end = find_block_range(lines)
    entries = parse_entries(lines, start, end)
    out = []
    for _, _, f in entries:
        out.append({
            "label": f.get("label"),
            "key": f.get("key"),
            "owner": f.get("owner"),
            "admin": f.get("admin") == "true",
            "enabled": f.get("enabled", "true") != "false",
            "quota": f.get("quota") if isinstance(f.get("quota"), dict) else None,
        })
    print(json.dumps(out))
    sys.exit(0)


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--config", required=True)
    p.add_argument("--out")
    sub = p.add_subparsers(dest="cmd", required=True)

    a = sub.add_parser("add")
    a.add_argument("--label", required=True)
    a.add_argument("--key", required=True)
    a.add_argument("--owner")
    a.add_argument("--admin", default="false")

    s = sub.add_parser("set-field")
    s.add_argument("--label", required=True)
    s.add_argument("--field", required=True, choices=["enabled", "admin", "owner"])
    s.add_argument("--value", required=True)

    q = sub.add_parser("set-quota")
    q.add_argument("--label", required=True)
    q.add_argument("--tokens", type=int)
    q.add_argument("--cost-usd", type=float)

    sub.add_parser("unset-quota").add_argument("--label", required=True)
    sub.add_parser("delete").add_argument("--label", required=True)
    sub.add_parser("list")

    args = p.parse_args()
    lines = load(args.config)

    handlers = {
        "add": cmd_add,
        "set-field": cmd_set_field,
        "set-quota": cmd_set_quota,
        "unset-quota": cmd_unset_quota,
        "delete": cmd_delete,
        "list": cmd_list,
    }

    new_lines = handlers[args.cmd](args, lines)
    if args.cmd == "list":
        return  # cmd_list exits
    if not args.out:
        raise SystemExit("--out is required for mutating commands")
    save(args.out, new_lines)


if __name__ == "__main__":
    main()
