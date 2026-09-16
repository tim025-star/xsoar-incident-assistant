# XSOAR Incident Assistant

XSOAR Incident Assistant is a local Windows data-processing tool for SOC analysts. It collects source fields from a Cortex XSOAR incident, reviews a bounded set of related cases, and formats the important data for analyst review. It does not decide what happened, recommend actions, update XSOAR, or submit forms.

This is an independent community project. It is not affiliated with or endorsed by Palo Alto Networks.

## Chrome connection

The tool connects to the signed-in Google Chrome session the analyst already uses. The local console, XSOAR incident, and temporary evidence tabs stay in that session. It does not launch, copy, or close a separate browser profile.

Chrome 144 or newer is required. Select **Connect Chrome** first. If Chrome has not exposed an approved debugging session, the home page shows **Chrome access needs attention**; only then select **Open Chrome access setup**, enable remote debugging, and approve Chrome's prompt. Chrome writes a local, process-specific WebSocket endpoint into its normal user-data directory. The tool validates that browser-scoped endpoint, connects only through `127.0.0.1`, and disconnects without closing Chrome.

Chrome's approval is session-scoped, so repeat the setup after Chrome restarts. A fixed debugging port is deliberately not used: current Chrome versions do not permit that approach for the default data directory, and it would weaken the user-controlled approval boundary.

No application can guarantee a particular XSOAR session lifetime or bypass an organisation's authentication policy.

## Install on Windows

Download `XSOAR-Incident-Assistant-Setup-<version>-x64.exe` from the project's GitHub Releases page and run it. The installer is per-user and includes its own Node.js runtime and locked production dependencies; administrator access and a system Node.js installation are not required.

Each release includes a matching `.sha256` file. The installer is currently unsigned, so Windows may show an unknown-publisher warning. Compare the checksum before running it.

1. Run the installer and leave **Create a desktop shortcut** and **Launch XSOAR Incident Assistant** selected. **Install local Ollama and qwen3.5:9b from GitHub** is optional and starts unchecked.
2. Open **Configuration**, enter the exact HTTPS origin of your XSOAR tenant, review the field mappings, and save.
3. Return to **Home** and select **Connect Chrome**. If Chrome access needs attention, use the setup action shown there, approve Chrome's prompt, then connect again.

The installer also adds a Start-menu shortcut. It does not add a browser extension, alter browser policy, start automatically at Windows sign-in, or overwrite configuration during an upgrade.

Requirements: Windows 11 x64 and Google Chrome 144 or newer.

### Optional local AI

The tool always builds a deterministic source-field response. When Local AI is enabled, Ollama transforms allowlisted source evidence into an event summary and explicitly observed facts. Its schema and prompt exclude conclusions, classifications, guidance, and recommended actions. The default `qwen3.5:9b` model is suitable for a CPU-only workstation with 32 GB RAM.

The optional installer task downloads the official Ollama `0.34.0` Windows installer and the default `qwen3.5:9b` Q4_K_M model from pinned GitHub Release assets. A fresh installation downloads about 8.2 GB; the model itself is about 6.6 GB. Allow at least 16 GB of free disk space while the model is assembled and imported. The task is unchecked and failure does not affect the core installation. It launches `OllamaSetup.exe` directly and uses the application's bundled Node.js runtime for the model import, so the end-user path does not invoke PowerShell or WinGet.

Every runner and model asset has a fixed byte length and SHA-256 digest in `src/local-ai-installer.js`. Downloads follow redirects only from `github.com` to approved GitHub asset hosts, resume an interrupted part when the server honours byte ranges, and are rejected before import if any part or the reassembled GGUF checksum differs. After a successful `ollama create`, the temporary GGUF is removed. Failures are recorded at `%LOCALAPPDATA%\XSOAR Incident Assistant\logs\local-ai-install.log` without signed asset URLs.

Select **Install default model** to use the verified GitHub path. If the default model is already present, the tool verifies it locally and does not contact the registry. Analysts can enter another valid local Ollama model and select **Pull selected model**; that path requires access to the Ollama registry. Both paths install the pinned Ollama runner from GitHub when needed.

