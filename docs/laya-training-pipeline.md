# Developer-only Laya training pipeline

This pipeline is separate from the customer application. The shipped Windows runtime remains CPU inference-only. Developer training artifacts are short-lived CI artifacts and are never included in the application installer or Laya release manifest.

## Frozen contracts

- Production mapper and renderer baseline: commit `82dd954`, prompt contract `english-fields-v3`.
- Integration base: commit `8592002`, plus reviewed worker/install hardening commits `0397f84`, `5f826ef`, and `7ad5bd6`.
- Base checkpoint: `convaiinnovations/laya` revision `1c5edc17a7acd8701df6fc341c0d179f1c62c982`, pinned file-by-file in `laya-mapper/base-model-manifest.json`.
- Synthetic factory input: the immutable `laya-synthetic-data-factory/outputs` directory supplied to `ingest_factory.py --factory`.

The factory is immutable draft input. Never edit its rows or train directly from them. `ingest_factory.py` verifies the final manifest, contract and five source hashes, preserves `templateFamilyId` splits, and emits only rows named in a manifest-bound independent-model review artifact. Factory rows marked `humanReviewRequired` remain quarantined from release-candidate data. No model review is represented as human approval.

Only these six draft roles have conservative global mappings:

- `occurredAt` to `occurred`
- `sourceIp` to `sourceIp`
- `destinationIp` to `destinationIp`
- `clientIp` to `clientIp`
- `clientHostname` to `clientHostname`
- `customerOrOrganization` to `customerName`

Every production target outside those six direct roles remains `unlabelled`, except for the reviewed positive-only Tier A mappings to `clientUserName` and `sourceUsername`; absence in the draft contract is never converted into a negative. Ambiguous or invalid-type direct labels are quarantined. Any additional mapping requires an explicit record/family review decision.

## Gates

1. Create an independent-model review artifact bound to the SHA-256 of `final-manifest.json` and the additional-drafts SHA-256. `pilotOnly` is a non-promotable engineering gate. `releaseCandidate` requires independent GPT-6 review and may include only factory rows whose draft flag is `humanReviewRequired: false`. Do not approve frozen-test rows during pilot/model selection.
2. Run `ingest_factory.py`. Review its emitted/quarantined counts and hashes.
3. Run `review.py` for pointer/type/hash, secret, tenant, domain, IPv4 and IPv6 checks.
4. Run `compile-laya-orchestration.mjs`. It exercises the unchanged grouped production mapper and records exact renderer output for every classification, alias comparison, forward/reverse sweep, `__none__`, adjudication and coverage decision.
5. Run `compiler.py compile`. It re-renders every trace and requires exact equality for IDs, markers, question type, options, state, question and token accounting. Every trace and compiled item is hash-bound. Multi-window positives require reviewed token windows; window zero is never assumed positive.
6. Run a head-only tiny-overfit pilot first, only after all 18 pilot rows have the exact semantic adjudications in `tiny-overfit-pilot.json` (79 direct positives, 29 direct no-match decisions, and 14 Tier A positives). The trainer reports the exact trainable parameter count, optimizer-step count and timing, preserves shipped `temperature` and `temperature_by_options`, and verifies saved/reloaded sequence predictions. Last-encoder-layer plus head is a separate explicit fallback experiment.
7. Sequence metrics are only teacher-forced diagnostics. They are never called pointer accuracy.
8. After model selection is locked, run the full grouped production mapper on untouched development and frozen-test source families. `evaluate-laya-reviewed-sources.mjs` measures pointer/none outcomes, complete coverage and repeated saved/reloaded output equality. `verify-laya-promotion.mjs` compares the candidate with the base checkpoint. The compiled frozen-test partition is promotion-only and the trainer never loads it.

Every derived row carries a content `recordHash` plus a separate `certificationHash` that binds reviewer identity, gate, review artifact, and additional-draft set. Changing `pilotOnly` to `releaseCandidate`, changing reviewer identity, or swapping a review artifact invalidates certification.

No checkpoint may be trained, calibrated, promoted or published until all gates pass. A failed gate ships the pinned base assets. The base checkpoint and source factory remain unchanged throughout.

## Corrected pilot commands

These commands are intentionally blocked until `<pilot-review.json>` is a hash-bound independent-model review that contains every exact override in `tiny-overfit-pilot.json`.

```powershell
$Factory = '<immutable-factory-output-directory>'
$Review = '<pilot-review.json>'
$Base = '<verified-base-english-directory>'
$Pilot = 'artifacts/laya-training/corrected-pilot'

python laya-mapper/ingest_factory.py --factory $Factory --approvals $Review --output "$Pilot/ingest"
python laya-mapper/review.py "$Pilot/ingest/approved-source.jsonl"
node scripts/compile-laya-orchestration.mjs "$Pilot/ingest/approved-source.jsonl" $Base "$Pilot/orchestration-trace.jsonl"
python laya-mapper/compiler.py compile --source "$Pilot/ingest/approved-source.jsonl" --trace "$Pilot/orchestration-trace.jsonl" --base $Base --base-manifest laya-mapper/base-model-manifest.json --output "$Pilot/compiled"
python laya-mapper/developer_trainer.py train --compiled "$Pilot/compiled" --config laya-mapper/developer-training-config.json --base $Base --base-manifest laya-mapper/base-model-manifest.json --output "$Pilot/checkpoint" --run-id corrected-pilot-v1 --device cpu --pilot --pilot-manifest laya-mapper/tiny-overfit-pilot.json --training-scope head-only
```

The trainer's final manifest must report `promotionEligible: false`, unchanged calibration, the exact optimizer-step count, and successful saved/reloaded choice and logit equality. Do not use the pilot checkpoint for release evaluation or promotion.
