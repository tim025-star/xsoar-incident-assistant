# XSOAR Incident Assistant

XSOAR Incident Assistant is a local Windows data-processing tool for SOC analysts. It collects the selected Cortex XSOAR alert, searches three months of same-client and same-alert-type history for past resolutions, and formats the evidence for analyst review. It does not decide what happened, recommend actions, update XSOAR, or submit forms.

This is an independent community project. It is not affiliated with or endorsed by Palo Alto Networks.

## Chrome connection

The tool connects to the signed-in Google Chrome session the analyst already uses. The local console, XSOAR incident, and temporary evidence tabs stay in that session. It does not launch, copy, or close a separate browser profile.

Chrome 144 or newer is required. Select **Connect Chrome** first. If Chrome has not exposed an approved debugging session, the home page shows **Chrome access needs attention**; only then select **Open Chrome access setup**, enable remote debugging, and approve Chrome's prompt. Chrome writes a local, process-specific WebSocket endpoint into its normal user-data directory. The tool validates that browser-scoped endpoint, connects only through `127.0.0.1`, and disconnects without closing Chrome.

Chrome's approval is session-scoped, so repeat the setup after Chrome restarts. A fixed debugging port is deliberately not used: current Chrome versions do not permit that approach for the default data directory, and it would weaken the user-controlled approval boundary.

No application can guarantee a particular XSOAR session lifetime or bypass an organisation's authentication policy.

## Install on Windows

Download `XSOAR-Incident-Assistant-Setup-<version>-x64.exe` from the project's GitHub Releases page and run it. The installer is per-user and includes its own Node.js runtime and locked production dependencies; administrator access and a system Node.js installation are not required.

Each release includes a matching `.sha256` file. The installer is currently unsigned, so Windows may show an unknown-publisher warning. Compare the checksum before running it.

1. Run the installer and leave **Create a desktop shortcut** and **Launch XSOAR Incident Assistant** selected. **Install local Ollama and qwen3.5:9b from GitHub** and **Install Laya-mapper** are optional and start unchecked.
2. Open **Configuration**, enter the exact HTTPS origin of your XSOAR tenant, review the field mappings, and save.
3. Return to **Home** and select **Connect Chrome**. If Chrome access needs attention, use the setup action shown there, approve Chrome's prompt, then connect again.

The installer also adds a Start-menu shortcut. It does not add a browser extension, alter browser policy, start automatically at Windows sign-in, or overwrite configuration during an upgrade.

Requirements: Windows 11 x64 and Google Chrome 144 or newer.

### Optional local AI

The tool always builds the same deterministic source-field response. When Local AI is enabled and processing succeeds, Ollama transforms the selected ticket's complete bounded alert JSON and mapped source fields into a concise event summary and non-repeating observed facts inside that response; it does not replace the fixed alert fields. Credential-bearing JSON keys are removed recursively before local processing. If complete alert JSON is unavailable or exceeds the safe local-processing limit, AI enrichment fails closed and the deterministic response remains available. Its schema and prompt exclude conclusions, classifications, guidance, and recommended actions. Historic tickets are processed separately and never sent to the model. The default `qwen3.5:9b` model is suitable for a CPU-only workstation with 32 GB RAM.

The optional installer task downloads the official Ollama `0.34.0` Windows installer and the default `qwen3.5:9b` Q4_K_M model from pinned GitHub Release assets. A fresh installation downloads about 8.2 GB; the model itself is about 6.6 GB. Allow at least 16 GB of free disk space while the model is assembled and imported. The task is unchecked and failure does not affect the core installation. It launches `OllamaSetup.exe` directly and uses the application's bundled Node.js runtime for the model import, so the end-user path does not invoke PowerShell or WinGet.

Every runner and model asset has a fixed byte length and SHA-256 digest in `src/local-ai-installer.js`. Downloads follow redirects only from `github.com` to approved GitHub asset hosts, resume an interrupted part when the server honours byte ranges, and are rejected before import if any part or the reassembled GGUF checksum differs. After a successful `ollama create`, the temporary GGUF is removed. Failures are recorded at `%LOCALAPPDATA%\XSOAR Incident Assistant\logs\local-ai-install.log` without signed asset URLs.

Select **Install default model** to use the verified GitHub path. If the default model is already present, the tool verifies it locally and does not contact the registry. Analysts can enter another valid local Ollama model and select **Pull selected model**; that path requires access to the Ollama registry. Both paths install the pinned Ollama runner from GitHub when needed.

Cloud and remote model aliases are blocked. Before Ollama receives incident evidence, the selected model must appear on the loopback service at `127.0.0.1:11434` and pass a fresh local-model check. The tool has no cloud AI endpoint or configurable AI URL. Generated output streams in the processed-data field. Invalid or unavailable AI output falls back to the deterministic source-field response.

### Reviewed Laya demo checkpoint

