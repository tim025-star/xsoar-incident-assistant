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
import random
import time
from pathlib import Path
from typing import Any

os.environ.setdefault("HF_HUB_OFFLINE", "1")
os.environ.setdefault("TRANSFORMERS_OFFLINE", "1")
os.environ.setdefault("HF_DATASETS_OFFLINE", "1")

import torch
from laya.common import build_model, proper_reward
from safetensors.torch import load_file, save_file
from transformers import AutoTokenizer

from compiler import CONTRACT, canonical_json, item_hash, sha256_json, verify_base_model

DEFAULT_EPOCHS = 4
GROUP_SIZE = 4


def progress(detail: str, value: float) -> None:
    print(json.dumps({"detail": detail, "progress": value}, separators=(",", ":")), flush=True)


def sha256_file(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


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


def forward(model, batch, device, *, detach_encoder=False):
    return model(batch["input_ids"].to(device), batch["attention_mask"].to(device),
                 batch["marker_pos"].to(device), batch["marker_mask"].to(device), batch["qtype"].to(device),
                 detach_encoder=detach_encoder)


def predict(model, items, pad_id, device, *, detach_encoder=False):
    rows = []
    model.eval()
    with torch.no_grad():
        for start in range(0, len(items), 8):
            chunk = items[start:start + 8]
            batch = collate(chunk, pad_id)
            logits, _ = forward(model, batch, device, detach_encoder=detach_encoder)
            for index, item in enumerate(chunk):
                values = logits[index, :len(item["markers"])].float().cpu()
                rows.append({"choice": int(values.argmax().item()), "logits": values.tolist()})
    return rows


def sequence_metrics(items, predictions):
    correct = sum(int(prediction["choice"] == item["label"]) for item, prediction in zip(items, predictions))
    selections = [(item, prediction) for item, prediction in zip(items, predictions) if item["metadata"]["phase"] == "selection"]
    classification = [(item, prediction) for item, prediction in zip(items, predictions) if item["metadata"]["phase"] == "classify"]
    return {
        "metricScope": "teacher-forced-rendered-sequences",
        "sequenceAccuracy": correct / max(1, len(items)),
        "selectionSequenceAccuracy": sum(int(prediction["choice"] == item["label"]) for item, prediction in selections) / max(1, len(selections)),
        "classificationWindowAccuracy": sum(int(prediction["choice"] == item["label"]) for item, prediction in classification) / max(1, len(classification)),
        "sequences": len(items),
        "endToEndPointerAccuracy": None,
        "promotionEvaluationRequired": True,
    }


def save_checkpoint(model, tokenizer, cfg, output: Path, manifest: dict[str, Any]) -> None:
    output.mkdir(parents=True, exist_ok=True)
    save_file({key: value.half().contiguous().cpu() for key, value in model.state_dict().items()}, output / "model.safetensors")
    model.encoder.config.save_pretrained(output / "encoder")
    tokenizer.save_pretrained(output / "tokenizer")
    (output / "rl_agent_config.json").write_text(json.dumps(cfg, indent=2) + "\n", encoding="utf-8")
    (output / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")


def verify_reload(model, cfg, checkpoint: Path, probe, pad_id, device, *, detach_encoder=False):
    before = predict(model, probe, pad_id, device, detach_encoder=detach_encoder)
    reloaded = build_model(cfg, encoder_dir=checkpoint / "encoder")
    reloaded.load_state_dict(load_file(checkpoint / "model.safetensors"), strict=True)
    reloaded.to(device)
    after = predict(reloaded, probe, pad_id, device, detach_encoder=detach_encoder)
    if [row["choice"] for row in before] != [row["choice"] for row in after]:
        raise ValueError("saved checkpoint changes validation predictions after reload")
    maximum_delta = max((abs(left - right) for a, b in zip(before, after) for left, right in zip(a["logits"], b["logits"])), default=0.0)
    if maximum_delta > 0.01:
        raise ValueError("saved checkpoint logits drift after reload")
    return {"choicesEqual": True, "maximumLogitDelta": maximum_delta, "probeSequences": len(probe)}


def train(args) -> None:
    base = Path(args.base)
    base_manifest_path = Path(args.base_manifest)
    base_manifest = verify_base_model(base, base_manifest_path)
    base_manifest_hash = sha256_json(base_manifest)
    train_items, development_items, compilation, compilation_hash = load_compiled(Path(args.compiled), base_manifest_hash)
    review_gates = set(compilation.get("reviewGates", []))
    if args.pilot and review_gates != {"pilotOnly"}:
        raise ValueError("pilot training requires exclusively pilotOnly reviewed source records")
    if not args.pilot and review_gates != {"releaseCandidate"}:
        raise ValueError("non-pilot training requires exclusively releaseCandidate reviewed source records")
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
    micro_batch = 4 if device.type == "cuda" else 1
    accumulation = 8 if device.type == "cuda" else 16
    epochs = int(config.get("pilotEpochs", 30) if args.pilot else config.get("epochs", DEFAULT_EPOCHS))
    micro_batches_per_epoch = math.ceil(len(train_items) / micro_batch)
    optimizer_steps_per_epoch = math.ceil(micro_batches_per_epoch / accumulation)
    total_optimizer_steps = max(1, optimizer_steps_per_epoch * epochs)
    scheduler = torch.optim.lr_scheduler.CosineAnnealingLR(optimizer, T_max=total_optimizer_steps, eta_min=1e-6)
    scaler = torch.amp.GradScaler("cuda", enabled=device.type == "cuda")
    optimizer_steps = 0
    started = time.time()
    for epoch in range(epochs):
        model.train()
        random.Random(42 + epoch).shuffle(train_items)
        optimizer.zero_grad(set_to_none=True)
        for batch_index, start in enumerate(range(0, len(train_items), micro_batch), 1):
            items = train_items[start:start + micro_batch]
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
            scaler.scale((rl_loss + ce_loss + 0.0 * activity.sum()) / accumulation).backward()
            if batch_index % accumulation == 0 or start + micro_batch >= len(train_items):
                scaler.unscale_(optimizer)
                torch.nn.utils.clip_grad_norm_(model.parameters(), 1.0)
                scaler.step(optimizer)
                scaler.update()
                optimizer.zero_grad(set_to_none=True)
                scheduler.step()
                optimizer_steps += 1
            completed = epoch * len(train_items) + min(len(train_items), start + micro_batch)
            progress(f"Training epoch {epoch + 1} of {epochs} on {device.type}.", 5 + 80 * completed / (len(train_items) * epochs))
    metrics = sequence_metrics(development_items, predict(model, development_items, tokenizer.pad_token_id, device, detach_encoder=scope == "head-only"))
    if args.pilot and metrics["sequenceAccuracy"] < float(config.get("pilotMinimumAccuracy", 0.95)):
        raise ValueError("tiny-overfit pilot did not reach its reviewed sequence target")
    if {key: cfg.get(key) for key in original_calibration} != original_calibration:
        raise ValueError("training changed shipped calibration unexpectedly")
    output = Path(args.output)
    manifest = {
        "schemaVersion": 2, "id": run_id, "base": "laya-english", "contract": CONTRACT,
        "baseModelManifestHash": base_manifest_hash, "compilationManifestHash": compilation_hash,
        "createdAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), "pilot": args.pilot,
        "trainingSequences": len(train_items), "developmentSequences": len(development_items),
        "optimizerSteps": optimizer_steps, "expectedOptimizerSteps": total_optimizer_steps,
        "trainingScope": scope, "trainableParameters": trainable_parameters, "totalParameters": total_parameters,
        "device": device.type, "durationSeconds": round(time.time() - started, 1),
        "calibration": {"status": "unchanged", "sha256": sha256_json(original_calibration)},
        "sequenceMetrics": metrics, "promotionEligible": False,
    }
    save_checkpoint(model, tokenizer, cfg, output, manifest)
    manifest["reloadVerification"] = verify_reload(model, cfg, output, development_items[:8], tokenizer.pad_token_id, device, detach_encoder=scope == "head-only")
    (output / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    progress("Developer checkpoint created; full production-mapper promotion evaluation is still required.", 100)


def main() -> None:
    parser = argparse.ArgumentParser()
    command = parser.add_subparsers(dest="command", required=True).add_parser("train")
    command.add_argument("--compiled", required=True)
    command.add_argument("--config", required=True)
    command.add_argument("--base", required=True)
    command.add_argument("--base-manifest", default=str(Path(__file__).with_name("base-model-manifest.json")))
    command.add_argument("--output", required=True)
    command.add_argument("--run-id", required=True)
    command.add_argument("--device", choices=["auto", "cpu", "cuda"], default="auto")
    command.add_argument("--pilot", action="store_true")
    command.add_argument("--pilot-manifest", default=str(Path(__file__).with_name("tiny-overfit-pilot.json")))
    command.add_argument("--training-scope", choices=["head-only", "last-layer-head", "full"], default="head-only")
    args = parser.parse_args()
    train(args)


if __name__ == "__main__":
    try:
        main()
    except Exception:
        progress("Developer Laya fine-tuning failed.", 0)
        raise
