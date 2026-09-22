"""Real tokenizer and SDK parity checks; set LAYA_MODEL_PATH to the pinned checkpoint."""
import unittest
import numpy as np
import runner


class AdapterChecks(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.agent = runner.runtime.load()

    def test_independent_batch_matches_sdk(self):
        items = []
        for index, value in enumerate(["Source IP address is 192.0.2.4", "No IP address is present"]):
            q = {"t": "noul", "ins": "Does this state contain an IP address?", "crit": {}}
            item = runner.checked_sequence(self.agent, value, q)
            item["decisionId"] = str(index)
            items.append(item)
        q = {"t": "choice", "ins": "Which is the source IP?", "crit": {"A": "192.0.2.4", "B": "198.51.100.2", "none": "No source IP"}}
        item = runner.checked_sequence(self.agent, "The source IP is 192.0.2.4. The destination IP is 198.51.100.2.", q)
        item["decisionId"] = "choice"
        items.append(item)
        for item, probabilities in runner.infer(self.agent, items):
            q = item["question"]
            answer = self.agent.predict(item["state"], {"test": {"type": q["t"], "instructions": q["ins"], "criteria": q["crit"]}})["answers"]["test"]
            if q["t"] == "noul":
                self.assertAlmostEqual(float(probabilities[1]), answer["noul"], delta=0.0002)
            else:
                np.testing.assert_allclose(probabilities, list(answer["probabilities"].values()), atol=0.0002, rtol=0)

    def test_tokens_windows_and_omissions(self):
        target = {"id": "descriptionLong", "description": "the original event description"}
        field = {"id": "long", "key": "message", "ancestry": ["documents", "0", "event"], "value": "long description " * 300, "context": [{"key": "other" + str(i), "value": "text " * 100} for i in range(16)], "omittedSiblings": 4}
        items = runner.classify_items(self.agent, {"id": "long", "field": field, "target": target})
        self.assertGreater(len(items), 1)
        self.assertEqual(items[0]["window"]["startToken"], 0)
        self.assertEqual(items[-1]["window"]["endToken"], items[-1]["window"]["totalValueTokens"])
        for left, right in zip(items, items[1:]):
            self.assertGreater(left["window"]["endToken"], right["window"]["startToken"])
        for item in items:
            self.assertLessEqual(len(item["ids"]), 512)
            self.assertLessEqual(item["tokenAccounting"]["headTokens"], 192)
            self.assertGreater(item["tokenAccounting"]["omittedSiblings"], 4)
            self.assertFalse(item["tokenAccounting"]["implicitTruncation"])
        candidates = [{**field, "id": "f" + str(i), "evidence": items[0]["evidence"]} for i in range(24)]
        choice = runner.choice_item(self.agent, {"id": "choice", "candidates": candidates, "target": target})
        self.assertGreaterEqual(choice["consumed"], 2)
        self.assertLess(choice["consumed"], 24)
        self.assertEqual(len(choice["markers"]), choice["consumed"] + 1)
        evaluated = runner.evaluate({"decisions": [{"id": "windows", "kind": "classify", "target": target, "field": {**field, "value": "A factual event description. " * 18, "context": []}}]})["results"][0]
        self.assertGreater(len(evaluated["windows"]), 1)
        self.assertEqual(evaluated["score"], max(w["score"] for w in evaluated["windows"]))

    def test_reversal_preserves_candidate_content_and_identifiers(self):
        candidates = [{"id": "field" + str(i), "key": "address", "ancestry": ["documents", "0", role], "evidence": "192.0.2." + str(i)} for i, role in enumerate(["source", "destination"])]
        decision = {"id": "order", "target": {"description": "the source IP address"}, "candidates": candidates}
        forward = runner.choice_item(self.agent, decision)
        reverse = runner.choice_item(self.agent, {**decision, "candidates": list(reversed(candidates))})
        self.assertEqual(forward["question"]["crit"], reverse["question"]["crit"])
        self.assertEqual(forward["state"], reverse["state"])
        self.assertEqual(list(forward["labels"]), list(reversed(list(reverse["labels"])[:-1])) + [runner.NONE])

    def test_no_implicit_instruction_or_option_truncation(self):
        for question in [{"t": "noul", "ins": "text " * 200, "crit": {}}, {"t": "choice", "ins": "Choose", "crit": {"a": "text " * 100, "none": "none"}}]:
            with self.assertRaises(ValueError):
                runner.checked_sequence(self.agent, "value", question)

    def test_grouped_choice_context_stays_token_safe(self):
        target = {"description": "the account name or principal identifier of the client user", "excludes": "person display name, application name, or session identifier"}
        fields = [{"id": "field" + str(i), "key": "userPrincipalName", "ancestry": ["documents", "0", role, "deviceDetail"], "evidence": "user@example.test", "context": [{"key": "deviceType", "value": "workstation"}, {"key": "displayName", "value": "Employee Device"}]} for i, role in enumerate(["client", "server"])]
        decision = {"id": "grouped", "kind": "choose", "target": target, "candidates": fields, "maxCandidates": 16}
        forward = runner.choice_item(self.agent, decision)
        reverse = runner.choice_item(self.agent, {**decision, "candidates": list(reversed(fields))})
        self.assertEqual(forward["state"], reverse["state"])
        self.assertEqual(forward["question"]["crit"], reverse["question"]["crit"])
        self.assertEqual(len(forward["markers"]), 3)
        for paired in [False, True]:
            long_fields = [{"id": "candidate" + str(i), "key": "value" if paired else "very long descriptive field key " * 10,
                            "ancestry": ["documents", "0", "long descriptive ancestry " * 20], "evidence": "descriptive " * 63,
                            "context": [{"key": "key" if paired else "neighbor field " * 10, "value": "account principal role " * 20},
                                        {"key": "second neighbor " * 10, "value": "another context " * 20}]} for i in range(2)]
            bounded = runner.choice_item(self.agent, {**decision, "candidates": long_fields})
            self.assertEqual(bounded["consumed"], 2)
            self.assertLessEqual(len(bounded["ids"]), 512)
            self.assertTrue(all(c["shortenedAncestry"] for c in bounded["tokenAccounting"]["candidates"]))


if __name__ == "__main__":
    unittest.main()
