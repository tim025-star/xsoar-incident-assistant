# XSOAR Incident Assistant

A local Windows utility that reads a focused Cortex XSOAR incident, finds recent incidents with the same rule and type, and opens a response draft in Notepad++.

This repository is being prepared for public release. Keep it private until its Git history has been sanitised and a licence has been selected.

## Requirements

- Windows 11
- Node.js 20 or newer
- AutoHotkey v2
- Google Chrome or Microsoft Edge
- Notepad++
- Access to a Cortex XSOAR tenant

## Setup

1. Clone the repository to a user-writable folder.
2. Copy `config.example.json` to `config.json`.
3. Replace `https://xsoar.example.com` in `allowedXsoarOrigins` with the exact HTTPS origin of each trusted XSOAR tenant. Do not include a path.
4. Set `template.analystName` and `template.analystTitle` in `config.json` if you want a signature. Leave `analystName` blank to omit it.
5. Run `npm ci`.
6. Run `start-chrome-debug.bat`, sign in to XSOAR in the dedicated browser profile, and focus the incident you want to process.
7. Press the physical Numpad+ key to create a draft.

The non-admin installer, `install-xsoar-incident-assistant.bat`, can install missing per-user prerequisites with `winget`, install the locked Node.js dependencies, create `config.json`, and add a per-user Startup shortcut. It never requires repository secrets.

Set `XSOAR_ASSISTANT_BROWSER=edge` before starting the launcher to prefer Edge. Chrome is preferred when the variable is unset.

## Security model

- `config.json` is local and ignored by Git. Never commit tenant origins, local executable paths, or production-derived fixtures.
- The launcher uses a dedicated browser profile and binds Chromium DevTools to `127.0.0.1`. CDP has no application-level authentication, so close the dedicated browser when it is not needed and do not use this profile for unrelated browsing.
- The helper accepts incident pages only from the exact HTTPS origins listed in `allowedXsoarOrigins`. Search, companion-view, and historical navigation must remain on the selected origin.
- Generated incident text travels through an in-memory stdout protocol and is written directly to the verified Notepad++ editor control. It is not copied through the Windows clipboard.
- The application does not create incident, template, progress, or error-log files. Chrome profile data and Notepad++ recovery or plugin behaviour are controlled by those applications and may persist data.
- Debug progress records are allowlisted and generic. Error dialogs can still contain local paths or incident identifiers needed to diagnose a failed run.

The loopback CDP endpoint is accessible to other processes on the same machine. Run the assistant only on a trusted workstation with normal endpoint protection and user isolation. A future architecture should replace the persistent TCP endpoint with a private, process-bound browser-control channel.

See [SECURITY.md](SECURITY.md) for vulnerability reporting and disclosure guidance.

## Configuration

The supplied example uses conservative timeouts, reviews at most five recent historical incidents, and keeps debug mode off. Common settings include:

- `allowedXsoarOrigins`: required exact HTTPS origins for trusted XSOAR tenants.
- `incidentUrlPattern`: path pattern for incident views; origin validation is separate and mandatory.
- `incidentsPath`: same-origin Incidents page or path.
- `incidentInfoTabLabel` and `investigationTabLabel`: local labels for the two incident views used during extraction.
- `fieldLabels`: local incident-layout labels. The checked-in values are generic examples.
- `headless`: copies the signed-in browser storage state to a temporary Playwright context for the current run.
- `historicalSummaryLabels` and `historicalRecommendationLabels`: exact local-layout labels when the generic semantic match is insufficient.
- `template`: neutral greeting, headings, contact text, and optional analyst signature. Your name belongs in the ignored local `config.json`, never in tracked source.

## Development

Run the checks used by CI:

```powershell
npm ci
npm run check
npm test
npm audit --audit-level=high
```

Optional DOM fixtures must be fully synthetic. Use reserved domains such as `example.test` and documentation address ranges such as `192.0.2.0/24`; never use copied production HTML.

## Licence

Licensed under the [MIT License](LICENSE).
