import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

export function createPrepareBridge({ compilerPath, basePath, python = "python", spawnImplementation = spawn, timeoutMs = 180000 }) {
  const child = spawnImplementation(python, [compilerPath, "prepare-server", "--base", basePath], {
    windowsHide: true, stdio: ["pipe", "pipe", "inherit"], env: { ...process.env, PYTHONUNBUFFERED: "1" }
  });
  const pending = new Map();
  let nextId = 0;
  const failAll = (error) => {
    for (const request of pending.values()) {
      clearTimeout(request.timer);
      request.reject(error);
    }
    pending.clear();
  };
  createInterface({ input: child.stdout }).on("line", (line) => {
    let response;
    try { response = JSON.parse(line); }
    catch { child.kill(); failAll(new Error("Production renderer returned invalid protocol output.")); return; }
    const request = pending.get(response.id);
    if (!request) return;
    pending.delete(response.id); clearTimeout(request.timer);
    if (response.error) request.reject(new Error(response.error));
    else request.resolve(response.result);
  });
  child.once("exit", () => failAll(new Error("Production renderer stopped.")));
  child.once("error", () => failAll(new Error("Production renderer failed to start.")));
  return {
    prepare(decisions) {
      const id = String(nextId++);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          child.kill();
          failAll(new Error("Production renderer preparation timed out."));
        }, timeoutMs);
        pending.set(id, { resolve, reject, timer });
        child.stdin.write(`${JSON.stringify({ id, decisions })}\n`, (error) => {
          if (error) {
            child.kill();
            failAll(new Error("Production renderer request failed."));
          }
        });
      });
    },
    close() { child.kill(); failAll(new Error("Production renderer closed.")); }
  };
}
