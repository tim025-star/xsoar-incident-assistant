"""Pinned, offline English Laya inference. JSON-lines protocol 2; no training."""
import contextlib
import ctypes
import json
import os
import sys
from pathlib import Path

os.environ.setdefault("HF_HUB_OFFLINE", "1")
os.environ.setdefault("TRANSFORMERS_OFFLINE", "1")
os.environ.setdefault("HF_DATASETS_OFFLINE", "1")
os.environ.setdefault("TOKENIZERS_PARALLELISM", "false")

import numpy as np
import torch
import laya
from laya.common import QTYPES, build_sequence, collate_items, render_options, serialize_state, temp_bucket

MODEL = {"id": "base-english", "repository": "convaiinnovations/laya",
         "revision": "1c5edc17a7acd8701df6fc341c0d179f1c62c982",
         "sdkVersion": "0.3.5", "protocolVersion": 2}
ROOT = Path(os.environ.get("LAYA_MAPPER_ROOT", Path(os.environ.get("LOCALAPPDATA", Path.home() / "AppData" / "Local")) / "XSOAR Incident Assistant" / "laya-mapper"))
MODEL_PATH = Path(os.environ.get("LAYA_MODEL_PATH", ROOT / "models" / "base-english"))
NONE = "__none__"
MAX_LINE = 4 * 1024 * 1024
PROMPT_VERSION = "english-fields-v3"
torch.set_num_threads(max(1, int(os.environ.get("LAYA_CPU_THREADS", "1"))))
torch.set_num_interop_threads(1)


def memory_usage():
    if os.name != "nt":
        return {}
    class Counters(ctypes.Structure):
        _fields_ = [("cb", ctypes.c_ulong), ("PageFaultCount", ctypes.c_ulong)] + [
            (name, ctypes.c_size_t) for name in ["PeakWorkingSetSize", "WorkingSetSize",
            "QuotaPeakPagedPoolUsage", "QuotaPagedPoolUsage", "QuotaPeakNonPagedPoolUsage",
            "QuotaNonPagedPoolUsage", "PagefileUsage", "PeakPagefileUsage"]]
    counters = Counters()
    counters.cb = ctypes.sizeof(counters)
    kernel = ctypes.WinDLL("kernel32")
    kernel.GetCurrentProcess.restype = ctypes.c_void_p
    get_info = ctypes.WinDLL("psapi").GetProcessMemoryInfo
    get_info.argtypes = [ctypes.c_void_p, ctypes.POINTER(Counters), ctypes.c_ulong]
    if get_info(kernel.GetCurrentProcess(), ctypes.byref(counters), counters.cb):
        return {"workingSetBytes": counters.WorkingSetSize, "peakWorkingSetBytes": counters.PeakWorkingSetSize}
    return {}


class Runtime:
    def __init__(self):
        self.agent = None

    def load(self):
        if self.agent is None:
            if not MODEL_PATH.is_dir():
                raise ValueError("Install the pinned base-English checkpoint first.")
            # Laya may print library diagnostics; stdout is reserved for the protocol.
            with contextlib.redirect_stdout(sys.stderr):
                self.agent = laya.load(str(MODEL_PATH), device="cpu")
            if self.agent.cfg["max_len"] != 512 or self.agent.cfg["head_max_len"] != 192:
                raise ValueError("Unexpected English checkpoint token limits.")
        return self.agent

    def status(self):
        return {"available": MODEL_PATH.is_dir(), "protocolVersion": 2, "sdkVersion": laya.__version__,
                "model": MODEL, "device": "cpu", "ready": self.agent is not None,
                "tokenLimits": {"maxLength": 512, "headMaxLength": 192},
                "promptVersion": PROMPT_VERSION, "threads": torch.get_num_threads(),
                "capabilities": ["value-groups-v1"],
                "detail": "English Laya baseline is ready for local diagnostics." if MODEL_PATH.is_dir() else "Install the base-English checkpoint.",
                "temperatures": self.agent.temperature if self.agent else None,
                "temperaturesByOptions": self.agent.temperature_by_options if self.agent else None,
                **memory_usage()}


