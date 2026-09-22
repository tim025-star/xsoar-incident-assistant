# Exact typed-value grouping decision

## Changes under test

The experiments use the same English checkpoint, weights, SDK and native token limits as the [v3 baseline](laya-baseline.md). They introduce no vendor-specific paths, semantic field allowlists or trained calibration. Target definitions describe the requested output; Laya selects the field.

Five cumulative presets were measured before choosing the production diagnostic behavior:

| Preset | Change from the preceding preset |
|---|---|
| `baseline` | Retain v3 field prompts and comparison behaviour |
| `grouped` | Group equal original types and values; assess aliases before comparing distinct values |
| `context` | Add readable object/field names and bounded same-object context to final comparisons |
| `pairwise` | Compare at most two candidates plus none, in forward and reverse sweeps |
| `verified` | Ask separate value and role support questions about the best guess |

Node owns grouping, comparisons and source-pointer resolution. Python owns the rendered context, token proof and inference. Both the diagnostics panel and evaluator call the same mapper interface. An installed runtime without the new capability fails with an update message.

The diagnostics interface now uses `grouped` only. The frozen `baseline` mode remains available to the offline evaluator for reproducible comparisons. The `context`, `pairwise` and `verified` presets were removed from the runtime interface after they failed to improve the fixed corpus. Their results remain below as the decision evidence.

## Duplicate values and coverage

Groups use exact JSON scalar type and value. The mapper does not trim, case-fold or coerce values for grouping. A numeric identifier and its string representation remain distinct. Arrays keep their indices.

For a repeated value, Laya compares its source fields in both orders and adjudicates disagreements. The group carries the selected source record into the distinct-value comparison. If both alias passes select none, the mapper retains the group using a flagged, unendorsed fallback record; it does not remove that value. The fallback follows the existing model-score and canonical-pointer tie-break, not a semantic mapping rule.

Every eligible field receives final-stage assessment, either in alias comparisons or as a singleton value candidate. Full provenance retains all member pointers, scores, windows and comparison records. This hierarchical comparison does not show all aliases in every cross-value input, and an incorrect alias representative can still affect value selection. Coverage proves assessment, not correctness.

The result separates value agreement from pointer agreement. Equal forward/reverse values can have disputed source pointers. Pointer disagreement remains tentative, and the evaluator retains the original preferred-pointer and accepted-alternative labels.

## Context and support

The context preset separates camel-case and underscore words without assigning their meaning. It includes the owning path and up to two same-object scalar fields, with explicit shortening and omission counts. Paired key/value records retain a dedicated role label. Candidate content stays fixed under reversal. The adapter verifies the actual SDK encoding against the native 512/192 token budgets.

The rejected support experiment asked whether the focal value and context supplied the target role. It used the same checkpoint, so it was not independent verification. It was removed after endorsing more wrong mappings than correct ones.

## Reproduce

The historical ablation used the v4 experiment runtime. The final grouped-only diagnostic returned to the v3 field-card rendering and retained only exact typed-value grouping. Set `LAYA_MAPPER_EXECUTABLE` and `LAYA_MODEL_PATH` as described in the baseline report, then run:

```powershell
node scripts/evaluate-laya-mapper.mjs --split all --workers 1 --variants baseline,grouped --output artifacts/laya-improvements/grouping-regression.json
node scripts/evaluate-laya-mapper.mjs --split all --workers 1 --variants baseline,grouped --corpus test/fixtures/laya-robustness-cases.json --output artifacts/laya-improvements/grouping-robustness.json
node scripts/compare-laya-mapper.mjs artifacts/laya-improvements/grouping-regression.json artifacts/laya-improvements/grouping-robustness.json
```

The original 13-case corpus and labels remain unchanged. Its five evaluation cases now serve as a fixed regression set because prior results informed this work; they are no longer a fresh holdout. The separate eight-case robustness set introduces duplicate, irrelevant-field, property-order and same-value/different-role checks. Families remain together. We fixed these labels before v4 model runs.

Current grouped/baseline reports include exact pointers, accepted alternatives, exact typed value accuracy, false absent-target mappings, missed targets, value/pointer disagreement, field coverage and timings. The historical v4 ablation report also records support-check errors. A historical support flag cannot improve pointer accuracy by hiding a wrong guess.

## Results

The added comparisons did not improve overall accuracy on the fixed 13-case, 47-target regression corpus. Diagnostics now use exact typed-value grouping because it provided one narrow duplicate-case improvement without regressing the fixed corpus. The other presets are retained only in the historical [machine-readable results](laya-improvement-results.json), which contain their metrics, target-level Entra outcomes, gains/regressions and hashes of the full local traces.

| Preset | Exact / accepted pointer outcomes | Correct values | Wrong mappings | False mappings for absent targets | Tentative outcomes | Total elapsed |
|---|---:|---:|---:|---:|---:|---:|
| `baseline` | 24/47 | 25/47 | 23 | 6 | 33 | 390.8 s |
| `grouped` | 24/47 | 25/47 | 23 | 6 | 33 | 423.3 s |
| `context` | 19/47 | 20/47 | 28 | 6 | 33 | 518.5 s |
| `pairwise` | 21/47 | 22/47 | 26 | 6 | 36 | 677.7 s |
| `verified` | 21/47 | 22/47 | 26 | 6 | 38 | 654.7 s |

These counts include correctly unmapped targets. Exact and accepted-alternative counts happen to be equal. No present target was missed; the failures were wrong selections. All five presets assessed all 509 eligible field-target pairs in both directions, with no incomplete runs. The new runtime's baseline reproduced all 13 previous pointer and status results.

