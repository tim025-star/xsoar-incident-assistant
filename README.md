# XSOAR Incident Assistant

XSOAR Incident Assistant is a local Windows application that uses Playwright to prepare an incident-response draft from Cortex XSOAR. It reads an incident open in Chrome, searches for matching incidents through the XSOAR page URL, reviews a limited number of recent matches, and displays a draft locally. It does not update XSOAR or submit forms.

This is an independent community project. It is not affiliated with or endorsed by Palo Alto Networks.

## Browser modes

The default **Current Chrome window** mode connects to the ordinary Google Chrome window and profile that are already running. It does not launch or close another browser instance. The assistant control page, XSOAR incident, and temporary child tabs therefore stay in one Chrome window.

Current Chrome mode requires Chrome 144 or newer and one user-controlled setup step. Open `chrome://inspect/#remote-debugging`, enable remote debugging, and accept Chrome's connection prompt. Chrome writes a local, process-specific WebSocket endpoint into its normal user-data directory. The assistant reads that endpoint, connects only through `127.0.0.1`, and disconnects without closing Chrome. If Chrome is restarted, Chrome may ask you to approve the connection again.

The **Managed profile** fallback opens Chrome with the legacy private-version profile at `%LOCALAPPDATA%\Google\Chrome\TSOC-Copilot`. Existing users can therefore keep the same dedicated Chrome profile and sign-in state if current Chrome mode is unavailable. Close the old debug Chrome completely before selecting **Open browser** in managed mode. Cookies and local storage remain in that profile between runs, but the XSOAR and identity-provider session policies still decide when reauthentication, MFA, revocation, or expiry occurs.

The managed/diagnostics profile directory is editable in Settings. A custom path must be an absolute, dedicated Chromium user-data directory: an existing directory must be empty or contain Chromium profile markers. Symbolic links, ordinary non-browser directories, and Chrome or Edge's normal `User Data` trees are rejected. These fallback modes launch and own the configured profile directly.

The settings page can detect standard Edge and Chrome profiles for the current Windows account. An explicit **Import profile** action copies only session-related browser storage from the selected profile into a separate assistant-owned profile. Close the selected browser before importing. The original profile is not changed or controlled, and imported authentication may still require MFA or a fresh sign-in. Browser history, extensions, saved passwords, and caches are not imported.

The optional **Diagnostics with DevTools** mode launches the same Playwright-owned browser and dedicated profile while automatically opening Chromium DevTools. It does not attach to normal Chrome.

No mode can guarantee a particular session lifetime or bypass an organisation's authentication policy.

## Install on Windows

Download the current `XSOAR-Incident-Assistant-Setup-<version>-x64.exe` from the project's GitHub Releases page, then run it. The installer is per-user: it does not require administrator access, Node.js, npm, or a system-wide software install.

Each release includes a matching `.sha256` file. The current installer is unsigned, so Windows may show an unknown-publisher warning. Compare the checksum with the downloaded installer before running it.

1. Run the downloaded installer and leave **Launch XSOAR Incident Assistant** selected.
2. In normal Chrome, open `chrome://inspect/#remote-debugging`, enable remote debugging, and accept Chrome's prompt.
3. In the application, keep **Current Chrome window**, enter the exact HTTPS origin of your XSOAR tenant and your optional analyst name/title, then save.
4. Select **Connect current Chrome**. The connection uses the tabs in the normal Chrome window and does not open another browser.
5. Use **Managed profile** only as a fallback. Its default path points to the legacy `TSOC-Copilot` directory; profile import and custom profile settings apply only to managed and diagnostics modes.

The installer adds a Start-menu shortcut and includes the application's Node.js runtime and locked production dependencies. It does not add a browser extension, alter browser policy, start automatically at Windows sign-in, or overwrite configuration and browser-profile data during an upgrade.

Requirements: Windows 11 x64 and a current Microsoft Edge or Google Chrome installation.

## Use

1. Start the application so its local control page opens as a normal Chrome tab.
2. Select **Connect current Chrome**, then keep one XSOAR incident open in another tab.
3. Select **Generate draft** in the assistant tab.
4. Review the draft, then explicitly select **Copy draft** if needed.

Temporary search and historical tabs are closed, and the original incident is brought back to the front. If multiple incident tabs are open, the assistant asks you to bring the intended one to the front.

Current Chrome mode does not inject keyboard listeners into the everyday browser. Its workflow starts from the **Generate draft** button in the assistant tab. In managed or diagnostics mode, select **Record shortcut** in Settings, then press the key or key combination you want during the five-second recording window. Playwright adds that in-memory listener only to the assistant-owned browser and removes it with the session.

If the Start-menu launch reports a startup error, reinstall the current release. The launcher displays an error instead of failing silently.

### Diagnostics mode

Select **Diagnostics with DevTools**, save settings, then select **Open browser**. The assistant launches the dedicated profile directly through Playwright and opens DevTools for each browser tab. Switching modes does not copy or replace the profile, so the existing assistant-browser sign-in remains available subject to the organisation's normal authentication policy. Close the browser before changing modes.

## Configure and verify your tenant

The settings page includes the tenant origin, analyst identity, incident URL pattern, incidents page path, URL query parameter, historical lookback, result limit, and page timeout. No person's name is hard-coded.

XSOAR routes vary by deployment. Before operational use, run a harmless search manually, confirm the query remains in the browser address bar, configure that path and parameter, then test against synthetic incidents. Automation stops if navigation leaves the configured HTTPS origin, an incident path does not match, or the final search URL does not retain the exact expected query.

## Credentials and data

The application never asks for or stores a password or API token, and it does not export Playwright `storageState`. In current Chrome mode, authentication remains entirely in the normal browser profile; no profile files are copied. While connected, Playwright can inspect and control tabs exposed by Chrome's approved debugging session, so connect only this trusted local application and disconnect when finished.

Managed mode authentication is handled by its configured dedicated browser profile. The default legacy profile is stored under `%LOCALAPPDATA%\Google\Chrome\TSOC-Copilot`; imported profiles are stored under `%LOCALAPPDATA%\XSOAR Incident Assistant`. If the user explicitly imports an existing standard profile, the application copies its Chromium local-state key and an allowlisted set of session-related stores, including cookies and site storage, into a new dedicated profile. It does not copy browser history, extensions, saved passwords, or caches. The source remains unchanged. Every configured profile contains browser session data and must be protected like any signed-in browser profile.

Configuration is stored locally in the same application-data directory. It may include a tenant hostname and analyst identity, but must not contain credentials or incident content. Drafts remain in process memory and reach the clipboard only after the user selects **Copy draft**. Browser history, endpoint monitoring, clipboard managers, and XSOAR audit records operate independently.

An organisation must review and approve the tool against its own browser, identity, information-handling, and software policies. This project makes no claim of compliance with any employer's internal requirements. See [SECURITY.md](SECURITY.md).

## Architecture

- `src/domain.js`: validation, URL construction, data merging, and draft generation.
- `src/workflow.js`: browser-independent incident/search/history orchestration.
- `src/page-adapter.js`: XSOAR DOM extraction.
- `src/browser-session.js`: user-approved current-Chrome attachment plus Playwright-owned managed and diagnostics sessions.
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
