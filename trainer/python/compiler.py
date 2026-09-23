"""Developer-only reviewed-data gate and production-renderer compiler.

Node owns production orchestration.  This module calls the frozen Python
renderer directly and records a cryptographic proof of every rendered item.
Training consumes only the hashed output of this compiler.
"""

from __future__ import annotations

import argparse
import hashlib
import ipaddress
import json
import math
import os
import re
import sys
from collections import defaultdict
from datetime import datetime, timezone
from pathlib import Path
from typing import Any
from urllib.parse import urlparse

NONE = "__none__"
CONTRACT = "english-fields-v3"
COMPILER_VERSION = "3"
MAX_DOCUMENTS = 16
MAX_DOCUMENT_BYTES = 96 * 1024
GROUP_KEYS = ("provider", "product", "templateFamily", "variantGroupId", "scenarioGroupId")
PROVENANCE_KEYS = ("generatorModel", "generatorRevision", "promptHash", "seed", "rawHash",
                   "normalizedHash", "targetCatalogVersion", "compilerVersion", "blindReviewerModel",
                   "blindReviewPromptHash", "reviewArtifactSha256", "additionalDraftsSha256")
NARRATIVE_TARGETS = {"incidentOutcome", "closeNotes", "descriptionLong", "historicalSummary", "historicalRecommendations"}
TARGET_TYPES = {
    "customerName": "text", "classification": "text", "occurred": "timestamp",
    "incidentOutcome": "text", "closeNotes": "text", "ruleName": "text", "caseType": "text",
    "clientIp": "ip", "clientHostname": "identifier", "clientUserName": "identifier",
    "destinationIp": "ip", "deviceHostname": "identifier", "eventInfo": "text", "eventName": "text",
    "detectionUrl": "url", "errorMessage": "text", "serviceMessage": "text",
    "sourceHostname": "identifier", "sourceIp": "ip", "sourceUsername": "identifier",
    "descriptionLong": "text", "historicalSummary": "text", "historicalRecommendations": "text",
}
ISO_TIMESTAMP = re.compile(r"^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})?$")


def canonical_json(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"), sort_keys=True, allow_nan=False)


def sha256_bytes(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def sha256_json(value: Any) -> str:
    return sha256_bytes(canonical_json(value).encode("utf-8"))


def raw_hash(record: dict[str, Any]) -> str:
    return sha256_json(record.get("documents"))


def normalized_payload(record: dict[str, Any]) -> dict[str, Any]:
    return {key: record.get(key) for key in ("schemaVersion", "sampleId", "synthetic", "sourceFamily", "split", "splitUnit", "documents", "decisions")}


def normalized_hash(record: dict[str, Any]) -> str:
    return sha256_json(normalized_payload(record))


def record_hash(record: dict[str, Any]) -> str:
    value = {key: item for key, item in record.items() if key not in ("recordHash", "certificationHash", "review")}
    return sha256_json(value)


def certification_hash(record: dict[str, Any]) -> str:
    provenance = record.get("provenance", {})
    return sha256_json({
        "recordHash": record.get("recordHash"),
        "review": record.get("review"),
        "reviewArtifactSha256": provenance.get("reviewArtifactSha256"),
        "additionalDraftsSha256": provenance.get("additionalDraftsSha256"),
    })


def typed_identity(value: Any) -> tuple[str, Any]:
    if value is None:
        return ("null", None)
    if isinstance(value, bool):
        return ("boolean", value)
    if isinstance(value, str):
        return ("string", value)
    if isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value):
        return ("number", value)
    raise ValueError("mapped values must be finite JSON scalars")


def resolve_pointer(documents: list[Any], pointer: str) -> Any:
    if not isinstance(pointer, str) or not pointer.startswith("/documents/"):
        raise ValueError("label pointer must address /documents")
    value: Any = {"documents": documents}
    for encoded in pointer[1:].split("/"):
        part = encoded.replace("~1", "/").replace("~0", "~")
        if isinstance(value, list):
            if not re.fullmatch(r"0|[1-9][0-9]*", part) or int(part) >= len(value):
                raise ValueError(f"label pointer does not resolve: {pointer}")
            value = value[int(part)]
        elif isinstance(value, dict) and part in value:
            value = value[part]
        else:
            raise ValueError(f"label pointer does not resolve: {pointer}")
    return value


def structurally_eligible(target: str, value: Any) -> bool:
    value_type = TARGET_TYPES.get(target)
    if value_type is None:
        return False
    text = "" if value is None else str(value).strip()
    if not text:
        return False
    if value_type == "identifier":
        return isinstance(value, str) or (isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value))
    if value_type == "ip":
        try:
            ipaddress.ip_address(text)
            return True
        except ValueError:
            return False
    if value_type == "url":
        try:
            parsed = urlparse(text)
            return parsed.scheme in ("http", "https") and bool(parsed.netloc)
        except ValueError:
            return False
    if value_type == "timestamp":
        if isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value):
            numeric = float(value)
            magnitude = abs(numeric)
            if magnitude >= 1e17:
                seconds = numeric / 1e9
            elif magnitude >= 1e14:
                seconds = numeric / 1e6
            elif magnitude >= 1e11:
                seconds = numeric / 1000
            else:
                seconds = numeric
            return 946684800 <= seconds < 4102444800
        if not isinstance(value, str) or not ISO_TIMESTAMP.fullmatch(value):
            return False
        try:
            parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
            if parsed.tzinfo is None:
                parsed = parsed.replace(tzinfo=timezone.utc)
            return datetime(2000, 1, 1, tzinfo=timezone.utc) <= parsed.astimezone(timezone.utc) < datetime(2100, 1, 1, tzinfo=timezone.utc)
        except ValueError:
            return False
    return isinstance(value, str)


