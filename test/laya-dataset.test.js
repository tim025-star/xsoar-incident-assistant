import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { createLayaDatasetStore } from "../src/laya-dataset.js";

test("managed Laya datasets resolve unique values and preserve explicit label states", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "laya-dataset-"));
  const store = createLayaDatasetStore({ directory });
  try {
    const saved = await store.add({
      documents: [{ opaque: { a7: "203.0.113.4", b9: "example.user" } }],
      labels: {
        sourceIp: { state: "mapped", value: "203.0.113.4" },
        sourceUsername: { state: "mapped", value: "example.user" },
        destinationIp: { state: "absent" }
      }
    });
    assert.equal(saved.labels.sourceIp.pointer, "/documents/0/opaque/a7");
    assert.equal(saved.labels.destinationIp.state, "absent");
    assert.equal(saved.labels.customerName.state, "unlabelled");
    assert.equal((await store.list())[0].mappedFields.includes("sourceIp"), true);
    assert.deepEqual((await store.get(saved.id)).documents, saved.documents);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("duplicate values require explicit pointer confirmation", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "laya-dataset-"));
  const store = createLayaDatasetStore({ directory });
  try {
    await assert.rejects(() => store.add({
      documents: [{ first: "same", second: "same" }],
      labels: { sourceUsername: { state: "mapped", value: "same" } }
    }), /matches multiple JSON pointers/);
    const saved = await store.add({
      documents: [{ first: "same", second: "same" }],
      labels: { sourceUsername: { state: "mapped", value: "same", pointer: "/documents/0/second" } }
    });
    assert.equal(saved.labels.sourceUsername.pointer, "/documents/0/second");
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("datasets export and import without losing raw examples", async () => {
  const firstDirectory = await mkdtemp(path.join(os.tmpdir(), "laya-dataset-a-"));
  const secondDirectory = await mkdtemp(path.join(os.tmpdir(), "laya-dataset-b-"));
  try {
    const first = createLayaDatasetStore({ directory: firstDirectory });
    await first.add({ documents: [{ x: "value" }], labels: { eventName: { state: "mapped", value: "value" } } });
    const second = createLayaDatasetStore({ directory: secondDirectory });
    await second.importJsonl(await first.exportJsonl());
    assert.equal((await second.list()).length, 1);
    assert.deepEqual((await second.exportJsonl()), await first.exportJsonl());
    await second.clear();
    assert.deepEqual(await second.list(), []);
  } finally {
    await Promise.all([rm(firstDirectory, { recursive: true, force: true }), rm(secondDirectory, { recursive: true, force: true })]);
  }
});
