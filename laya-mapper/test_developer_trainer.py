"""Recovery tests use a tiny CPU module, never the Laya model or source corpus."""

import copy
import json
import random
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock, patch

import torch

import developer_trainer as trainer


def components():
    model = torch.nn.Sequential(torch.nn.Linear(3, 4), torch.nn.Dropout(0.2), torch.nn.Linear(4, 2))
    optimizer = torch.optim.AdamW(model.parameters(), lr=0.01)
    scheduler = torch.optim.lr_scheduler.CosineAnnealingLR(optimizer, T_max=8, eta_min=0.0001)
    scaler = torch.amp.GradScaler("cuda", enabled=False)
    return model, optimizer, scheduler, scaler


def epoch(model, optimizer, scheduler, scaler):
    model.train()
    for _ in range(2):
        optimizer.zero_grad(set_to_none=True)
        loss = (model(torch.randn(2, 3)) - random.random()).square().mean()
        scaler.scale(loss).backward()
        scaler.step(optimizer)
        scaler.update()
        scheduler.step()


def bindings():
    return {"runId": "unit-test", "baseModelManifestHash": "a" * 64,
            "compilationManifestHash": "b" * 64, "trainingConfigSha256": "c" * 64,
            "pilotManifestSha256": "d" * 64, "trainerSha256": "e" * 64,
            "trainingScope": "head-only", "device": "cpu", "maximumEpochs": 4,
            "optimizerStepsPerEpoch": 2, "maximumOptimizerSteps": 8}


