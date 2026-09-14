import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptPath = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "scripts",
  "keyboard-trigger.ps1"
);

export function keyboardTriggerCommand({ endpoint, token }) {
  return {
    command: "powershell.exe",
    args: ["-NoLogo", "-NoProfile", "-NonInteractive", "-File", scriptPath],
    options: {
      env: {
        ...process.env,
        XSOAR_ASSISTANT_HOTKEY_ENDPOINT: endpoint,
        XSOAR_ASSISTANT_HOTKEY_TOKEN: token
      },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true
    }
  };
}

function waitForReady(child, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    let output = "";
    const timeout = setTimeout(() => finish(new Error("The Numpad+ keyboard trigger did not start within five seconds.")), timeoutMs);
    const finish = (error) => {
      clearTimeout(timeout);
      child.stdout.off("data", onOutput);
      child.off("error", onError);
      child.off("exit", onExit);
      if (error) reject(error);
      else resolve();
    };
    const onOutput = (chunk) => {
      output += String(chunk);
      if (/^READY\s*$/m.test(output)) finish();
    };
    const onError = () => finish(new Error("The Numpad+ keyboard trigger could not be started."));
    const onExit = (code) => finish(new Error(`The Numpad+ keyboard trigger exited before starting${code === null ? "." : ` (code ${code}).`}`));
    child.stdout.on("data", onOutput);
    child.once("error", onError);
    child.once("exit", onExit);
  });
}

export async function startKeyboardTrigger({ endpoint, token, spawnProcess = spawn } = {}) {
  if (process.platform !== "win32") {
    throw new Error("The Numpad+ keyboard trigger is supported only on Windows.");
  }
  const { command, args, options } = keyboardTriggerCommand({ endpoint, token });
  const child = spawnProcess(command, args, options);
  await waitForReady(child);
  return {
    async stop() {
      if (child.exitCode !== null || child.killed) return;
      await new Promise((resolve) => {
        child.once("exit", resolve);
        child.kill();
      });
    }
  };
}
