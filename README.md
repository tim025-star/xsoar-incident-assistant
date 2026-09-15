# XSOAR Incident Assistant

XSOAR Incident Assistant is a local Windows application that uses Playwright to prepare an incident-response draft from Cortex XSOAR. It reads an incident open in Chrome, searches for matching incidents through the XSOAR page URL, reviews a limited number of recent matches, and displays a draft locally. It does not update XSOAR or submit forms.

This is an independent community project. It is not affiliated with or endorsed by Palo Alto Networks.

## Chrome connection

The assistant supports one browser workflow: it connects to the ordinary Google Chrome window and profile you already use. The assistant control page, XSOAR incident, and temporary child tabs stay in that Chrome window. It does not launch, copy, or close a separate browser profile.

Chrome 144 or newer is required. Select **Open Chrome setup**, enable remote debugging, and accept Chrome's connection prompt. Chrome writes a local, process-specific WebSocket endpoint into its normal user-data directory. The assistant reads that endpoint, validates its browser-scoped path, connects only through `127.0.0.1`, and disconnects without closing Chrome.

Chrome's approval is session-scoped, so repeat the setup after Chrome restarts. A fixed debugging port is deliberately not used: current Chrome versions do not permit that approach for the default data directory, and it would weaken the user-controlled approval boundary.

No application can guarantee a particular XSOAR session lifetime or bypass an organisation's authentication policy.

## Install on Windows

Download `XSOAR-Incident-Assistant-Setup-<version>-x64.exe` from the project's GitHub Releases page and run it. The installer is per-user and includes its own Node.js runtime and locked production dependencies; administrator access and a system Node.js installation are not required.

Each release includes a matching `.sha256` file. The installer is currently unsigned, so Windows may show an unknown-publisher warning. Compare the checksum before running it.

1. Run the installer and leave **Create a desktop shortcut** and **Launch XSOAR Incident Assistant** selected. **Install local Ollama and download qwen3.5:9b** is optional and starts unchecked.
2. Select **Open Chrome setup**, enable remote debugging, and accept Chrome's prompt.
3. Enter the exact HTTPS origin of your XSOAR tenant and optional analyst name/title.
4. Select **Connect Chrome**. The current settings are saved before the connection is made.

The installer also adds a Start-menu shortcut. It does not add a browser extension, alter browser policy, start automatically at Windows sign-in, or overwrite configuration during an upgrade.

Requirements: Windows 11 x64 and Google Chrome 144 or newer.

### Optional local AI

The assistant always produces its baseline draft deterministically. If enabled in the settings page, it can use a locally installed Ollama model to fill concise investigation, related-activity, vendor-guidance, and recommendation sections. The default model is `qwen3.5:9b`, a practical CPU-only option for a machine with 32 GB RAM.

The optional installer task installs the pinned WinGet package `Ollama.Ollama` version `0.34.0` and downloads `qwen3.5:9b` (about 6.6 GB). It is unchecked and failure does not affect the core installation. Releases pass the exact package version through `OLLAMA_VERSION`; change it only after verifying that version in WinGet.

Cloud/remote aliases are rejected. Before incident evidence is sent, the selected model must be listed by the loopback Ollama service at `127.0.0.1:11434` and pass a fresh local-model check. The application has no cloud-AI endpoint or configurable AI URL. Downloads report progress, can be cancelled, use a short connection timeout and stop after two minutes with no valid progress; continuous progress has no total elapsed-time cap. Inference has a separate three-minute limit. Invalid, unavailable, remote, or malformed AI output falls back to the deterministic draft.

## Use

1. Open the application from its desktop or Start-menu shortcut.
2. If Chrome was restarted, select **Open Chrome setup** and approve remote debugging.
3. Select **Connect Chrome** and keep one XSOAR incident open in another tab.
4. Select **Generate draft** in the assistant tab.
5. Review the draft, then explicitly select **Copy draft** if needed.

Temporary search and historical tabs are closed, and the original incident is brought back to the front. If multiple incident tabs are open, the assistant asks you to bring the intended one to the front.

If launch reports a startup error, reinstall the current release. The launcher displays an error instead of failing silently.

## Configure and verify your tenant

The settings page includes the tenant origin, analyst identity, incident URL pattern, incidents page path, URL query parameter, historical lookback, result limit, and page timeout. No person's name is hard-coded.

XSOAR routes vary by deployment. Before operational use, run a harmless search manually, confirm the query remains in the browser address bar, configure that path and parameter, then test against synthetic incidents. Automation stops if navigation leaves the configured HTTPS origin, an incident path does not match, or the final search URL does not retain the exact expected query.

## Credentials and data

The application never asks for or stores a password or API token, and it does not export Playwright `storageState` or copy Chrome profile files. Authentication remains in the normal Chrome profile. While connected, Playwright can inspect and control tabs exposed by Chrome's approved debugging session, so connect only this trusted local application and disconnect when finished.

Configuration is stored under `%LOCALAPPDATA%\XSOAR Incident Assistant`. It may include a tenant hostname, analyst identity, local-AI opt-in, and selected local model name, but must not contain credentials or incident content. Drafts remain in process memory and reach the clipboard only after the user selects **Copy draft**. An AI-enriched draft must be explicitly acknowledged as reviewed for that generation before it can be copied. Only a bounded allowlist of extracted incident and historical fields is sent to loopback Ollama, never to configuration. Browser history, endpoint monitoring, clipboard managers, and XSOAR audit records operate independently.

An organisation must review and approve the tool against its own browser, identity, information-handling, and software policies. See [SECURITY.md](SECURITY.md).

## Architecture

- `src/domain.js`: validation, URL construction, data merging, and draft generation.
- `src/workflow.js`: browser-independent incident/search/history orchestration.
- `src/page-adapter.js`: XSOAR DOM extraction.
- `src/browser-session.js`: user-approved current-Chrome connection and the browser adapter.
- `src/local-ai.js`: loopback-only Ollama client, bounded evidence construction, and strict enrichment validation.
- `src/rpc.js`: typed oRPC operations and local application state.
- `src/server.js`: Hono loopback server, request security checks, and static delivery.
- `web/`: Solid and Tailwind configuration/status interface, built by Vite into ignored `dist/` output.

New extraction rules belong in the page adapter, draft formats in the domain module, and browser behaviour behind the browser adapter. The local application intentionally remains a single package.

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

The end-user installer is built only from a version tag. It stages the built application, production dependencies, and a pinned portable Node.js runtime, then packages them with Inno Setup. The optional Ollama task has a separately pinned WinGet version set through `OLLAMA_VERSION`.

1. Update `package.json` with the release version and push a matching `v<version>` tag.
2. The **Windows release** workflow verifies the project and runtime checksum, builds the unsigned installer, writes its SHA-256 sidecar, and publishes both files to the GitHub Release.

Tests and examples must use fictional data and reserved domains such as `example.test`. Never commit browser profiles, production HTML, screenshots, incident exports, tenant names, credentials, or session data.

## License

This project uses the [MIT License](LICENSE).
