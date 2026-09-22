"""Convert immutable synthetic-factory drafts into reviewed compiler sources.

The input tree is never modified.  Rows without an explicit approval entry are
reported as quarantined and are not emitted for compilation.
"""

from __future__ import annotations

import argparse
import hashlib
import json
from collections import Counter, defaultdict
from pathlib import Path
from typing import Any

from compiler import (COMPILER_VERSION, CONTRACT, TARGET_TYPES, canonical_json, certification_hash, normalized_hash,
                      raw_hash, record_hash, resolve_pointer, structurally_eligible, typed_identity, validate_source_record)

DIRECT_TARGETS = {
    "occurred": "occurredAt",
    "sourceIp": "sourceIp",
    "destinationIp": "destinationIp",
    "clientIp": "clientIp",
    "clientHostname": "clientHostname",
    "customerName": "customerOrOrganization",
}


def sha256_file(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def json_type(value: Any) -> str:
    if value is None:
        return "null"
    if isinstance(value, bool):
        return "boolean"
    if isinstance(value, str):
        return "string"
    if isinstance(value, int):
        return "integer"
    if isinstance(value, float):
        return "number"
    if isinstance(value, list):
        return "array"
    return "object"


def prefixed(pointer: str) -> str:
    if not isinstance(pointer, str) or not pointer.startswith("/"):
        raise ValueError("draft pointer must be rooted at alert")
    return "/documents/0" + pointer


def load_approvals(path: Path | None, manifest_hash: str, additional_hash: str) -> tuple[dict[str, Any], str, str | None]:
    if path is None:
        return {}, hashlib.sha256(b"no-approvals").hexdigest(), None
    raw = path.read_bytes()
    value = json.loads(raw)
    if (value.get("schemaVersion") != 1 or value.get("datasetManifestSha256") != manifest_hash
            or value.get("additionalDraftsSha256") != additional_hash):
        raise ValueError("approval file is not bound to this dataset manifest")
    gate = value.get("gate")
    reviewer = value.get("reviewer")
    approvals = value.get("reviews")
    if (gate not in ("pilotOnly", "releaseCandidate") or not isinstance(reviewer, dict)
            or reviewer.get("kind") != "independent-model" or not isinstance(approvals, list)):
        raise ValueError("review artifact requires an independent-model reviewer and explicit gate")
    if gate == "releaseCandidate" and not str(reviewer.get("model", "")).lower().startswith("gpt-6"):
        raise ValueError("release-candidate review must use an independent GPT-6 model")
    if not re_full_hash(reviewer.get("promptHash")):
        raise ValueError("reviewer prompt hash is invalid")
    by_id = {}
    for approval in approvals:
        record_id = approval.get("recordId")
        if (not isinstance(record_id, str) or record_id in by_id or approval.get("status") != "approved"
                or not isinstance(approval.get("findings"), list)):
            raise ValueError("review entries require unique approved record IDs and findings")
        by_id[record_id] = {**approval, "gate": gate, "reviewer": reviewer}
    return by_id, hashlib.sha256(raw).hexdigest(), gate


def re_full_hash(value: Any) -> bool:
    return isinstance(value, str) and len(value) == 64 and all(character in "0123456789abcdef" for character in value)


def verify_factory(root: Path) -> tuple[dict[str, Any], str, list[dict[str, Any]]]:
    manifest_path = root / "final-manifest.json"
    manifest_hash = sha256_file(manifest_path)
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    if manifest.get("manifestStatus") != "validated-draft-input-only" or manifest.get("trainingRowsEmitted") is not False:
        raise ValueError("factory manifest is not validated draft-only input")
    contract_path = root / manifest["contract"]["path"]
    if sha256_file(contract_path) != manifest["contract"]["sha256"]:
        raise ValueError("factory contract hash mismatch")
    rows = []
    for source, expected in manifest.get("sources", {}).items():
        records_path = root / "sources" / source / "records.jsonl"
        if sha256_file(records_path) != expected.get("sha256"):
            raise ValueError(f"factory source hash mismatch: {source}")
        source_rows = [json.loads(line) for line in records_path.read_text(encoding="utf-8").splitlines() if line]
        if len(source_rows) != expected.get("records"):
            raise ValueError(f"factory source count mismatch: {source}")
        rows.extend(source_rows)
    totals = manifest.get("totals", {})
    if len(rows) != totals.get("records") or len({row.get("recordId") for row in rows}) != len(rows):
        raise ValueError("factory record totals or uniqueness do not match the manifest")
    family_splits: dict[str, set[str]] = defaultdict(set)
    for row in rows:
        family_splits[row["templateFamilyId"]].add(row["split"])
    if any(len(splits) != 1 for splits in family_splits.values()):
        raise ValueError("factory template families cross fixed splits")
    return manifest, manifest_hash, rows


def derived_record(row: dict[str, Any], approval: dict[str, Any], manifest_hash: str, approval_hash: str,
                   additional_hash: str, tier_mapping: dict[str, Any] | None, tier_hash: str) -> dict[str, Any]:
    documents = [row["alert"]]
    overrides = approval.get("targetOverrides", {})
    if not isinstance(overrides, dict) or any(target not in TARGET_TYPES for target in overrides):
        raise ValueError("approval contains an invalid production target override")
    decisions = {}
    for target in TARGET_TYPES:
        tier_target = tier_mapping and tier_mapping["productionTarget"] == target
        override = overrides.get(target, {})
        if (not isinstance(override, dict)
                or any(key not in ("sourceTarget", "primaryPointer", "acceptedPointers", "originalType", "rationale", "positiveWindows")
                       for key in override)):
            raise ValueError(f"invalid target override for {target}")
        if "primaryPointer" in override and (not isinstance(override.get("primaryPointer"), str)
                                              or not override["primaryPointer"].startswith("/")
                                              or override.get("originalType") not in ("string", "integer", "number", "boolean")
                                              or not isinstance(override.get("rationale"), str)
                                              or not override["rationale"].strip()
                                              or not isinstance(override.get("acceptedPointers", []), list)):
            raise ValueError(f"reviewed pointer override is incomplete for {target}")
        source_target = override.get("sourceTarget") or (tier_mapping["sourceTarget"] if tier_target else DIRECT_TARGETS.get(target))
        if not source_target:
            decisions[target] = {"state": "unlabelled"}
            continue
        label = row["targetLabels"].get(source_target)
        if not isinstance(label, dict):
            raise ValueError(f"missing draft target label: {source_target}")
        status = "matched" if override.get("primaryPointer") else label.get("expectedStatus")
        pointer = override.get("primaryPointer") or label.get("primaryPointer")
        if status == "matched" and pointer:
            accepted = [pointer, *(override.get("acceptedPointers") or row.get("acceptedAlternatives", {}).get(source_target, []))]
            accepted = list(dict.fromkeys(prefixed(item) for item in accepted))
            primary = prefixed(pointer)
            resolved = resolve_pointer(documents, primary)
            expected_type = override.get("originalType") or label.get("originalType")
            if json_type(resolved) != expected_type:
                raise ValueError(f"draft pointer type mismatch for {source_target}")
            for alternate in accepted:
                if typed_identity(resolve_pointer(documents, alternate)) != typed_identity(resolved):
                    raise ValueError(f"accepted alternative changes typed value for {source_target}")
            decision = {
                "state": "mapped", "primaryPointer": primary, "acceptedPointers": accepted,
                "resolvedValue": resolved, "rationale": override.get("rationale") or label.get("rationale", ""),
                "independentModelReviewed": True,
            }
            windows = overrides.get(target, {}).get("positiveWindows")
            if windows is not None:
                decision["positiveWindows"] = {prefixed(key): value for key, value in windows.items()}
            decisions[target] = decision
        elif status in ("no-match", "missing") and pointer is None and not tier_target:
            decisions[target] = {"state": "absent", "independentModelReviewed": True, "rationale": label.get("rationale", "")}
        elif status == "invalid-type":
            raise ValueError(f"direct target {source_target} has invalid-type evidence and requires quarantine")
        else:
            decisions[target] = {"state": "unlabelled"}
    result = {
        "schemaVersion": 2,
        "sampleId": row["recordId"],
        "synthetic": True,
        "sourceFamily": row["sourceFamily"],
        "split": row["split"],
        "splitUnit": {
            "provider": row["sourceFamily"],
            "product": row["sourceSchema"]["provenanceId"],
            "templateFamily": row["templateFamilyId"],
            "variantGroupId": row["templateFamilyId"],
            "scenarioGroupId": row["recordId"],
        },
        "documents": documents,
        "decisions": decisions,
        "provenance": {
            "generatorModel": row["generatorMetadata"]["generator"],
            "generatorRevision": manifest_hash,
            "promptHash": approval["reviewer"]["promptHash"],
            "seed": row["recordId"],
            "rawHash": "",
            "normalizedHash": "",
            "targetCatalogVersion": CONTRACT,
            "compilerVersion": COMPILER_VERSION,
            "blindReviewerModel": approval["reviewer"]["model"],
            "blindReviewPromptHash": approval["reviewer"]["promptHash"],
            "reviewArtifactSha256": approval_hash,
            "additionalDraftsSha256": additional_hash,
            "sourceSchemaProvenanceId": row["sourceSchema"]["provenanceId"],
            "factoryManifestSha256": manifest_hash,
            "tierAMappingVersion": tier_mapping.get("version") if tier_mapping else None,
            "tierAMappingSha256": tier_hash if tier_mapping else None,
        },
        "review": {"state": "approved", "blind": True, "gate": approval["gate"], "reviewer": approval["reviewer"]},
    }
    result["provenance"]["rawHash"] = raw_hash(result)
    result["provenance"]["normalizedHash"] = normalized_hash(result)
    result["recordHash"] = record_hash(result)
    result["certificationHash"] = certification_hash(result)
    return validate_source_record(result)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--factory", type=Path, required=True)
    parser.add_argument("--approvals", type=Path)
    parser.add_argument("--tier-a", type=Path, default=Path(__file__).with_name("tier-a-family-mappings.json"))
    parser.add_argument("--additional-drafts", type=Path, default=Path(__file__).with_name("additional-synthetic-drafts.jsonl"))
    parser.add_argument("--additional-manifest", type=Path, default=Path(__file__).with_name("additional-synthetic-drafts.manifest.json"))
    parser.add_argument("--pilot-manifest", type=Path, default=Path(__file__).with_name("tiny-overfit-pilot.json"))
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    manifest, manifest_hash, rows = verify_factory(args.factory)
    additional_manifest = json.loads(args.additional_manifest.read_text(encoding="utf-8"))
    additional_hash = sha256_file(args.additional_drafts)
    additional_rows = [json.loads(line) for line in args.additional_drafts.read_text(encoding="utf-8").splitlines() if line]
    if (additional_manifest.get("status") != "review-required-draft-input-only"
            or additional_manifest.get("sha256") != additional_hash
            or additional_manifest.get("records") != len(additional_rows)
            or any(row.get("split") == "frozen-test" for row in additional_rows)):
        raise ValueError("additional synthetic drafts do not match their review-required manifest")
    rows.extend(additional_rows)
    approvals, approval_hash, review_gate = load_approvals(args.approvals, manifest_hash, additional_hash)
    if review_gate == "pilotOnly":
        pilot = json.loads(args.pilot_manifest.read_text(encoding="utf-8"))
        pilot_ids = set(pilot.get("records", []))
        if set(approvals) != pilot_ids:
            raise ValueError("pilot-only review must approve exactly the frozen 18-record pilot slice")
        required_overrides = pilot.get("requiredTargetOverrides", {})
        for record_id, expected_overrides in required_overrides.items():
            if approvals.get(record_id, {}).get("targetOverrides", {}) != expected_overrides:
                raise ValueError(f"pilot review is missing the exact semantic adjudication for {record_id}")
    tier_bytes = args.tier_a.read_bytes()
    tier = json.loads(tier_bytes)
    if tier.get("schemaVersion") != 1 or tier.get("positiveOnly") is not True or tier.get("sourceTarget") != "accountUpn":
        raise ValueError("Tier A mapping metadata is invalid")
    tier_hash = hashlib.sha256(tier_bytes).hexdigest()
    tier_by_family = {}
    for mapping in tier.get("mappings", []):
        family = mapping.get("templateFamilyId")
        if family in tier_by_family or mapping.get("productionTarget") not in ("clientUserName", "sourceUsername"):
            raise ValueError("Tier A mapping metadata contains an invalid or duplicate family")
        tier_by_family[family] = {**mapping, "sourceTarget": tier["sourceTarget"], "version": tier["version"]}
    emitted, quarantine = [], []
    preflight = Counter()
    for row in rows:
        invalid_direct = []
        if row.get("humanReviewRequired") is False:
            for production_target, source_target in DIRECT_TARGETS.items():
                status = row["targetLabels"][source_target]["expectedStatus"]
                preflight["decisions"] += 1
                if status == "matched":
                    pointer = row["targetLabels"][source_target].get("primaryPointer")
                    try:
                        value = resolve_pointer([row["alert"]], prefixed(pointer))
                    except ValueError:
                        value = None
                    if not structurally_eligible(production_target, value):
                        preflight["invalidType"] += 1
                        invalid_direct.append(source_target)
                    else:
                        preflight["positives"] += 1
                elif status in ("no-match", "missing"):
                    preflight["explicitNoneOrMissing"] += 1
                elif status == "invalid-type":
                    preflight["invalidType"] += 1
                    invalid_direct.append(source_target)
            tier_mapping = tier_by_family.get(row["templateFamilyId"])
            if tier_mapping and row["targetLabels"][tier_mapping["sourceTarget"]]["expectedStatus"] == "matched":
                preflight["tierAPositiveUsernameLabels"] += 1
        if invalid_direct:
            quarantine.append({"recordId": row["recordId"], "split": row["split"], "reason": "invalid-type direct label: " + ", ".join(invalid_direct)})
            continue
        approval = approvals.get(row["recordId"])
        if approval is None:
            reason = "factory review-required draft" if row.get("humanReviewRequired") else "explicit independent-model review required"
            quarantine.append({"recordId": row["recordId"], "split": row["split"], "reason": reason})
            continue
        try:
            if approval["gate"] == "releaseCandidate" and row.get("humanReviewRequired") is not False:
                raise ValueError("factory humanReviewRequired rows cannot enter a release candidate")
            emitted.append(derived_record(row, approval, manifest_hash, approval_hash, additional_hash,
                                          tier_by_family.get(row["templateFamilyId"]), tier_hash))
        except ValueError as error:
            quarantine.append({"recordId": row["recordId"], "split": row["split"], "reason": str(error)})
    unknown = sorted(set(approvals) - {row["recordId"] for row in rows})
    if unknown:
        raise ValueError("approval file references unknown records: " + ", ".join(unknown[:10]))
    if review_gate == "pilotOnly":
        pilot = json.loads(args.pilot_manifest.read_text(encoding="utf-8"))
        direct_decisions = [record["decisions"][target] for record in emitted for target in DIRECT_TARGETS]
        observed = {
            "expectedDirectDecisions": len(direct_decisions),
            "expectedDirectPositive": sum(decision["state"] == "mapped" for decision in direct_decisions),
            "expectedDirectNone": sum(decision["state"] == "absent" for decision in direct_decisions),
            "expectedTierAPositiveIdentity": sum(
                record["decisions"][target]["state"] == "mapped"
                for record in emitted for target in ("clientUserName", "sourceUsername")
            ),
        }
        expected = {key: pilot.get(key) for key in observed}
        if observed != expected:
            raise ValueError(f"reviewed pilot labels do not match the adjudicated manifest: observed={observed}, expected={expected}")
    args.output.mkdir(parents=True, exist_ok=True)
    source_path = args.output / "approved-source.jsonl"
    source_text = "".join(canonical_json(row) + "\n" for row in emitted)
    source_path.write_text(source_text, encoding="utf-8")
    report = {
        "schemaVersion": 1,
        "factory": str(args.factory.resolve()),
        "factoryManifestSha256": manifest_hash,
        "additionalDraftsSha256": additional_hash,
        "contractSha256": manifest["contract"]["sha256"],
        "tierAMappingSha256": tier_hash,
        "reviewGate": review_gate,
        "inputRecords": len(rows),
        "inputFamilies": len({row["templateFamilyId"] for row in rows}),
        "inputBySplit": dict(Counter(row["split"] for row in rows)),
        "conservativePreflight": dict(preflight),
        "emitted": len(emitted),
        "emittedBySplit": dict(Counter(row["split"] for row in emitted)),
        "quarantined": len(quarantine),
        "quarantinedByReason": dict(Counter(item["reason"] for item in quarantine)),
        "approvedSourceSha256": hashlib.sha256(source_text.encode("utf-8")).hexdigest(),
        "quarantine": quarantine,
    }
    (args.output / "ingest-report.json").write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({key: value for key, value in report.items() if key != "quarantine"}, indent=2))


if __name__ == "__main__":
    main()