Grouping alone produced no pointer-accuracy gains or regressions. The combined preset gained `customerName` in `incident-holdout`, but lost `clientHostname` in `overflow` and `incidentOutcome` in `firewall-roles`, `closure-narrative` and `network-holdout`. Support checks did not change any pairwise-selected pointer.

The support checks endorsed 31 guesses: 14 accepted pointers and 17 incorrect pointers, including four false absent-target mappings. They rejected nine incorrect guesses but also three correct ones. The checks are additional model evidence, not an independent verification gate.

### Duplicate and noise robustness

On the separate eight-case, 19-target set, baseline scored 7/19 and both grouping alone and the combined preset scored 8/19. Each assessed all 79 eligible pairs. Baseline was repeated for the isolated grouping comparison and reproduced its pointers and statuses.

The one gain was `identity-duplicate` / `clientHostname`: grouping recovered `/documents/0/client/hostname` after duplicate values caused the baseline to select the application name. This is a narrow demonstrated benefit of grouping. The missing username guess became a wrong guess, not a correct mapping. All three absent customer names were still falsely mapped. The combined preset endorsed all three false customer mappings.

Object-property reordering preserved outputs. All tested presets preserved distinct source/destination pointers in the same-value case. Adding a collector address still made both IP targets select the collector in the noise case. Duplicate handling therefore does not solve semantic role confusion.

### Entra gate: still failed

Every preset scored 0/5 accepted outcomes. The correct IP value was returned through a non-preferred pointer, giving 1/5 value outcomes. With all experiments enabled:

| Target | Actual pointer | Support check |
|---|---|---|
| `sourceIp` | `/documents/0/records/properties/ipAddress` | supported; correct value, wrong preferred pointer |
| `occurred` | `/documents/0/timestamp` | supported; wrong timestamp |
| `clientHostname` | `/documents/0/records/properties/authenticationProcessingDetails/1/value` | rejected |
| `clientUserName` | `/documents/0/records/properties/userType` | rejected |
| `customerName` | `/documents/0/records/properties/location/city` | rejected; target should be unmapped |

All 290 eligible Entra pairs reached final assessment. The preferred IP, time, hostname and username fields ranked 2, 6, 4 and 12 respectively in stage one. They were not lost to a candidate cutoff. Complete coverage does not establish that the bounded model context was sufficient or that the model understood it.

### Measurement limits

These are cumulative experiments, not a full factorial study. Richer context and smaller comparisons can interact with grouping. The original corpus is a regression set, and the small synthetic robustness set cannot support production-accuracy claims.

Elapsed times are one run per case/preset on the same CPU, checkpoint and 14-thread worker budget. The first case in each preset includes cold startup; subsequent cases use a resident worker. Packaging and lightweight checks overlapped parts of the session, so these times are indicative, not a controlled performance benchmark. The verified preset being faster than pairwise is not evidence that extra checks reduce cost. Peak observed worker working set was about 2.75 GiB. No new multi-worker performance claim is made.

The architecture keeps coverage, structural validation and exact-value handling deterministic while leaving semantic selection to Laya. The current evidence supports retaining that boundary, but not adding more decision layers as an assumed accuracy fix. The next useful investigation is whether the base model can reliably resolve small, clearly stated role comparisons, before making the pipeline more complex. No training, alternative model or fixture-specific answer rule was introduced.

## Verification and local package

- `npm run check`, `npm test` (102 passed), and `npm run verify:browser` passed.
- Five Python checks passed using the real checkpoint/tokenizer, including SDK parity, independent batches, overlapping windows, long paired context and reverse-order content stability.
- Trace assertions checked 97 completed case/preset runs and 2,861 eligible field-target pairs: every pair reached both comparison directions, property reordering preserved results, and support checks preserved pairwise-selected pointers.
- The final grouped-only inference package installed from local assets with network downloads disabled. The installed executable matched the built executable's hash and passed actual classification inference with the required value-group capability. The removed support mode is not part of this package.
- Historical `@Browser` verification covered the combined v4 experiment on Entra's duplicate-IP target and the 64-field overflow case. After removing the rejected context, pairwise and support modes, a grouped-only browser rerun confirmed the fixed model identity, absence of experiment/support controls, manual-worker controls, progress, cancellation recovery, alternatives, expandable provenance and a real no-answer result. Full grouped-only Entra and overflow outcomes come from the evaluator, not the later browser rerun. Visual inspection found no result-table layout issue.

The grouped package retains the baseline's Python 3.13.6, PyTorch 2.9.1+cpu, Transformers 4.57.6, NumPy 2.3.4 and PyInstaller 6.16.0 environment. Its local schema-v3 manifest is `artifacts/laya-improvements/assets/laya-mapper-manifest.json`; the runtime archive is 174,111,175 bytes with SHA-256 `ecd57baa11dcd61705e68f6afff332045e212d4732316036e48d5cdba0f1b38a`. The executable SHA-256 is `22b6d241ca4cb3ab29e34d9b9ef1f20579df0b3a537d5b7922002f3c05a68b18`. Checkpoint weights retain SHA-256 `891102d372688fc2a094dac56a384bc537b87c63f21f9f3dac0be2b7cbc8d86c`. Release URLs in the generated manifest identify an intended release only: nothing was pushed or published.

The Node/Python ownership boundary was retained during the design review. Decisions and their evidence are recorded locally in `artifacts/laya-improvements/decisions.tsv`. Prose review did not rewrite frozen model prompts, so it could not contaminate the comparison. Existing trainer edits, stored datasets, checkpoints and prior baseline artifacts were preserved.