class PilotRecoveryTests(unittest.TestCase):
    def test_runtime_identity_uses_bundled_module_versions(self):
        identity = trainer.runtime_identity(torch.device("cpu"))
        self.assertEqual(identity["laya"], "0.3.5")
        self.assertEqual(identity["transformers"], "4.57.6")
        self.assertEqual(identity["safetensors"], "0.6.2")
        self.assertIsNone(identity["cuda"])
        self.assertEqual(identity["cudaDevices"], [])

    def setUp(self):
        random.seed(42)
        torch.manual_seed(42)
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.path = Path(self.directory.name) / "pilot-state.pt"
        self.parts = components()
        epoch(*self.parts)
        epoch(*self.parts)

    def save(self):
        trainer.save_pilot_state(self.path, *self.parts, bindings(), 2, 4, 12.5, None)

    def test_resume_matches_uninterrupted_weights_optimizer_schedule_and_rng(self):
        self.save()
        saved = torch.load(self.path, weights_only=True)
        self.assertTrue(all(tensor.dtype == torch.float32 for tensor in saved["parameters"].values()))
        self.assertEqual(saved["gate"], "pilotOnly")
        self.assertIs(saved["promotionEligible"], False)
        self.assertEqual(saved["scaler"], self.parts[3].state_dict())
        epoch(*self.parts)
        epoch(*self.parts)
        expected_weights = copy.deepcopy(self.parts[0].state_dict())
        expected_optimizer = copy.deepcopy(self.parts[1].state_dict())
        expected_schedule = self.parts[2].state_dict()
        expected_random, expected_torch = random.random(), torch.rand(4)

        restored_parts = components()  # Deliberately consumes RNG before restore.
        restored = trainer.restore_pilot_state(self.path, *restored_parts, bindings())
        self.assertEqual((restored["epochsCompleted"], restored["optimizerSteps"], restored["elapsedSeconds"]), (2, 4, 12.5))
        for _ in range(restored["epochsCompleted"], bindings()["maximumEpochs"]):
            epoch(*restored_parts)
        for key, expected in expected_weights.items():
            self.assertTrue(torch.equal(expected, restored_parts[0].state_dict()[key]), key)
        actual_optimizer = restored_parts[1].state_dict()
        self.assertEqual(expected_optimizer["param_groups"], actual_optimizer["param_groups"])
        for key, values in expected_optimizer["state"].items():
            for name, expected in values.items():
                self.assertTrue(torch.equal(expected, actual_optimizer["state"][key][name]))
        self.assertEqual(expected_schedule, restored_parts[2].state_dict())
        self.assertEqual(expected_random, random.random())
        self.assertTrue(torch.equal(expected_torch, torch.rand(4)))

    def test_resume_rejects_changed_bindings_before_loading_model(self):
        self.save()
        for key in bindings():
            with self.subTest(key=key), patch.object(self.parts[0], "load_state_dict") as load:
                changed = {**bindings(), key: "changed"}
                with self.assertRaisesRegex(ValueError, "bindings"):
                    trainer.restore_pilot_state(self.path, *self.parts, changed)
                load.assert_not_called()

    def test_resume_rejects_promotion_and_inconsistent_schedule(self):
        self.save()
        original = torch.load(self.path, weights_only=True)
        changes = [("gate", "releaseCandidate"), ("promotionEligible", True),
                   ("epochsCompleted", 3), ("optimizerSteps", 3),
                   ("scheduler", {**original["scheduler"], "T_max": 80}),
                   ("scheduler", {**original["scheduler"], "last_epoch": 1})]
        for key, value in changes:
            with self.subTest(key=key, value=value):
                torch.save({**original, key: value}, self.path)
                with self.assertRaises(ValueError):
                    trainer.restore_pilot_state(self.path, *self.parts, bindings())

    def test_training_only_recovery_is_nonpromotable_and_gate_bound(self):
        path = self.path.with_name("training-state.pt")
        trainer.save_recovery_state(path, *self.parts, bindings(), 2, 4, 12.5, None,
                                    gate="trainingOnly", kind="training-resume-state")
        saved = torch.load(path, weights_only=True)
        self.assertEqual((saved["kind"], saved["gate"]), ("training-resume-state", "trainingOnly"))
        self.assertIs(saved["promotionEligible"], False)
        restored = trainer.restore_recovery_state(path, *components(), bindings(),
                                                  gate="trainingOnly", kind="training-resume-state")
        self.assertEqual((restored["epochsCompleted"], restored["optimizerSteps"]), (2, 4))
        with self.assertRaisesRegex(ValueError, "bindings"):
            trainer.restore_recovery_state(path, *components(), bindings(),
                                           gate="releaseCandidate", kind="training-resume-state")

    def test_failed_atomic_replace_preserves_previous_recovery_file(self):
        self.save()
        previous = self.path.read_bytes()
        with patch.object(trainer.os, "replace", side_effect=OSError("simulated interrupted commit")):
            with self.assertRaisesRegex(OSError, "interrupted"):
                self.save()
        self.assertEqual(previous, self.path.read_bytes())
        self.assertEqual(list(self.path.parent.glob("*.tmp")), [])

    def test_frozen_parameters_are_omitted_and_mutable_buffers_are_restored(self):
        model = self.parts[0]
        for parameter in model[0].parameters():
            parameter.requires_grad = False
        model.register_buffer("temperature", torch.tensor([1.75]))
        self.save()
        saved = torch.load(self.path, weights_only=True)
        self.assertEqual(set(saved["parameters"]), {"2.weight", "2.bias"})
        self.assertEqual(set(saved["buffers"]), {"temperature"})
        model.temperature.fill_(9.0)
        trainer.restore_pilot_state(self.path, *self.parts, bindings())
        self.assertEqual(model.temperature.item(), 1.75)
        saved["parameters"].pop("2.bias")
        torch.save(saved, self.path)
        with self.assertRaisesRegex(ValueError, "parameters keys"):
            trainer.restore_pilot_state(self.path, *self.parts, bindings())

    def test_nonfinite_parameters_or_optimizer_state_cannot_replace_recovery(self):
        self.save()
        previous = self.path.read_bytes()
        with torch.no_grad():
            self.parts[0][0].weight[0, 0] = float("nan")
        with self.assertRaisesRegex(ValueError, "non-finite"):
            self.save()
        self.assertEqual(previous, self.path.read_bytes())
        trainer.restore_pilot_state(self.path, *self.parts, bindings())
        next(iter(self.parts[1].state.values()))["exp_avg"].fill_(float("inf"))
        with self.assertRaisesRegex(ValueError, "non-finite"):
            self.save()
        self.assertEqual(previous, self.path.read_bytes())
        with self.assertRaisesRegex(ValueError, "loss"):
            trainer.require_finite(torch.tensor(float("nan")), "loss")


