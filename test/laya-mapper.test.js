import test from "node:test";
import assert from "node:assert/strict";
import { createLayaMapper as createMapper, flattenAlertDocuments, resolveAlertPointer } from "../src/laya-mapper.js";
import { chooseWorkerCount, createLayaWorkerPool, createLayaSidecarRunner } from "../src/laya-worker.js";

const NONE = "__none__";
// Preserve the original orchestration checks against the frozen experiment.
function createLayaMapper(options) {
  const mapper = createMapper(options);
  return { ...mapper, mapIncident: (input) => mapper.mapIncident({ experiment: "baseline", ...input }) };
}
// These doubles test orchestration, not semantic model accuracy.
function mockRunner({ limit = 4, choose = (candidates) => candidates.find((c) => c.value === "answer")?.id || NONE, score = () => 0.01, mutate = (x) => x, workers = 1 } = {}) {
  const seen = [];
  return { seen, close() {}, status: async () => ({ available: true }), configure: async () => ({ effectiveWorkers: workers, capabilities: ["value-groups-v1"] }),
    async evaluate({ decisions }) {
      seen.push(...decisions);
      return mutate({ results: decisions.map((d) => {
        if (d.kind === "classify") return { id: d.id, score: score(d), evidence: String(d.field.value), selectedWindow: { startToken: 0, endToken: 1, totalValueTokens: 1 }, windows: [{ startToken: 0, endToken: 1, totalValueTokens: 1, score: score(d), tokenAccounting: { implicitTruncation: false } }] };
        const candidates = d.candidates.slice(0, Math.min(limit, d.maxCandidates || limit));
        const selected = choose(candidates, d);
        return { id: d.id, consumed: candidates.length, choice: selected, probabilities: Object.fromEntries([...candidates.map((c) => c.id), NONE].map((id) => [id, id === selected ? 1 : 0])) };
      }) });
    }
  };
}

test("stable records preserve JSON pointers, arrays and object-order independence", () => {
  const a = [{ z: 4, "a/b": { "~key": [null, "hello", false] } }];
  const b = [{ "a/b": { "~key": [null, "hello", false] }, z: 4 }];
  assert.deepEqual(flattenAlertDocuments(a), flattenAlertDocuments(b));
  for (const leaf of flattenAlertDocuments(a)) assert.equal(resolveAlertPointer(a, leaf.pointer), leaf.value);
  assert.equal(resolveAlertPointer(a, "/documents/0/__proto__"), undefined);
  assert.throws(() => flattenAlertDocuments([{ text: "x".repeat(100000) }]), /limit/);
});

test("typed value groups assess every alias and compare distinct values without fixed semantic winners", async () => {
  const documents = [{ source: { account: "answer" }, destination: { account: "answer" }, aliases: Array(9).fill("answer"), numeric: 42, text: "42", spaced: " answer " }];
  const runner = mockRunner({ choose: (c) => c.find((f) => f.ancestry.includes("source"))?.id || c.find((f) => f.value === "answer")?.id || NONE, score: () => 0.8 });
  const mapper = createMapper({ runner });
  const result = await mapper.mapIncident({ documents, targets: ["clientUserName"] });
  const trace = result.provenance.clientUserName;
  assert.equal(result.processingComplete, true);
  assert.equal(result.paths.clientUserName, "/documents/0/source/account");
  assert.equal(trace.groups.length, 4);
  assert.equal(trace.assessedIds.length, 14);
  for (const direction of ["forward", "reverse"]) assert.equal(new Set(trace.comparisons.filter((c) => c.pass.endsWith(direction)).flatMap((c) => c.candidateIds)).size, 14);
  assert.equal(result.coverage.clientUserName.distinctValues, 4);
  for (const comparison of trace.comparisons.filter((c) => !c.pass.startsWith("aliases:"))) {
    const fields = comparison.candidateIds.map((id) => flattenAlertDocuments(documents).find((f) => f.id === id));
    assert.equal(new Set(fields.map((f) => JSON.stringify([f.type, f.value]))).size, fields.length);
    assert.ok(fields.length <= 16);
  }
  const reordered = await mapper.mapIncident({ documents: [{ ...Object.fromEntries(Object.entries(documents[0]).reverse()) }], targets: ["clientUserName"] });
  assert.deepEqual(reordered.paths, result.paths);
  assert.deepEqual(reordered.provenance.clientUserName.groups, trace.groups);
});

