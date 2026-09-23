# Experimental Laya distribution boundary

The stable checkpoint-promotion policy in `laya-training-pipeline.md` remains unchanged. A model that has not passed every promotion gate must not be installed, activated in normal incident processing, described as production-ready, or published as a stable release.

The repository owner explicitly requested a separately isolated build on 23 September 2026 so the current pilot can be tested on approved real alerts. That request permits one narrow distribution exception for a **portable diagnostics-only prerelease**. It is not a checkpoint-promotion exception and does not make the model eligible for production use.

An experimental distribution under this exception must:

- retain `gate: pilotOnly`, `trainingComplete: false`, and `promotionEligible: false` in the exported model and release attestation;
- use a distinct checkpoint identity and verify every inference file before loading it;
- reconstruct only an evaluated, immutable recovery-state copy from the hash-verified English base;
- prove finite serialized state and exact 1,004-sequence choice parity across save/reload, while describing the teacher-forced metric only as a training diagnostic;
- remain CPU-only, offline, in-memory, and unable to install, train, persist, activate, or affect normal incident processing;
- ship as a portable ZIP that does not share the stable installer identity or application-data paths;
- use a non-`v*` Git tag and a GitHub release explicitly marked prerelease;
- avoid frozen-test data, fixture-specific selection rules, and any claim that real-alert accuracy is known;
- pass clean-extraction runtime and browser checks before publication; and
- publish an attestation binding the exact recovery snapshot, exported model, runtime, source commit, ZIP, and SHA-256 sidecar.

Feedback export is explicit and local. It excludes the original source document but includes source values and provenance, so analysts must review it before sharing. Stable v0.3.14 and `main` are outside this exception.
