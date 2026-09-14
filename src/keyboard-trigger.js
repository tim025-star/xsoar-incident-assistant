import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { activationHotkeySpec } from "./hotkey.js";

const scriptPath = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "scripts",
  "keyboard-trigger.ps1"
);

export function keyboardTriggerCommand({ endpoint, token, activationHotkey }) {
  const hotkey = activationHotkeySpec(activationHotkey);
  return {
    command: "powershell.exe",
    args: ["-NoLogo", "-NoProfile", "-NonInteractive", "-File", scriptPath],
    options: {
      env: {
        ...process.env,
        XSOAR_ASSISTANT_HOTKEY_ENDPOINT: endpoint,
        XSOAR_ASSISTANT_HOTKEY_TOKEN: token,
        XSOAR_ASSISTANT_HOTKEY_LABEL: hotkey.label,
        XSOAR_ASSISTANT_HOTKEY_MODIFIERS: String(hotkey.modifiers),
        XSOAR_ASSISTANT_HOTKEY_VIRTUAL_KEY: String(hotkey.virtualKey)
      },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true
    }
  };
}

function waitForReady(child, hotkeyLabel, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    let output = "";
    const timeout = setTimeout(() => finish(new Error(`The ${hotkeyLabel} keyboard trigger did not start within five seconds.`)), timeoutMs);
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
    const onError = () => finish(new Error(`The ${hotkeyLabel} keyboard trigger could not be started.`));
    const onExit = (code) => finish(new Error(`The ${hotkeyLabel} keyboard trigger exited before starting${code === null ? "." : ` (code ${code}).`}`));
    child.stdout.on("data", onOutput);
    child.once("error", onError);
    child.once("exit", onExit);
  });
}

async function stopChild(child) {
  if (child.exitCode !== null) return;
  await new Promise((resolve) => {
    child.once("exit", resolve);
    child.kill();
  });
}

export async function startKeyboardTrigger({
  endpoint,
  token,
  activationHotkey,
  spawnProcess = spawn,
  platform = process.platform,
  readyTimeoutMs = 5000
} = {}) {
  if (platform !== "win32") {
    throw new Error("The Numpad+ keyboard trigger is supported only on Windows.");
  }
  const hotkey = activationHotkeySpec(activationHotkey);
  const { command, args, options } = keyboardTriggerCommand({ endpoint, token, activationHotkey: hotkey.id });
  const child = spawnProcess(command, args, options);
  try {
    await waitForReady(child, hotkey.label, readyTimeoutMs);
  } catch (error) {
    await stopChild(child);
    throw error;
  }
  return {
    async stop() {
      await stopChild(child);
    }
  };
}
