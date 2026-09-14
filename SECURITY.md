# Security policy

## Supported versions

Security fixes are applied to the latest revision on the default branch. Version 1 used Chromium remote debugging and is no longer supported.

## Reporting a vulnerability

Use GitHub's private vulnerability reporting feature when it is available. Do not open a public issue containing credentials, browser-session data, tenant names, incident content, or production-derived reproduction material. Use synthetic data and reserved domains wherever possible.

## Permission model

The extension uses these Manifest V3 permissions:

- `activeTab` to act only after the user invokes the extension.
- `scripting` to read configured fields from XSOAR pages.
- `sidePanel` to display status and the generated draft.
- `storage` to keep settings locally and draft state for the browser session.

The manifest declares optional HTTPS host access so the user can choose their tenant at runtime. The settings flow requests only `<configured-origin>/*`, and the workflow independently validates every incident, search, and historical navigation against that exact origin. The extension does not request `cookies`, `debugger`, `nativeMessaging`, `webRequest`, or clipboard permissions.

## Credentials and sensitive data

- Authentication stays in the user's existing browser session. The extension does not handle passwords, cookies, or API tokens.
- Settings in `chrome.storage.local` must contain configuration only, never credentials or incident content.
- Draft and progress state use `chrome.storage.session` and are cleared when the browser session ends.
- Clipboard access occurs only from an explicit **Copy** action in the side panel.
- Browser history, browser sync, endpoint monitoring, XSOAR audit records, and clipboard-management software are outside this extension's control.

Generated drafts and any exported settings must be handled according to the deploying organisation's security and data-retention requirements. No organisation-specific compliance claim is made by this project.

## Release checks

Before publishing a release:

1. Run `npm ci`, `npm run check`, `npm test`, and `npm audit --audit-level=high`.
2. Review the manifest and ensure no new permission is broader than the feature requires.
3. Scan the current tree and reachable Git history for secrets, employee identifiers, customer names, tenant codes, private paths, internal domains, and production-derived fixtures.
4. Test installation in current stable Chrome and Edge.
5. Verify the configured query URL and field labels against a synthetic incident in every supported XSOAR release.