Cloud and remote model aliases are blocked. Before Ollama receives incident evidence, the selected model must appear on the loopback service at `127.0.0.1:11434` and pass a fresh local-model check. The tool has no cloud AI endpoint or configurable AI URL. Generated output streams in the processed-data field. Invalid or unavailable AI output falls back to the deterministic source-field response.

## Use

1. Open the application from its desktop or Start-menu shortcut.
2. Select **Connect Chrome**. If the app detects that Chrome access needs attention, use the setup action it displays, approve remote debugging, then connect again.
3. Keep the intended XSOAR incident open in Chrome. Expand **Target a specific incident** only when you need to enter an Incident ID.
4. Select **Process data** in the local console.
5. When processing is complete, the app returns to the local console automatically. If Local AI is enabled, review the validated output in **Processed incident data**.
6. If Local AI processing was used, confirm that the fields match the source evidence, then select **Copy processed data**.

When Incident ID is blank, the tool uses the only open incident tab. If several are open, enter the intended ID to avoid triaging the wrong case. An entered ID opens through the configured incident URL template. The tool closes temporary incident, search, and related-case tabs after evidence collection.

If launch reports a startup error, reinstall the current release. The launcher displays an error instead of failing silently.

## Configure and verify your tenant

The separate **Configuration** page includes the tenant URL, analyst identity, incident route regex, incident URL template, incident list path, search parameter, related-case lookback, review limit, page timeout, local AI, output wording, and JSON log mappings. Each mapping accepts JSON keys or dotted paths such as `source.ip` or `events.actor.user_name`; array indexes are ignored. Existing XSOAR field labels and two-column log tables remain supported as fallbacks. No analyst name is hard-coded.

XSOAR routes vary by deployment. Before operational use, run a harmless search manually, confirm the query remains in the browser address bar, configure that path and parameter, then test against synthetic incidents. Automation stops if navigation leaves the configured HTTPS origin, an incident path does not match, or the final search URL does not retain the exact expected query.

## Credentials and data

The application never asks for or stores a password or API token, and it does not export Playwright `storageState` or copy Chrome profile files. Authentication remains in the normal Chrome profile. While connected, Playwright can inspect and control tabs exposed by Chrome's approved debugging session, so connect only this trusted local application and disconnect when finished.

Configuration is stored under `%LOCALAPPDATA%\XSOAR Incident Assistant`. It may include a tenant hostname, analyst identity, Local AI setting, selected model name, output wording, and field-label mappings, but it must not contain credentials or incident content. Processed data stays in memory and reaches the clipboard only after the analyst selects **Copy processed data**. The tool requires review confirmation before it copies AI-processed fields. Only a bounded allowlist from the original incident goes to loopback Ollama. Related-ticket records are appended locally after AI processing and are never sent to the model.

An organisation must review and approve the tool against its own browser, identity, information-handling, and software policies. See [SECURITY.md](SECURITY.md).

## Architecture

- `src/domain.js`: validation, URL construction, data merging, and draft generation.
- `src/workflow.js`: browser-independent incident/search/history orchestration.
- `src/page-adapter.js`: bounded JSON log parsing plus fallback XSOAR DOM extraction.
- `src/browser-session.js`: user-approved current-Chrome connection and the browser adapter.
- `src/local-ai.js`: loopback-only Ollama client, bounded evidence construction, and strict enrichment validation.
- `src/local-ai-installer.js`: pinned GitHub downloads, checksums, resumable model assembly, and local Ollama import.
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

The end-user installer is built only from a version tag. It stages the built application, production dependencies, and a pinned portable Node.js runtime, then packages them with Inno Setup. Ollama and default-model versions, URLs, sizes, and hashes are pinned in `src/local-ai-installer.js`.

1. Update `package.json` with the release version and push a matching `v<version>` tag.
2. The **Windows release** workflow verifies the project and runtime checksum, builds the unsigned installer, writes its SHA-256 sidecar, and publishes both files to the GitHub Release.

Tests and examples must use fictional data and reserved domains such as `example.test`. Never commit browser profiles, production HTML, screenshots, incident exports, tenant names, credentials, or session data.

## License

This project uses the [MIT License](LICENSE).
