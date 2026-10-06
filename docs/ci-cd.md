# CI, releases, and secret protection

## Development stays on trunk

Short-lived PR branches merge into `main`. There is no `develop` branch or
long-lived release branch. Ordinary merges **never publish to npm**.

GitHub Actions runs `.github/workflows/ci.yml` on every PR, including fork PRs
without secrets. `publish.yml` calls that same reusable CI on every push to `main`. It detects affected packages;
shared tooling/workflow/release-plan changes validate all packages. Root
documentation-only changes still run tooling and secret checks. The stable
required status is **CI passed**.

Each affected package runs:

1. Lockfile installation with `npm ci --ignore-scripts`.
2. ESLint and TypeScript checking.
3. Separate unit and integration suites.
4. `npm audit --audit-level=high`, **including development dependencies**.
5. An actual `npm pack`, content checks, clean-consumer installation, and Pi
   registration smoke test against the installed artifact.
6. Upload of the validated tarball and SHA-512 integrity metadata.

These packages intentionally publish TypeScript source, so building means
producing and validating the npm artifact, not introducing a transpilation step.
The clean consumer omits host peer packages: Pi supplies those. Runtime
dependencies are installed normally. The smoke test disables network calls and
uses an isolated home and agent directory.

`scripts/packages.mjs` is the package allowlist and test partition. Every test
belongs to exactly one of the unit/integration suites; an empty suite or missing
listed test fails. Existing suites contain some mixed-granularity files; the
integration lane includes cross-module contracts, registration, filesystem,
process, and package-load checks. New cross-component tests should be listed in
that lane rather than merely renamed to claim integration coverage.

The existing web-search Linux/Windows/macOS and Pi compatibility matrix remains
a required reusable workflow when web-search or shared tooling changes. Live
search-provider tests are intentionally not release gates.

### Local checks

Use Node 24 and npm 12.0.0 for the main CI baseline:

```bash
npm ci --ignore-scripts
npm ci --prefix pi-ask --ignore-scripts
npm run lint --prefix pi-ask
npm run typecheck --prefix pi-ask
npm run test:unit --prefix pi-ask
npm run test:integration --prefix pi-ask
npm audit --prefix pi-ask --audit-level=high
npm run build --prefix pi-ask
npm run test:tooling
```

Repeat package checks for the other packages. `.artifacts/` is ignored by Git.

## Requesting a release

Prerequisites: this tooling is merged into `main`, GitHub CLI is authenticated,
and the one-time account setup below is complete. The prepare command uses the
**remote main SHA**, not uncommitted local changes or the caller's branch.

Preview without creating a PR or publishing:

```bash
npm run release:prepare -- \
  --package pi-ask --bump patch \
  --notes 'Fix question review navigation.' \
  --dry-run
```

Remove `--dry-run` to dispatch the preparation workflow. Release notes are
required; the script never asks an LLM to infer versions or write notes.

For independently versioned packages in one release:

```bash
npm run release:prepare -- \
  --package pi-ask:patch \
  --package pi-slate:minor \
  --notes 'Improve interview navigation and add Slate layout options.'
```

The command checks npm's current versions and dispatches
`release-prepare.yml` with an exact SHA and explicit inputs. Actions regenerates
the plan on that SHA and creates/updates the short-lived `release/next` PR.
It updates only:

- `.release/plan.json`
- selected package manifests and lockfile root versions
- selected changelogs (preserving released entries and moving Unreleased notes)

The same SHA and inputs produce the same release file contents. Review the
versions and notes, let CI pass, then merge the PR.

**Main must not advance between preparation and merging.** If it does, rerun
the prepare command to regenerate the PR. This conservative rule avoids
publishing changes that were absent from the reviewed release plan.

Patch/minor/major have their usual numeric meaning, including before 1.0:
`0.1.2 --bump major` becomes `1.0.0`. Choose `minor` explicitly for a breaking
0.x release if that is the package's policy.

A release includes every change already merged into each selected package.
It does not cherry-pick individual feature PRs. Unselected packages remain
unpublished. Finish or recover an outstanding release before preparing another.

### Publication and recovery

Publication starts only when **main's CI jobs succeed**, including secret
scanning. It requires both a valid generated plan on the release commit and a
merged `release/next` PR from this repository. A direct push with version edits
is not publication authorization.

`publish.yml` checks out the exact successful CI SHA and downloads artifacts
from **that same run ID**, never a PR run or another commit. Validation and
publication share one push event, keeping npm provenance tied to the actual
validated commit even if main advances during the run. It checks package names,
versions, tarball manifests, registry state, and SHA-512 integrity before
publishing. No package install scripts or `prepublishOnly` hooks run in the
privileged publishing job: the validation already ran in read-only CI.

npm publication uses OIDC and automatic provenance. Each package gets a
`<directory>-v<version>` Git tag and GitHub release. Publishing is serialized;
a package already published with identical bytes is skipped on retry. A version
with different bytes, an unexpected current registry version, or a conflicting
tag fails closed.

If publishing fails, **rerun the failed Main CI and releases run**, not the
release preparation command. For example:

```bash
gh run rerun <publish-run-id> --failed
```