def validate_documents(documents: Any) -> list[Any]:
    if not isinstance(documents, list) or not 1 <= len(documents) <= MAX_DOCUMENTS:
        raise ValueError("documents must contain 1 to 16 records")
    if len(canonical_json(documents).encode("utf-8")) > MAX_DOCUMENT_BYTES:
        raise ValueError("documents exceed the 96 KiB production limit")
    visited = 0

    def visit(value: Any, depth: int) -> None:
        nonlocal visited
        visited += 1
        if depth > 30 or visited > 10000:
            raise ValueError("documents exceed production complexity limits")
        if isinstance(value, list):
            for item in value:
                visit(item, depth + 1)
        elif isinstance(value, dict):
            for item in value.values():
                visit(item, depth + 1)
        else:
            typed_identity(value)

    for document in documents:
        visit(document, 0)
    return documents


def validate_source_record(record: Any, *, require_approved: bool = True) -> dict[str, Any]:
    if not isinstance(record, dict) or record.get("schemaVersion") != 2 or record.get("synthetic") is not True:
        raise ValueError("records must be synthetic schemaVersion 2 data")
    if not isinstance(record.get("sampleId"), str) or not record["sampleId"]:
        raise ValueError("sampleId is required")
    documents = validate_documents(record.get("documents"))
    if record.get("split") not in ("train", "development", "frozen-test"):
        raise ValueError("source record has an invalid fixed split")
    split = record.get("splitUnit")
    if not isinstance(split, dict) or any(not isinstance(split.get(key), str) or not split[key] for key in GROUP_KEYS):
        raise ValueError("complete splitUnit grouping is required")
    provenance = record.get("provenance")
    if not isinstance(provenance, dict) or any(key not in provenance for key in PROVENANCE_KEYS):
        raise ValueError("complete generation provenance is required")
    if provenance.get("targetCatalogVersion") != CONTRACT or str(provenance.get("compilerVersion")) != COMPILER_VERSION:
        raise ValueError("source record targets another compiler contract")
    if provenance.get("rawHash") != raw_hash(record):
        raise ValueError("rawHash does not match canonical source documents")
    if provenance.get("normalizedHash") != normalized_hash(record):
        raise ValueError("normalizedHash does not match normalized source content")
    review = record.get("review")
    reviewer = review.get("reviewer") if isinstance(review, dict) else None
    review_gate = review.get("gate") if isinstance(review, dict) else None
    if require_approved and (not isinstance(review, dict) or review.get("state") != "approved"
                             or not isinstance(review.get("blind"), bool)
                             or review_gate not in ("pilotOnly", "trainingOnly", "releaseCandidate")
                             or not isinstance(reviewer, dict) or reviewer.get("kind") != "independent-model"
                             or not isinstance(reviewer.get("model"), str) or not reviewer["model"]
                             or not re.fullmatch(r"[a-f0-9]{64}", str(reviewer.get("promptHash", "")))):
        raise ValueError("only explicitly independent-model-reviewed records may be compiled")
    if require_approved and review_gate != "trainingOnly" and review.get("blind") is not True:
        raise ValueError("pilot and release-candidate records require blind independent review")
    if require_approved and review_gate in ("trainingOnly", "releaseCandidate") and not reviewer["model"].lower().startswith("gpt-6"):
        raise ValueError("training and release-candidate records require independent GPT-6 semantic review")
    if require_approved and (reviewer["model"] != provenance.get("blindReviewerModel")
                             or reviewer["promptHash"] != provenance.get("blindReviewPromptHash")):
        raise ValueError("reviewer identity does not match immutable provenance")
    for hash_key in ("reviewArtifactSha256", "additionalDraftsSha256"):
        if not re.fullmatch(r"[a-f0-9]{64}", str(provenance.get(hash_key, ""))):
            raise ValueError(f"invalid provenance hash: {hash_key}")
    decisions = record.get("decisions")
    if not isinstance(decisions, dict) or set(decisions) != set(TARGET_TYPES):
        raise ValueError("every production target must have exactly one decision")
    for target, decision in decisions.items():
        if not isinstance(decision, dict) or decision.get("state") not in ("mapped", "absent", "unlabelled"):
            raise ValueError(f"invalid decision for {target}")
        if decision["state"] == "mapped":
            pointers = decision.get("acceptedPointers")
            if not isinstance(pointers, list) or not pointers or len(set(pointers)) != len(pointers) or decision.get("primaryPointer") not in pointers:
                raise ValueError(f"mapped decision for {target} requires reviewed accepted pointers")
            if "resolvedValue" not in decision:
                raise ValueError(f"mapped decision for {target} requires resolvedValue")
            expected = typed_identity(decision["resolvedValue"])
            for pointer in pointers:
                actual = resolve_pointer(documents, pointer)
                if typed_identity(actual) != expected:
                    raise ValueError(f"mapped decision for {target} does not resolve to its recorded value")
                if not structurally_eligible(target, actual):
                    raise ValueError(f"mapped decision for {target} is structurally ineligible")
            positive_windows = decision.get("positiveWindows", {})
            if not isinstance(positive_windows, dict) or any(pointer not in pointers for pointer in positive_windows):
                raise ValueError(f"mapped decision for {target} has invalid positive-window labels")
            for pointer, windows in positive_windows.items():
                if not isinstance(windows, list) or not windows or any(
                    not isinstance(window, dict) or not isinstance(window.get("startToken"), int)
                    or not isinstance(window.get("endToken"), int) or window["startToken"] < 0
                    or window["endToken"] <= window["startToken"] for window in windows
                ):
                    raise ValueError(f"mapped decision for {target} has invalid reviewed windows for {pointer}")
        elif decision.get("acceptedPointers") or decision.get("primaryPointer") or "resolvedValue" in decision:
            raise ValueError(f"non-mapped decision for {target} cannot contain mapped evidence")
        for pointer in decision.get("hardNegativePointers", []):
            value = resolve_pointer(documents, pointer)
            if pointer in decision.get("acceptedPointers", []) or not structurally_eligible(target, value):
                raise ValueError(f"invalid hard negative for {target}")
        needs_semantic_review = (decision["state"] == "absent"
                                 or (decision["state"] == "mapped" and target in NARRATIVE_TARGETS)
                                 or decision.get("securityCritical") or decision.get("disputed")
                                 or len(decision.get("acceptedPointers", [])) > 1)
        if needs_semantic_review and decision.get("independentModelReviewed") is not True:
            raise ValueError(f"decision for {target} requires explicit independent-model review")
    if record.get("recordHash") != record_hash(record):
        raise ValueError("recordHash does not match canonical source content")
    if record.get("certificationHash") != certification_hash(record):
        raise ValueError("certificationHash does not bind the review and lineage")
    return record


