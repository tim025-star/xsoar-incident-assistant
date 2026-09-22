"""Offline CPU/CUDA fine-tuner for the XSOAR Laya-mapper checkpoint."""

import argparse
import json
import math
import os
import random
import sys
import time
import uuid
from pathlib import Path

os.environ.setdefault("HF_HUB_OFFLINE", "1")
os.environ.setdefault("TRANSFORMERS_OFFLINE", "1")
os.environ.setdefault("HF_DATASETS_OFFLINE", "1")

import torch
from safetensors.torch import load_file, save_file
from transformers import AutoTokenizer
from laya.common import QTYPES, build_model, build_sequence, proper_reward, render_options


MAX_CHUNK_TOKENS = 700
MAX_CHOICES = 6
EPOCHS = 4
GROUP_SIZE = 4


def progress(detail, value):
    print(json.dumps({"detail": detail, "progress": value}, separators=(",", ":")), flush=True)


def pointer_part(value):
    return str(value).replace("~", "~0").replace("/", "~1")


def flatten(documents):
    leaves = []

    def visit(value, parts):
        if isinstance(value, list):
            for index, item in enumerate(value):
                visit(item, parts + [str(index)])
        elif isinstance(value, dict):
            for key, item in value.items():
                visit(item, parts + [str(key)])
        else:
            leaves.append({
                "id": f"leaf-{len(leaves)}",
                "pointer": "/" + "/".join(pointer_part(item) for item in parts),
                "ancestry": parts[:-1],
                "key": parts[-1] if parts else "",
                "value": value,
            })

    for index, document in enumerate(documents):
        visit(document, ["documents", str(index)])
    return leaves


def token_chunks(tokenizer, leaves):
    chunks, current = [], []
    for leaf in leaves:
        proposed = current + [leaf]
        rendered = json.dumps({"leaves": proposed}, ensure_ascii=False, separators=(",", ":"))
        count = len(tokenizer.encode(rendered, add_special_tokens=True))
        if current and count > MAX_CHUNK_TOKENS:
            chunks.append(current)
            current = [leaf]
        else:
            current = proposed
    if current:
        chunks.append(current)
    return chunks


def build_item(tokenizer, cfg, state, question, target, metadata):
    qtype = question["type"]
    criteria = question.get("criteria", {})
    rendered = {"t": qtype, "ins": question["instructions"], "crit": criteria}
    sequence, markers = build_sequence(tokenizer, state, rendered, cfg["max_len"], cfg["head_max_len"])
    option_count = len(render_options({"t": qtype, "crit": criteria}))
    if len(markers) != option_count or len(target) != option_count:
        return None
    return {
        "ids": sequence,
        "markers": markers,
        "qtype": QTYPES[qtype],
        "target": target,
        "label": max(range(len(target)), key=target.__getitem__),
        "metadata": metadata,
    }