class SequenceMetricsTests(unittest.TestCase):
    def test_predict_length_buckets_in_safe_batches_and_restores_input_order(self):
        lengths = [30, 3, 20, 6, 29, 4, 25, 5, 28, 7, 24, 8, 27, 9, 23, 10, 26, 11]
        items = [{"ids": [index + 1] * length, "markers": [0, 1], "target": [1.0, 0.0],
                  "label": 0, "qtype": 0, "itemHash": "duplicate-hash"}
                 for index, length in enumerate(lengths)]
        seen_shapes = []

        def fake_forward(_model, batch, _device, **_kwargs):
            seen_shapes.append(tuple(batch["input_ids"].shape))
            identity = batch["input_ids"][:, 0].float()
            return torch.stack((identity, -identity), dim=1), torch.tensor(0.0)

        model = Mock()
        with patch.object(trainer, "forward", side_effect=fake_forward):
            predictions = trainer.predict(model, items, 0, "cpu")
        self.assertEqual([row["logits"][0] for row in predictions], [float(index + 1) for index in range(len(items))])
        self.assertEqual(seen_shapes, [(16, 28), (2, 30)])
        model.eval.assert_called_once_with()

    def test_predict_rejects_nonfinite_logits_before_metrics_or_recovery(self):
        item = {"ids": [1, 2], "markers": [0, 1], "target": [1.0, 0.0],
                "label": 0, "qtype": 0, "itemHash": "nonfinite"}
        model = Mock()
        with patch.object(trainer, "forward", return_value=(torch.tensor([[float("nan"), 0.0]]), torch.tensor(0.0))):
            with self.assertRaisesRegex(ValueError, "non-finite prediction logits"):
                trainer.predict(model, [item], 0, "cpu")

    def test_reload_checks_late_sequences_and_rejects_nonfinite_logits(self):
        probe = [{"markers": [1, 2]} for _ in range(12)]
        before = [{"choice": 0, "logits": [1.0, 0.0]} for _ in probe]
        for kind in ("late-choice", "nonfinite", "incomplete"):
            after = copy.deepcopy(before)
            if kind == "late-choice":
                after[10]["choice"] = 1
            elif kind == "nonfinite":
                after[10]["logits"][0] = float("nan")
            else:
                after.pop()
            with self.subTest(kind=kind), patch.object(trainer, "build_model"), patch.object(trainer, "load_file"), \
                    patch.object(trainer, "predict", side_effect=[before, after]):
                with self.assertRaises(ValueError):
                    trainer.verify_reload(object(), {}, Path("unused"), probe, 0, "cpu")

    def test_subgroups_expose_positive_none_target_and_family_errors(self):
        items = [
            {"label": label, "metadata": {"phase": phase, "goldChoice": gold, "target": target,
                                         "splitUnit": {"templateFamily": family}}}
            for label, phase, gold, target, family in [
                (1, "classify", None, "sourceIp", "network"),
                (0, "classify", None, "customerName", "network"),
                (0, "selection", "field", "sourceIp", "identity"),
                (1, "selection", "__none__", "customerName", "identity"),
            ]
        ]
        predictions = [{"choice": choice} for choice in (1, 1, 0, 0)]
        metrics = trainer.sequence_metrics(items, predictions)
        self.assertEqual(metrics["sequenceAccuracy"], 0.5)
        self.assertEqual(metrics["subgroups"]["answer"]["positive"], {"correct": 2, "sequences": 2, "accuracy": 1.0})
        self.assertEqual(metrics["subgroups"]["answer"]["none"]["accuracy"], 0.0)
        self.assertEqual(metrics["subgroups"]["target"]["customerName"]["accuracy"], 0.0)
        self.assertEqual(metrics["subgroups"]["family"]["identity"]["accuracy"], 0.5)
        self.assertIsNone(metrics["endToEndPointerAccuracy"])
        with self.assertRaisesRegex(ValueError, "incomplete coverage"):
            trainer.sequence_metrics(items, predictions[:2])


