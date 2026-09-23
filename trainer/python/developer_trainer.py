"""Developer-only trainer for hashed production-rendered Laya sequences.

This executable never ships with the customer inference runtime.  Its metrics
are deliberately sequence-level; promotion requires a separate full
production-mapper evaluation over untouched frozen source families.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import os
import platform
import random
import sys
import tempfile
import time
from pathlib import Path
from typing import Any

os.environ.setdefault("HF_HUB_OFFLINE", "1")
os.environ.setdefault("TRANSFORMERS_OFFLINE", "1")
os.environ.setdefault("HF_DATASETS_OFFLINE", "1")

import torch
from laya import __version__ as laya_version
from laya.common import build_model, proper_reward
from safetensors import __version__ as safetensors_version
from safetensors.torch import load_file, save_file
from transformers import AutoTokenizer, __version__ as transformers_version

from compiler import CONTRACT, canonical_json, item_hash, sha256_json, verify_base_model

DEFAULT_EPOCHS = 4
GROUP_SIZE = 4


def progress(detail: str, value: float) -> None:
    print(json.dumps({"detail": detail, "progress": value}, separators=(",", ":")), flush=True)


def sha256_file(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def runtime_identity(device: torch.device) -> dict[str, Any]:
    return {
        "python": platform.python_version(), "torch": str(torch.__version__),
        "laya": laya_version, "transformers": transformers_version,
        "safetensors": safetensors_version, "threads": torch.get_num_threads(),
        "interopThreads": torch.get_num_interop_threads(),
        "cuda": torch.version.cuda if device.type == "cuda" else None,
        "cudaDevices": [torch.cuda.get_device_name(index) for index in range(torch.cuda.device_count())]
        if device.type == "cuda" else [],
    }


def load_compiled(compiled: Path, base_manifest_hash: str) -> tuple[list[dict[str, Any]], list[dict[str, Any]], dict[str, Any], str]:
    manifest_path = compiled / "compilation-manifest.json"
    manifest_bytes = manifest_path.read_bytes()
    manifest = json.loads(manifest_bytes)
    if manifest.get("schemaVersion") != 1 or manifest.get("contract") != CONTRACT or manifest.get("baseModelManifestHash") != base_manifest_hash:
        raise ValueError("compiled dataset contract or base identity mismatch")
    if manifest.get("frozenTestPurpose") != "production-mapper-promotion-only":
        raise ValueError("compiled dataset does not protect the frozen test partition")
    groups = manifest.get("groups", {})
    partitions = [set(groups.get(name, [])) for name in ("train", "development", "frozen-test")]
    if any(partitions[left].intersection(partitions[right]) for left in range(3) for right in range(left + 1, 3)):
        raise ValueError("compiled dataset has template-family split leakage")

    def load_partition(name: str) -> list[dict[str, Any]]:
        path = compiled / f"{name}.jsonl"
        if sha256_file(path) != manifest.get("files", {}).get(f"{name}.jsonl"):
            raise ValueError(f"compiled {name} file hash mismatch")
        rows = [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines() if line]
        for row in rows:
            if row.get("schemaVersion") != 1 or row.get("contract") != CONTRACT or row.get("baseModelManifestHash") != base_manifest_hash:
                raise ValueError(f"compiled {name} item identity mismatch")
            if row.get("itemHash") != item_hash(row):
                raise ValueError(f"compiled {name} item hash mismatch")
            if row.get("renderProof", {}).get("ids") != row.get("ids") or row.get("renderProof", {}).get("markers") != row.get("markers") or row.get("renderProof", {}).get("qtype") != row.get("qtype"):
                raise ValueError(f"compiled {name} render proof mismatch")
        return rows

    # Frozen-test is hash-verified for custody, but its rows are never loaded into
    # this process. Only the production-mapper promotion evaluator may read it.
    frozen_path = compiled / "frozen-test.jsonl"
    if sha256_file(frozen_path) != manifest.get("files", {}).get("frozen-test.jsonl"):
        raise ValueError("compiled frozen-test file hash mismatch")
    return load_partition("train"), load_partition("development"), manifest, hashlib.sha256(manifest_bytes).hexdigest()


def collate(items, pad_id):
    length = max(len(item["ids"]) for item in items)
    choices = max(len(item["markers"]) for item in items)
    count = len(items)
    ids = torch.full((count, length), pad_id, dtype=torch.long)
    attention = torch.zeros((count, length), dtype=torch.long)
    marker_pos = torch.zeros((count, choices), dtype=torch.long)
    marker_mask = torch.zeros((count, choices), dtype=torch.bool)
    target = torch.zeros((count, choices), dtype=torch.float32)
    for index, item in enumerate(items):
        ids[index, :len(item["ids"])] = torch.tensor(item["ids"])
        attention[index, :len(item["ids"])] = 1
        size = len(item["markers"])
        marker_pos[index, :size] = torch.tensor(item["markers"])
        marker_mask[index, :size] = True
        target[index, :len(item["target"])] = torch.tensor(item["target"], dtype=torch.float32)
    return {"input_ids": ids, "attention_mask": attention, "marker_pos": marker_pos, "marker_mask": marker_mask,
            "target": target, "qtype": torch.tensor([item["qtype"] for item in items]),
            "label": torch.tensor([item["label"] for item in items])}


def length_bucketed_batches(items, batch_size, seed):
    ordered = sorted(items, key=lambda item: (len(item["ids"]), item["itemHash"]))
    batches = [ordered[start:start + batch_size] for start in range(0, len(ordered), batch_size)]
    random.Random(seed).shuffle(batches)
    return batches


def forward(model, batch, device, *, detach_encoder=False):
    return model(batch["input_ids"].to(device), batch["attention_mask"].to(device),
                 batch["marker_pos"].to(device), batch["marker_mask"].to(device), batch["qtype"].to(device),
                 detach_encoder=detach_encoder)


def predict(model, items, pad_id, device, *, detach_encoder=False, batch_size=16):
    if type(batch_size) is not int or batch_size < 1:
        raise ValueError("prediction batch size must be a positive integer")
    rows = [None] * len(items)
    indexed = sorted(enumerate(items), key=lambda pair: (len(pair[1]["ids"]), pair[0]))
    model.eval()
    with torch.no_grad():
        for start in range(0, len(indexed), batch_size):
            chunk = indexed[start:start + batch_size]
            chunk_items = [item for _, item in chunk]
            batch = collate(chunk_items, pad_id)
            logits, _ = forward(model, batch, device, detach_encoder=detach_encoder)
            for batch_index, (original_index, item) in enumerate(chunk):
                values = logits[batch_index, :len(item["markers"])].float().cpu()
                if not bool(torch.isfinite(values).all()):
                    raise ValueError("non-finite prediction logits")
                rows[original_index] = {"choice": int(values.argmax().item()), "logits": values.tolist()}
    if any(row is None for row in rows):
        raise ValueError("sequence predictions have incomplete coverage")
    return rows


def sequence_metrics(items, predictions):
    if len(items) != len(predictions):
        raise ValueError("sequence predictions have incomplete coverage")
    correct = sum(int(prediction["choice"] == item["label"]) for item, prediction in zip(items, predictions))
    selections = [(item, prediction) for item, prediction in zip(items, predictions) if item["metadata"]["phase"] == "selection"]
    classification = [(item, prediction) for item, prediction in zip(items, predictions) if item["metadata"]["phase"] == "classify"]
    groups = {name: {} for name in ("phase", "answer", "target", "family")}
    for item, prediction in zip(items, predictions):
        metadata = item["metadata"]
        positive = item["label"] == 1 if metadata["phase"] == "classify" else metadata["goldChoice"] != "__none__"
        keys = {"phase": metadata["phase"], "answer": "positive" if positive else "none",
                "target": metadata["target"], "family": metadata["splitUnit"]["templateFamily"]}
        for name, key in keys.items():
            group = groups[name].setdefault(key, {"correct": 0, "sequences": 0})
            group["sequences"] += 1
            group["correct"] += int(prediction["choice"] == item["label"])
    for values in groups.values():
        for group in values.values():
            group["accuracy"] = group["correct"] / group["sequences"]
    return {
        "metricScope": "teacher-forced-rendered-sequences",
        "sequenceAccuracy": correct / max(1, len(items)),
        "selectionSequenceAccuracy": sum(int(prediction["choice"] == item["label"]) for item, prediction in selections) / max(1, len(selections)),
        "classificationWindowAccuracy": sum(int(prediction["choice"] == item["label"]) for item, prediction in classification) / max(1, len(classification)),
        "sequences": len(items),
        "endToEndPointerAccuracy": None,
        "promotionEvaluationRequired": True,
        "subgroups": groups,
    }


def require_finite(value, context):
    if isinstance(value, torch.Tensor):
        valid = not (value.is_floating_point() or value.is_complex()) or bool(torch.isfinite(value).all())
    elif isinstance(value, float):
        valid = math.isfinite(value)
    elif isinstance(value, dict):
        for key, item in value.items():
            require_finite(item, f"{context}.{key}")
        return
    elif isinstance(value, (tuple, list)):
        for item in value:
            require_finite(item, context)
        return
    else:
        return
    if not valid:
        raise ValueError(f"non-finite training state: {context}")


def save_recovery_state(path, model, optimizer, scheduler, scaler, bindings, epochs_completed,
                        optimizer_steps, elapsed_seconds, metrics, *, gate, kind):
    """Atomically replace a run-bound recovery state; never export a promotable checkpoint."""
    state = {
        "schemaVersion": 1, "kind": kind, "gate": gate, "promotionEligible": False,
        "bindings": bindings, "epochsCompleted": epochs_completed, "optimizerSteps": optimizer_steps,
        "elapsedSeconds": elapsed_seconds, "metrics": metrics,
        # Frozen parameters come from the hash-verified base; mutable buffers do not.
        # Preserve training precision. The final inference export is separately fp16.
        "parameters": {name: parameter.detach() for name, parameter in model.named_parameters() if parameter.requires_grad},
        "buffers": {name: buffer.detach() for name, buffer in model.named_buffers()},
        "optimizer": optimizer.state_dict(),
        "scheduler": scheduler.state_dict(), "scaler": scaler.state_dict(),
        "rng": {"python": random.getstate(), "torch": torch.get_rng_state(),
                "cuda": torch.cuda.get_rng_state_all() if bindings["device"].startswith("cuda") else []},
    }
    require_finite(state, "training recovery")
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = None
    try:
        with tempfile.NamedTemporaryFile(dir=path.parent, prefix=path.name + ".", suffix=".tmp", delete=False) as handle:
            temporary = Path(handle.name)
            torch.save(state, handle)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, path)
    finally:
        if temporary is not None and temporary.exists():
            temporary.unlink()


def restore_recovery_state(path, model, optimizer, scheduler, scaler, bindings, *, gate, kind):
    # Explicit weights_only avoids arbitrary pickle execution from a supplied file.
    state = torch.load(path, map_location="cpu", weights_only=True)
    if (state.get("schemaVersion") != 1 or state.get("kind") != kind
            or state.get("gate") != gate or state.get("promotionEligible") is not False
            or state.get("bindings") != bindings):
        raise ValueError("training recovery state does not match this exact run and its artifact/config/scope bindings")
    epoch, steps = state.get("epochsCompleted"), state.get("optimizerSteps")
    if (type(epoch) is not int or not 1 <= epoch <= bindings["maximumEpochs"]
            or type(steps) is not int or steps != epoch * bindings["optimizerStepsPerEpoch"]
            or state["scheduler"].get("last_epoch") != steps
            or state["scheduler"].get("T_max") != bindings["maximumOptimizerSteps"]):
        raise ValueError("training recovery state has inconsistent epoch or fixed-schedule counters")
    elapsed = state.get("elapsedSeconds")
    if not isinstance(elapsed, (int, float)) or not math.isfinite(elapsed) or elapsed < 0:
        raise ValueError("training recovery state has invalid elapsed time")
    rng = state["rng"]
    if len(rng["cuda"]) != (torch.cuda.device_count() if bindings["device"].startswith("cuda") else 0):
        raise ValueError("training recovery state has incompatible CUDA RNG states")
    parameters = {name: parameter for name, parameter in model.named_parameters() if parameter.requires_grad}
    buffers = dict(model.named_buffers())
    for key, current in (("parameters", parameters), ("buffers", buffers)):
        stored = state.get(key)
        if (not isinstance(stored, dict) or stored.keys() != current.keys()
                or any(not isinstance(stored[name], torch.Tensor) or stored[name].shape != tensor.shape
                       or stored[name].dtype != tensor.dtype for name, tensor in current.items())):
            raise ValueError(f"training recovery state has incompatible {key} keys, shapes or precision")
    require_finite(state, "training recovery")
    with torch.no_grad():
        for current, stored in ((parameters, state["parameters"]), (buffers, state["buffers"])):
            for name, tensor in current.items():
                tensor.copy_(stored[name])
    optimizer.load_state_dict(state["optimizer"])
    scheduler.load_state_dict(state["scheduler"])
    scaler.load_state_dict(state["scaler"])
    random.setstate(rng["python"])
    torch.set_rng_state(rng["torch"])
    if rng["cuda"]:
        torch.cuda.set_rng_state_all(rng["cuda"])
    # Release loaded parameter copies instead of retaining them throughout training.
    return {key: state[key] for key in ("epochsCompleted", "optimizerSteps", "elapsedSeconds", "metrics")}


def save_pilot_state(path, model, optimizer, scheduler, scaler, bindings, epochs_completed,
                     optimizer_steps, elapsed_seconds, metrics):
    """Backward-compatible pilot recovery entry point used by existing runs and tests."""
    return save_recovery_state(path, model, optimizer, scheduler, scaler, bindings, epochs_completed,
                               optimizer_steps, elapsed_seconds, metrics,
                               gate="pilotOnly", kind="pilot-resume-state")


def restore_pilot_state(path, model, optimizer, scheduler, scaler, bindings):
    """Backward-compatible pilot recovery entry point used by existing runs and tests."""
    return restore_recovery_state(path, model, optimizer, scheduler, scaler, bindings,
                                  gate="pilotOnly", kind="pilot-resume-state")


def save_checkpoint(model, tokenizer, cfg, output: Path, manifest: dict[str, Any]) -> None:
    output.mkdir(parents=True, exist_ok=True)
    parameters = dict(model.named_parameters())
    weights = {}
    for key, value in model.state_dict().items():
        # The frozen base was loaded from fp16, so writing it as fp16 is lossless.
        # Preserve trained parameters and mutable buffers at their working precision;
        # otherwise the export itself can change the newly trained model's logits.
        if value.is_floating_point() and key in parameters and not parameters[key].requires_grad:
            value = value.half()
        weights[key] = value.detach().contiguous().cpu()
    save_file(weights, output / "model.safetensors")
    model.encoder.config.save_pretrained(output / "encoder")
    tokenizer.save_pretrained(output / "tokenizer")
    (output / "rl_agent_config.json").write_text(json.dumps(cfg, indent=2) + "\n", encoding="utf-8")
    (output / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")


def verify_reload(model, cfg, checkpoint: Path, probe, pad_id, device, *, detach_encoder=False):
    verification_batch_size = 8 if torch.device(device).type == "cuda" else 16
    before = predict(model, probe, pad_id, device, detach_encoder=detach_encoder,
                     batch_size=verification_batch_size)
    # Verification is the final use of the trained model. Move it off the GPU
    # before constructing the reload copy so 6 GiB devices never hold both.
    model.to("cpu")
    if torch.device(device).type == "cuda":
        torch.cuda.empty_cache()
    reloaded = build_model(cfg, encoder_dir=checkpoint / "encoder")
    reloaded.load_state_dict(load_file(checkpoint / "model.safetensors"), strict=True)
    reloaded.to(device)
    after = predict(reloaded, probe, pad_id, device, detach_encoder=detach_encoder,
                    batch_size=verification_batch_size)
    if (len(before) != len(probe) or len(after) != len(probe)
            or any(len(row["logits"]) != len(item["markers"])
                   or not all(math.isfinite(value) for value in row["logits"])
                   for predictions in (before, after) for item, row in zip(probe, predictions))):
        raise ValueError("saved checkpoint has incomplete or non-finite reload predictions")
    if [row["choice"] for row in before] != [row["choice"] for row in after]:
        raise ValueError("saved checkpoint changes validation predictions after reload")
    maximum_delta = max((abs(left - right) for a, b in zip(before, after) for left, right in zip(a["logits"], b["logits"])), default=0.0)
    if maximum_delta > 0.01:
        raise ValueError("saved checkpoint logits drift after reload")
    return {"choicesEqual": True, "maximumLogitDelta": maximum_delta, "probeSequences": len(probe)}


def train(args) -> None:
    resume_path = getattr(args, "resume_state", None)
    base = Path(args.base)
    base_manifest_path = Path(args.base_manifest)
    base_manifest = verify_base_model(base, base_manifest_path)
    base_manifest_hash = sha256_json(base_manifest)
    train_items, development_items, compilation, compilation_hash = load_compiled(Path(args.compiled), base_manifest_hash)
    review_gates = set(compilation.get("reviewGates", []))
    if args.pilot and review_gates != {"pilotOnly"}:
        raise ValueError("pilot training requires exclusively pilotOnly reviewed source records")
    if not args.pilot and review_gates not in ({"trainingOnly"}, {"releaseCandidate"}):
        raise ValueError("non-pilot training requires exclusively trainingOnly or releaseCandidate reviewed source records")
    recovery_gate = next(iter(review_gates))
    recovery_kind = "pilot-resume-state" if args.pilot else "training-resume-state"
    recovery_suffix = ".pilot-state.pt" if args.pilot else ".training-state.pt"
    state_path = Path(args.output).with_name(Path(args.output).name + recovery_suffix)
    if state_path.exists() and not resume_path:
        raise ValueError("training recovery state already exists; explicitly resume it or use a new output")
    config = json.loads(Path(args.config).read_text(encoding="utf-8"))
    minimum = int(config.get("minimumSequences", 50))
    if len(train_items) < minimum or (not args.pilot and not development_items):
        raise ValueError("not enough compiled reviewed train/development sequences")
    if args.pilot:
        pilot = json.loads(Path(args.pilot_manifest).read_text(encoding="utf-8"))
        pilot_ids = set(pilot.get("records", []))
        if pilot.get("schemaVersion") != 1 or len(pilot_ids) != 18:
            raise ValueError("tiny-overfit pilot manifest is invalid")
        train_items = [item for item in train_items if item["metadata"]["sampleId"] in pilot_ids]
        observed = {item["metadata"]["sampleId"] for item in train_items}
        if observed != pilot_ids:
            raise ValueError("compiled training data does not contain the complete reviewed pilot slice")
        development_items = train_items
    cfg = json.loads((base / "rl_agent_config.json").read_text(encoding="utf-8"))
    if cfg.get("max_len") != 512 or cfg.get("head_max_len") != 192:
        raise ValueError("training requires the pinned English checkpoint token limits")
    original_calibration = {key: cfg.get(key) for key in ("temperature", "temperature_by_options")}
    tokenizer = AutoTokenizer.from_pretrained(base / "tokenizer", local_files_only=True)
    device = torch.device("cuda" if args.device == "auto" and torch.cuda.is_available() else args.device if args.device != "auto" else "cpu")
    if args.device == "cuda" and not torch.cuda.is_available():
        raise ValueError("CUDA was requested but is unavailable")
    random_seed = 42
    random.seed(random_seed)
    torch.manual_seed(random_seed)
    if device.type == "cuda":
        torch.cuda.manual_seed_all(random_seed)
    run_id = args.run_id
    weights_path = base / "model.safetensors"
    model = build_model(cfg, encoder_dir=base / "encoder")
    model.load_state_dict(load_file(weights_path), strict=True)
    scope = args.training_scope
    for parameter in model.parameters():
        parameter.requires_grad = scope == "full"
    if scope in ("head-only", "last-layer-head"):
        for name, parameter in model.named_parameters():
            if "encoder." not in name:
                parameter.requires_grad = True
    if scope == "last-layer-head":
        import re
        indexed = []
        for name, parameter in model.named_parameters():
            match = re.search(r"encoder\.(?:encoder\.)?(?:layer|layers)\.(\d+)\.", name)
            if match:
                indexed.append((int(match.group(1)), parameter))
        if not indexed:
            raise ValueError("could not identify the final encoder layer for the requested scope")
        final_index = max(index for index, _ in indexed)
        for index, parameter in indexed:
            if index == final_index:
                parameter.requires_grad = True
    trainable = [parameter for parameter in model.parameters() if parameter.requires_grad]
    trainable_parameters = sum(parameter.numel() for parameter in trainable)
    total_parameters = sum(parameter.numel() for parameter in model.parameters())
    progress(f"Training scope {scope}: {trainable_parameters} of {total_parameters} parameters trainable.", 3)
    if scope != "head-only" and hasattr(model.encoder, "gradient_checkpointing_enable"):
        model.encoder.gradient_checkpointing_enable(gradient_checkpointing_kwargs={"use_reentrant": False})
    model.to(device)
    optimizer = torch.optim.AdamW(trainable, lr=1e-4 if scope == "head-only" else 2.5e-5, weight_decay=0.01)
    if device.type == "cuda":
        micro_batch, accumulation = 4, 8
    elif scope == "head-only":
        micro_batch = int(config.get("cpuHeadOnlyMicroBatch", 16))
        accumulation = int(config.get("cpuHeadOnlyAccumulation", 1))
    else:
        micro_batch, accumulation = 1, 16
    if micro_batch < 1 or accumulation < 1:
        raise ValueError("microbatch and accumulation settings must be positive")
    epochs = int(config.get("pilotEpochs", 30) if args.pilot else config.get("epochs", DEFAULT_EPOCHS))
    pilot_target = float(config.get("pilotMinimumAccuracy", 0.95))
    pilot_evaluation_interval = int(config.get("pilotEvaluationInterval", 5))
    if epochs < 1 or pilot_evaluation_interval < 1:
        raise ValueError("epoch and pilot evaluation settings must be positive")
    micro_batches_per_epoch = math.ceil(len(train_items) / micro_batch)
    optimizer_steps_per_epoch = math.ceil(micro_batches_per_epoch / accumulation)
    total_optimizer_steps = max(1, optimizer_steps_per_epoch * epochs)
    scheduler = torch.optim.lr_scheduler.CosineAnnealingLR(optimizer, T_max=total_optimizer_steps, eta_min=1e-6)
    cuda_initial_grad_scale = float(config.get("cudaInitialGradScale", 1024))
    if not math.isfinite(cuda_initial_grad_scale) or cuda_initial_grad_scale <= 0:
        raise ValueError("CUDA initial gradient scale must be finite and positive")
    scaler = torch.amp.GradScaler("cuda", enabled=device.type == "cuda", init_scale=cuda_initial_grad_scale)
    optimizer_steps = 0
    epochs_completed = 0
    early_stopped = False
    metrics = None
    elapsed_before_resume = 0.0
    resumed_from_epoch = None
    resumed_from_optimizer_steps = None
    implementation_path = Path(sys.executable) if getattr(sys, "frozen", False) else Path(__file__)
    compiler_path = implementation_path if getattr(sys, "frozen", False) else Path(__file__).with_name("compiler.py")
    bindings = {
        "runId": run_id, "output": str(Path(args.output).resolve()), "contract": CONTRACT,
        "baseModelManifestHash": base_manifest_hash, "compilationManifestHash": compilation_hash,
        "trainerSha256": sha256_file(implementation_path),
        "compilerSha256": sha256_file(compiler_path),
        "trainingConfigSha256": sha256_file(Path(args.config)),
        "pilotManifestSha256": sha256_file(Path(args.pilot_manifest)) if args.pilot else None,
        "trainingScope": scope, "device": str(device), "randomSeed": random_seed,
        "microBatch": micro_batch, "gradientAccumulation": accumulation,
        "cudaInitialGradScale": cuda_initial_grad_scale,
        "maximumEpochs": epochs, "maximumOptimizerSteps": total_optimizer_steps,
        "optimizerStepsPerEpoch": optimizer_steps_per_epoch,
        "trainingItemsSha256": sha256_json([item["itemHash"] for item in train_items]),
        "runtime": runtime_identity(device),
    }
    if resume_path:
        restored = (restore_pilot_state(resume_path, model, optimizer, scheduler, scaler, bindings)
                    if args.pilot else
                    restore_recovery_state(resume_path, model, optimizer, scheduler, scaler, bindings,
                                           gate=recovery_gate, kind=recovery_kind))
        epochs_completed, optimizer_steps = restored["epochsCompleted"], restored["optimizerSteps"]
        resumed_from_epoch, resumed_from_optimizer_steps = epochs_completed, optimizer_steps
        elapsed_before_resume, metrics = restored["elapsedSeconds"], restored["metrics"]
        early_stopped = metrics is not None and metrics["sequenceAccuracy"] >= pilot_target and epochs_completed < epochs
        progress(f"Resumed training at epoch {epochs_completed} with {optimizer_steps} optimizer steps; fixed schedule unchanged.",
                 5 + 80 * epochs_completed / epochs)
    started = time.time()
    for epoch in range(epochs_completed, epochs):
        if early_stopped:
            break
        model.train()
        batches = length_bucketed_batches(train_items, micro_batch, 42 + epoch)
        optimizer.zero_grad(set_to_none=True)
        processed = 0
        for batch_index, items in enumerate(batches, 1):
            batch = collate(items, tokenizer.pad_token_id)
            with torch.autocast(device.type, dtype=torch.float16, enabled=device.type == "cuda"):
                logits, activity = forward(model, batch, device, detach_encoder=scope == "head-only")
            logits = logits.float()
            mask = batch["marker_mask"].to(device)
            target = batch["target"].to(device)
            counts = mask.sum(-1, keepdim=True).float()
            sigma = 0.4 + (0.1 - 0.4) * epoch / max(1, epochs - 1)
            noise = torch.randn((GROUP_SIZE,) + logits.shape, device=device) * sigma * mask
            noise = (noise - noise.sum(-1, keepdim=True) / counts) * mask
            sampled = logits.detach().unsqueeze(0) + noise
            probabilities = torch.softmax(sampled.masked_fill(~mask, -1e4), -1)
            with torch.no_grad():
                reward = proper_reward(probabilities, target.unsqueeze(0), batch["qtype"].to(device), mask, w_sph=0.75, w_rps=1.0)
                advantage = (reward - reward.mean(0, keepdim=True)) / (reward.std() + 1e-6)
            log_probability = -(((sampled - logits.unsqueeze(0)) ** 2) * mask).sum(-1) / (2 * sigma ** 2)
            rl_loss = -(advantage * log_probability).mean()
            ce_loss = -(target * torch.log_softmax(logits.masked_fill(~mask, -1e4), -1)).sum(-1).mean()
            loss = (rl_loss + ce_loss + 0.0 * activity.sum()) / accumulation
            require_finite(loss, "loss")
            scaler.scale(loss).backward()
            if batch_index % accumulation == 0 or batch_index == len(batches):
                scaler.unscale_(optimizer)
                torch.nn.utils.clip_grad_norm_(trainable, 1.0, error_if_nonfinite=True)
                scaler.step(optimizer)
                scaler.update()
                optimizer.zero_grad(set_to_none=True)
                scheduler.step()
                optimizer_steps += 1
            processed += len(items)
            completed = epoch * len(train_items) + processed
            progress(f"Training epoch {epoch + 1} of {epochs} on {device.type}.", 5 + 80 * completed / (len(train_items) * epochs))
        epochs_completed = epoch + 1
        if args.pilot and (epochs_completed % pilot_evaluation_interval == 0 or epochs_completed == epochs):
            metrics = sequence_metrics(
                development_items,
                predict(model, development_items, tokenizer.pad_token_id, device, detach_encoder=scope == "head-only"),
            )
            progress(f"Pilot sequence accuracy after epoch {epochs_completed}: {metrics['sequenceAccuracy']:.4f}.",
                     5 + 80 * epochs_completed / epochs)
            if metrics["sequenceAccuracy"] >= pilot_target:
                early_stopped = epochs_completed < epochs
        recovery_values = (state_path, model, optimizer, scheduler, scaler, bindings, epochs_completed,
                           optimizer_steps, elapsed_before_resume + time.time() - started, metrics)
        if args.pilot:
            save_pilot_state(*recovery_values)
        else:
            save_recovery_state(*recovery_values, gate=recovery_gate, kind=recovery_kind)
        if early_stopped:
            break
    if metrics is None:
        metrics = sequence_metrics(development_items, predict(model, development_items, tokenizer.pad_token_id, device, detach_encoder=scope == "head-only"))
    if args.pilot and metrics["sequenceAccuracy"] < pilot_target:
        raise ValueError("tiny-overfit pilot did not reach its reviewed sequence target")
    expected_completed_steps = optimizer_steps_per_epoch * epochs_completed
    if optimizer_steps != expected_completed_steps:
        raise ValueError("optimizer-step accounting drifted from the completed epochs")
    if {key: cfg.get(key) for key in original_calibration} != original_calibration:
        raise ValueError("training changed shipped calibration unexpectedly")
    output = Path(args.output)
    manifest = {
        "schemaVersion": 2, "id": run_id, "base": "laya-english", "contract": CONTRACT,
        "baseModelManifestHash": base_manifest_hash, "compilationManifestHash": compilation_hash,
        "trainerSha256": bindings["trainerSha256"],
        "trainingConfigSha256": sha256_file(Path(args.config)),
        "pilotManifestSha256": sha256_file(Path(args.pilot_manifest)) if args.pilot else None,
        "createdAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), "pilot": args.pilot,
        "trainingSequences": len(train_items), "developmentSequences": len(development_items),
        "optimizerSteps": optimizer_steps, "expectedOptimizerSteps": expected_completed_steps,
        "maximumOptimizerSteps": total_optimizer_steps, "epochsCompleted": epochs_completed,
        "maximumEpochs": epochs, "earlyStopped": early_stopped,
        "randomSeed": random_seed, "microBatch": micro_batch, "gradientAccumulation": accumulation,
        "cudaInitialGradScale": cuda_initial_grad_scale,
        "trainingScope": scope, "trainableParameters": trainable_parameters, "totalParameters": total_parameters,
        "device": device.type, "durationSeconds": round(elapsed_before_resume + time.time() - started, 1),
        "resumed": bool(resume_path), "resumedFromEpoch": resumed_from_epoch,
        "resumedFromOptimizerSteps": resumed_from_optimizer_steps,
        "recoveryState": state_path.name,
        "calibration": {"status": "unchanged", "sha256": sha256_json(original_calibration)},
        "weightPrecision": {"trainedParameters": "source", "frozenParameters": "float16", "buffers": "source"},
        "sequenceMetrics": metrics, "reviewGates": sorted(review_gates), "promotionEligible": False,
    }
    # Recovery is already durable and training is complete. Release optimiser
    # tensors before the inference-only export verification begins.
    del optimizer, scheduler, scaler, trainable
    if device.type == "cuda":
        torch.cuda.empty_cache()
    save_checkpoint(model, tokenizer, cfg, output, manifest)
    manifest["reloadVerification"] = verify_reload(model, cfg, output, development_items, tokenizer.pad_token_id, device, detach_encoder=scope == "head-only")
    (output / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    progress("Developer checkpoint created; full production-mapper promotion evaluation is still required.", 100)


def main() -> None:
    parser = argparse.ArgumentParser()
    subparsers = parser.add_subparsers(dest="command", required=True)
    command = subparsers.add_parser("train")
    command.add_argument("--compiled", required=True)
    command.add_argument("--config", required=True)
    command.add_argument("--base", required=True)
    command.add_argument("--base-manifest", default=str(Path(__file__).with_name("base-model-manifest.json")))
    command.add_argument("--output", required=True)
    command.add_argument("--run-id", required=True)
    command.add_argument("--device", choices=["auto", "cpu", "cuda"], default="auto")
    command.add_argument("--pilot", action="store_true")
    command.add_argument("--resume-state", help="Resume an exact run from its epoch-boundary recovery state")
    command.add_argument("--pilot-manifest", default=str(Path(__file__).with_name("tiny-overfit-pilot.json")))
    command.add_argument("--training-scope", choices=["head-only", "last-layer-head", "full"], default="head-only")
    status = subparsers.add_parser("runtime-status")
    status.add_argument("--device", choices=["cpu", "cuda"], default="cpu")
    args = parser.parse_args()
    if args.command == "runtime-status":
        if args.device == "cuda" and not torch.cuda.is_available():
            raise ValueError("CUDA was requested but is unavailable")
        print(json.dumps(runtime_identity(torch.device(args.device)), sort_keys=True))
    else:
        train(args)


if __name__ == "__main__":
    try:
        main()
    except Exception:
        progress("Developer Laya fine-tuning failed.", 0)
        raise
