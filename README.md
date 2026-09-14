# XSOAR Incident Assistant

[![CI](https://github.com/tim025-star/xsoar-incident-assistant/actions/workflows/ci.yml/badge.svg)](https://github.com/tim025-star/xsoar-incident-assistant/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

XSOAR Incident Assistant is a local Windows utility for preparing incident-response drafts from Cortex XSOAR. It reads the active incident, searches for recent incidents with the same rule name and case type, reviews up to the configured number of historical incidents, and opens a draft in a new Notepad++ tab.

The assistant does not update the incident in XSOAR. Review each generated draft before using it.

## Requirements

- Windows 11
- Node.js 20 or newer
- AutoHotkey v2
- Google Chrome or Microsoft Edge
- Notepad++
- Access to a Cortex XSOAR tenant

The installer can use `winget` to install missing per-user prerequisites without administrator access.

## Install

### Installer

1. Clone or download this repository to a user-writable folder.
2. Run `install-xsoar-incident-assistant.bat`.
3. Open the generated `config.json` and replace `https://xsoar.example.com` with the exact HTTPS origin of your XSOAR tenant.
4. Add your name and role under `template`, or leave `analystName` blank to omit both from the sign-off.
5. Run `start-chrome-debug.bat` once to start the dedicated browser profile and assistant. The installer also adds a per-user Startup shortcut for later Windows sign-ins.

The installer installs the locked Node.js dependencies, creates `config.json` from the public example, configures the detected Notepad++ path, and adds the Startup shortcut. It does not require repository or XSOAR secrets.

### Manual setup

1. Clone the repository to a user-writable folder.
2. Copy `config.example.json` to `config.json`.
3. Configure your trusted XSOAR origin and template identity as described below.
4. Run `npm ci`.
5. Run `start-chrome-debug.bat`.

## Configure

Keep local settings in `config.json`. Git ignores this file so tenant addresses, local executable paths, and analyst details do not enter the repository.

At minimum, replace the example origin and review the sign-off:

```json
{
  "allowedXsoarOrigins": [
    "https://your-xsoar-tenant.example"
  ],
  "template": {
    "greeting": "Hello",
    "recommendationsHeading": "Recommended Actions",
    "contactText": "If you require more information or would like to discuss this incident, contact your security operations team and quote the incident ID.",
    "signOff": "Kind regards,",
    "analystName": "Your Name",
    "analystTitle": "Your Role"
  }
}
```

Each `allowedXsoarOrigins` entry must contain an exact HTTPS origin without a path, query string, or fragment. Leave `analystName` empty to omit the analyst name and title. You can also change the greeting, headings, contact text, and sign-off.

XSOAR layouts and labels can differ between tenants. The main compatibility settings are:

- `incidentUrlPattern`: path pattern for incident views. The assistant validates the origin separately.
- `incidentsPath`: same-origin Incidents page or path.
- `incidentInfoTabLabel` and `investigationTabLabel`: labels for the incident views used during extraction.
- `fieldLabels`: labels for the incident fields. The checked-in values provide generic examples.
- `timeRangeLabel`: label for the historical-search time range.
- `historicalSummaryLabels` and `historicalRecommendationLabels`: tenant-specific labels to use when the semantic defaults do not match.
- `maxHistoricalIncidents`: maximum number of recent matching incidents to review. The default is five.
- `headless`: runs extraction in a temporary headless Playwright context using the signed-in browser's storage state.
- `debugMode`: shows generic progress information without writing debug logs.

See [`config.example.json`](config.example.json) for all settings and defaults.

## Use

1. Start `start-chrome-debug.bat` if the assistant is not running.
2. Sign in to XSOAR through the dedicated browser profile.
3. Open the incident and select its browser tab.
4. Press the physical **Numpad+** key.
5. Review the draft that opens in a new Notepad++ tab.

Chrome is the default browser. To use Edge for a manual launch from PowerShell:

```powershell
$env:XSOAR_ASSISTANT_BROWSER = "edge"
.\start-chrome-debug.bat
```

Set `XSOAR_ASSISTANT_BROWSER` as a Windows user environment variable if the Startup shortcut should use Edge at sign-in.

## Troubleshooting

- **Port 9222 is already in use:** close the existing remote-debugging browser and run the launcher again.
- **The incident tab is not found:** confirm that its HTTPS origin appears in `allowedXsoarOrigins` and that its path matches `incidentUrlPattern`.
- **Fields are missing:** update the tab and field labels in `config.json` to match the tenant's XSOAR layout.
- **Notepad++ is not found:** set `notepadPlusPlusPath` to the full executable path. Environment variables such as `%LOCALAPPDATA%` are supported.
- **The hidden Startup launch fails:** run `start-chrome-debug.bat` by hand to see the detailed error.

## Security and data handling

- Use a dedicated browser profile and close it when you finish. Chromium DevTools listens on `127.0.0.1`, but other processes running as the same Windows user can access that endpoint because CDP has no application-level authentication.
- Add only trusted HTTPS tenant origins to `allowedXsoarOrigins`. The assistant keeps incident, search, and historical navigation on the selected origin.
- The assistant sends generated text to the verified Notepad++ editor control through an in-memory protocol. It does not use the Windows clipboard or create incident, template, progress, or error-log files.
- Chrome profile data and Notepad++ recovery or plugin features can persist content. Configure those applications to meet your data-handling requirements.
- Error dialogs can contain local paths or incident identifiers needed to diagnose a failed run.
- Do not commit browser profiles, screenshots, captured production HTML, incident exports, or production-derived test fixtures.

Read [SECURITY.md](SECURITY.md) before reporting a vulnerability or contributing security-sensitive changes.

## Development

GitHub Actions runs these commands on Windows with Node.js 20:

```powershell
npm ci
npm run check
npm test
```

Run the dependency audit before a release or dependency update:

```powershell
npm audit --audit-level=high
```

Tests and optional DOM fixtures must use fictional organizations, reserved domains such as `example.test`, and documentation address ranges such as `192.0.2.0/24`.

## License

This project uses the [MIT License](LICENSE).