test("value agreement and pointer disagreement remain distinct", async () => {
  const result = await createMapper({ runner: mockRunner({ choose: (c) => c[0].id, score: () => 0.9 }) }).mapIncident({ documents: [{ a: "answer", b: "answer" }], targets: ["clientUserName"] });
  assert.equal(result.statuses.clientUserName, "tentative");
  assert.deepEqual(result.provenance.clientUserName.agreement, { value: "agreed", pointer: "disagreed" });
  assert.equal(result.fields.clientUserName, "answer");
  assert.equal(result.provenance.clientUserName.groups[0].memberIds.length, 2);
  const rejectedAliases = await createMapper({ runner: mockRunner({ choose: (c) => c.length > 1 ? NONE : c[0].id }) }).mapIncident({ documents: [{ a: "answer", b: "answer" }], targets: ["clientUserName"], experiment: "grouped" });
  assert.equal(rejectedAliases.fields.clientUserName, "answer");
  assert.equal(rejectedAliases.statuses.clientUserName, "tentative");
  assert.equal(rejectedAliases.provenance.clientUserName.agreement.pointer, "unresolved");
  assert.equal(rejectedAliases.provenance.clientUserName.disagreements, false);
  assert.equal(rejectedAliases.coverage.clientUserName.finalAssessed, 2);
});

test("older runtimes fail closed when value grouping is required", async () => {
  const runner = mockRunner({ score: () => 0.8 });
  const input = { documents: [{ a: "answer" }], targets: ["clientUserName"] };
  runner.configure = async () => ({ effectiveWorkers: 1 });
  const old = await createMapper({ runner }).mapIncident(input);
  assert.equal(old.processingComplete, false);
  assert.match(old.warning, /Update the Laya inference runtime/);
});

test("every eligible field reaches both sweeps, including low scores beyond 24, and multiple buckets", async () => {
  const documents = [Object.fromEntries(Array.from({ length: 40 }, (_, i) => ["field" + String(i).padStart(2, "0"), i === 39 ? "answer" : "other"]))];
  const runner = mockRunner({ score: (d) => d.field.value === "answer" ? 0.001 : 0.9 });
  const result = await createLayaMapper({ runner }).mapIncident({ documents, targets: ["sourceUsername", "clientUserName"] });
  assert.equal(result.processingComplete, true);
  for (const target of ["sourceUsername", "clientUserName"]) {
    assert.equal(result.statuses[target], "selected");
    assert.equal(result.paths[target], "/documents/0/field39");
    assert.equal(result.provenance[target].candidates.length, 40);
    for (const pass of ["forward", "reverse"]) assert.equal(new Set(result.provenance[target].comparisons.filter((c) => c.pass === pass).flatMap((c) => c.candidateIds)).size, 40);
  }
  assert.equal(runner.seen.filter((d) => d.kind === "classify").length, 80);
});

test("paired array records retain sibling role context and source values are resolved exactly", async () => {
  const runner = mockRunner({ choose: (c) => c.find((candidate) => candidate.key === "value")?.id || NONE });
  const result = await createLayaMapper({ runner }).mapIncident({ documents: [{ attrs: [{ key: "Client account", value: "  name  " }] }], targets: ["clientUserName"] });
  const value = runner.seen.find((d) => d.kind === "classify" && d.field.key === "value");
  assert.deepEqual(value.field.context, [{ key: "key", value: "Client account" }]);
  assert.equal(result.fields.clientUserName, "  name  ");
  const numeric = await createLayaMapper({ runner }).mapIncident({ documents: [{ value: 42 }], targets: ["clientUserName"] });
  assert.equal(numeric.fields.clientUserName, 42);
});

test("none, empty and single-candidate buckets need no invented padding", async () => {
  for (const documents of [[{}], [{ ip: "not an ip" }], [{ ip: "192.0.2.2" }]]) {
    const runner = mockRunner();
    const result = await createLayaMapper({ runner }).mapIncident({ documents, targets: ["sourceIp"], complete: false });
    assert.equal(result.statuses.sourceIp, "no_supported_match");
    assert.equal(result.sourceComplete, false);
    assert.equal(result.processingComplete, true);
    for (const d of runner.seen.filter((d) => d.kind === "choose")) assert.equal(d.candidates.length, 1);
  }
});

test("disagreement remains tentative, records none votes, and tie-breaks deterministically", async () => {
  const runner = mockRunner({ choose: (c) => c[0].id });
  const result = await createLayaMapper({ runner }).mapIncident({ documents: [{ a: "one", b: "two" }], targets: ["clientUserName"] });
  assert.equal(result.statuses.clientUserName, "tentative");
  assert.equal(result.paths.clientUserName, "/documents/0/a");
  assert.equal(result.provenance.clientUserName.comparisons.filter((c) => c.pass === "adjudication").length, 2);
  assert.match(result.warning, /Tentative/);
  let count = 0;
  const nonePreference = await createLayaMapper({ runner: mockRunner({ choose: (c) => ++count === 1 ? c[0].id : NONE }) }).mapIncident({ documents: [{ a: "answer" }], targets: ["clientUserName"] });
  assert.equal(nonePreference.statuses.clientUserName, "tentative");
  assert.equal(nonePreference.provenance.clientUserName.nominees[1], NONE);
  assert.ok(nonePreference.provenance.clientUserName.comparisons.filter((c) => c.pass === "adjudication").every((c) => c.choice === NONE));
});