Laya is diagnostics-only in this phase. Normal incident processing uses the existing deterministic mapper; Qwen enrichment is unchanged. Training code, datasets, and checkpoint-management controls are not part of the core application or installer. Upgrading does not delete existing datasets, multilingual downloads, or custom checkpoints already stored on disk.

On **Configuration → Test Laya-mapper without XSOAR**, paste approved or fictional JSON, choose targets and automatic/manual CPU workers, and run the mapper. No tenant is needed. The panel shows every requested target, exact pointers, selected/tentative/no-supported-match/incomplete statuses, coverage, model scores, and expandable provenance. Pasted input and results are not saved automatically. Cancellation terminates active workers.

The demo checkpoint `expanded-training-cuda-632-alerts-v1` is a head-only fine-tune of the root English `convaiinnovations/laya` checkpoint at revision `1c5edc17a7acd8701df6fc341c0d179f1c62c982`, using Laya SDK `0.3.5`. It completed its fixed three-epoch schedule and exact 5,338-sequence save/reload verification. Its 81.15% teacher-forced sequence score is shown for provenance and is **not production mapping accuracy**. The checkpoint remains `promotionEligible: false`; every result requires analyst review.

Every supported scalar/target pair is either explicitly rejected for a structural reason or assessed independently. Stage-one scores order the bucket; they never exclude candidates. Every eligible field reaches forward and reverse final comparisons, including overflow buckets. Disagreements produce a labelled tentative best guess; two none results produce no supported match. Full pointers and original values stay outside prompts and are resolved by ID. Long strings use overlapping token windows; omitted context is counted.

The bounded input limits are 96 KiB, depth 30, and 10,000 visited nodes. CPU microbatches contain at most 16 sequences and 4,096 padded tokens. Automatic mode uses one resident model process because it was fastest in the measured one/two/four-worker benchmark. Manual mode supports 1–4 workers for other hardware, subject to pending work and a memory safety check. Workers reserve two logical processors for the application/OS and share the remaining thread budget.

Installation uses verified GitHub release assets (fixed size and SHA-256), an inference-only schema-v4 manifest, an app-local `runtime-v2`, and `models/base-english`. The manifest separately identifies the upstream architecture and trained checkpoint. The installer starts the installed runtime, performs a protocol-2 inference smoke check, and records the verified checkpoint identity before reporting success. An upgraded application refuses to label old base weights as the tuned checkpoint. No Python installation or trainer download is required for end users. Offline asset packs are supported. Old protocol-1 executables cannot run the mapper.

Selecting **Install Laya-mapper** downloads about 1.0 GiB and uses about 1.3 GiB after installation. The measured single-worker process peaks near 2.8 GiB RAM; automatic mode keeps one model resident and uses the available CPU thread budget while reserving two logical processors for Windows and the application.

See [the v0.4.0 demo checkpoint report](docs/laya-demo-v0.4.0.md) and [the baseline implementation](docs/laya-baseline.md) for evaluation scope, evidence and limitations.

The diagnostics mapper uses exact typed-value grouping with source aliases. It reports value agreement separately from pointer agreement and retains every alias for review. The UI shows the active checkpoint hash, current inference stage, stage progress, elapsed time, worker allocation, coverage, result status, and full provenance. No vendor-specific semantic answer rules select mappings.

## Use

1. Open the application from its desktop or Start-menu shortcut.
2. Select **Connect Chrome**. If the app detects that Chrome access needs attention, use the setup action it displays, approve remote debugging, then connect again.
3. Keep the intended XSOAR incident open in Chrome. Expand **Target a specific incident** only when you need to enter an Incident ID.
4. Select **Process data** in the local console.
5. When processing is complete, the app returns to the local console automatically. Review the alert fields in **Processed incident data** and use the key details for your own investigation.
6. Select **Copy processed data** when you need the alert details on the clipboard.

When Incident ID is blank, the tool uses the only open incident tab. If several are open, enter the intended ID to avoid triaging the wrong case. An entered ID opens through the configured incident URL template. While Local AI processes the current alert, the tool searches the previous three months for matching incidents. It closes temporary views, search tabs, and historic incident tabs after evidence collection.

If launch reports a startup error, reinstall the current release. The launcher displays an error instead of failing silently.

## Configure and verify your tenant

The separate **Configuration** page includes the tenant URL, analyst identity, incident routes, historic result limit, page timeout, local AI, output wording, and JSON log mappings. Each mapping accepts JSON keys or dotted paths such as `source.ip` or `events.actor.user_name`; array indexes are ignored. Existing XSOAR field labels and two-column log tables remain supported as fallbacks. No analyst name is hard-coded.

XSOAR routes vary by deployment. Before operational use, confirm the configured incident route, URL template, incident list path, and search parameter against synthetic incidents. Historic searches submit exact `rawName` and `rawType` values plus a fixed three-month creation window through XSOAR's main incidents search input. Each candidate is then checked against the selected ticket's customer, rule, and type before its resolution is included. Automation stops or omits the candidate if navigation leaves the configured HTTPS origin or an incident path does not match.