def verify_base_model(base: Path, manifest_path: Path) -> dict[str, Any]:
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    if (manifest.get("id"), manifest.get("revision"), manifest.get("sdkVersion"), manifest.get("promptVersion")) != (
        "base-english", "1c5edc17a7acd8701df6fc341c0d179f1c62c982", "0.3.5", CONTRACT
    ) or manifest.get("tokenLimits") != {"maxLength": 512, "headMaxLength": 192}:
        raise ValueError("base model manifest identity is not pinned")
    for relative, expected in manifest.get("files", {}).items():
        file_path = base / relative
        if not file_path.is_file() or file_path.stat().st_size != expected.get("size"):
            raise ValueError(f"base model file size mismatch: {relative}")
        digest = sha256_file(file_path)
        if digest != expected.get("sha256"):
            raise ValueError(f"base model file hash mismatch: {relative}")
    return manifest


def group_key(value: dict[str, Any]) -> str:
    return value["splitUnit"]["templateFamily"]


def split_groups(rows: list[dict[str, Any]]) -> dict[str, list[dict[str, Any]]]:
    groups: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for row in rows:
        groups[group_key(row)].append(row)
    result = {"train": [], "development": [], "frozen-test": []}
    for key, values in groups.items():
        splits = {row["split"] for row in values}
        if len(splits) != 1:
            raise ValueError(f"template family crosses fixed splits: {key}")
        result[next(iter(splits))].extend(values)
    group_sets = [{group_key(row) for row in values} for values in result.values()]
    if any(group_sets[left].intersection(group_sets[right]) for left in range(len(group_sets)) for right in range(left + 1, len(group_sets))):
        raise ValueError("split leakage detected")
    return result


