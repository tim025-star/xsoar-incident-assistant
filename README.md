# XSOAR Incident Assistant

XSOAR Incident Assistant is a local Windows application that uses Playwright to prepare an incident-response draft from Cortex XSOAR. It reads the incident open in the assistant browser, searches for matching incidents through the XSOAR page URL, reviews a limited number of recent matches, and displays a draft locally. It does not update XSOAR or submit forms.

This is an independent community project. It is not affiliated with or endorsed by Palo Alto Networks.

## Browser modes

The default **Managed profile** mode opens Chrome with the legacy private-version profile at `%LOCALAPPDATA%\Google\Chrome\TSOC-Copilot`. Existing users can therefore keep the same dedicated Chrome profile and sign-in state while moving away from the old port-9222 launcher. Close the old debug Chrome completely before selecting **Open browser** in this application. Cookies and local storage remain in that profile between runs, but the XSOAR and identity-provider session policies still decide when reauthentication, MFA, revocation, or expiry occurs.

The profile directory is editable in Settings. A custom path must be an absolute, dedicated Chromium user-data directory: an existing directory must be empty or contain Chromium profile markers. Symbolic links, ordinary non-browser directories, and Chrome or Edge's normal `User Data` trees are rejected. The application launches and owns the configured profile directly; it does not attach to an independently running browser.

The settings page can detect standard Edge and Chrome profiles for the current Windows account. An explicit **Import profile** action copies only session-related browser storage from the selected profile into a separate assistant-owned profile. Close the selected browser before importing. The original profile is not changed or controlled, and imported authentication may still require MFA or a fresh sign-in. Browser history, extensions, saved passwords, and caches are not imported.

The optional **Diagnostics with DevTools** mode launches the same Playwright-owned browser and dedicated profile while automatically opening Chromium DevTools. It does not expose a remote-debugging network endpoint or attach to an independently launched browser.

Neither mode can guarantee a particular session lifetime or bypass an organisation's authentication policy.

## Install on Windows

Download the current `XSOAR-Incident-Assistant-Setup-<version>-x64.exe` from the project's GitHub Releases page, then run it. The installer is per-user: it does not require administrator access, Node.js, npm, or a system-wide software install.

Each release includes a matching `.sha256` file. The current installer is unsigned, so Windows may show an unknown-publisher warning. Compare the checksum with the downloaded installer before running it.

1. Run the downloaded installer and leave **Launch XSOAR Incident Assistant** selected.
2. Existing private-version users should close the old TSOC debug Chrome and its launcher. The default profile path already points to the legacy `TSOC-Copilot` directory.
3. In the application, enter the exact HTTPS origin of your XSOAR tenant and your optional analyst name/title, then save. Change the dedicated profile path only if your profile is stored elsewhere.
4. Optionally select a detected standard Edge or Chrome profile and choose **Import profile** after closing that browser completely.
5. Keep **Managed profile** unless you need Chromium DevTools for troubleshooting.

The installer adds a Start-menu shortcut and includes the application's Node.js runtime and locked production dependencies. It does not add a browser extension, alter browser policy, start automatically at Windows sign-in, or overwrite configuration and browser-profile data during an upgrade.

Requirements: Windows 11 x64 and a current Microsoft Edge or Google Chrome installation.

## Use

1. Select **Open browser**.
2. Sign in if your organisation requires it and open one XSOAR incident.
3. While the assistant browser is focused on an incident, press the configured activation shortcut (default: **Numpad+**), or select **Generate draft**.
4. Review the draft, then explicitly select **Copy draft** if needed.

Temporary search and historical tabs are closed, and the original incident is brought back to the front. If multiple incident tabs are open, the assistant asks you to bring the intended one to the front.

Select **Record shortcut** in Settings, then press the key or key combination you want during the five-second recording window. Recording stops after the first supported shortcut or when the window expires. When the managed XSOAR browser opens, Playwright adds an in-memory key listener to its pages. A match can invoke the existing draft workflow only from the focused top-level page after its URL passes the configured XSOAR incident checks. It is not global, installs no browser extension or plugin, runs no PowerShell hotkey script, and stops with the browser session.

If the Start-menu launch reports a startup error, reinstall the current release. The launcher displays an error instead of failing silently.

