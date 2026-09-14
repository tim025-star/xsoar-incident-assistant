# XSOAR Incident Assistant

XSOAR Incident Assistant is a Manifest V3 browser extension that prepares an incident-response draft from the Cortex XSOAR incident already open in Chrome or Microsoft Edge.

It reads configured fields from the active incident, opens a matching-incident search through the XSOAR page URL, reviews a limited number of recent matches, and displays an editable draft in the browser side panel. It does not update XSOAR, submit forms, or send incident data to an external service.

> This is an independent community project. It is not affiliated with or endorsed by Palo Alto Networks.

## What changed in version 2

Version 2 replaces the remote-debugging, dedicated-browser-profile, AutoHotkey, Node.js runtime, and Notepad++ workflow with a browser extension:

- Use the browser and signed-in XSOAR session you already have open.
- Grant access to one exact HTTPS tenant origin from the settings page.
- Run searches by navigating to a URL containing the configured query parameter.
- Review and copy the draft from the extension side panel.
- Set your analyst name and title in Settings; no person's identity is built into the template.

The version 1 startup scripts and debug-mode integration have been removed.

## Install for testing

Chrome Web Store and Microsoft Edge Add-ons packages are not published yet. To test the release from source:

1. Download or clone this repository.
2. Open `chrome://extensions` in Chrome or `edge://extensions` in Edge.
3. Enable **Developer mode**.
4. Select **Load unpacked** and choose the repository's `extension` folder.
5. Open the extension's **Settings** page.
6. Enter the exact HTTPS origin of your XSOAR tenant and select **Save and grant tenant access**.

Node.js is needed only for development and tests, not to run the extension.

## Configure

The Settings page contains the public defaults and all tenant-specific values:

- **XSOAR HTTPS origin:** one exact tenant origin, without a path or credentials.
- **Incident path pattern:** a regular expression matching incident page paths.
- **Incidents page path:** the page used to search for matching incidents.
- **Search URL parameter:** the URL parameter that XSOAR uses for the query. The default is `query`.
- **Lookback query:** the additional time constraint included in the search.
- **Analyst name and title:** optional signature values stored in extension-local settings.
- **Field labels:** mappings for layouts whose visible labels differ from the generic defaults.

Settings are stored by the browser in `chrome.storage.local` for this extension. Do not include passwords, session cookies, API tokens, customer names, or incident content in settings. Exported settings files can include your tenant origin and analyst identity, so handle them according to your organisation's policy.

### Verify the search URL for your tenant

XSOAR deployments and versions can use different routes and URL parameters. Before operational use, perform a synthetic test:

1. In XSOAR, run a harmless incident search manually.
2. Confirm that the query remains visible in the browser address bar.
3. Copy the incidents page path and query-parameter name into Settings.
4. Generate a draft from a synthetic incident and confirm the side panel reports the expected matches.

The extension stops if navigation leaves the configured HTTPS origin, the active page does not match the configured incident path, or XSOAR does not retain the exact expected query in the final URL.

## Use

1. Sign in to XSOAR normally in Chrome or Edge.
2. Open an incident that matches the configured path.
3. Select the extension button to open the side panel.
4. Select **Generate draft**, or press `Alt+Shift+X`.
5. Review the draft. Select **Copy** only when you are ready to place it on the system clipboard.

The original incident tab is restored when processing finishes. Temporary search and historical-incident tabs are closed.

## Credentials and data handling

The extension does not ask for, read, store, or transmit XSOAR passwords, cookies, or API tokens. XSOAR authentication remains owned by the normal browser session. The extension asks the browser for page access only to the exact HTTPS origin selected in Settings.

During a run, incident fields are read from XSOAR pages and processed locally in the extension. The finished draft and generic progress state are kept in `chrome.storage.session`, which is cleared when the browser session ends. The draft reaches the Windows clipboard only after the user selects **Copy**.

Browser history, XSOAR itself, endpoint monitoring, clipboard managers, or browser synchronisation may retain data independently of this project. An organisation must assess those controls and approve the extension for its own environment. This repository does not claim compliance with any employer's internal security policy.

See [SECURITY.md](SECURITY.md) for the permission model and reporting process.

## Architecture and extension points

The code is split around a small browser-adapter boundary:

- `extension/domain.js` owns validation, URL construction, data merging, and draft generation.
- `extension/workflow.js` coordinates the incident, search, and historical-review sequence without depending directly on Chrome APIs.
- `extension/page-adapter.js` contains XSOAR DOM extraction.
- `extension/background.js` implements the Chrome/Edge adapter and controls session state.
- `extension/options.*` and `extension/sidepanel.*` provide configuration and output UI.

New extraction rules belong in the page adapter, new draft formats in the domain module, and new browser behavior behind the adapter interface. This keeps tenant compatibility changes separate from the security-sensitive navigation and permission checks.

## Development

Requirements:

- Node.js 20 or newer
- Chrome or Microsoft Edge for extension testing

Run the checks:

```powershell
npm ci
npm run check
npm test
npm run verify:browser
npm run package
npm audit --audit-level=high
```

`npm run package` creates `output/xsoar-incident-assistant-extension.zip`. GitHub Actions also publishes this ZIP as a workflow artifact after all checks pass.

Tests and fixtures must use fictional organisations, reserved domains such as `example.test`, and documentation IP address ranges. Never commit production HTML, screenshots, incident exports, tenant names, credentials, or browser profiles.

## Known compatibility boundary

The automated test suite verifies URL construction, origin/path enforcement, workflow cleanup, permissions, and generic DOM extraction. A maintainer must still test the configured search URL and field labels against each supported XSOAR release because the public product documentation does not define a stable browser deep-link contract for incident searches.

## License

This project uses the [MIT License](LICENSE).
