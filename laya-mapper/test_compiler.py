import json
import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import compiler
import ingest_factory
import review


def source(sample_id="sample-1", split="train", value="203.0.113.4"):
    decisions = {target: {"state": "unlabelled"} for target in compiler.TARGET_TYPES}
    decisions["sourceIp"] = {
        "state": "mapped",
        "primaryPointer": "/documents/0/source",
        "acceptedPointers": ["/documents/0/source"],
        "resolvedValue": value,
    }
    record = {
        "schemaVersion": 2,
        "sampleId": sample_id,
        "synthetic": True,
        "sourceFamily": "fixture",
        "split": split,
        "splitUnit": {"provider": "provider", "product": "product", "templateFamily": "family", "variantGroupId": "variant", "scenarioGroupId": sample_id},
        "documents": [{"source": value, "later": "evidence"}],
        "decisions": decisions,
        "provenance": {
            "generatorModel": "generator", "generatorRevision": "revision", "promptHash": "a" * 64,
            "seed": 1, "rawHash": "", "normalizedHash": "", "targetCatalogVersion": compiler.CONTRACT,
            "compilerVersion": compiler.COMPILER_VERSION, "blindReviewerModel": "gpt-6-astra", "blindReviewPromptHash": "b" * 64,
            "reviewArtifactSha256": "c" * 64, "additionalDraftsSha256": "d" * 64,
        },
        "review": {"state": "approved", "blind": True, "gate": "pilotOnly", "reviewer": {
            "kind": "independent-model", "model": "gpt-6-astra", "version": "test", "promptHash": "b" * 64
        }},
    }
    record["provenance"]["rawHash"] = compiler.raw_hash(record)
    record["provenance"]["normalizedHash"] = compiler.normalized_hash(record)
    seal(record)
    return record


def seal(record):
    record["recordHash"] = compiler.record_hash(record)
    record["certificationHash"] = compiler.certification_hash(record)


class FakeRuntime:
    def load(self):
        return object()


class FakeRunner:
    runtime = FakeRuntime()

    @staticmethod
    def classify_items(_agent, _decision):
        base = {"ids": [1, 2], "markers": [1, 2], "qtype": 0, "state": {}, "question": {}, "evidence": "evidence", "tokenAccounting": {"inputTokens": 2}}
        return [
            {**base, "window": {"startToken": 0, "endToken": 8, "totalValueTokens": 16}},
            {**base, "ids": [3, 4], "window": {"startToken": 7, "endToken": 16, "totalValueTokens": 16}},
        ]