## Credentials and data

The application never asks for or stores a password or API token, and it does not export Playwright `storageState` or copy Chrome profile files. Authentication remains in the normal Chrome profile. While connected, Playwright can inspect and control tabs exposed by Chrome's approved debugging session, so connect only this trusted local application and disconnect when finished.

Configuration is stored under `%LOCALAPPDATA%\XSOAR Incident Assistant`. It may include a tenant hostname, analyst identity, Local AI setting, selected model/checkpoint names, output wording, and field-label mappings, but it must not contain credentials or incident content. Processed data stays in memory and reaches the clipboard only after the analyst selects **Copy processed data**. Only bounded evidence from the selected incident goes to loopback Ollama or the local Laya process. Matching historic resolutions are appended locally after processing.

An organisation must review and approve the tool against its own browser, identity, information-handling, and software policies. See [SECURITY.md](SECURITY.md).

## Architecture

- `src/domain.js`: validation, URL construction, data merging, and draft generation.
- `src/workflow.js`: parallel selected-alert processing and bounded historic-resolution orchestration.
- `src/page-adapter.js`: bounded JSON log parsing plus fallback XSOAR DOM extraction.
- `docs/xsoar-dom-sources.md`: supported XSOAR elements, detailed-event tables, and extraction boundaries.
- `src/browser-session.js`: user-approved current-Chrome connection and the browser adapter.
- `src/local-ai.js`: loopback-only Ollama client, bounded evidence construction, and strict enrichment validation.
- `src/local-ai-installer.js`: pinned GitHub downloads, checksums, resumable model assembly, and local Ollama import.
- `src/laya-mapper.js`, `src/laya-targets.js`: stable field records, shared target meanings, exhaustive scoring, complete bucket comparisons, and exact-pointer resolution.
- `src/laya-worker.js`, `laya-mapper/runner.py`: protocol-2 workers, cancellation, token-safe independent batching, and pinned English CPU inference.
- `src/laya-mapper-installer.js`: verified on-demand installation of the inference-only runtime and pinned English checkpoint.
- `trainer/`: optional reviewed-data, compilation, training, evaluation, and promotion tooling with its own Windows installer. The trainer may import the production mapper contract; the core never imports trainer code.
- `src/rpc.js`: typed oRPC operations and local application state.
- `src/server.js`: Hono loopback server, request security checks, and static delivery.
- `web/`: Solid and Tailwind configuration/status interface, built by Vite into ignored `dist/` output.

New extraction rules belong in the page adapter, draft formats in the domain module, and browser behaviour behind the browser adapter. The end-user application and optional trainer are separate packages with separate installation identities.

## Development

```powershell
npm ci
npm run build
npm run check
npm test
npm run verify:browser
npm audit --audit-level=high

# Optional trainer module
npm run check:trainer
npm run test:trainer
```

### Creating a Windows release

The end-user installer is built only from a version tag. It stages the built application, production dependencies, a pinned portable Node.js runtime, and the reviewed Laya asset manifest, then packages them with Inno Setup. Ollama and default-model versions, URLs, sizes, and hashes are pinned in `src/local-ai-installer.js`; the Laya CPU inference archive and English checkpoint files are pinned by size and SHA-256 in the staged release manifest.

1. Build and smoke-test the application-local CPU inference archive and reviewed checkpoint. Review the generated inference-only schema-v4 manifest, checkpoint identity, hashes, and dependency inventories, then set repository variables `LAYA_MAPPER_MANIFEST_URL` and `LAYA_MAPPER_MANIFEST_SHA256`. For a local package, set `LAYA_MAPPER_MANIFEST_PATH` to that reviewed file. To prepare a disconnected deployment, download every manifest asset into the same directory as the resulting Setup executable; no network access is then required by the Laya installation task.
2. Update `package.json` with the release version and push a matching `v<version>` tag.
3. The **Windows release** workflow verifies the project and runtime checksum, builds the unsigned installer, writes its SHA-256 sidecar, and publishes both files to the GitHub Release.

### Creating the optional trainer installer

The manual **Laya developer-only training runtimes** workflow builds and tests the trainer independently. It emits a CPU or CUDA runtime archive plus a separate `XSOAR-Laya-Trainer-Setup-<version>-<backend>-x64.exe`. The trainer uses its own AppId and installs under `%LOCALAPPDATA%\Programs\XSOAR Laya Trainer`; it is never bundled into, installed by, or required by the XSOAR Incident Assistant. See [trainer/README.md](trainer/README.md).

Tests and examples must use fictional data and reserved domains such as `example.test`. Never commit browser profiles, production HTML, screenshots, incident exports, tenant names, credentials, or session data.

## License

This project uses the [MIT License](LICENSE).
