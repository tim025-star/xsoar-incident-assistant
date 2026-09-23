"""Materialize an immutable, non-promotable pilot recovery snapshot for diagnostics.

This command never resumes training and never reads the frozen-test partition.
It reconstructs the verified base model, overlays the exact head-only recovery
state, and verifies all reviewed pilot sequences before producing inference files.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import os
import shutil
import tempfile
import time
from pathlib import Path

import torch
from laya.common import build_model
from safetensors.torch import load_file, save_file
from transformers import AutoTokenizer

from compiler import CONTRACT, sha256_json, verify_base_model
from developer_trainer import (
    load_compiled,
    predict,
    require_finite,
    runtime_identity,
    sequence_metrics,
    sha256_file,
)


def streaming_sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with Path(path).open("rb") as handle:
        for chunk in iter(lambda: handle.read(4 * 1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def set_head_only(model) -> None:
    for parameter in model.parameters():
        parameter.requires_grad = False
    for name, parameter in model.named_parameters():
        if "encoder." not in name:
            parameter.requires_grad = True


def save_inference_checkpoint(model, tokenizer, cfg, output: Path, manifest) -> None:
    """Keep the frozen encoder compact while retaining trained-head precision."""
    output.mkdir(parents=True, exist_ok=True)
    stored = {}
    for name, value in model.state_dict().items():
        tensor = value.detach().contiguous().cpu()
        if tensor.is_floating_point():
            tensor = tensor.half() if name.startswith("encoder.") else tensor.float()
        stored[name] = tensor
    require_finite(stored, "mixed-precision inference checkpoint")
    save_file(stored, output / "model.safetensors")
    model.encoder.config.save_pretrained(output / "encoder")
    tokenizer.save_pretrained(output / "tokenizer")
    (output / "rl_agent_config.json").write_text(json.dumps(cfg, indent=2) + "\n", encoding="utf-8")
    (output / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")


def verify_saved_reload(before, cfg, checkpoint, items, pad_id, device):
    reloaded = build_model(cfg, encoder_dir=checkpoint / "encoder")
    reloaded.load_state_dict(load_file(checkpoint / "model.safetensors"), strict=True)
    reloaded.to(device)
    after = predict(reloaded, items, pad_id, device, detach_encoder=True)
    if (len(before) != len(items) or len(after) != len(items)
            or any(len(row["logits"]) != len(item["markers"])
                   or not all(math.isfinite(value) for value in row["logits"])
                   for predictions_ in (before, after) for item, row in zip(items, predictions_))):
        raise ValueError("saved checkpoint has incomplete or non-finite reload predictions")
    if [row["choice"] for row in before] != [row["choice"] for row in after]:
        raise ValueError("saved checkpoint changes validation predictions after reload")
    maximum_delta = max((abs(left - right) for a, b in zip(before, after)
                         for left, right in zip(a["logits"], b["logits"])), default=0.0)
    if maximum_delta > 0.01:
        raise ValueError(f"saved checkpoint logits drift after reload: {maximum_delta:.8f}")
    return {"choicesEqual": True, "maximumLogitDelta": maximum_delta, "probeSequences": len(items)}


def expected_bindings(args, base_manifest_hash, compilation_hash, train_items, config):
    micro_batch = int(config.get("cpuHeadOnlyMicroBatch", 16))
    accumulation = int(config.get("cpuHeadOnlyAccumulation", 1))
    epochs = int(config.get("pilotEpochs", 30))
    steps_per_epoch = math.ceil(math.ceil(len(train_items) / micro_batch) / accumulation)
    return {
        "runId": args.run_id,
        "output": str(Path(args.training_output).resolve()),
        "contract": CONTRACT,
        "baseModelManifestHash": base_manifest_hash,
        "compilationManifestHash": compilation_hash,
        "trainerSha256": sha256_file(Path(args.training_trainer)),
        "compilerSha256": sha256_file(Path(args.training_compiler)),
        "trainingConfigSha256": sha256_file(Path(args.config)),
        "pilotManifestSha256": sha256_file(Path(args.pilot_manifest)),
        "trainingScope": "head-only",
        "device": "cpu",
        "randomSeed": 42,
        "microBatch": micro_batch,
        "gradientAccumulation": accumulation,
        "maximumEpochs": epochs,
        "maximumOptimizerSteps": steps_per_epoch * epochs,
        "optimizerStepsPerEpoch": steps_per_epoch,
        "trainingItemsSha256": sha256_json([item["itemHash"] for item in train_items]),
        "runtime": runtime_identity(torch.device("cpu")),
    }


def validate_state(state, expected, evaluation_interval):
    if (state.get("schemaVersion") != 1 or state.get("kind") != "pilot-resume-state"
            or state.get("gate") != "pilotOnly" or state.get("promotionEligible") is not False):
        raise ValueError("snapshot is not a non-promotable pilot recovery state")
    if state.get("bindings") != expected:
        raise ValueError("snapshot bindings do not match the exact reviewed run artifacts")
    epoch = state.get("epochsCompleted")
    steps = state.get("optimizerSteps")
    if (type(epoch) is not int or epoch < 1 or epoch > expected["maximumEpochs"]
            or epoch % evaluation_interval or steps != epoch * expected["optimizerStepsPerEpoch"]):
        raise ValueError("snapshot is not an evaluated epoch boundary with consistent optimizer accounting")
    scheduler = state.get("scheduler", {})
    if (scheduler.get("last_epoch") != steps or scheduler.get("_step_count") != steps + 1
            or scheduler.get("T_max") != expected["maximumOptimizerSteps"]):
        raise ValueError("snapshot scheduler counters do not match the fixed training schedule")
    metrics = state.get("metrics")
    if (not isinstance(metrics, dict) or metrics.get("metricScope") != "teacher-forced-rendered-sequences"
            or metrics.get("sequences") != 1004 or not math.isfinite(metrics.get("sequenceAccuracy", float("nan")))):
        raise ValueError("snapshot does not contain the complete evaluated pilot metric")
    require_finite(state, "pilot snapshot")
    return epoch, steps, metrics


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--snapshot", required=True)
    parser.add_argument("--compiled", required=True)
    parser.add_argument("--config", required=True)
    parser.add_argument("--base", required=True)
    parser.add_argument("--base-manifest", required=True)
    parser.add_argument("--pilot-manifest", required=True)
    parser.add_argument("--training-trainer", required=True)
    parser.add_argument("--training-compiler", required=True)
    parser.add_argument("--training-output", required=True)
    parser.add_argument("--run-id", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--threads", type=int, default=8)
    args = parser.parse_args()

    if not 1 <= args.threads <= 32:
        raise ValueError("threads must be between 1 and 32")
    torch.set_num_threads(args.threads)
    torch.set_num_interop_threads(args.threads)

    snapshot = Path(args.snapshot).resolve()
    output = Path(args.output).resolve()
    live_state = Path(args.training_output).resolve().with_name(Path(args.training_output).name + ".pilot-state.pt")
    if snapshot == live_state:
        raise ValueError("refusing to export the rolling recovery file; copy one completed epoch boundary first")
    if output.exists():
        raise ValueError("refusing to overwrite an existing exported checkpoint")
    state_sha256 = streaming_sha256(snapshot)
    state = torch.load(snapshot, map_location="cpu", weights_only=True, mmap=True)
    if streaming_sha256(snapshot) != state_sha256:
        raise ValueError("snapshot changed while it was being opened; export only an immutable copied epoch boundary")

    base = Path(args.base).resolve()
    base_manifest = verify_base_model(base, Path(args.base_manifest))
    base_manifest_hash = sha256_json(base_manifest)
    train_items, _development_items, compilation, compilation_hash = load_compiled(Path(args.compiled), base_manifest_hash)
    if set(compilation.get("reviewGates", [])) != {"pilotOnly"}:
        raise ValueError("snapshot export requires the pilotOnly reviewed corpus")
    pilot = json.loads(Path(args.pilot_manifest).read_text(encoding="utf-8"))
    pilot_ids = set(pilot.get("records", []))
    if pilot.get("schemaVersion") != 1 or len(pilot_ids) != 18:
        raise ValueError("pilot manifest is invalid")
    train_items = [item for item in train_items if item["metadata"]["sampleId"] in pilot_ids]
    if {item["metadata"]["sampleId"] for item in train_items} != pilot_ids or len(train_items) != 1004:
        raise ValueError("compiled data does not contain the exact 1,004-sequence reviewed pilot slice")

    config = json.loads(Path(args.config).read_text(encoding="utf-8"))
    expected = expected_bindings(args, base_manifest_hash, compilation_hash, train_items, config)
    evaluation_interval = int(config.get("pilotEvaluationInterval", 5))
    epoch, steps, stored_metrics = validate_state(state, expected, evaluation_interval)

    cfg = json.loads((base / "rl_agent_config.json").read_text(encoding="utf-8"))
    if cfg.get("max_len") != 512 or cfg.get("head_max_len") != 192:
        raise ValueError("base checkpoint token limits changed")
    original_calibration = {key: cfg.get(key) for key in ("temperature", "temperature_by_options")}
    tokenizer = AutoTokenizer.from_pretrained(base / "tokenizer", local_files_only=True)
    model = build_model(cfg, encoder_dir=base / "encoder")
    model.load_state_dict(load_file(base / "model.safetensors"), strict=True)
    set_head_only(model)

    parameters = {name: parameter for name, parameter in model.named_parameters() if parameter.requires_grad}
    buffers = dict(model.named_buffers())
    for label, current in (("parameters", parameters), ("buffers", buffers)):
        stored = state.get(label)
        if (not isinstance(stored, dict) or stored.keys() != current.keys()
                or any(not isinstance(stored[name], torch.Tensor)
                       or stored[name].shape != tensor.shape or stored[name].dtype != tensor.dtype
                       for name, tensor in current.items())):
            raise ValueError(f"snapshot has incompatible {label}")
    with torch.no_grad():
        for current, stored in ((parameters, state["parameters"]), (buffers, state["buffers"])):
            for name, tensor in current.items():
                tensor.copy_(stored[name])
    model.to(torch.device("cpu"))

    predictions = predict(model, train_items, tokenizer.pad_token_id, torch.device("cpu"), detach_encoder=True)
    observed_metrics = sequence_metrics(train_items, predictions)
    if observed_metrics != stored_metrics:
        raise ValueError("snapshot predictions do not reproduce the stored evaluated metric")

    candidate_id = f"english-head-pilot-e{epoch}-{state_sha256[:12]}"
    manifest = {
        "schemaVersion": 1,
        "id": candidate_id,
        "revision": None,
        "experimental": True,
        "diagnosticsOnly": True,
        "snapshot": True,
        "trainingComplete": False,
        "gate": "pilotOnly",
        "promotionEligible": False,
        "base": {"id": "base-english", "repository": "convaiinnovations/laya", "revision": base_manifest.get("revision")},
        "contract": CONTRACT,
        "sourceStateSha256": state_sha256,
        "snapshotEpoch": epoch,
        "metricsEpoch": epoch,
        "metricsMatchWeights": True,
        "optimizerSteps": steps,
        "expectedOptimizerSteps": epoch * expected["optimizerStepsPerEpoch"],
        "maximumEpochs": expected["maximumEpochs"],
        "maximumOptimizerSteps": expected["maximumOptimizerSteps"],
        "trainingScope": "head-only",
        "trainingSequences": len(train_items),
        "reviewedTrainingRecords": len(pilot_ids),
        "sequenceMetrics": observed_metrics,
        "metricWarning": "Teacher-forced reviewed training-sequence accuracy is not production-mapper accuracy.",
        "bindings": expected,
        "calibration": {"status": "unchanged", "sha256": sha256_json(original_calibration)},
        "serialization": {"frozenEncoder": "float16", "trainedHead": "float32"},
        "createdAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
    }

    output.parent.mkdir(parents=True, exist_ok=True)
    temporary = Path(tempfile.mkdtemp(prefix=output.name + ".", dir=output.parent))
    try:
        save_inference_checkpoint(model, tokenizer, cfg, temporary, manifest)
        require_finite(load_file(temporary / "model.safetensors"), "exported mixed-precision checkpoint")
        weights_sha256 = streaming_sha256(temporary / "model.safetensors")
        manifest["revision"] = weights_sha256
        manifest["weightsSha256"] = weights_sha256
        inference_files = {}
        for file in sorted(path for path in temporary.rglob("*") if path.is_file() and path.name != "manifest.json"):
            relative = file.relative_to(temporary).as_posix()
            inference_files[relative] = {"size": file.stat().st_size, "sha256": streaming_sha256(file)}
        manifest["inferenceFiles"] = inference_files
        manifest["reloadVerification"] = verify_saved_reload(
            predictions, cfg, temporary, train_items, tokenizer.pad_token_id, torch.device("cpu")
        )
        (temporary / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
        os.replace(temporary, output)
    finally:
        if temporary.exists():
            shutil.rmtree(temporary, ignore_errors=True)
    print(json.dumps(manifest, separators=(",", ":")), flush=True)


if __name__ == "__main__":
    main()