def training_items(examples, tokenizer, cfg):
    items = []
    for example in examples:
        leaves = flatten(example["documents"])
        chunks = token_chunks(tokenizer, leaves)
        for target_name, label in example["labels"].items():
            if label["state"] == "unlabelled":
                continue
            gold_pointer = label.get("pointer", "")
            for chunk_index, chunk in enumerate(chunks):
                relevant = bool(gold_pointer and any(leaf["pointer"] == gold_pointer for leaf in chunk))
                item = build_item(
                    tokenizer,
                    cfg,
                    {"json_fields": chunk},
                    {
                        "type": "noul",
                        "instructions": f"Does this JSON chunk contain the source value for canonical field '{target_name}'?",
                    },
                    [0.0, 1.0] if relevant else [1.0, 0.0],
                    {"phase": "relevance", "target": target_name, "example": example["id"], "chunk": chunk_index},
                )
                if item:
                    items.append(item)
                if not relevant:
                    continue
                for start in range(0, len(chunk), MAX_CHOICES):
                    candidates = chunk[start:start + MAX_CHOICES]
                    ids = [candidate["id"] for candidate in candidates]
                    if not any(candidate["pointer"] == gold_pointer for candidate in candidates):
                        continue
                    criteria = {
                        candidate["id"]: (
                            f"JSON pointer {candidate['pointer']}; parent structure "
                            f"{json.dumps(candidate['ancestry'], ensure_ascii=False)}; field {candidate['key']}; "
                            f"value {json.dumps(candidate['value'], ensure_ascii=False)}"
                        )
                        for candidate in candidates
                    }
                    gold_index = next(i for i, candidate in enumerate(candidates) if candidate["pointer"] == gold_pointer)
                    target = [1.0 if index == gold_index else 0.0 for index in range(len(candidates))]
                    item = build_item(
                        tokenizer,
                        cfg,
                        {"json_context": chunk},
                        {
                            "type": "choice",
                            "instructions": f"Which exact JSON field contains canonical field '{target_name}'?",
                            "criteria": criteria,
                        },
                        target,
                        {"phase": "selection", "target": target_name, "example": example["id"], "options": ids},
                    )
                    if item:
                        items.append(item)
    return items


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
    return {
        "input_ids": ids,
        "attention_mask": attention,
        "marker_pos": marker_pos,
        "marker_mask": marker_mask,
        "target": target,
        "qtype": torch.tensor([item["qtype"] for item in items]),
        "label": torch.tensor([item["label"] for item in items]),
    }


def forward(model, batch, device):
    return model(
        batch["input_ids"].to(device),
        batch["attention_mask"].to(device),
        batch["marker_pos"].to(device),
        batch["marker_mask"].to(device),
        batch["qtype"].to(device),
    )


def fit_temperatures(predictions):
    values = [1.0, 1.0, 1.0]
    for qtype in range(3):
        selected = [(logits, target) for item_type, logits, target in predictions if item_type == qtype]
        if len(selected) < 10:
            continue
        width = max(len(logits) for logits, _ in selected)
        logits = torch.full((len(selected), width), -1e4)
        targets = torch.zeros((len(selected), width))
        for index, (row_logits, row_target) in enumerate(selected):
            logits[index, :len(row_logits)] = torch.tensor(row_logits)
            targets[index, :len(row_target)] = torch.tensor(row_target)
        log_temperature = torch.zeros(1, requires_grad=True)
        optimizer = torch.optim.LBFGS([log_temperature], lr=0.1, max_iter=100)

        def closure():
            optimizer.zero_grad()
            loss = -(targets * torch.log_softmax(logits / log_temperature.exp(), -1)).sum(-1).mean()
            loss.backward()
            return loss

        optimizer.step(closure)
        values[qtype] = float(torch.clamp(log_temperature.exp(), 0.1, 10.0).item())
    return values


def evaluate(model, items, pad_id, device):
    correct = 0
    selection_total = 0
    selection_correct = 0
    predictions = []
    per_field = {}
    model.eval()
    with torch.no_grad():
        for start in range(0, len(items), 8):
            chunk = items[start:start + 8]
            batch = collate(chunk, pad_id)
            logits, _ = forward(model, batch, device)
            logits = logits.float().cpu()
            for index, item in enumerate(chunk):
                width = len(item["markers"])
                row = logits[index, :width]
                predicted = int(row.argmax().item())
                correct += int(predicted == item["label"])
                if item["metadata"]["phase"] == "selection":
                    selection_total += 1
                    selection_correct += int(predicted == item["label"])
                    field = item["metadata"]["target"]
                    field_result = per_field.setdefault(field, {"correct": 0, "total": 0})
                    field_result["total"] += 1
                    field_result["correct"] += int(predicted == item["label"])
                predictions.append((item["qtype"], row.tolist(), item["target"]))
    total = max(1, len(items))
    selection_denominator = max(1, selection_total)
    exact = selection_correct / selection_denominator
    return {
        "sequenceAccuracy": correct / total,
        "exactPointerAccuracy": exact,
        "fieldCoverage": selection_total / total,
        "perFieldCoverage": {
            field: values["correct"] / max(1, values["total"])
            for field, values in sorted(per_field.items())
        },
        "invalidSelectionRate": 0.0,
        "fallbackRate": 1.0 - exact,
        "validationSequences": len(items),
    }, predictions