### Diagnostics mode

Select **Diagnostics with DevTools**, save settings, then select **Open browser**. The assistant launches the dedicated profile directly through Playwright and opens DevTools for each browser tab. Switching modes does not copy or replace the profile, so the existing assistant-browser sign-in remains available subject to the organisation's normal authentication policy. Close the browser before changing modes.

## Configure and verify your tenant

The settings page includes the tenant origin, analyst identity, incident URL pattern, incidents page path, URL query parameter, historical lookback, result limit, and page timeout. No person's name is hard-coded.

XSOAR routes vary by deployment. Before operational use, run a harmless search manually, confirm the query remains in the browser address bar, configure that path and parameter, then test against synthetic incidents. Automation stops if navigation leaves the configured HTTPS origin, an incident path does not match, or the final search URL does not retain the exact expected query.

## Credentials and data

The application never asks for or stores a password or API token, and it does not export Playwright `storageState`. Authentication is handled by the configured dedicated browser profile. The default legacy profile is stored under `%LOCALAPPDATA%\Google\Chrome\TSOC-Copilot`; imported profiles are stored under `%LOCALAPPDATA%\XSOAR Incident Assistant`. If the user explicitly imports an existing standard profile, the application copies its Chromium local-state key and an allowlisted set of session-related stores, including cookies and site storage, into a new dedicated profile. It does not copy browser history, extensions, saved passwords, or caches. The source remains unchanged. Every configured profile contains browser session data and must be protected like any signed-in browser profile.

Configuration is stored locally in the same application-data directory. It may include a tenant hostname and analyst identity, but must not contain credentials or incident content. Drafts remain in process memory and reach the clipboard only after the user selects **Copy draft**. Browser history, endpoint monitoring, clipboard managers, and XSOAR audit records operate independently.

An organisation must review and approve the tool against its own browser, identity, information-handling, and software policies. This project makes no claim of compliance with any employer's internal requirements. See [SECURITY.md](SECURITY.md).

## Architecture

- `src/domain.js`: validation, URL construction, data merging, and draft generation.
- `src/workflow.js`: browser-independent incident/search/history orchestration.
- `src/page-adapter.js`: XSOAR DOM extraction.
- `src/browser-session.js`: Playwright-owned managed and diagnostics browser sessions.
- `src/browser-profiles.js`: detection and explicit isolated import of standard Edge and Chrome profiles.
- `src/hotkey.js` and `src/browser-session.js`: shortcut recording, validation, and the focused assistant-browser listener.
- `src/rpc.js`: typed oRPC operations and local application state.
- `src/server.js`: Hono loopback server, request security checks, and static delivery.
- `web/`: Solid and Tailwind configuration/status interface, built by Vite into ignored `dist/` output.

New extraction rules belong in the page adapter, draft formats in the domain module, and browser behavior behind the browser adapter. This keeps future features independent of session mode.

The local application stack is Solid, Tailwind CSS, Hono, oRPC, Zod, and Vite on Node.js. It intentionally remains a single package: this desktop-style local tool does not need a database, server rendering, external authentication framework, or monorepo overhead.

## Development

```powershell
npm ci
npm run build
npm run check
npm test
npm run verify:browser
npm audit --audit-level=high
```

### Creating a Windows release

The end-user installer is built only from a version tag. It stages the built application, production dependencies, and a pinned portable Node.js runtime, then packages them with Inno Setup. The staged files and output installer are ignored by Git.

1. Update `package.json` with the release version and push a matching `v<version>` tag.
2. The **Windows release** GitHub Actions workflow verifies the project, verifies the downloaded runtime SHA-256, builds the unsigned `XSOAR-Incident-Assistant-Setup-<version>-x64.exe`, writes its SHA-256 sidecar, and publishes both files to the GitHub Release.

For a local packaging run, install Inno Setup 6, build the application, set `NODE_RUNTIME_PATH` to a verified x64 `node.exe`, then run `npm run package:windows`. This is a maintainer operation; end users should always install a published release asset.

Tests and examples must use fictional data and reserved domains such as `example.test`. Never commit browser profiles, production HTML, screenshots, incident exports, tenant names, credentials, or session data.

## License

This project uses the [MIT License](LICENSE).
