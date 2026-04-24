# CI and Version Management Design

**Date:** 2026-04-24

## Overview

Add GitHub Actions CI and automate version management so that `package.json`, `.claude-plugin/plugin.json`, and `src/ferret.ts` are kept in sync via a single `npm version` command, and npm publishing is triggered automatically by creating a GitHub Release.

## Version Sync

`package.json` is the canonical version source. A script `scripts/sync-version.mjs` reads the `npm_new_version` environment variable (set automatically by npm during the version lifecycle) and:

1. Updates the `version` field in `.claude-plugin/plugin.json` (parsed and re-serialised as JSON)
2. Replaces the `.version("x.x.x")` string in `src/ferret.ts` via regex

The `version` lifecycle script in `package.json` runs this script and then stages both files so they are included in the commit npm creates:

```json
"version": "node scripts/sync-version.mjs && git add .claude-plugin/plugin.json src/ferret.ts"
```

`plugin.json` must retain the real version in the repo since Claude Code reads it directly.

## CI Workflow (`.github/workflows/ci.yml`)

- **Trigger:** `pull_request` (all branches)
- **Steps:** checkout → setup Node 20 → `npm ci` → `npm test`
- No publish or build artefacts — green/red signal on PRs only

## Release Workflow (`.github/workflows/release.yml`)

- **Trigger:** `release: [published]`
- **Steps:** checkout → setup Node 20 (with `registry-url: https://registry.npmjs.org`) → `npm ci` → `npm test` → `npm run build` → `npm publish`
- Requires an `NPM_TOKEN` secret in GitHub repo settings (generated from npm account)
- Tests run again as a last-check before publish

## Developer Workflow

```bash
# 1. Bump version (syncs all 3 files, commits, tags)
npm version patch   # or minor / major

# 2. Push commit and tag
git push && git push --tags

# 3. Create a GitHub Release from the tag (UI or gh CLI)
#    → triggers the release workflow → npm publish
```

The GitHub Release creation is the deliberate "pull the trigger" step — pushing a tag alone does not publish anything.

## Files Changed

| File | Change |
|------|--------|
| `package.json` | Add `version` lifecycle script |
| `scripts/sync-version.mjs` | New script to sync version across files |
| `.github/workflows/ci.yml` | New CI workflow |
| `.github/workflows/release.yml` | New release/publish workflow |
