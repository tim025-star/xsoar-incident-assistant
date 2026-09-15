# Security policy

## Supported versions and reporting

Security fixes apply to the latest default-branch revision. Use GitHub private vulnerability reporting. Do not place credentials, session data, tenant names, incident content, or production-derived material in a public issue.

## Security boundaries

- The controller binds only to `127.0.0.1`, authorises every oRPC request with a random per-process token, checks the exact Host, checks Origin on mutations, limits request bodies, and uses a restrictive Content Security Policy.
- Every XSOAR navigation must remain on the configured exact HTTPS origin. Incident and search paths are independently validated, including the expected URL query.
- Current Chrome mode requires Chrome 144 or newer and the user's explicit approval at `chrome://inspect/#remote-debugging`. The assistant reads Chrome's `DevToolsActivePort`, accepts only a numeric local port and a browser-scoped endpoint path, connects only to `127.0.0.1`, and disconnects without closing Chrome. It never enables debugging or supplies a remote-debugging launch flag itself.
- Managed and diagnostics modes use one configured dedicated persistent profile launched and owned directly by Playwright. The default is the legacy `%LOCALAPPDATA%\Google\Chrome\TSOC-Copilot` profile. An explicit custom absolute path is allowed only when it is empty or already looks like a Chromium user-data root; symbolic links, ordinary non-browser directories, and the normal Chrome or Edge `User Data` trees are rejected.
- Profile discovery is read-only. Profile import requires an explicit action through the authenticated local UI, rejects arbitrary paths and symbolic links, and atomically copies an allowlisted set of session-related stores into the assistant application-data directory. It does not alter or directly automate the source profile.
- Diagnostics mode opens Chromium DevTools without attaching to normal Chrome.
- The activation shortcut is available only in the Playwright-managed browser, not in current Chrome mode. It is not a global keyboard hook, browser extension, or plugin. Its randomly named Playwright binding accepts calls only from a focused top-level page whose URL passes the configured XSOAR incident checks.
- No feature asks for, logs, or serialises XSOAR passwords, API tokens, cookie values, or Playwright storage state. Explicit profile import copies encrypted Chromium cookies and site storage as files without inspecting their values; it excludes history, extensions, saved passwords, and caches.
- Drafts are held in process memory. Clipboard access occurs only after an explicit user action in the local UI.

An approved current-Chrome debugging session grants the local assistant broad control over the browser's exposed tabs for as long as it is connected. Only enable it for this trusted local application, keep the endpoint loopback-only, and select **Disconnect** when finished. Chrome and its tabs remain open after disconnection.

A configured managed browser profile contains active browser-session material and must be protected by normal Windows account and endpoint controls. Removing the profile signs the assistant out but also deletes local browser state; close the assistant browser before changing its path or removing it. The old CDP launcher and the new Playwright-owned session must never open the same legacy profile concurrently.

## Organisational review

Deploying organisations should assess browser automation, identity-provider conditions, profile storage, endpoint controls, XSOAR audit behaviour, clipboard controls, package dependencies, and incident-data handling. This repository does not claim compliance with any organisation's internal policy.

## Release checks

1. Run `npm ci`, `npm run check`, `npm test`, `npm run verify:browser`, and `npm audit --audit-level=high`.
2. Confirm the protected `windows-release` environment has required reviewers and owns the Authenticode certificate secrets. The workflow must verify that the tag points to `main` before it signs, then verify the installer signature after signing.
3. Review dependencies and all network/browser launch changes.
4. Scan the current tree and reachable history for secrets, identities, tenant codes, private paths, internal domains, production fixtures, and browser profiles.
5. Test current Chrome attachment plus managed and diagnostics modes with synthetic incidents in supported browsers.
6. Verify each supported XSOAR deployment's search URL and visible field labels.
