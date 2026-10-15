---
name: github-coding
description: Make code changes to Gustavo's GitHub repos (gguarina/intentbios, gguarina/Intentbios-openclaw) with git and gh — branch, test, PR, merge only when green.
---

# GitHub coding workflow

Use this whenever you are asked to change code, fix a bug, or ship a feature in a GitHub repo.

## Where things are

- Checkouts live under `$OPENCLAW_WORKSPACE_DIR/repos/` (on the persistent `/data` volume):
  - `repos/intentbios` → `gguarina/intentbios` (default branch `main`)
  - clone others with `gh repo clone gguarina/<repo> "$OPENCLAW_WORKSPACE_DIR/repos/<repo>"`
- `git` and `gh` are installed and already authenticated (GH_TOKEN, fine-grained; push only to
  `gguarina/intentbios` and `gguarina/Intentbios-openclaw`). Check with `gh auth status`.
- Never print, echo, or commit tokens or `.env` files.

## Workflow (always)

1. `cd` into the checkout, `git fetch origin && git checkout main && git pull --ff-only`.
   If the tree is dirty from earlier work, stop and ask before discarding anything.
2. Create a branch: `git checkout -b openclaw/<short-topic>`. Never commit directly to `main`.
3. Read the repo's README / AGENTS.md / package.json (or equivalent) to learn how to install and test.
4. Make the change. Keep it small and focused.
5. Run the repo's tests/lint/typecheck (e.g. `npm test`, `pnpm test`, `pytest`). Fix failures you caused.
6. Commit with a clear message, `git push -u origin HEAD`.
7. Open a PR: `gh pr create --fill --base main` (add a body: what, why, how tested).
8. Watch checks: `gh pr checks --watch`. Merge **only** when all checks pass and the user asked for
   (or already approved) a merge: `gh pr merge --squash --delete-branch`.
   If checks fail, fix forward on the branch; do not merge red PRs.
9. Report the PR link (and merge SHA if merged) back in chat.

## Hard limits

- Never touch production data: no Postgres/database commands against Railway, no volume changes,
  no Railway variable or secret changes, no plan changes.
- Never force-push to `main`, never rewrite published history, never disable CI or branch protection.
- `gguarina/Intentbios-openclaw` is the repo that deploys *this* bot (auto-deploy on merge to `main`).
  Be extra careful there: a broken merge takes you offline. Run `npm test` before opening the PR.

## Railway (not connected yet)

There is no Railway API token configured. When the user provides one it plugs in as the service
variable `RAILWAY_API_TOKEN` (and can then back a Railway MCP server in `mcp.servers`). Until then,
do not try to deploy or inspect Railway yourself — pushing to `main` of a Railway-linked repo is
what triggers deploys.
