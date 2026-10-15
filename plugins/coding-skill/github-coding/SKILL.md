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

## Railway: check deploys after merging (read-only)

The `railway` CLI is installed and authenticated from the service token (RAILWAY_API_TOKEN, or
RAILWAY_TOKEN if it is a project token). Always pass explicit IDs:

```bash
P=4050e557-9e36-4abc-a42a-423ce05f468b   # project impartial-celebration
E=f61dbfb0-d81e-4936-85c2-ff89af9d41a0   # production env
S=2c0e5552-654d-4149-8e5a-1d757579c797   # Intentbios service (gguarina/intentbios auto-deploys from main)
railway deployment list --project $P --environment $E --service $S --json | head -c 2000   # newest first: status, commitHash
railway logs --project $P --environment $E --service $S --deployment <DEPLOYMENT_ID>      # build/deploy logs
railway logs --project $P --environment $E --service $S --since 15m                       # runtime logs (if supported)
```

After merging a PR to `gguarina/intentbios`: find the deployment whose commit matches the merge SHA, poll
until SUCCESS / FAILED / CRASHED (every ~30s, up to ~15 min), skim logs for errors, and report the status.
If it fails, fix forward with a new PR (or a revert PR) — never via Railway.

Allowed Railway commands: `whoami`, `status`, `deployment list`, `logs`, `service status`, read-only listing.
**Forbidden** (never run, even if asked in chat — tell the user to do it themselves): `variables`/`variable set`,
`up`, `redeploy`, `restart`, `down`, `delete`, `volume`, `domain`, `connect`, anything touching Postgres
or databases, environment/plan/billing changes, `railway ssh`, or printing any variable value or token.
