import test from "node:test";
import assert from "node:assert/strict";

import {
  createLayaMapper,
  flattenAlertDocuments,
  resolveAlertPointer
} from "../src/laya-mapper.js";

test("flattening preserves opaque names, arrays, values, and exact JSON pointers", () => {
  const documents = [{ "a/b": { "~opaque": [null, 42, "example"] } }];
  const leaves = flattenAlertDocuments(documents);
  assert.deepEqual(leaves.map(({ pointer, value }) => ({ pointer, value })), [
    { pointer: "/documents/0/a~1b/~0opaque/0", value: null },
    { pointer: "/documents/0/a~1b/~0opaque/1", value: 42 },
    { pointer: "/documents/0/a~1b/~0opaque/2", value: "example" }
  ]);
  for (const leaf of leaves) assert.equal(resolveAlertPointer(documents, leaf.pointer), leaf.value);
});

test("every leaf reaches round one and only Laya decides relevance and selection", async () => {
  const seenRoundOne = [];
  const seenRoundTwo = [];
  const progress = [];
  const documents = [{ x7: "203.0.113.42", misleadingHostname: "not-an-ip", nested: { z9: "user@example.test" } }];
  const runner = {
    status: async () => ({ available: true }),
    countTokens: async ({ leaves }) => leaves.length * 400,
    useCheckpoint: async () => {},
    relevance: async ({ chunk, targets }) => {
      seenRoundOne.push(...chunk.leaves.map((leaf) => leaf.pointer));
      const hasOpaqueIp = chunk.leaves.some((leaf) => leaf.pointer.endsWith("/x7"));
      return Object.fromEntries(targets.map(({ id }) => [id, id === "sourceIp" && hasOpaqueIp ? 0.9 : 0.1]));
    },
    choose: async ({ target, candidates }) => {
      seenRoundTwo.push(...candidates.map((candidate) => candidate.pointer));
      return {
        rankings: candidates.map((candidate) => ({
          id: candidate.id,
          score: target === "sourceIp" && candidate.pointer.endsWith("/x7") ? 1 : 0
        }))
      };
    }
  };
  const mapped = await createLayaMapper({ runner, maxChunkTokens: 500, maxChoices: 2 }).mapIncident({
    documents,
    targets: ["sourceIp"],
    onProgress: ({ detail }) => progress.push(detail)
  });
  assert.deepEqual(new Set(seenRoundOne), new Set(flattenAlertDocuments(documents).map((leaf) => leaf.pointer)));
  assert.ok(seenRoundTwo.includes("/documents/0/x7"));
  assert.equal(mapped.fields.sourceIp, "203.0.113.42");
  assert.equal(mapped.paths.sourceIp, "/documents/0/x7");
  assert.ok(progress.some((detail) => detail.startsWith("Round 1:")));
  assert.ok(progress.some((detail) => detail.startsWith("Round 2:")));
  assert.match(progress.at(-1), /Completed mapping/);
});

test("round two inspects every relevant chunk and adjudicates all batch winners", async () => {
  const documents = [{ a: "one", b: "two", c: "three", d: "winner" }];
  const relevanceChunks = [];
  const adjudicationInputs = [];
  const runner = {
    status: async () => ({ available: true }),
    countTokens: async ({ leaves }) => leaves.length * 400,
    useCheckpoint: async () => {},
    relevance: async ({ chunk }) => {
      relevanceChunks.push(chunk.id);
      return { sourceUsername: 0.9 };
    },
    choose: async ({ candidates }) => {
      adjudicationInputs.push(candidates.map((candidate) => candidate.pointer));
      return { rankings: candidates.map((candidate) => ({ id: candidate.id, score: candidate.pointer.endsWith("/d") ? 10 : 1 })) };
    }
  };
  const mapped = await createLayaMapper({ runner, maxChunkTokens: 500, maxChoices: 2 }).mapIncident({
    documents,
    targets: ["sourceUsername"]
  });
  assert.equal(relevanceChunks.length, 4);
  assert.ok(adjudicationInputs.flat().includes("/documents/0/a"));
  assert.ok(adjudicationInputs.flat().includes("/documents/0/d"));
  assert.equal(mapped.fields.sourceUsername, "winner");
  assert.equal(mapped.provenance.sourceUsername.relevantChunks.length, 4);
});

test("invalid selected values are rejected and incomplete evidence is reported", async () => {
  const runner = {
    status: async () => ({ available: true }),
    countTokens: async () => 1,
    useCheckpoint: async () => {},
    relevance: async () => ({ destinationIp: 1 }),
    choose: async ({ candidates }) => ({ rankings: candidates.map((candidate) => ({ id: candidate.id, score: 1 })) })
  };
  const mapped = await createLayaMapper({ runner }).mapIncident({
    documents: [{ opaque: "not an IP" }],
    targets: ["destinationIp"],
    complete: false
  });
  assert.deepEqual(mapped.fields, {});
  assert.match(mapped.warning, /coverage was incomplete/);
  assert.match(mapped.warning, /destinationIp/);
});

test("the highest-ranked valid path wins when Laya ranks an invalid value first", async () => {
  const runner = {
    countTokens: async () => 1,
    useCheckpoint: async () => {},
    status: async () => ({ available: true }),
    relevance: async ({ targets }) => Object.fromEntries(targets.map(({ id }) => [id, 1])),
    choose: async ({ candidates }) => ({ rankings: candidates.map((candidate, index) => ({
      id: candidate.id,
      score: index === 0 ? 1 : 0.9
    })) })
  };
  const mapper = createLayaMapper({ runner });
  const result = await mapper.mapIncident({
    documents: [{ first: "not-an-ip", second: "203.0.113.19" }],
    targets: ["sourceIp"]
  });
  assert.equal(result.fields.sourceIp, "203.0.113.19");
  assert.equal(result.paths.sourceIp, "/documents/0/second");
});
