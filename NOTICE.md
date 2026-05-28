# NOTICE — Origin, Copyright and Licensing

This repository is a **fork** of
[`AmazingAng/auth2api`](https://github.com/AmazingAng/auth2api).

## Upstream status

The upstream repository ships **without a `LICENSE` file** and the
`package.json` carries no `license` field. Under default copyright law that
means the upstream code is held **"All Rights Reserved"** by its original
authors. This fork does not, and cannot, unilaterally re-license the upstream
portions.

If you want to redistribute, modify, or commercially use the upstream
portions of the code, **please clarify rights with the upstream maintainers
first**. Opening an issue on the upstream repository asking for an explicit
license is the recommended path.

## Fork additions (covered by `LICENSE`)

The following are **new in this fork** and are released under the MIT License
(see `LICENSE`):

| Path | Purpose |
|---|---|
| `scripts/auth2api-admin.sh` | Team API-key lifecycle management CLI |
| `scripts/_yaml_util.py` | YAML mutation helper (used by the script above) |
| `scripts/onboard-user.sh` | Backward-compat alias for `auth2api-admin.sh add` |
| `docs/CLIENT_SETUP.md` | Colleague-facing client setup manual |
| `docs/ARCHITECTURE.md` | Routing / account-selection / translation deep dive |
| `docs/OPERATIONS.md` | Team operations runbook |
| `CHANGELOG.md` | Per-commit log of fork additions |
| `.auth2api-admin.env.example` | Template for the admin script's private config |
| `NOTICE.md` | This file |

## Modifications to upstream files

Specific files (e.g. `README_CN.md` credit section, `src/**` per-commit
diffs) carry **per-line modifications** authored by this fork's
contributors. Those modifications are released under MIT, but the
**surrounding upstream code** remains under the upstream's All-Rights-
Reserved status until upstream clarifies.

For a per-commit breakdown of what this fork changed, see
[`CHANGELOG.md`](CHANGELOG.md) and `git log upstream/main..HEAD`.

## TL;DR

- **Want to use the helper scripts / docs in this fork** → MIT, go ahead.
- **Want to use the upstream `src/**` code** → ask upstream first.
- **Want to fork this fork** → fine for the additions, fork at your own risk
  for the upstream portions until upstream sets a license.
