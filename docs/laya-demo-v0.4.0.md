# Laya demo checkpoint in v0.4.0

Version 0.4.0 packages `expanded-training-cuda-632-alerts-v1` for diagnostics in the core application. Normal XSOAR incident processing remains deterministic; Laya results are never applied automatically.

## Identity and verification

- Base architecture: `convaiinnovations/laya` English revision `1c5edc17a7acd8701df6fc341c0d179f1c62c982`, SDK 0.3.5.
- Trained weights SHA-256: `68fa97a82a8364efb7865f241f4909b4af380be7f32d16840a534ed509f0f7a7`.
- Fixed schedule: three epochs and 2,205 optimizer steps.
- Save/reload verification: all 5,338 development sequences produced identical choices and zero maximum logit drift; all state was finite.
- Promotion status: `false`. This is a reviewed demonstration checkpoint, not an automatically trusted production mapper.

The 81.15% teacher-forced sequence score describes rendered training decisions. It is not end-to-end real-alert or production accuracy.

## Short production-mapper comparison

The same packaged CPU runtime and grouped production mapper ran once against each checkpoint on all eight labelled development fixtures. Frozen evaluation cases were not accessed.

| Metric | Frozen base | Demo checkpoint |
| --- | ---: | ---: |
| Accepted mappings | 12/28 (42.9%) | 13/28 (46.4%) |
| Value-correct results | 13/28 (46.4%) | 14/28 (50.0%) |
| Wrong mappings | 16 | 7 |
| Missed mappings | 0 | 8 |
| False mappings for absent targets | 4 | 2 |
| Forward/reverse disagreements | 21 | 13 |
| Eligible fields finally assessed | 439/439 | 439/439 |
| Total inference time | 480.9 seconds | 409.6 seconds |

The checkpoint is more conservative: it substantially reduces wrong guesses and disagreement, but returns no match for some fields the base model selected correctly. In particular, the development run improved source/destination IP roles and absent-customer handling while missing some time, hostname, username, closure-note, customer, and outcome fields. Human review remains mandatory.

## Demo visibility

The Configuration diagnostics panel displays:

- the exact checkpoint ID and shortened weights hash;
- the teacher-forced score with an explicit accuracy warning;
- the current stage, stage-local completion counts, elapsed time, workers and CPU threads;
- selected, tentative, no-supported-match, and incomplete results;
- exact pointers, competing alternatives, coverage, omissions, scores, and full provenance.

The schema-v4 installer manifest binds the displayed checkpoint identity to the downloaded model weight hash. An older base-only installation is reported as unavailable until the reviewed demo checkpoint is installed and verified.