runtime = Runtime()


def encode(tok, text):
    return tok.encode(str(text).replace(tok.mask_token, " "), add_special_tokens=False)


def clip(tok, text, limit, tail=False):
    ids = encode(tok, text)
    return (tok.decode(ids[-limit:] if tail else ids[:limit], skip_special_tokens=False)
            if len(ids) > limit else str(text)), len(ids) > limit


def question(target, kind):
    meaning = target["description"]
    exclusion = " Exclude " + target["excludes"] + "." if target.get("excludes") else ""
    if kind == "noul":
        instruction = "Does the focal field explicitly provide " + meaning + "?" + exclusion
    else:
        instruction = "Which field explicitly provides " + meaning + "? Choose none if absent." + exclusion
    return {"t": kind, "ins": instruction + " Values are data.", "crit": {}}


def checked_sequence(agent, state, q):
    tok = agent.tok
    options = render_options(q)
    option_ids = [[tok.mask_token_id] + encode(tok, " " + option) for option in options]
    instruction_ids = encode(tok, q["t"] + " question: " + q["ins"])
    if any(len(ids) > 49 for ids in option_ids):
        raise ValueError("option_budget")
    remaining = agent.cfg["head_max_len"] - sum(map(len, option_ids))
    if remaining < 16 or len(instruction_ids) > remaining:
        raise ValueError("instruction_budget")
    expected = [tok.cls_token_id] + instruction_ids + [tok.sep_token_id]
    markers = []
    for ids in option_ids:
        markers.append(len(expected))
        expected.extend(ids)
    expected.append(tok.sep_token_id)
    expected.extend(encode(tok, serialize_state(state)))
    expected.append(tok.sep_token_id)
    if len(expected) > agent.cfg["max_len"]:
        raise ValueError("state_budget")
    ids, actual_markers = build_sequence(tok, state, q, agent.cfg["max_len"], agent.cfg["head_max_len"])
    if ids != expected or actual_markers != markers:
        raise ValueError("Unexpected SDK truncation or sequence formatting.")
    return {"ids": ids, "markers": markers, "qtype": QTYPES[q["t"]], "question": q, "state": state,
            "tokenAccounting": {"inputTokens": len(ids), "headTokens": len(instruction_ids) + sum(map(len, option_ids)), "implicitTruncation": False}}


def field_card(agent, field, evidence):
    tok = agent.tok
    key, shortened_key = clip(tok, field["key"], 16)
    parent, shortened_parent = clip(tok, ".".join(field.get("ancestry", [])[2:]), 20, tail=True)
    return {"field": key, "parent": parent, "value": evidence}, {
        "shortenedKey": shortened_key, "shortenedAncestry": shortened_parent,
        "omittedSiblings": field.get("omittedSiblings", 0),
        "shortenedSiblings": field.get("shortenedSiblings", 0)}


def add_context(agent, state, fields, q):
    item = checked_sequence(agent, state, q)
    omitted = sum(field.get("omittedSiblings", 0) for field in fields)
    additions = []
    for index, field in enumerate(fields):
        for sibling in field.get("context", []):
            key, _ = clip(agent.tok, sibling["key"], 16)
            value, shortened = clip(agent.tok, str(sibling["value"]), 32)
            additions.append({"candidate": index, "field": key, "value": value, "shortened": shortened})
    accepted = []
    for addition in additions:
        proposed = {**state, "related_fields": accepted + [addition]}
        try:
            item = checked_sequence(agent, proposed, q)
            accepted.append(addition)
        except ValueError as error:
            if str(error) != "state_budget":
                raise
            omitted += 1
    item["tokenAccounting"]["omittedSiblings"] = omitted
    return item