test("malformed/missing/duplicate/nonfinite responses never become no-match", async () => {
  const mutations = [
    () => ({}), (r) => ({ results: r.results.slice(1) }),
    (r) => ({ results: [r.results[0], r.results[0]] }),
    (r) => ({ results: r.results.map((i) => ({ ...i, score: NaN })) }),
    (r) => ({ results: r.results.map((i) => ({ ...i, score: Infinity })) })
  ];
  for (const mutate of mutations) {
    const result = await createLayaMapper({ runner: mockRunner({ mutate }) }).mapIncident({ documents: [{ a: "x", b: "y" }], targets: ["clientUserName"] });
    assert.equal(result.processingComplete, false);
    assert.equal(result.statuses.clientUserName, "incomplete");
    assert.match(result.warning, /incomplete/);
  }
});

test("worker scheduling does not change deterministic orchestration or omit decisions", async () => {
  const documents = [{ a: "answer", b: "b", c: "c" }];
  const outputs = [];
  for (const workers of [1, 2, 4]) outputs.push(await createLayaMapper({ runner: mockRunner({ workers }) }).mapIncident({ documents, targets: ["clientHostname", "clientUserName", "customerName"] }));
  for (const r of outputs) { assert.equal(r.decisionsCompleted, outputs[0].decisionsCompleted); assert.deepEqual(r.paths, outputs[0].paths); }
});

test("automatic mode uses the measured single-worker default while manual mode respects pending work", () => {
  assert.equal(chooseWorkerCount({ processors: 16, availableMemory: 25 * 1024 ** 3 }), 1);
  assert.equal(chooseWorkerCount({ processors: 8, availableMemory: 13 * 1024 ** 3 }), 1);
  assert.equal(chooseWorkerCount({ processors: 16, availableMemory: 4 * 1024 ** 3 }), 1);
  assert.equal(chooseWorkerCount({ workerMode: "manual", workerCount: 4, workItems: 2 }), 2);
});

test("interrupted batches retry once with a fresh worker and repeated failure is surfaced", async () => {
  let calls = 0, closes = 0;
  const pool = createLayaWorkerPool({ runnerFactory: () => ({ close() { closes++; }, status: async () => ({ available: true }), evaluate: async () => { if (++calls === 1) throw Error("interrupted"); return { results: [] }; } }) });
  await pool.configure({ workerMode: "manual", workerCount: 1 });
  assert.deepEqual((await pool.evaluate({ decisions: [] })).results, []);
  assert.equal(calls, 2); assert.equal(closes, 1);
  pool.close();
  const failed = createLayaMapper({ runner: mockRunner({ mutate: () => { throw Error("failed twice"); } }) });
  assert.equal((await failed.mapIncident({ documents: [{ x: "x" }], targets: ["clientUserName"] })).statuses.clientUserName, "incomplete");
});

test("cancellation terminates workers and prevents queued work or retries", async () => {
  let rejectRunning, calls = 0, closes = 0;
  const pool = createLayaWorkerPool({ runnerFactory: () => ({ close() { closes++; rejectRunning?.(Error("closed")); }, status: async () => ({ available: true }), evaluate: () => { calls++; return new Promise((_, reject) => { rejectRunning = reject; }); } }) });
  const mapper = createLayaMapper({ runner: pool });
  const controller = new AbortController();
  const pending = mapper.mapIncident({ documents: [{ x: "x" }], targets: ["clientUserName"], signal: controller.signal });
  while (!calls) await new Promise((resolve) => setImmediate(resolve));
  controller.abort();
  await assert.rejects(pending, /cancelled/);
  assert.equal(calls, 1); assert.ok(closes >= 1);
});

test("old executable fails protocol handshake", async () => {
  const { EventEmitter } = await import("node:events");
  const { PassThrough, Writable } = await import("node:stream");
  const runner = createLayaSidecarRunner({ executable: process.execPath, spawnImplementation: () => {
    const child = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.kill = () => {};
    child.stdin = new Writable({ write(chunk, _encoding, done) { const request = JSON.parse(chunk.toString()); child.stdout.write(JSON.stringify({ id: request.id, result: { available: true } }) + "\n"); done(); } });
    return child;
  } });
  await assert.rejects(runner.status(), /protocol-2/);
  runner.close();
});
