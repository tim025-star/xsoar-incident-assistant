import { parentPort, workerData } from "node:worker_threads";

import { getQuickJS } from "quickjs-emscripten";

try {
  const quickJS = await getQuickJS();
  const runtime = quickJS.newRuntime();
  runtime.setMemoryLimit(16 * 1024 * 1024);
  runtime.setMaxStackSize(256 * 1024);
  const deadline = Date.now() + 500;
  runtime.setInterruptHandler(() => Date.now() > deadline);
  const context = runtime.newContext();
  try {
    const incidentJson = context.newString(JSON.stringify(workerData.incident));
    context.setProp(context.global, "__incidentJson", incidentJson);
    incidentJson.dispose();
    const result = context.evalCode(`(() => {
      "use strict";
      const incident = Object.freeze(JSON.parse(__incidentJson));
      const quote = (value) => JSON.stringify(String(value ?? ""));
      ${workerData.source}
      if (typeof buildQuery !== "function") throw new Error("Define buildQuery(incident, quote).");
      return buildQuery(incident, quote);
    })()`);
    if (result.error) {
      const error = context.dump(result.error);
      result.error.dispose();
      throw new Error(String(error?.message || error).slice(0, 300));
    }
    const query = context.dump(result.value);
    result.value.dispose();
    if (typeof query !== "string" || query.length > 2048) {
      throw new Error("Historic query JavaScript must return a string no longer than 2048 characters.");
    }
    parentPort.postMessage({ query });
  } finally {
    context.dispose();
    runtime.dispose();
  }
} catch (error) {
  parentPort.postMessage({ error: String(error instanceof Error ? error.message : error).slice(0, 300) });
}
