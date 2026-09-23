import copy
import json
import tempfile
import unittest
from pathlib import Path

import torch
from safetensors.torch import load_file

from export_pilot_snapshot import save_inference_checkpoint, validate_state


class PilotSnapshotValidationTests(unittest.TestCase):
    def setUp(self):
        self.expected = {
            "maximumEpochs": 30,
            "maximumOptimizerSteps": 1890,
            "optimizerStepsPerEpoch": 63,
        }
        self.state = {
            "schemaVersion": 1,
            "kind": "pilot-resume-state",
            "gate": "pilotOnly",
            "promotionEligible": False,
            "bindings": self.expected,
            "epochsCompleted": 15,
            "optimizerSteps": 945,
            "scheduler": {"last_epoch": 945, "_step_count": 946, "T_max": 1890},
            "metrics": {
                "metricScope": "teacher-forced-rendered-sequences",
                "sequenceAccuracy": 0.9,
                "sequences": 1004,
            },
            "parameters": {"head": torch.ones(2)},
            "buffers": {},
        }

    def test_accepts_an_evaluated_non_promotable_boundary(self):
        epoch, steps, metrics = validate_state(self.state, self.expected, 5)
        self.assertEqual((epoch, steps, metrics["sequences"]), (15, 945, 1004))

    def test_rejects_stale_metrics_between_evaluation_boundaries(self):
        state = copy.deepcopy(self.state)
        state["epochsCompleted"] = 12
        state["optimizerSteps"] = 756
        state["scheduler"]["last_epoch"] = 756
        state["scheduler"]["_step_count"] = 757
        with self.assertRaisesRegex(ValueError, "evaluated epoch boundary"):
            validate_state(state, self.expected, 5)

    def test_rejects_non_finite_recovery_values(self):
        state = copy.deepcopy(self.state)
        state["parameters"]["head"][0] = float("nan")
        with self.assertRaisesRegex(ValueError, "non-finite"):
            validate_state(state, self.expected, 5)

    def test_rejects_changed_artifact_bindings(self):
        state = copy.deepcopy(self.state)
        state["bindings"] = {**self.expected, "trainerSha256": "changed"}
        with self.assertRaisesRegex(ValueError, "bindings"):
            validate_state(state, self.expected, 5)

    def test_serialization_keeps_only_the_trained_head_at_float32(self):
        class Config:
            @staticmethod
            def save_pretrained(directory):
                Path(directory).mkdir(parents=True)
                (Path(directory) / "config.json").write_text("{}", encoding="utf-8")

        class Model:
            encoder = type("Encoder", (), {"config": Config()})()

            @staticmethod
            def state_dict():
                return {
                    "encoder.layer.weight": torch.tensor([1.25], dtype=torch.float32),
                    "decision_head.weight": torch.tensor([1.25], dtype=torch.float32),
                }

        class Tokenizer:
            @staticmethod
            def save_pretrained(directory):
                Path(directory).mkdir(parents=True)
                (Path(directory) / "tokenizer.json").write_text("{}", encoding="utf-8")

        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory)
            save_inference_checkpoint(Model(), Tokenizer(), {"max_len": 512}, output, {"experimental": True})
            tensors = load_file(output / "model.safetensors")
            self.assertEqual(tensors["encoder.layer.weight"].dtype, torch.float16)
            self.assertEqual(tensors["decision_head.weight"].dtype, torch.float32)
            self.assertEqual(json.loads((output / "manifest.json").read_text(encoding="utf-8"))["experimental"], True)


if __name__ == "__main__":
    unittest.main()