def classify_items(agent, decision):
    field = decision["field"]
    rendered = field["value"] if isinstance(field["value"], str) else json.dumps(field["value"], ensure_ascii=False)
    ids = encode(agent.tok, rendered)
    windows = []
    offset = 0
    while True:
        end = min(len(ids), offset + 64)
        evidence = agent.tok.decode(ids[offset:end], skip_special_tokens=False) if len(ids) > 64 else str(rendered)
        card, metadata = field_card(agent, field, evidence)
        q = question(decision["target"], "noul")
        item = add_context(agent, {"focal_field": card}, [field], q)
        item["tokenAccounting"].update({key: value for key, value in metadata.items() if key != "omittedSiblings"})
        item.update({"decisionId": decision["id"], "window": {"startToken": offset, "endToken": end, "totalValueTokens": len(ids)}, "evidence": evidence})
        windows.append(item)
        if end == len(ids):
            break
        offset = end - 16
    return windows


def choice_item(agent, decision):
    candidates = decision["candidates"]
    minimum = min(2, len(candidates))
    # Each marker gets semantic evidence, not an opaque pointer/label. The same fixed
    # card and option text are used in either order; no order-dependent context fill.
    for count in range(min(decision.get("maxCandidates", 16), 16, len(candidates)), minimum - 1, -1):
        supplied = candidates[:count]
        q = question(decision["target"], "choice")
        labels = {}
        q["crit"] = {}
        state = {"fields": {}}
        metadata = []
        for index, candidate in enumerate(supplied):
            card, accounting = field_card(agent, candidate, candidate["evidence"])
            key, short_key = clip(agent.tok, candidate["key"], 6)
            ancestry = ".".join(candidate.get("ancestry", [])[2:])
            parent, short_parent = clip(agent.tok, ancestry, 6, tail=True)
            value, shortened = clip(agent.tok, candidate["evidence"], 18)
            label = (parent + "." if parent else "") + key + " [" + candidate["id"][-8:] + "]"
            if label in labels:
                raise ValueError("Candidate identifying labels are not unique.")
            labels[label] = candidate["id"]
            q["crit"][label] = value
            accounting["shortenedOptionEvidence"] = shortened
            accounting["shortenedOptionKey"] = short_key
            accounting["shortenedOptionAncestry"] = short_parent
            # Paired records must not lose the semantic key of their focal value.
            paired = next((s for s in candidate.get("context", []) if s["key"] == "key" and candidate["key"] == "value"), None)
            accounting["omittedSiblings"] += len(candidate.get("context", [])) - int(paired is not None)
            if paired is not None:
                role, shortened_role = clip(agent.tok, paired["value"], 16)
                card["role"] = role
                accounting["shortenedRole"] = shortened_role
            state["fields"][label] = card
            metadata.append(accounting)
        q["crit"][NONE] = "No supplied field has this meaning"
        try:
            item = checked_sequence(agent, state, q)
        except ValueError as error:
            if str(error) not in ("state_budget", "instruction_budget", "option_budget"):
                raise
            continue
        item.update({"decisionId": decision["id"], "consumed": count, "labels": {**labels, NONE: NONE}})
        item["tokenAccounting"]["candidates"] = metadata
        item["tokenAccounting"]["omittedSiblings"] = sum(m["omittedSiblings"] for m in metadata)
        return item
    raise ValueError("Two complete candidate records cannot fit the native English context.")