class PilotLoopTests(unittest.TestCase):
    def test_interrupted_epoch_resumes_fixed_schedule_and_exports_only_after_gate(self):
        # Exercise the real loop with a tiny head, mocked inputs, and no Laya weights.
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "rl_agent_config.json").write_text(json.dumps({"max_len": 512, "head_max_len": 192}))
            (root / "config.json").write_text(json.dumps({"minimumSequences": 1, "pilotEpochs": 2,
                "pilotEvaluationInterval": 1, "pilotMinimumAccuracy": 0.95, "cpuHeadOnlyMicroBatch": 16}))
            ids = [str(index) for index in range(18)]
            (root / "pilot.json").write_text(json.dumps({"schemaVersion": 1, "records": ids}))
            items = [{"ids": [1, 2], "markers": [0, 1], "target": [1.0, 0.0], "label": 0,
                      "qtype": 0, "itemHash": index, "metadata": {"sampleId": index, "phase": "selection",
                      "goldChoice": "field", "target": "sourceIp", "splitUnit": {"templateFamily": "fixture"}}}
                     for index in ids]
            args = SimpleNamespace(base=str(root), base_manifest="unused", compiled="unused",
                                   config=str(root / "config.json"), pilot_manifest=str(root / "pilot.json"),
                                   output=str(root / "checkpoint"), pilot=True, resume_state=None,
                                   device="cpu", training_scope="head-only", run_id="loop-test")
            weights = torch.nn.Linear(2, 2).state_dict()
            real_save = trainer.save_pilot_state

            def interrupted_save(*values):
                real_save(*values)
                raise InterruptedError("simulated process stop after epoch commit")

            def toy_forward(model, batch, device, **_kwargs):
                logits = model(batch["input_ids"].float())
                return logits, logits.sum()

            def exported(_model, _tokenizer, _cfg, output, _manifest):
                output.mkdir()

            with patch.object(trainer, "verify_base_model", return_value={}), \
                    patch.object(trainer, "load_compiled", return_value=(items, [], {"reviewGates": ["pilotOnly"]}, "compilation")), \
                    patch.object(trainer.AutoTokenizer, "from_pretrained", return_value=SimpleNamespace(pad_token_id=0)), \
                    patch.object(trainer, "build_model", side_effect=lambda *_a, **_k: torch.nn.Linear(2, 2)), \
                    patch.object(trainer, "load_file", return_value=weights), \
                    patch.object(trainer, "forward", side_effect=toy_forward), \
                    patch.object(trainer, "predict", side_effect=[[{"choice": 1} for _ in items], [{"choice": 0} for _ in items]]), \
                    patch.object(trainer, "save_checkpoint", side_effect=exported) as export, \
                    patch.object(trainer, "verify_reload", return_value={"choicesEqual": True}) as reload_check, \
                    patch.object(trainer, "progress"):
                with patch.object(trainer, "save_pilot_state", side_effect=interrupted_save):
                    with self.assertRaises(InterruptedError):
                        trainer.train(args)
                export.assert_not_called()
                recovery = torch.load(root / "checkpoint.pilot-state.pt", weights_only=True)
                required_bindings = {
                    "runId", "output", "contract", "baseModelManifestHash", "compilationManifestHash",
                    "trainerSha256", "compilerSha256", "trainingConfigSha256", "pilotManifestSha256",
                    "trainingScope", "device", "randomSeed", "microBatch", "gradientAccumulation",
                    "maximumEpochs", "maximumOptimizerSteps", "optimizerStepsPerEpoch",
                    "trainingItemsSha256", "runtime",
                }
                self.assertTrue(required_bindings.issubset(recovery["bindings"]))
                self.assertEqual(recovery["bindings"]["runtime"]["laya"], "0.3.5")
                self.assertEqual(recovery["bindings"]["runtime"]["transformers"], "4.57.6")
                self.assertEqual(recovery["bindings"]["output"], str((root / "checkpoint").resolve()))
                args.resume_state = str(root / "checkpoint.pilot-state.pt")
                trainer.train(args)
                export.assert_called_once()
                self.assertEqual(reload_check.call_args.args[3], items)
                manifest = json.loads((root / "checkpoint" / "manifest.json").read_text())
                self.assertEqual((manifest["epochsCompleted"], manifest["optimizerSteps"], manifest["maximumOptimizerSteps"]), (2, 4, 4))
                self.assertIs(manifest["promotionEligible"], False)
                self.assertTrue(manifest["resumed"])
                self.assertEqual((manifest["resumedFromEpoch"], manifest["resumedFromOptimizerSteps"]), (1, 2))
                self.assertEqual(manifest["recoveryState"], "checkpoint.pilot-state.pt")


if __name__ == "__main__":
    unittest.main()
