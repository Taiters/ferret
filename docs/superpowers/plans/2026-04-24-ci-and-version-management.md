# CI and Version Management Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add GitHub Actions CI (tests on PRs, publish on GitHub Release) and automate version sync across `package.json`, `.claude-plugin/plugin.json`, and `src/ferret.ts` via `npm version`.

**Architecture:** A `scripts/sync-version.mjs` Node.js script reads the updated version from `package.json` (which npm has already patched before running the lifecycle hook) and writes it into `plugin.json` and `ferret.ts`. The `version` lifecycle script in `package.json` runs this and stages both files. Two GitHub Actions workflows handle CI (PR tests) and release (publish on GitHub Release).

**Tech Stack:** Node.js ESM script, GitHub Actions (`actions/checkout@v4`, `actions/setup-node@v4`), npm publish.

---

### Task 1: Create version sync script

**Files:**
- Create: `scripts/sync-version.mjs`

This script is called by npm's `version` lifecycle hook. By the time it runs, npm has already updated `package.json` with the new version, so we read from there.

- [ ] **Step 1: Create `scripts/sync-version.mjs`**

```js
import { readFileSync, writeFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

const { version } = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));

// Update .claude-plugin/plugin.json
const pluginPath = join(root, '.claude-plugin/plugin.json');
const plugin = JSON.parse(readFileSync(pluginPath, 'utf8'));
plugin.version = version;
writeFileSync(pluginPath, JSON.stringify(plugin, null, 2) + '\n');
console.log(`Updated .claude-plugin/plugin.json → ${version}`);

// Update src/ferret.ts
const ferretPath = join(root, 'src/ferret.ts');
const ferret = readFileSync(ferretPath, 'utf8');
const updated = ferret.replace(/\.version\("[^"]*"\)/, `.version("${version}")`);
if (updated === ferret) {
  console.error('Error: Could not find .version("...") pattern in src/ferret.ts');
  process.exit(1);
}
writeFileSync(ferretPath, updated);
console.log(`Updated src/ferret.ts → ${version}`);
```

- [ ] **Step 2: Commit**

```bash
git add scripts/sync-version.mjs
git commit -m "feat: add version sync script"
```

---

### Task 2: Wire up npm version lifecycle hook

**Files:**
- Modify: `package.json` (scripts section)

npm's `version` lifecycle script runs after `package.json` is updated but before the commit and tag are created. The `git add` at the end stages the two changed files so they're included in npm's version commit.

- [ ] **Step 1: Add the `version` script to `package.json`**

In the `"scripts"` block, add:

```json
"version": "node scripts/sync-version.mjs && git add .claude-plugin/plugin.json src/ferret.ts",
```

The full scripts block should look like:

```json
"scripts": {
  "build": "tsc",
  "build:watch": "tsc --watch",
  "version": "node scripts/sync-version.mjs && git add .claude-plugin/plugin.json src/ferret.ts",
  "index": "node dist/ferret.js index",
  "search": "node dist/ferret.js search",
  "stats": "node dist/ferret.js stats",
  "bench": "npx tsx scripts/benchmark.ts",
  "test": "vitest run",
  "test:watch": "vitest"
},
```

- [ ] **Step 2: Commit**

```bash
git add package.json
git commit -m "feat: wire npm version lifecycle hook"
```

---

### Task 3: Verify version sync end-to-end

No automated test for this script — it's a build utility that's validated by running it. Use `--no-git-tag-version` to test without creating a real commit or tag.

- [ ] **Step 1: Run a dry version bump**

```bash
npm version 0.1.4 --no-git-tag-version
```

Expected output:
```
Updated .claude-plugin/plugin.json → 0.1.4
Updated src/ferret.ts → 0.1.4
v0.1.4
```

- [ ] **Step 2: Verify the three files were updated**

```bash
node -e "import('./.claude-plugin/plugin.json', {assert:{type:'json'}}).then(m=>console.log(m.default.version))"
# Expected: 0.1.4

grep '\.version(' src/ferret.ts
# Expected: .version("0.1.4");

node -e "import('./package.json', {assert:{type:'json'}}).then(m=>console.log(m.default.version))"
# Expected: 0.1.4
```

- [ ] **Step 3: Revert the test bump**

```bash
git checkout package.json .claude-plugin/plugin.json src/ferret.ts
```

---

### Task 4: Create CI workflow

**Files:**
- Create: `.github/workflows/ci.yml`

Runs `npm test` on every pull request. Uses `cache: 'npm'` on setup-node to avoid re-downloading dependencies on every run.

- [ ] **Step 1: Create `.github/workflows/ci.yml`**

```yaml
name: CI

on:
  pull_request:

jobs:
  test:
    runs-on: ubuntu-latest

    steps:
      - uses: actions/checkout@v4

      - uses: actions/setup-node@v4
        with:
          node-version: '20'
          cache: 'npm'

      - run: npm ci

      - run: npm test
```

- [ ] **Step 2: Commit**

```bash
git add .github/workflows/ci.yml
git commit -m "feat: add CI workflow for pull requests"
```

---

### Task 5: Create release workflow

**Files:**
- Create: `.github/workflows/release.yml`

Triggers when a GitHub Release is published. Runs tests as a last-check, builds the TypeScript, then publishes to npm. Requires an `NPM_TOKEN` secret in the GitHub repo settings (Settings → Secrets and variables → Actions → New repository secret). Generate the token at npmjs.com → Access Tokens → Generate New Token (Automation type).

- [ ] **Step 1: Create `.github/workflows/release.yml`**

```yaml
name: Release

on:
  release:
    types: [published]

jobs:
  publish:
    runs-on: ubuntu-latest

    steps:
      - uses: actions/checkout@v4

      - uses: actions/setup-node@v4
        with:
          node-version: '20'
          cache: 'npm'
          registry-url: 'https://registry.npmjs.org'

      - run: npm ci

      - run: npm test

      - run: npm run build

      - run: npm publish
        env:
          NODE_AUTH_TOKEN: ${{ secrets.NPM_TOKEN }}
```

- [ ] **Step 2: Commit**

```bash
git add .github/workflows/release.yml
git commit -m "feat: add release workflow for npm publish"
```

---

### Task 6: Add NPM_TOKEN secret to GitHub

This is a manual step in the GitHub UI — cannot be done via code.

- [ ] **Step 1: Generate an npm Automation token**

Go to [npmjs.com](https://www.npmjs.com) → profile → Access Tokens → Generate New Token → select **Automation** type → copy the token.

- [ ] **Step 2: Add secret to GitHub repo**

Go to the repo on GitHub → Settings → Secrets and variables → Actions → New repository secret.
- Name: `NPM_TOKEN`
- Value: paste the token from Step 1

---

## End-to-End Release Workflow (for reference)

Once all tasks are complete, the release flow is:

```bash
# Bump version, sync all 3 files, commit, and tag
npm version patch   # or: minor / major

# Push the commit and the tag
git push && git push --tags

# Then: go to GitHub → Releases → Draft a new release
# → choose the tag just pushed → publish
# → GitHub Actions triggers and publishes to npm
```