This reuses the original CI artifacts (retained for 30 days) and completes
remaining publications/tags/releases. Do not delete the plan or manually
increment versions to hide a partial failure. If artifacts have expired,
restore the exact original artifacts before retrying; any rebuilt bytes must
match already-published registry integrity. Published versions cannot be
overwritten. Fix a bad release with a new patch release, and deprecate the bad
version where appropriate.

If a merged release fails validation and needs source changes rather than a
retry, **stop its outstanding Actions run first**. If none of its versions
have reached npm, revert the release-only commit through a PR (use
`git revert -m 1 <sha>` for a merge commit, or `git revert <sha>` for a squash
commit). CI permits only the exact metadata rollback and verifies that no
target version exists on npm. Cancel before changing those metadata files;
then merge the fix and prepare a fresh release. A partially published release
cannot be cancelled this way: finish its original artifacts before releasing
a follow-up patch.

## One-time GitHub/npm account setup

Repository files cannot configure npm account trust or create your GitHub App.
Complete these steps before the first release:

1. **Release GitHub App:** create/install an App on only this repository with
   repository **Contents: read/write** and **Pull requests: read/write**.
   Set repository variable `RELEASE_APP_ID` and Actions secret
   `RELEASE_APP_PRIVATE_KEY`. The short-lived App token lets the generated PR
   trigger normal PR CI. Do not use a long-lived npm token or put a private key
   in a repository file.
2. **Environment:** a GitHub environment named `npm`, restricted to the
   `main` branch, was created during setup. Preserve that restriction. An extra environment approval is optional; merging the
   release PR is the normal release decision.
3. **npm trusted publishers:** for each of `pi-slate`, `@gagansd/pi-ask`,
   `@gagansd/pi-subagents`, and `@gagansd/pi-web-search`, configure:
   - GitHub owner: `GaganSD`
   - Repository: `pi-extensions`
   - Workflow filename: `publish.yml` (not the full path)
   - Environment: `npm`
   - Allow direct `npm publish`
4. **Protect main:** after the first CI run, require PRs and the **CI passed**
   check, require the branch to be up to date, block force pushes/deletion, and
   avoid bypasses. For a solo-maintainer repository, required checks can apply
   without a mandatory second person's approval. `CODEOWNERS` routes changes
   to release/security tooling to the owner; require code-owner review when
   your reviewer setup supports it.
5. **Push protection:** keep GitHub secret scanning and push protection enabled
   under repository Settings → Security. These were enabled during setup.
   They protect supported credential formats before GitHub accepts a push;
   the Actions scanner is not a replacement.

## Snyk dependency scan

`.github/workflows/snyk.yml` is a reusable workflow that runs on every
affected package when `ci.yml` detects changes. The `passed` job requires it
alongside `npm audit`, secret scanning, and the existing test lanes.

Each run installs the Snyk CLI via `snyk/actions/setup@master`, then runs:

- `snyk test --severity-threshold=high --dev=false` against the package's
  installed production dependencies.
- `snyk test --severity-threshold=high --dev=true` against the same lockfile's
  development dependencies. (Pi packages are source-published, so dev deps
  remain on the build path.)
- `snyk monitor` snapshots the lockfile to Snyk so newly disclosed advisories
  surface in the Snyk web UI without re-scanning history.

`snyk test` blocks the pipeline on high or critical advisories. `snyk monitor`
is best-effort so a Snyk outage cannot freeze the release.

The workflow requires a repository secret named `SNYK_TOKEN`. Generate one at
<https://app.snyk.io/account> → Auth Token. Set it under
Settings → Secrets and variables → Actions. For a personal account, leaving
`SNYK_ORG` unset
is fine — Snyk falls back to the authenticated user's default org. Add it as a
repository variable only when the token must report under a specific org.

Snyk's free tier covers public repositories without a monthly test limit. Add
`SNYK_TOKEN` once and the workflow runs on every CI build thereafter.

Dependabot proposes weekly Actions and npm updates. Actions use commit SHA
pins. The Gitleaks binary version and SHA-256 checksum in
`scripts/install-gitleaks.sh` must be updated together.

## Secret scanning

`digital-twins` uses TruffleHog with verified-only findings, which calls
credential providers and misses credentials without verifiers. This repository
uses **Gitleaks 8.30.1** with its default rules: an offline, lightweight scan
without a service token, license, or live credential-verification requests.

CI scans fetched Git history on every PR/main run with redacted output. It also
tests that the scanner rejects a synthetic credential. There is no blanket
test-directory allowlist or existing-secret baseline.

Install the optional local staged-file guard in **each clone**:

```bash
brew install gitleaks
npm run hooks:install
npm run secrets:scan
```

The installer refuses to replace an existing hook configuration. The hook
blocks a commit if Gitleaks is missing or finds a secret. It is installed in
the implementation clone, but Git cannot install it automatically in other
clones. Common local credential files are also ignored by Git.

**No scanner guarantees detection of every key.** CI runs after a push, local
hooks can be bypassed, and GitHub push protection supports specific patterns.
Never commit real credentials, even temporarily. If a key is exposed, revoke
or rotate it immediately; deleting it in a later commit does not remove it
from history. Never add an allowlist entry to silence a real key.

## Adding another package

Add its publishable metadata and lockfile, validation scripts, and explicit
test partition to `scripts/packages.mjs`; add its npm directory to Dependabot.
The release allowlist intentionally excludes private/root packages and unknown
paths. Establish its initial npm publication and trusted publisher before
using this existing-package release flow.
