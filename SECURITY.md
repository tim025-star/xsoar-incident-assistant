# Security policy

## Supported versions and reporting

Security fixes apply to the latest default-branch revision. Use GitHub private vulnerability reporting. Do not place credentials, session data, tenant names, incident content, or production-derived material in a public issue.

## Security boundaries

- The controller binds only to `127.0.0.1`, authorises every oRPC request with a random per-process token, checks the exact Host, checks Origin on mutations, limits request bodies, and uses a restrictive Content Security Policy.
- Every XSOAR navigation must remain on the configured exact HTTPS origin. Incident and search paths are independently validated, including the expected URL query.
- Both browser modes use a dedicated persistent profile launched and owned directly by Playwright. The normal Chrome or Edge user-data tree and its descendants are rejected.
- Diagnostics mode opens Chromium DevTools without exposing a TCP remote-debugging endpoint or attaching to an independently launched browser.
- No feature reads, exports, copies, logs, or serialises passwords, cookies, tokens, or Playwright storage state.
- Drafts are held in process memory. Clipboard access occurs only after an explicit user action in the local UI.

The dedicated browser profile contains active browser-session material and must be protected by normal Windows account and endpoint controls. Removing the profile signs the assistant out but also deletes local browser state; close the assistant browser before removal.

## Organisational review

Deploying organisations should assess browser automation, identity-provider conditions, profile storage, endpoint controls, XSOAR audit behaviour, clipboard controls, package dependencies, and incident-data handling. This repository does not claim compliance with any organisation's internal policy.

## Release checks

1. Run `npm ci`, `npm run check`, `npm test`, `npm run verify:browser`, and `npm audit --audit-level=high`.
2. Review dependencies and all network/browser launch changes.
3. Scan the current tree and reachable history for secrets, identities, tenant codes, private paths, internal domains, production fixtures, and browser profiles.
4. Test managed and diagnostics modes with synthetic incidents in current Edge and Chrome.
5. Verify each supported XSOAR deployment's search URL and visible field labels.