def _runtime(base: Path):
    os.environ["LAYA_MODEL_PATH"] = str(base)
    import runner
    return runner


def render_projection(item: dict[str, Any]) -> dict[str, Any]:
    keys = ("ids", "markers", "qtype", "state", "question", "tokenAccounting", "window", "evidence", "consumed", "labels")
    return {key: item[key] for key in keys if key in item}


def render_decision(runner, agent, decision: dict[str, Any]) -> dict[str, Any]:
    if decision.get("kind") == "classify":
        items = runner.classify_items(agent, decision)
    elif decision.get("kind") == "choose":
        items = [runner.choice_item(agent, decision)]
    else:
        raise ValueError("unsupported orchestration decision")
    return {"items": [render_projection(item) for item in items]}


def prepare(decisions: list[dict[str, Any]], base: Path) -> list[dict[str, Any]]:
    runner = _runtime(base)
    agent = runner.runtime.load()
    return [{"id": decision["id"], "kind": decision["kind"], "rendered": render_decision(runner, agent, decision)} for decision in decisions]


def trace_hash(row: dict[str, Any]) -> str:
    return sha256_json({key: value for key, value in row.items() if key != "traceHash"})


def item_hash(row: dict[str, Any]) -> str:
    return sha256_json({key: value for key, value in row.items() if key != "itemHash"})


def _training_item(rendered: dict[str, Any], target: list[float], metadata: dict[str, Any], base_manifest_hash: str) -> dict[str, Any]:
    row = {
        "schemaVersion": 1,
        "contract": CONTRACT,
        "baseModelManifestHash": base_manifest_hash,
        "ids": rendered["ids"],
        "markers": rendered["markers"],
        "qtype": rendered["qtype"],
        "target": target,
        "label": max(range(len(target)), key=target.__getitem__),
        "renderProof": rendered,
        "metadata": metadata,
    }
    row["itemHash"] = item_hash(row)
    return row


def compile_trace(rows: list[dict[str, Any]], base: Path, base_manifest_hash: str) -> list[dict[str, Any]]:
    runner = _runtime(base)
    agent = runner.runtime.load()
    positives: dict[tuple[str, str], list[dict[str, Any]]] = defaultdict(list)
    hard_negatives: dict[tuple[str, str], list[dict[str, Any]]] = defaultdict(list)
    easy_negatives: dict[tuple[str, str], list[dict[str, Any]]] = defaultdict(list)
    choices = []
    for trace_index, row in enumerate(rows):
        if row.get("traceHash") != trace_hash(row):
            raise ValueError("trace hash mismatch")
        decision = row["decision"]
        exact = render_decision(runner, agent, decision)
        if canonical_json(exact) != canonical_json(row.get("rendered")):
            raise ValueError("production/compiler render drift")
        metadata = {"sampleId": row["sampleId"], "splitUnit": row["splitUnit"], "target": row["target"],
                    "pass": row.get("pass"), "traceIndex": trace_index, "decisionId": decision["id"]}
        rendered_items = exact["items"]
        if decision["kind"] == "classify":
            positive = bool(row["gold"]["positive"])
            reviewed_windows = {
                (window["startToken"], window["endToken"])
                for window in row["gold"].get("positiveWindows", [])
            }
            if positive and len(rendered_items) > 1 and not reviewed_windows:
                raise ValueError("multi-window positive requires reviewed evidence windows")
            for rendered in rendered_items:
                bounds = (rendered["window"]["startToken"], rendered["window"]["endToken"])
                label = positive and (len(rendered_items) == 1 or bounds in reviewed_windows)
                compiled = _training_item(rendered, [0.0, 1.0] if label else [1.0, 0.0],
                                          {**metadata, "phase": "classify", "window": rendered["window"]}, base_manifest_hash)
                bucket = positives if label else hard_negatives if row["gold"].get("hardNegative") else easy_negatives
                bucket[(row["sampleId"], row["target"])].append(compiled)
        else:
            rendered = rendered_items[0]
            if rendered["consumed"] != row["gold"]["consumed"]:
                raise ValueError("production/compiler candidate consumption drift")
            option_ids = list(rendered["labels"].values())
            gold = row["gold"]["choice"]
            if gold not in option_ids:
                raise ValueError("gold choice is outside the production-rendered options")
            choices.append(_training_item(rendered, [float(option == gold) for option in option_ids], {
                **metadata, "phase": "selection", "options": option_ids, "goldChoice": gold,
                "hasGold": gold != NONE, "noneIndex": option_ids.index(NONE),
            }, base_manifest_hash))
    compiled = list(choices)
    keys = set(positives) | set(hard_negatives) | set(easy_negatives)
    for key in sorted(keys):
        compiled.extend(positives[key])
        compiled.extend(hard_negatives[key])
        limit = max(2, 2 * (len(positives[key]) + len(hard_negatives[key])))
        compiled.extend(sorted(easy_negatives[key], key=lambda item: sha256_json(item["metadata"]))[:limit])
    return compiled


