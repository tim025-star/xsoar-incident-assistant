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

### Optional Laya-mapper

Laya-mapper is a separate, fully local semantic field mapper for alert sources whose JSON keys vary between products or customers. It mechanically sends every scalar JSON leaf through a two-round Laya comparison: first selecting relevant chunks for each canonical field, then selecting an exact JSON pointer from every relevant chunk. Code does not use aliases, key names, value shapes, or deterministic semantics to shortlist model candidates. The chosen pointer is resolved against the original document; an invalid choice falls back to the existing configured mapping and produces a visible warning.

The bundled base is Laya `0.3.5` with the `laya-multilingual` checkpoint and its 1,024-token context. The base checkpoint works without fine-tuning but is general-purpose, so analysts must review its output. With both local processors enabled, Laya maps the canonical fields first and Qwen receives those fields plus its existing bounded raw evidence. With only Laya enabled, ordinary code renders the fixed template. With neither enabled, existing deterministic extraction is unchanged.

Laya inference receives the complete bounded alert JSON unchanged. It runs as an on-demand child process with Hugging Face and Transformers forced offline, loads only approved local checkpoint directories, and does not log requests, model inputs, selected values, or training examples. No cloud endpoint is used at runtime. If alert JSON is incomplete, all available documents are still mapped and the draft reports incomplete coverage and any deterministic fallback.

An XSOAR tenant is not required to evaluate the mapper. On **Configuration**, expand **Test Laya-mapper without XSOAR**, paste fictional or otherwise approved alert JSON, select the canonical targets, and run the local test. It uses the active production checkpoint and the same complete-coverage mapping path as incident processing, then displays selected values, exact JSON pointers, rankings, provenance, and warnings. While it runs, the page shows elapsed time and live checkpoint, chunking, round-one, round-two, and final-comparison stages without displaying or logging alert values; the run can be cancelled. Start with one target to make accuracy and runtime easy to assess, then add fields deliberately. Diagnostic input and output remain in memory and are not added to the training dataset.

Clients do not install Python, pip, PyTorch, PowerShell modules, WinGet packages, services, drivers, or PATH entries for Laya. The optional installer verifies fixed sizes and SHA-256 hashes, then expands an application-local self-contained runtime with Windows 11's built-in `tar.exe`. Internet-connected installs download only pinned GitHub Release assets. For restricted or disconnected endpoints, IT can place the reviewed manifest assets beside Setup; the same hashes are verified, and trainer archives found there are retained in the application-data `offline-assets` directory until training is requested.

Fine-tuning data is saved only when an analyst explicitly adds an example. It is stored separately beneath `%LOCALAPPDATA%\XSOAR Incident Assistant\laya-mapper`, not in `config.json`. Each example retains the complete bounded alert JSON and mapped, absent, or unlabelled states. Unique values resolve to their exact pointer automatically; repeated values require the analyst to confirm a pointer. Dataset import/export uses JSON Lines.

Training requires at least 50 whole labelled alerts and uses an alert-level 80/20 train/evaluation split. The training tools are a larger, separate verified archive expanded only when requested. Automatic selection uses the CUDA build when `nvidia-smi` confirms an NVIDIA GPU and otherwise uses CPU; an administrator or analyst can override that choice. CPU training is supported but may be extremely slow. Rolling checkpoints and cancellation are supported. A completed checkpoint reports held-out exact-pointer accuracy, per-field coverage, invalid-selection rate, and fallback rate, and remains inactive until an analyst explicitly selects it. Only compatible JSON and `safetensors` checkpoint bundles are accepted; executable and pickle model content is rejected.

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

Configuration is stored under `%LOCALAPPDATA%\XSOAR Incident Assistant`. It may include a tenant hostname, analyst identity, Local AI setting, selected model/checkpoint names, output wording, and field-label mappings, but it must not contain credentials or incident content. Explicitly saved Laya training examples and checkpoints use the separate `laya-mapper` directory described above. Processed data stays in memory and reaches the clipboard only after the analyst selects **Copy processed data**. Only bounded evidence from the selected incident goes to loopback Ollama or the local Laya process. Matching historic resolutions are appended locally after processing.

An organisation must review and approve the tool against its own browser, identity, information-handling, and software policies. See [SECURITY.md](SECURITY.md).

## Architecture

- `src/domain.js`: validation, URL construction, data merging, and draft generation.
- `src/workflow.js`: parallel selected-alert processing and bounded historic-resolution orchestration.
- `src/page-adapter.js`: bounded JSON log parsing plus fallback XSOAR DOM extraction.
- `docs/xsoar-dom-sources.md`: supported XSOAR elements, detailed-event tables, and extraction boundaries.
- `src/browser-session.js`: user-approved current-Chrome connection and the browser adapter.
- `src/local-ai.js`: loopback-only Ollama client, bounded evidence construction, and strict enrichment validation.
- `src/local-ai-installer.js`: pinned GitHub downloads, checksums, resumable model assembly, and local Ollama import.
- `src/laya-mapper.js`: lossless flattening, model-only candidate routing, two-round comparison, exact-pointer validation, and sidecar lifecycle.
- `src/laya-dataset.js`, `src/laya-training.js`: explicit local training examples, safe checkpoint management, and offline fine-tuning orchestration.
- `src/laya-mapper-installer.js`: verified on-demand inference/checkpoint and training-runtime installation.
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

The end-user installer is built only from a version tag. It stages the built application, production dependencies, a pinned portable Node.js runtime, and the reviewed Laya asset manifest, then packages them with Inno Setup. Ollama and default-model versions, URLs, sizes, and hashes are pinned in `src/local-ai-installer.js`; the Laya CPU inference archive, separate CPU and CUDA training archives, and checkpoint files are pinned by size and SHA-256 in the staged release manifest.

1. Run the manual **Laya-mapper Windows assets** workflow to build and smoke-test the application-local CPU inference archive, CPU and CUDA trainer archives, and the pinned `laya-multilingual` checkpoint. Review the generated schema-v2 manifest and dependency inventories, then set repository variables `LAYA_MAPPER_MANIFEST_URL` and `LAYA_MAPPER_MANIFEST_SHA256`. For a local package, set `LAYA_MAPPER_MANIFEST_PATH` to that reviewed file. To prepare a disconnected deployment, download every manifest asset into the same directory as the resulting Setup executable; no network access is then required by the Laya installation task.
2. Update `package.json` with the release version and push a matching `v<version>` tag.
3. The **Windows release** workflow verifies the project and runtime checksum, builds the unsigned installer, writes its SHA-256 sidecar, and publishes both files to the GitHub Release.

Tests and examples must use fictional data and reserved domains such as `example.test`. Never commit browser profiles, production HTML, screenshots, incident exports, tenant names, credentials, or session data.

## License

This project uses the [MIT License](LICENSE).
