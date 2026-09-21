# Security policy

## Supported versions and reporting

Security fixes apply to the latest default-branch revision. Use GitHub private vulnerability reporting. Do not place credentials, session data, tenant names, incident content, or production-derived material in a public issue.

## Security boundaries

- The controller binds only to `127.0.0.1`, authorises every oRPC request with a random per-process token, checks the exact Host, checks Origin on mutations, limits request bodies, and uses a restrictive Content Security Policy.
- Every XSOAR navigation must remain on the configured exact HTTPS origin. Incident and search paths are independently validated, including the expected URL query.
- The Chrome connection requires Chrome 144 or newer and explicit approval at `chrome://inspect/#remote-debugging`. The assistant reads Chrome's `DevToolsActivePort`, accepts only a numeric local port and a browser-scoped endpoint path, connects only to `127.0.0.1`, and disconnects without closing Chrome.
- The assistant never enables debugging automatically, supplies a remote-debugging launch flag, chooses a fixed debugging port, launches a separate automated browser, or copies browser-profile files.
- Optional AI enrichment connects only to fixed loopback `http://127.0.0.1:11434`; users cannot configure an AI host, API key, or cloud provider. Cloud/remote aliases are rejected before configuration and download. Before evidence is sent, the selected model must appear locally and pass a fresh `/api/show` check that rejects `remote_host` or `remote_model` metadata. Evidence consists only of bounded allowlisted incident fields plus complete, bounded alert JSON from explicit JSON containers; credential-bearing JSON keys are removed recursively. Oversized or incomplete alert JSON fails closed to the deterministic draft. Output must pass strict JSON-schema and size checks.
- The default local-AI installer uses pinned HTTPS GitHub Release URLs only. Redirects are manually validated against a small GitHub-host allowlist; credentials, non-HTTPS URLs, nonstandard ports, unbounded redirects, size mismatches, and SHA-256 mismatches are rejected. The end-user install path invokes neither PowerShell nor WinGet. Custom-model downloads still use Ollama's registry and are labelled separately in the UI.
- No feature asks for, logs, or serialises XSOAR passwords, API tokens, cookie values, or Playwright storage state.
- Drafts are held in process memory. Clipboard access occurs only after an explicit user action in the local UI.

An approved debugging session grants the local assistant broad control over Chrome's exposed tabs while connected. Only enable it for this trusted local application, keep the endpoint loopback-only, and select **Disconnect** when finished. Chrome and its tabs remain open after disconnection. Chrome requires the user to approve the connection again after a restart.

## Organisational review

Deploying organisations should assess browser automation, identity-provider conditions, endpoint controls, XSOAR audit behaviour, clipboard controls, package dependencies, and incident-data handling. This repository does not claim compliance with any organisation's internal policy.

## Release checks

1. Run `npm ci`, `npm run check`, `npm test`, `npm run verify:browser`, and `npm audit --audit-level=high`.
2. Verify that the release tag points to `main` before publishing the installer and checksum.
3. Review dependencies and all network/browser launch changes, including loopback-only Ollama and every pinned GitHub asset URL, size, and SHA-256 digest.
4. Scan the current tree and reachable history for secrets, identities, tenant codes, private paths, internal domains, production fixtures, and browser profiles.
5. Test the current-Chrome connection with synthetic incidents in a supported Chrome version.
6. Verify each supported XSOAR deployment's search URL and visible field labels.