def save_checkpoint(model, tokenizer, cfg, output, manifest=None):
    output.mkdir(parents=True, exist_ok=True)
    weights = {key: value.half().contiguous().cpu() for key, value in model.state_dict().items()}
    save_file(weights, output / "model.safetensors")
    model.encoder.config.save_pretrained(output / "encoder")
    tokenizer.save_pretrained(output / "tokenizer")
    with (output / "rl_agent_config.json").open("w", encoding="utf-8") as handle:
        json.dump(cfg, handle, indent=2)
    if manifest is not None:
        with (output / "manifest.json").open("w", encoding="utf-8") as handle:
            json.dump(manifest, handle, indent=2)


def train(args):
    config = json.loads(Path(args.config).read_text(encoding="utf-8"))
    examples = [json.loads(line) for line in Path(args.dataset).read_text(encoding="utf-8").splitlines() if line]
    if len(examples) < int(config.get("minimumExamples", 50)):
        raise ValueError("not enough labeled examples")
    random.Random(int(config.get("splitSeed", 42))).shuffle(examples)
    validation_count = max(10, math.ceil(len(examples) * float(config.get("validationFraction", 0.2))))
    validation_examples, train_examples = examples[:validation_count], examples[validation_count:]

    base = Path(args.base)
    cfg = json.loads((base / "rl_agent_config.json").read_text(encoding="utf-8"))
    cfg["max_len"] = 1024
    cfg["head_max_len"] = 256
    tokenizer = AutoTokenizer.from_pretrained(base / "tokenizer", local_files_only=True)
    progress("Preparing Laya training sequences.", 2)
    train_items = training_items(train_examples, tokenizer, cfg)
    validation_items = training_items(validation_examples, tokenizer, cfg)
    if not train_items or not validation_items:
        raise ValueError("labeled examples did not produce trainable sequences")

    if args.device == "cuda" and not torch.cuda.is_available():
        raise ValueError("CUDA was requested but is unavailable")
    device = torch.device("cuda" if args.device == "auto" and torch.cuda.is_available() else args.device if args.device != "auto" else "cpu")
    if device.type == "cuda":
        progress(f"NVIDIA CUDA detected ({torch.cuda.get_device_name(0)}); preparing GPU training.", 3)
    else:
        progress("CUDA is unavailable or CPU was selected; CPU fine-tuning may be extremely slow.", 3)
    model = build_model(cfg, encoder_dir=base / "encoder")
    rolling = Path(args.output).parent / "checkpoint_latest"
    weights_path = rolling / "model.safetensors" if args.resume and (rolling / "model.safetensors").is_file() else base / "model.safetensors"
    model.load_state_dict(load_file(weights_path), strict=True)
    if hasattr(model.encoder, "gradient_checkpointing_enable"):
        model.encoder.gradient_checkpointing_enable(gradient_checkpointing_kwargs={"use_reentrant": False})
    model.to(device)
    model.train()
    optimizer = torch.optim.AdamW([
        {"params": [value for name, value in model.named_parameters() if "encoder." in name], "lr": 2.5e-5},
        {"params": [value for name, value in model.named_parameters() if "encoder." not in name], "lr": 1e-4},
    ], weight_decay=0.01)
    micro_batch = 4 if device.type == "cuda" else 1
    accumulation = 8 if device.type == "cuda" else 16
    total_steps = max(1, math.ceil(len(train_items) / micro_batch) * EPOCHS)
    scheduler = torch.optim.lr_scheduler.CosineAnnealingLR(optimizer, T_max=total_steps, eta_min=1e-6)
    scaler = torch.amp.GradScaler("cuda", enabled=device.type == "cuda")
    started = time.time()

    for epoch in range(EPOCHS):
        random.Random(42 + epoch).shuffle(train_items)
        optimizer.zero_grad(set_to_none=True)
        for batch_index, start in enumerate(range(0, len(train_items), micro_batch), 1):
            items = train_items[start:start + micro_batch]
            batch = collate(items, tokenizer.pad_token_id)
            with torch.autocast(device.type, dtype=torch.float16, enabled=device.type == "cuda"):
                logits, activity = forward(model, batch, device)
            logits = logits.float()
            mask = batch["marker_mask"].to(device)
            target = batch["target"].to(device)
            counts = mask.sum(-1, keepdim=True).float()
            sigma = 0.4 + (0.1 - 0.4) * epoch / max(1, EPOCHS - 1)
            noise = torch.randn((GROUP_SIZE,) + logits.shape, device=device) * sigma * mask
            noise = (noise - noise.sum(-1, keepdim=True) / counts) * mask
            sampled = logits.detach().unsqueeze(0) + noise
            probabilities = torch.softmax(sampled.masked_fill(~mask, -1e4), -1)
            with torch.no_grad():
                reward = proper_reward(probabilities, target.unsqueeze(0), batch["qtype"].to(device), mask, w_sph=0.75, w_rps=1.0)
                advantage = reward - reward.mean(0, keepdim=True)
                advantage = advantage / (advantage.std() + 1e-6)
            log_probability = -(((sampled - logits.unsqueeze(0)) ** 2) * mask).sum(-1) / (2 * sigma ** 2)
            rl_loss = -(advantage * log_probability).mean()
            ce_loss = -(target * torch.log_softmax(logits.masked_fill(~mask, -1e4), -1)).sum(-1).mean()
            loss = (rl_loss + ce_loss + 0.0 * activity.sum()) / accumulation
            scaler.scale(loss).backward()
            if batch_index % accumulation == 0 or start + micro_batch >= len(train_items):
                scaler.unscale_(optimizer)
                torch.nn.utils.clip_grad_norm_(model.parameters(), 1.0)
                scaler.step(optimizer)
                scaler.update()
                optimizer.zero_grad(set_to_none=True)
                scheduler.step()
            completed = epoch * len(train_items) + min(len(train_items), start + micro_batch)
            progress(f"Training epoch {epoch + 1} of {EPOCHS} on {device.type}.", 5 + 80 * completed / (len(train_items) * EPOCHS))
        save_checkpoint(model, tokenizer, cfg, rolling)

    progress("Evaluating held-out alerts and calibrating probabilities.", 88)
    metrics, predictions = evaluate(model, validation_items, tokenizer.pad_token_id, device)
    cfg["fine_tuned"] = True
    cfg["model_name"] = "xsoar-laya-mapper"
    cfg["temperature"] = fit_temperatures(predictions)
    checkpoint_id = f"mapper-{time.strftime('%Y%m%d-%H%M%S')}-{uuid.uuid4().hex[:8]}"
    manifest = {
        "schemaVersion": 1,
        "id": checkpoint_id,
        "base": "laya-multilingual",
        "createdAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "trainingExamples": len(train_examples),
        "validationExamples": len(validation_examples),
        "device": device.type,
        "durationSeconds": round(time.time() - started, 1),
        "metrics": metrics,
    }
    save_checkpoint(model, tokenizer, cfg, Path(args.output), manifest)
    progress("Laya fine-tuning completed; review metrics before activation.", 100)


def main():
    parser = argparse.ArgumentParser()
    subparsers = parser.add_subparsers(dest="command", required=True)
    command = subparsers.add_parser("train")
    command.add_argument("--dataset", required=True)
    command.add_argument("--config", required=True)
    command.add_argument("--base", required=True)
    command.add_argument("--output", required=True)
    command.add_argument("--device", choices=["auto", "cpu", "cuda"], default="auto")
    command.add_argument("--resume", action="store_true")
    args = parser.parse_args()
    if args.command == "train":
        train(args)


if __name__ == "__main__":
    try:
        main()
    except Exception:
        progress("Laya fine-tuning failed.", 0)
        raise SystemExit(1)
