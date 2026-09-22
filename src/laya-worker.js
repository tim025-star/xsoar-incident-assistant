import { access } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { LAYA_MODEL, LAYA_PROMPT_VERSION } from "./laya-targets.js";

export function chooseWorkerCount({ workerMode = "auto", workerCount = 1, workItems = 4 } = {}) {
  // One resident checkpoint with a divided CPU thread budget was fastest in the
  // fixed one/two/four-worker benchmark. Manual mode remains available for
  // different hardware and genuinely independent workloads.
  return Math.max(1, Math.min(workItems, workerMode === "manual" ? Math.max(1, Math.min(4, workerCount)) : 1));
}

function executablePath() {
  return process.env.LAYA_MAPPER_EXECUTABLE || path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local"), "XSOAR Incident Assistant", "laya-mapper", "runtime-v2", "laya-mapper.exe");
}

export function createLayaSidecarRunner({ executable = executablePath(), arguments_ = ["serve"], threads = 1, spawnImplementation = spawn, timeoutMs = 180000, env = {} } = {}) {
  let child, starting, generation = 0;
  const pending = new Map();
  const failAll = (error) => {
    for (const item of pending.values()) { clearTimeout(item.timer); item.reject(error); }
    pending.clear();
  };
  const close = () => {
    generation++;
    const previous = child;
    child = undefined;
    previous?.kill();
    failAll(new Error("Laya-mapper process closed."));
  };
  const start = async () => {
    if (child && !child.killed) return child;
    if (starting) return starting;
    starting = (async () => {
      const epoch = generation;
      await access(executable).catch(() => { throw new Error("Install the base-English Laya runtime (protocol 2) first."); });
      if (epoch !== generation) throw new Error("Laya-mapper operation was cancelled.");
      const process_ = spawnImplementation(executable, arguments_, { windowsHide: true, stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, ...env, HF_HUB_OFFLINE: "1", TRANSFORMERS_OFFLINE: "1", HF_DATASETS_OFFLINE: "1", LAYA_CPU_THREADS: String(threads), OMP_NUM_THREADS: String(threads), MKL_NUM_THREADS: String(threads), TOKENIZERS_PARALLELISM: "false" } });
      child = process_;
      let buffered = "";
      process_.stdout.setEncoding("utf8");
      process_.stdout.on("data", (chunk) => {
        if (child !== process_) return;
        buffered += chunk;
        if (Buffer.byteLength(buffered) > 4 * 1024 * 1024) { close(); return; }
        let newline;
        while ((newline = buffered.indexOf("\n")) >= 0) {
          const line = buffered.slice(0, newline); buffered = buffered.slice(newline + 1);
          if (!line.trim()) continue;
          let response;
          try { response = JSON.parse(line); } catch { failAll(new Error("Laya returned invalid protocol output.")); close(); return; }
          const request = pending.get(response.id);
          if (!request) continue;
          pending.delete(response.id); clearTimeout(request.timer);
          if (response.error) request.reject(new Error(String(response.error)));
          else request.resolve(response.result);
        }
      });
      // Drain stderr without retaining alert content or blocking the child.
      process_.stderr.on("data", () => {});
      process_.once("error", () => { if (child === process_) { child = undefined; failAll(new Error("Laya-mapper is unavailable.")); } });
      process_.once("exit", () => { if (child === process_) { child = undefined; failAll(new Error("Laya-mapper stopped unexpectedly.")); } });
      return process_;
    })();
    try { return await starting; } finally { starting = undefined; }
  };
  const request = async (action, input = {}) => {
    const process_ = await start();
    const id = randomUUID();
    const line = JSON.stringify({ id, action, input }) + "\n";
    if (Buffer.byteLength(line) > 4 * 1024 * 1024) throw new Error("Laya request is too large.");
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { pending.delete(id); reject(new Error("Laya-mapper timed out.")); close(); }, timeoutMs);
      pending.set(id, { resolve, reject, timer });
      process_.stdin.write(line, "utf8", (error) => { if (error) close(); });
    });
  };
  return { close, evaluate: (input) => request("evaluate", input), async status() {
    const result = await request("status");
    if (result.protocolVersion !== 2 || result.model?.id !== LAYA_MODEL.id || result.model?.revision !== LAYA_MODEL.revision
        || result.sdkVersion !== LAYA_MODEL.sdkVersion || result.promptVersion !== LAYA_PROMPT_VERSION) throw new Error("Laya runtime/checkpoint mismatch; install the pinned base-English protocol-2 runtime.");
    return result;
  } };
}

export function createLayaWorkerPool({ runnerFactory = (options) => createLayaSidecarRunner(options) } = {}) {
  let slots = [], queue = [], generation = 0, configuration = "", info;
  const close = () => {
    generation++;
    for (const slot of slots) slot.runner.close();
    for (const job of queue.splice(0)) job.reject(new Error("Laya-mapper operation was cancelled."));
    slots = []; configuration = ""; info = undefined;
  };
  const drain = () => {
    for (const slot of slots) {
      if (slot.busy || !queue.length) continue;
      const job = queue.shift();
      if (job.signal?.aborted) { job.reject(new Error("Laya-mapper operation was cancelled.")); queueMicrotask(drain); continue; }
      slot.busy = true;
      const epoch = generation;
      void (async () => {
        try {
          let result;
          for (let attempt = 0; attempt < 2; attempt++) {
            try { result = await slot.runner.evaluate(job.input); break; }
            catch (error) {
              if (attempt || epoch !== generation || job.signal?.aborted) throw error;
              slot.runner.close();
              slot.runner = runnerFactory({ threads: slot.threads });
              const status = await slot.runner.status();
              if (!status.available) throw new Error(status.detail);
            }
          }
          if (epoch !== generation || job.signal?.aborted) throw new Error("Laya-mapper operation was cancelled.");
          slot.runtime = result.runtime;
          job.resolve({ ...result, runtime: { ...result.runtime, ...info, workers: slots.map((worker) => worker.runtime).filter(Boolean) } });
        } catch (error) { job.reject(error); }
        finally { slot.busy = false; drain(); }
      })();
    }
  };
  return {
    close,
    async status() {
      if (!slots.length) slots = [{ runner: runnerFactory({ threads: 1 }), busy: false, threads: 1 }];
      try { return { ...await slots[0].runner.status(), ...info }; }
      catch (error) { return { available: false, detail: error.message, model: LAYA_MODEL, protocolVersion: 2 }; }
    },
    async configure(settings) {
      const count = chooseWorkerCount(settings);
      const threads = Math.max(1, Math.floor(Math.max(1, os.availableParallelism() - 2) / count));
      const key = count + ":" + threads;
      if (configuration !== key) {
        close();
        if (count > 1 && os.freemem() < (count * 2.5 + 1) * 1024 ** 3) throw new Error("Insufficient available RAM for " + count + " English workers; free memory or select fewer workers.");
        slots = Array.from({ length: count }, () => ({ runner: runnerFactory({ threads }), busy: false, threads }));
        configuration = key;
      }
      const status = await slots[0].runner.status();
      if (!status.available) throw new Error(status.detail);
      info = { effectiveWorkers: count, threadsPerWorker: threads, workerMode: settings.workerMode, requestedWorkers: settings.workerCount };
      return { ...status, ...info };
    },
    evaluate(input, { signal } = {}) {
      return new Promise((resolve, reject) => {
        if (!slots.length) { reject(new Error("Configure the Laya worker pool first.")); return; }
        queue.push({ input, signal, resolve, reject }); drain();
      });
    }
  };
}
