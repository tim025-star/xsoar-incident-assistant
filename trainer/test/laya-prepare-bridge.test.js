import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";

import { createPrepareBridge } from "../scripts/laya-prepare-bridge.mjs";

function childDouble() {
  const child = new EventEmitter();
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.killed = false;
  child.kill = () => { child.killed = true; };
  return child;
}

test("renderer preparation timeout rejects pending work and kills the process", async () => {
  const child = childDouble();
  const bridge = createPrepareBridge({ compilerPath: "compiler.py", basePath: "base", timeoutMs: 5, spawnImplementation: () => child });
  await assert.rejects(bridge.prepare([{ id: "d1" }]), /preparation timed out/i);
  assert.equal(child.killed, true);
});

test("renderer bridge resolves a matching protocol response", async () => {
  const child = childDouble();
  const bridge = createPrepareBridge({ compilerPath: "compiler.py", basePath: "base", timeoutMs: 1000, spawnImplementation: () => child });
  child.stdin.once("data", (line) => {
    const request = JSON.parse(String(line));
    child.stdout.write(`${JSON.stringify({ id: request.id, result: [{ id: "d1" }] })}\n`);
  });
  assert.deepEqual(await bridge.prepare([{ id: "d1" }]), [{ id: "d1" }]);
  bridge.close();
});