def read_jsonl(path: Path) -> list[dict[str, Any]]:
    return [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines() if line.strip()]


def write_jsonl(path: Path, rows: list[dict[str, Any]]) -> str:
    content = "".join(canonical_json(row) + "\n" for row in rows)
    encoded = content.encode("utf-8")
    path.write_bytes(encoded)
    return sha256_bytes(encoded)


def serve_prepare(base: Path) -> None:
    for raw in sys.stdin:
        request_id = None
        try:
            request = json.loads(raw)
            request_id = request.get("id")
            decisions = request.get("decisions", [])
            if not isinstance(decisions, list) or not 1 <= len(decisions) <= 16:
                raise ValueError("invalid decision batch")
            response = {"id": request_id, "result": prepare(decisions, base)}
        except Exception:
            response = {"id": request_id, "error": "production renderer rejected the decision"}
        print(canonical_json(response), flush=True)


def main() -> None:
    parser = argparse.ArgumentParser()
    subparsers = parser.add_subparsers(dest="command", required=True)
    prepare_parser = subparsers.add_parser("prepare-server")
    prepare_parser.add_argument("--base", type=Path, required=True)
    compile_parser = subparsers.add_parser("compile")
    compile_parser.add_argument("--trace", type=Path, required=True)
    compile_parser.add_argument("--source", type=Path, required=True)
    compile_parser.add_argument("--base", type=Path, required=True)
    compile_parser.add_argument("--base-manifest", type=Path, default=Path(__file__).with_name("base-model-manifest.json"))
    compile_parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    if args.command == "prepare-server":
        serve_prepare(args.base)
        return
    base_manifest = verify_base_model(args.base, args.base_manifest)
    base_manifest_hash = sha256_json(base_manifest)
    sources = [validate_source_record(row) for row in read_jsonl(args.source)]
    source_by_id = {row["sampleId"]: row for row in sources}
    if len(source_by_id) != len(sources):
        raise ValueError("duplicate source sampleId")
    traces = read_jsonl(args.trace)
    for row in traces:
        if row.get("sampleId") not in source_by_id or row.get("target") not in TARGET_TYPES:
            raise ValueError("trace references an unknown source or target")
        if source_by_id[row["sampleId"]]["decisions"][row["target"]]["state"] == "unlabelled":
            raise ValueError("trace references an unlabelled target")
    enriched = [{**row, "split": source_by_id[row["sampleId"]]["split"], "splitUnit": source_by_id[row["sampleId"]]["splitUnit"]} for row in traces]
    partitions = split_groups(enriched)
    args.output.mkdir(parents=True, exist_ok=True)
    file_hashes = {}
    for name, partition_rows in partitions.items():
        file_hashes[f"{name}.jsonl"] = write_jsonl(args.output / f"{name}.jsonl", compile_trace(partition_rows, args.base, base_manifest_hash))
    manifest = {
        "schemaVersion": 1, "contract": CONTRACT, "compilerVersion": COMPILER_VERSION,
        "baseModelManifestHash": base_manifest_hash, "sourceHash": hashlib.sha256(args.source.read_bytes()).hexdigest(),
        "traceHash": hashlib.sha256(args.trace.read_bytes()).hexdigest(), "files": file_hashes,
        "frozenTestPurpose": "production-mapper-promotion-only",
        "reviewGates": sorted({row["review"]["gate"] for row in sources}),
        "groups": {name: sorted(set(group_key(row) for row in values)) for name, values in partitions.items()},
    }
    (args.output / "compilation-manifest.json").write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")


if __name__ == "__main__":
    main()
