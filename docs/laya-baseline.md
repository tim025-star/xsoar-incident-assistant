# English Laya field-mapping baseline

## Scope and contract

This implementation runs in the local diagnostics panel. It does not activate Laya in incident workflows. The application retains deterministic incident mapping, stored datasets and previous checkpoints. Training remains deferred.

The checkpoint is `convaiinnovations/laya` at revision `1c5edc17a7acd8701df6fc341c0d179f1c62c982`, root English model, local ID `base-english`. The runtime uses CPU inference and Laya SDK 0.3.5. It retains the 512-token sequence limit and 192-token question/options limit from the checkpoint. The pinned SDK wheel SHA-256 is `4c57f64cbaf893bb5c7b4affddc2bf21a819f55df51941689f11868583be2903`.

The SDK applies its own temperature clamp. In particular, it changes the shipped `choice:11+` temperature from `0.10058280825614929` to `0.5` in memory. The adapter records the applied temperatures; it does not change the configuration file, fit temperatures or modify weights. Treat scores as uncalibrated for this task. See the [upstream inference implementation](https://github.com/NandhaKishorM/laya/blob/v0.3.5/laya/agent.py) and [sequence builder](https://github.com/NandhaKishorM/laya/blob/v0.3.5/laya/common.py).

## Module ownership

| Module | Responsibility |
|---|---|
| `src/laya-targets.js` | Shared meanings, exclusions, value types and checkpoint identity |
| `src/laya-mapper.js` | Validation, canonical pointer ordering, stable IDs, complete buckets, two sweeps and adjudication |
| `src/laya-worker.js` | Protocol handshake, resident worker pool, dispatch deadlines, retry and cancellation |
| `laya-mapper/runner.py` | Prompt rendering, token proof, overlapping windows, independent sequences, SDK-equivalent scores |
| `src/laya-mapper-installer.js` | Verified inference-only assets and separate installation directories |

Callers use `mapIncident`, `status` and `close`. Both the evaluator and diagnostics use this interface. The Python adapter supports protocol-2 `status` and `evaluate`; it rejects the previous protocol. The handshake checks protocol, SDK and checkpoint identity.

Stage one returns the `noul` true probability, never the SDK's confidence statistic. Every structurally eligible scalar remains in its target bucket, even with a low score. Each bucket receives complete forward and reverse sweeps. A comparison carries its winner into the next group; none clears that winner. The adapter reduces group size until all instructions, option markers and candidate evidence fit without SDK truncation.

Two matching real nominees yield `selected`. Two none nominees yield `no_supported_match`. Disagreement triggers two nominee comparisons and yields `tentative`; ties use stage-one scores and then canonical pointer order. Adjudication traces preserve any vote for none. Processing errors yield `incomplete`, not a negative classification. The result separates source completeness from model-processing completeness.

## Context and resource limits

Input limits: 96 KiB of JSON, depth 30 and 10,000 visited nodes. Object keys sort by canonical code-unit order; arrays retain indices and order. Original values and full pointers stay in Node. The model selects IDs, and Node resolves values from the source document.

The adapter splits long values into 64-token windows with 16-token overlap. It retains the highest field-target window score and records the contributing window. Context includes bounded same-object siblings, with paired `key`/`value` records prioritised. Stage-two cards use fixed content in both orders, including the paired role. Token accounting records shortened keys/ancestry/options and omitted siblings. Coverage therefore means every eligible focal field received an assessment, not that the model saw the whole source document at once.

Structural checks reject null/empty values, invalid IPs, non-HTTP(S) URLs, unsupported event times and non-text values for narrative/name targets. Identifier targets also accept numeric scalars so an account ID or numeric hostname can reach semantic assessment. The timestamp check supports ISO-style datetime strings and numeric epoch seconds/milliseconds in 2000–2099. Text checks do not apply vendor-specific hostname or username rules.

Workers start on demand and reuse loaded checkpoints. Automatic selection uses 1 worker, 2 at 8 logical processors plus 12 GiB available RAM, or 4 at 16 processors plus 24 GiB. Manual mode accepts 1–4, capped by pending independent batches. A multi-worker start requires at least 2.5 GiB per worker plus 1 GiB spare. Memory pressure can still cause a worker failure; the result must then expose incomplete coverage.

The pool reserves two logical processors and divides the rest between workers. Python groups sequences by length and limits a forward pass to 16 decisions and 4,096 padded tokens. Dispatch starts the 180-second timeout, not queue entry. An interrupted request gets one retry on a fresh worker. Cancellation kills active processes and rejects queued work.

## Reproduce

Build the runtime with `.github/workflows/laya-mapper-assets.yml`, or use its pinned builder commands in a local Python environment. Build inventories distinguish the local Python build from the workflow's Python 3.12 build. The release manifest contains only inference assets and model files, with sizes and SHA-256 hashes. It does not require trainer assets.

Point these environment variables at a reviewed local package and its checkpoint:

```powershell
$env:LAYA_MAPPER_EXECUTABLE = 'C:\path\to\runtime-v2\laya-mapper.exe'
$env:LAYA_MODEL_PATH = 'C:\path\to\models\base-english'
node scripts/smoke-laya-runtime.mjs $env:LAYA_MAPPER_EXECUTABLE
node scripts/evaluate-laya-mapper.mjs --split development --workers 1 --output artifacts/development.json
node scripts/evaluate-laya-mapper.mjs --split evaluation --workers 1 --output artifacts/evaluation.json
node scripts/evaluate-laya-mapper.mjs --case overflow --workers 4 --runs 2 --output artifacts/benchmark-4.json
```

The evaluator defaults to the same packaged executable as the UI. Its optional `--python` argument supports adapter development, not release acceptance. JSON reports include exact and accepted-alternative pointer results, wrong/missed mappings, false absent-target mappings, tentative accuracy, correct-field rank and final-assessment coverage, order disagreement, full traces, token limits, runtime metadata and timings. Windows runtime metadata reports per-process working-set peaks. Summing these peaks gives a conservative process-peak total, not a simultaneous whole-system peak measurement.

For UI verification without changing saved user configuration:

```powershell
npm run build
node scripts/serve-laya-diagnostics.mjs
```

Open the printed local URL in @Browser. Settings stay in memory in this development harness. Production settings retain their existing authenticated, exact-origin local RPC protections.

## Evaluation design

`test/fixtures/laya-baseline-cases.json` labels 13 synthetic engineering cases: eight development cases and five evaluation cases. The split predates prompt tuning. The additional overflow development case checks retention past candidate 24 and supplies the worker benchmark. Variants of a case stay in the same split. This sample supports debugging and comparisons, not claims about production accuracy.

Prompt versions: v1 used positional opaque labels; v2 put semantic descriptions beside the choice markers; v3 keeps semantic candidate labels and their identifying suffixes fixed when order changes. The evaluation subset remains untouched until v3 freezes. Prompt development used only the development cases and small source/destination probes. None of these steps trains the model.

## Measured results

The implementation passes the engineering checks, but the unchanged base model fails the Entra quality gate. Do not enable incident-workflow mapping on the strength of these results.

The final run used prompt `english-fields-v3`, the packaged executable, CPU inference, and the shared mapper. The local package uses Python 3.13.6, PyTorch 2.9.1+cpu, Transformers 4.57.6, NumPy 2.3.4 and PyInstaller 6.16.0. The [machine-readable summary](laya-baseline-results.json) includes target-level outcomes, preferred-field ranks and coverage. The full local trace is `artifacts/laya-baseline/final-evaluation.json` (SHA-256 `0f8d39774a571f55bda0b1cc91d4aba41cf120d9797dde6c2251d7ce1fc63d8c`).

| Metric | Development | Untouched evaluation | Combined |
|---|---:|---:|---:|
| Cases | 8 | 5 | 13 |
| Exact pointer / correct no-match | 12/28 | 12/19 | 24/47 (51.1%) |
| Including accepted alternatives | 12/28 | 12/19 | 24/47 |
| Wrong mappings | 16 | 7 | 23 |
| Missed present targets | 0 | 0 | 0 |
| False mappings for absent targets | 4/6 | 2/4 | 6/10 |
| Correct tentative results | 7/21 | 7/12 | 14/33 (42.4%) |
| Forward/reverse disagreement | 21/28 | 12/19 | 33/47 (70.2%) |
| Incomplete runs | 0 | 0 | 0 |

Tentative results cover 33 of 47 requested targets. For present targets alone, preferred-pointer accuracy is 20/37 (54.1%). All 509 eligible field-target pairs received stage-one scores and final-stage assessment. All 37 labelled preferred fields reached the final stage. The four correct no-match outcomes came from structural IP/time rejection; this corpus does not establish reliable semantic abstention for text targets.

Context remains bounded. Each trace records omitted siblings and shortened descriptions; stage-two cards retain fixed focal evidence and paired-record roles rather than the whole original object. The `omittedContext` aggregate counts stage-one sibling omissions; comparison-level token accounting records stage-two omissions. This evaluation found no processing failures or lost eligible candidates. It cannot distinguish every semantic error from the effects of omitted non-focal context.

### Entra quality gate: failed

All five outcomes are tentative, and all four expected real fields reached final comparison. The complete source contains 105 scalar leaves. The target buckets contain 2, 6, 99, 99 and 84 candidates respectively.

| Target | Model result | Expected result | Preferred field stage-one rank |
|---|---|---|---:|
| `sourceIp` | `/documents/0/records/properties/ipAddress` | `/documents/0/records/callerIpAddress` | 2 |
| `occurred` | `/documents/0/timestamp` | `/documents/0/records/time` or `/documents/0/records/properties/createdDateTime` | 6 |
| `clientHostname` | `/documents/0/records/properties/agent/agentSubjectType` | `/documents/0/records/properties/deviceDetail/displayName` | 4 |
| `clientUserName` | `/documents/0/records/properties/authenticationProcessingDetails/1/value` | `/documents/0/records/properties/userPrincipalName` | 12 |
| `customerName` | `/documents/0/records/properties/agent/agentType` | No supported match | n/a |

The source IP value is correct (`203.0.113.42`), but its pointer fails the preferred-pointer gate. The selected occurrence field contains collection time, so it does not qualify as an event-time alternative. The other tentative values are `notAgentic`, an OAuth-scope JSON string, and `notAgentic`. No fixture-specific rules correct these results.

### Worker benchmark

Host: AMD Ryzen 7 5800X3D, 16 logical processors, 31.93 GiB physical RAM. All runs use the same 64-field overflow fixture, checkpoint, prompt and maximum 14-thread budget. One cold and one warm run per setting provide a small engineering comparison, not a performance distribution. The main benchmark ran separately from other model inference; later UI/evaluation activity shared CPU capacity, so its elapsed times do not belong in this comparison.

| Workers | Threads per worker | Cold | Warm | Sum of process working-set peaks |
|---:|---:|---:|---:|---:|
| 1 | 14 | 64.485 s | 44.631 s | 2.75 GiB |
| 2 | 7 | 68.911 s | 57.273 s | 5.50 GiB |
| 4 | 3 | 96.274 s | 82.207 s | 10.99 GiB |

Every setting assessed all 64 candidates in both directions and returned `/documents/0/z_clientHostname` as tentative. Worker-count changes did not change the answer. Extra workers slowed this fixture on this host, especially its sequential final sweep. The initial auto policy remains unchanged; use manual one-worker mode for this measured workload. A broader benchmark should precede a platform-wide policy change.

### Verification and package

- `npm run check`: passed.
- `npm test`: 99 tests passed, including the existing deterministic workflow and origin/token checks.
- Python adapter checks: four real-checkpoint tests passed. They cover SDK probability parity within 0.0002, independent states, instruction/option token proof, overlapping windows, maximum-window aggregation and stable reversed candidate content.
- `npm run verify:browser`: passed. These UI tests use model doubles and do not establish accuracy.
- Packaged runtime smoke: passed with protocol 2 and the pinned English checkpoint.
- Offline installation: verified archive/model hashes, extracted into a separate test directory, then completed real packaged inference with network download disabled. No trainer asset was required.
- @Browser: verified Entra, an explicit no-supported-match case, the 64-field overflow case, tentative warnings/alternatives, expandable provenance, and cancellation. Entra returned the same five tentative pointers as the evaluator, with all 290 eligible field-target pairs scored and final-assessed. Its displayed provenance reports complete processing and prompt `english-fields-v3`. The overflow UI result also matches the evaluator and all worker benchmarks.

The local inference package and dependency inventory are in `artifacts/laya-baseline/assets`. Its schema-v3 manifest pins a 174,103,409-byte runtime archive with SHA-256 `90e2b002a21b0a2c0d31e060ad1eae2df4498a63db64ff093e09185c7b39b481`. The 842,609,210-byte model weights retain the upstream SHA-256 `891102d372688fc2a094dac56a384bc537b87c63f21f9f3dac0be2b7cbc8d86c`.

These are local candidate assets. No commit, push, GitHub release or application deployment occurred. The manifest's intended release URLs require publication before online installation; the verified offline package works now. Existing trainer edits and downloaded assets remain intact. Prompt questions retain their tested wording during prose review so documentation edits do not change the evaluated contract.
