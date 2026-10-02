# Release checks: 0.2.0

Review date: 2026-10-02. These checks describe this release candidate, not a guarantee of future provider availability.

## Security fixes

- Welcome state uses exclusive file creation. It cannot replace an existing file or follow a pre-existing file symlink.
- A config named `web-search-welcome.json` uses a different marker path.
- Fixed HTTP endpoints reject redirects, including MCP cleanup. Custom API keys and request bodies cannot follow redirects to another origin.
- Sourcegraph repository filters escape regular-expression characters and match the complete repository name.
- Classifier discovery stops after three seconds. Existing pins do not trigger discovery.
- Package checks reject install-time scripts, undeclared imports, runtime dependencies, and files outside the publication allowlist.

The review covered credentials, process calls, HTTP/MCP transport, config writes, classifier boundaries, packaging, and dependency advisories.

Both full and production npm audits reported zero vulnerabilities for the checked dependency trees. Checks covered Pi 0.99.0 and 1.0.0.

The earlier “high security risk” warning was unavailable. This audit cannot identify its cause or certify that every scanner will accept the package. Pi supplies host dependencies. A recipient's Pi installation can have different advisories.

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
- CI covers Node 22.19.0 and 24 on Linux, macOS, and Windows. An additional job checks Pi 1.0.0.

To test an installed candidate with the live smoke, supply its package directory:

```bash
npm run smoke:live -- /path/to/node_modules/@gagansd/pi-web-search
```

## Limits

- No test simulated 1,000 devices against public services. Anonymous providers control availability, indexing, and rate limits.
- Authenticated GitHub, Exa REST, and hosted classifier tests use fixtures. This review did not make paid classifier requests.
- Retrieved text remains untrusted. Classification does not prevent all prompt injection or establish truth.
- Search queries, URLs, and optional classifier excerpts leave the device. Do not send secrets or private code.
- Config writes serialize within one process, not across separate Pi processes. Do not edit the same config concurrently from different processes.
- Terminal checks used macOS. Automated platform checks do not cover every terminal or operating-system configuration.

## Publish

Confirm that PR checks pass for the final commit. Run the commands above before publication.

```bash
npm publish --access public
```

`prepublishOnly` repeats the production audit, offline tests, typecheck, and tarball checks. It does not run live provider checks.