class CompilerTests(unittest.TestCase):
    def test_mapped_labels_resolve_exact_typed_eligible_values(self):
        self.assertEqual(compiler.validate_source_record(source())["sampleId"], "sample-1")
        wrong = source()
        wrong["decisions"]["sourceIp"]["resolvedValue"] = "198.51.100.2"
        wrong["provenance"]["normalizedHash"] = compiler.normalized_hash(wrong)
        seal(wrong)
        with self.assertRaisesRegex(ValueError, "recorded value"):
            compiler.validate_source_record(wrong)
        ineligible = source(value="not-an-ip")
        with self.assertRaisesRegex(ValueError, "structurally ineligible"):
            compiler.validate_source_record(ineligible)

    def test_documents_and_hashes_match_production_limits(self):
        too_many = source()
        too_many["documents"] = [{} for _ in range(17)]
        with self.assertRaisesRegex(ValueError, "1 to 16"):
            compiler.validate_source_record(too_many)
        oversized = source()
        oversized["documents"][0]["padding"] = "x" * (96 * 1024)
        with self.assertRaisesRegex(ValueError, "96 KiB"):
            compiler.validate_source_record(oversized)
        tampered = source()
        tampered["documents"][0]["later"] = "changed"
        with self.assertRaisesRegex(ValueError, "rawHash"):
            compiler.validate_source_record(tampered)

    def test_timestamp_structural_eligibility_matches_calendar_rules(self):
        self.assertTrue(compiler.structurally_eligible("occurred", "2024-02-29T04:14:00Z"))
        self.assertFalse(compiler.structurally_eligible("occurred", "2026-02-29T04:14:00Z"))
        self.assertFalse(compiler.structurally_eligible("occurred", "2026-09-20T24:14:00Z"))

    def test_fixed_template_family_splits_cannot_leak(self):
        rows = [source("a", "train"), source("b", "train")]
        partitions = compiler.split_groups(rows)
        self.assertEqual({row["sampleId"] for row in partitions["train"]}, {"a", "b"})
        rows[1]["split"] = "development"
        with self.assertRaisesRegex(ValueError, "crosses fixed splits"):
            compiler.split_groups(rows)

    def test_later_reviewed_window_is_positive_and_window_zero_is_negative(self):
        decision = {"id": "d1", "kind": "classify", "target": {"id": "sourceIp"}, "field": {"pointer": "/documents/0/source"}}
        rendered = {"items": [compiler.render_projection(item) for item in FakeRunner.classify_items(None, decision)]}
        row = {
            "sampleId": "sample-1", "target": "sourceIp", "split": "train",
            "splitUnit": source()["splitUnit"], "decision": decision, "rendered": rendered,
            "gold": {"positive": True, "positiveWindows": [{"startToken": 7, "endToken": 16}], "hardNegative": False},
        }
        row["traceHash"] = compiler.trace_hash(row)
        with patch.object(compiler, "_runtime", return_value=FakeRunner):
            items = compiler.compile_trace([row], Path("."), "c" * 64)
        labels = {(item["metadata"]["window"]["startToken"], item["metadata"]["window"]["endToken"]): item["label"] for item in items}
        self.assertEqual(labels[(0, 8)], 0)
        self.assertEqual(labels[(7, 16)], 1)

    def test_trace_and_item_hashes_reject_tampering(self):
        row = {"sampleId": "sample", "value": 1}
        row["traceHash"] = compiler.trace_hash(row)
        self.assertEqual(row["traceHash"], compiler.trace_hash(row))
        row["value"] = 2
        self.assertNotEqual(row["traceHash"], compiler.trace_hash(row))
        item = {"ids": [1], "itemHash": ""}
        item["itemHash"] = compiler.item_hash(item)
        item["ids"].append(2)
        self.assertNotEqual(item["itemHash"], compiler.item_hash(item))

    def test_safety_scan_handles_example_email_ipv6_tenant_and_secrets(self):
        safe = source()
        safe["documents"][0]["email"] = "user@corp.example"
        safe["documents"][0]["ipv6"] = "2001:db8::20"
        safe["documents"][0]["occurred"] = "2026-09-20T04:14:00Z"
        safe["provenance"]["rawHash"] = compiler.raw_hash(safe)
        safe["provenance"]["normalizedHash"] = compiler.normalized_hash(safe)
        seal(safe)
        self.assertEqual(review.mechanical_findings(safe), [])
        unsafe = source()
        unsafe["documents"][0].update({"email": "user@real-company.com", "ipv6": "2606:4700:4700::1111", "tenant": "contoso.onmicrosoft.com", "password": "password=really-secret-value"})
        unsafe["provenance"]["rawHash"] = compiler.raw_hash(unsafe)
        unsafe["provenance"]["normalizedHash"] = compiler.normalized_hash(unsafe)
        seal(unsafe)
        findings = "\n".join(review.mechanical_findings(unsafe))
        self.assertIn("non-fictional email", findings)
        self.assertIn("routable IP", findings)
        self.assertIn("tenant domain", findings)
        self.assertIn("secret material", findings)

    def test_safety_scan_does_not_treat_iso_time_as_ipv6(self):
        timestamp = source()
        timestamp["documents"][0]["occurred"] = "2026-09-20T04:14:00Z"
        timestamp["provenance"]["rawHash"] = compiler.raw_hash(timestamp)
        timestamp["provenance"]["normalizedHash"] = compiler.normalized_hash(timestamp)
        seal(timestamp)
        self.assertEqual(review.mechanical_findings(timestamp), [])

        routable_ipv6 = source()
        routable_ipv6["documents"][0]["sourceV6"] = "2606:4700:4700::1111"
        routable_ipv6["provenance"]["rawHash"] = compiler.raw_hash(routable_ipv6)
        routable_ipv6["provenance"]["normalizedHash"] = compiler.normalized_hash(routable_ipv6)
        seal(routable_ipv6)
        self.assertIn("non-documentation routable IP: 2606:4700:4700::1111", review.mechanical_findings(routable_ipv6))

    def test_review_and_lineage_are_bound_by_certification_hash(self):
        changed_gate = source()
        changed_gate["review"]["gate"] = "releaseCandidate"
        with self.assertRaisesRegex(ValueError, "certificationHash"):
            compiler.validate_source_record(changed_gate)
        mismatched_reviewer = source()
        mismatched_reviewer["review"]["reviewer"]["model"] = "different-reviewer"
        seal(mismatched_reviewer)
        with self.assertRaisesRegex(ValueError, "reviewer identity"):
            compiler.validate_source_record(mismatched_reviewer)

    def test_reviewed_pointer_override_is_explicit_and_hash_bound(self):
        absent = {"primaryPointer": None, "originalType": None, "expectedStatus": "no-match", "rationale": "Absent."}
        row = {
            "recordId": "fixture.override", "sourceFamily": "fixture", "templateFamilyId": "fixture.train", "split": "train",
            "sourceSchema": {"provenanceId": "fixture.v1"},
            "alert": {"ipAddress": "203.0.113.9"},
            "targetLabels": {
                "occurredAt": absent, "sourceIp": absent, "destinationIp": absent, "clientIp": absent,
                "clientHostname": absent, "customerOrOrganization": absent,
            },
            "acceptedAlternatives": {},
            "generatorMetadata": {"generator": "fixture-generator"},
        }
        approval = {
            "gate": "pilotOnly",
            "reviewer": {"kind": "independent-model", "model": "gpt-6-astra", "version": "test", "promptHash": "b" * 64},
            "targetOverrides": {"sourceIp": {
                "primaryPointer": "/ipAddress", "acceptedPointers": [], "originalType": "string",
                "rationale": "The address is the reviewed activity origin.",
            }},
        }
        record = ingest_factory.derived_record(row, approval, "a" * 64, "c" * 64, "d" * 64, None, "e" * 64)
        self.assertEqual(record["decisions"]["sourceIp"]["primaryPointer"], "/documents/0/ipAddress")
        self.assertEqual(record["provenance"]["reviewArtifactSha256"], "c" * 64)
        self.assertEqual(record["provenance"]["additionalDraftsSha256"], "d" * 64)
        self.assertEqual(record["certificationHash"], compiler.certification_hash(record))

    def test_tier_a_mapping_requires_record_target_approval(self):
        row = {
            "recordId": "fixture.tier-a", "sourceFamily": "fixture", "templateFamilyId": "fixture.tier", "split": "train",
            "sourceSchema": {"provenanceId": "fixture.v1"}, "alert": {"account": "actor@example.test"},
            "targetLabels": {
                "occurredAt": {"primaryPointer": None, "expectedStatus": "no-match", "rationale": "Absent."},
                "sourceIp": {"primaryPointer": None, "expectedStatus": "no-match", "rationale": "Absent."},
                "destinationIp": {"primaryPointer": None, "expectedStatus": "no-match", "rationale": "Absent."},
                "clientIp": {"primaryPointer": None, "expectedStatus": "no-match", "rationale": "Absent."},
                "clientHostname": {"primaryPointer": None, "expectedStatus": "no-match", "rationale": "Absent."},
                "customerOrOrganization": {"primaryPointer": None, "expectedStatus": "no-match", "rationale": "Absent."},
                "accountUpn": {"primaryPointer": "/account", "originalType": "string", "expectedStatus": "matched", "rationale": "Actor."},
            },
            "acceptedAlternatives": {}, "generatorMetadata": {"generator": "fixture-generator"},
        }
        reviewer = {"kind": "independent-model", "model": "gpt-6-astra", "version": "test", "promptHash": "b" * 64}
        generic = {"gate": "pilotOnly", "reviewer": reviewer}
        tier = {"productionTarget": "sourceUsername", "sourceTarget": "accountUpn", "version": "test"}
        without_target = ingest_factory.derived_record(row, generic, "a" * 64, "c" * 64, "d" * 64, tier, "e" * 64)
        self.assertEqual(without_target["decisions"]["sourceUsername"]["state"], "unlabelled")
        bypass = {**generic, "targetOverrides": {"sourceUsername": {"sourceTarget": "accountUpn"}}}
        with self.assertRaisesRegex(ValueError, "requires a target-specific approval"):
            ingest_factory.derived_record(row, bypass, "a" * 64, "c" * 64, "d" * 64, tier, "e" * 64)
        explicit = {**generic, "targetApprovals": {"sourceUsername": {
            "status": "approved", "sourceTarget": "accountUpn", "finding": "The account is the initiating actor."
        }}}
        with_target = ingest_factory.derived_record(row, explicit, "a" * 64, "c" * 64, "d" * 64, tier, "e" * 64)
        self.assertEqual(with_target["decisions"]["sourceUsername"]["state"], "mapped")
        self.assertEqual(with_target["decisions"]["sourceUsername"]["reviewFinding"], "The account is the initiating actor.")

    @unittest.skipUnless(os.environ.get("LAYA_MODEL_PATH"), "real pinned checkpoint not configured")
    def test_real_renderer_golden_projection_is_exact(self):
        import runner
        agent = runner.runtime.load()
        decisions = [
            {"id": "c", "kind": "classify", "target": {"id": "sourceIp", "description": "the source IP address from which the activity originated", "excludes": "destination or collector address", "valueType": "ip"},
             "field": {"id": "f", "key": "sourceAddress", "ancestry": ["documents", "0"], "value": "203.0.113.8", "context": [], "omittedSiblings": 0}},
            {"id": "q", "kind": "choose", "target": {"id": "sourceIp", "description": "the source IP address from which the activity originated", "excludes": "destination or collector address", "valueType": "ip"},
             "candidates": [
                 {"id": "a", "key": "sourceAddress", "ancestry": ["documents", "0"], "evidence": "203.0.113.8", "context": []},
                 {"id": "b", "key": "destinationAddress", "ancestry": ["documents", "0"], "evidence": "198.51.100.9", "context": []},
             ], "maxCandidates": 16},
        ]
        for decision in decisions:
            direct = runner.classify_items(agent, decision) if decision["kind"] == "classify" else [runner.choice_item(agent, decision)]
            expected = {"items": [compiler.render_projection(item) for item in direct]}
            actual = compiler.render_decision(runner, agent, decision)
            self.assertEqual(actual, expected)
            for item in actual["items"]:
                for key in ("ids", "markers", "qtype", "state", "question", "tokenAccounting"):
                    self.assertEqual(item[key], expected["items"][0][key])


if __name__ == "__main__":
    unittest.main()