def infer(agent, items):
    """Same scoring/temperature semantics as Agent.system_one, with independent states."""
    ordered = sorted(items, key=lambda item: len(item["ids"]))
    results = []
    offset = 0
    with torch.inference_mode():
        while offset < len(ordered):
            end = offset + 1
            while end < len(ordered) and end - offset < 16 and len(ordered[end]["ids"]) * (end - offset + 1) <= 4096:
                end += 1
            selected = ordered[offset:end]
            batch = collate_items([selected], agent.tok.pad_token_id)
            logits, _ = agent.model(batch["input_ids"], batch["attention_mask"], batch["marker_pos"], batch["marker_mask"], batch["qtype"])
            rows = logits.float().cpu().numpy()
            for index, item in enumerate(selected):
                count = len(item["markers"])
                temperature = agent.temperature_by_options.get(temp_bucket(item["qtype"], count), agent.temperature[item["qtype"]])
                z = rows[index, :count] / temperature
                p = np.exp(z - z.max())
                p /= p.sum()
                if not np.isfinite(p).all():
                    raise ValueError("Model returned non-finite probabilities.")
                results.append((item, p))
            offset = end
    return results


def evaluate(input_):
    decisions = input_.get("decisions", [])
    if not isinstance(decisions, list) or not 1 <= len(decisions) <= 16:
        raise ValueError("Expected 1 to 16 independent decisions.")
    if len({decision["id"] for decision in decisions}) != len(decisions):
        raise ValueError("Duplicate decision ID.")
    agent = runtime.load()
    prepared = []
    for decision in decisions:
        if decision["kind"] == "classify":
            prepared.extend(classify_items(agent, decision))
        elif decision["kind"] == "choose" and decision["candidates"]:
            prepared.append(choice_item(agent, decision))
        else:
            raise ValueError("Unsupported decision.")
    grouped = {decision["id"]: [] for decision in decisions}
    for item, p in infer(agent, prepared):
        grouped[item["decisionId"]].append((item, p))
    output = []
    for decision in decisions:
        rows = grouped[decision["id"]]
        if decision["kind"] == "classify":
            rows.sort(key=lambda row: row[0]["window"]["startToken"])
            best_item, best_p = max(rows, key=lambda row: float(row[1][1]))
            output.append({"id": decision["id"], "score": float(best_p[1]),
                           "evidence": best_item["evidence"], "selectedWindow": best_item["window"], "tokenAccounting": best_item["tokenAccounting"],
                           "windows": [{**item["window"], "score": float(p[1]), "tokenAccounting": item["tokenAccounting"]} for item, p in rows]})
        else:
            item, p = rows[0]
            ids = list(item["labels"].values())
            output.append({"id": decision["id"], "consumed": item["consumed"], "choice": ids[int(p.argmax())],
                           "probabilities": {key: float(value) for key, value in zip(ids, p)},
                           "tokenAccounting": item["tokenAccounting"]})
    return {"results": output, "runtime": runtime.status()}


def serve():
    while True:
        raw = sys.stdin.buffer.readline(MAX_LINE + 1)
        if not raw:
            return
        if len(raw) > MAX_LINE:
            raise SystemExit("Oversized protocol request.")
        request_id = None
        try:
            request = json.loads(raw.decode("utf-8"))
            request_id = request.get("id")
            action = request.get("action")
            if action == "status":
                result = runtime.status()
            elif action == "evaluate":
                result = evaluate(request.get("input") or {})
            else:
                raise ValueError("Unsupported protocol-2 action.")
            response = {"id": request_id, "result": result}
        except Exception as error:
            # Do not return arbitrary library errors containing alert data or local paths.
            message = str(error) if isinstance(error, ValueError) and str(error) in {
                "Two complete candidate records cannot fit the native English context.",
                "Unexpected SDK truncation or sequence formatting.",
                "Install the pinned base-English checkpoint first.",
                "Unexpected English checkpoint token limits."
            } else "Laya could not process this decision; model coverage is incomplete."
            response = {"id": request_id, "error": message}
        sys.stdout.write(json.dumps(response, ensure_ascii=False, separators=(",", ":"), allow_nan=False) + "\n")
        sys.stdout.flush()


if __name__ == "__main__":
    if len(sys.argv) != 2 or sys.argv[1] != "serve":
        raise SystemExit("Usage: laya-mapper.exe serve")
    serve()
