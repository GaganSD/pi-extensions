# Release checks: 0.2.0

Review date: 2026-10-02. These checks describe this release candidate, not a guarantee of future provider availability.

## Security fixes

- Welcome state uses exclusive file creation. It cannot replace an existing file or follow a pre-existing file symlink.
- A config named `web-search-welcome.json` uses a different marker path.
- The extension's HTTP transport rejects redirects, including custom MCP cleanup. These requests cannot forward API keys or bodies through redirects.
- Sourcegraph repository filters escape regular-expression characters and match the complete repository name.
- The command stops waiting for classifier discovery after three seconds and requests cancellation. Existing pins do not trigger discovery.
- Package checks reject install-time scripts, undeclared imports, runtime dependencies, and files outside the publication allowlist.

The review covered credentials, process calls, HTTP/MCP transport, config writes, classifier boundaries, packaging, and dependency advisories.

## npm advisory and host dependencies

A plain npm 11 installation reproduced one high-severity advisory through automatically installed Pi peers. Pi 1.0.0's shrinkwrap pins `brace-expansion@5.0.9`. Version `5.0.12` fixes the reported advisories, including [GHSA-qhr7-859c-m2p7](https://github.com/advisories/GHSA-qhr7-859c-m2p7).

Host peers are now optional. Installing this extension no longer downloads another Pi installation or its dependency tree. Pi supplies these modules when it loads the extension. Package tests check an ordinary npm install without peer-suppression flags.

The locked Pi 0.99.0 development tree passes the full audit. Pi 1.0.0 compatibility checks use npm 12, which selected patched `5.0.12`. Both full and production audits passed on those trees. CI retains the full audit gate.

This change does not patch an existing Pi installation. Audit the host separately. The original warning text remains unavailable, so this reproduced path is not a confirmed explanation of that report.

## Validation

Run these commands from `pi-web-search`:

```bash
npm ci --ignore-scripts --no-audit --no-fund
npm test
npm run typecheck
npm audit --audit-level=high
npm run pack:check
npm run smoke:live
```

- Offline tests cover provider fallback, parsing, timeouts, cancellation, config changes, credentials, and classification.
- Package checks install the tarball without host peers. Pi loads its TypeScript entrypoint without compilation. Tests also run against extracted source.
- The live smoke uses an isolated home and agent directory. It does not use your keys or GitHub CLI login.
- Live checks cover Exa, grep.app, scoped Sourcegraph, native Parallel, URL extraction, and multi-source code search through Pi's SDK.
- Live checks send public test queries. They require network access and can fail when a provider is unavailable.
- A terminal rehearsal checked local installation, first-run setup, settings display, and a second launch without the welcome prompt.
- The compatibility lane has three jobs: Linux (Node 22.19.0, Pi 0.99), Windows (Node 24, Pi 0.99), and macOS (Node 24, Pi 1.0).
- Each compatibility job runs audits, typechecks, and package tests. Runtime tests in that lane run against the tarball. Pi 1.0 installation uses npm 12.
- Shared monorepo CI also runs lint, separate unit/integration suites, a clean-consumer artifact build, and secret scanning. See the repository’s `docs/ci-cd.md` for the current release workflow.

To test an installed candidate with the live smoke, supply its package directory:

```bash
npm run smoke:live -- /path/to/node_modules/@gagansd/pi-web-search
```

## Limits

- No test simulated 1,000 devices against public services. Anonymous providers control availability, indexing, and rate limits.
- Pi owns native Parallel and classifier transports. This review does not certify their redirect policies.
- Authenticated GitHub, Exa REST, and hosted classifier tests use fixtures. This review did not make paid classifier requests.
- Retrieved text remains untrusted. Classification does not prevent all prompt injection or establish truth.
- Search queries, URLs, and optional classifier excerpts leave the device. Do not send secrets or private code.
- Config writes serialize within one process, not across separate Pi processes. Do not edit the same config concurrently from different processes.
- Terminal checks used macOS. Automated platform checks do not cover every terminal or operating-system configuration.

## Publish

Request a release from the monorepo root using `npm run release:prepare` as documented in the repository’s `docs/ci-cd.md`. Merging its release PR publishes the validated tarball through GitHub Actions after main CI passes. Ordinary PR merges do not publish.

`prepublishOnly` remains a local safety check: it repeats the production audit, offline tests, typecheck, and tarball checks. CI publication validates the artifact first and disables lifecycle hooks when publishing that exact tarball. Neither route runs live provider checks.
