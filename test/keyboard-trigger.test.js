import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";

import { keyboardTriggerCommand, startKeyboardTrigger } from "../src/keyboard-trigger.js";

test("keyboard trigger keeps its loopback capability out of command-line arguments", () => {
  const command = keyboardTriggerCommand({
    endpoint: "http://127.0.0.1:45123/internal/keyboard-trigger",
    token: "keyboard-session-token"
  });

  assert.equal(command.command, "powershell.exe");
  assert.deepEqual(command.args.slice(0, 4), ["-NoLogo", "-NoProfile", "-NonInteractive", "-File"]);
  assert.match(command.args[4], /keyboard-trigger\.ps1$/);
  assert.equal(command.options.env.XSOAR_ASSISTANT_HOTKEY_ENDPOINT, "http://127.0.0.1:45123/internal/keyboard-trigger");
  assert.equal(command.options.env.XSOAR_ASSISTANT_HOTKEY_TOKEN, "keyboard-session-token");
  assert.equal(command.options.env.XSOAR_ASSISTANT_HOTKEY_LABEL, "Numpad +");
  assert.equal(command.options.env.XSOAR_ASSISTANT_HOTKEY_MODIFIERS, "0");
  assert.equal(command.options.env.XSOAR_ASSISTANT_HOTKEY_VIRTUAL_KEY, "107");
  assert.equal(command.args.join(" ").includes("keyboard-session-token"), false);
});

test("keyboard trigger accepts only the supported shortcut presets", () => {
  const command = keyboardTriggerCommand({
    endpoint: "http://127.0.0.1:45123/internal/keyboard-trigger",
    token: "keyboard-session-token",
    activationHotkey: "ctrl_alt_g"
  });
  assert.equal(command.options.env.XSOAR_ASSISTANT_HOTKEY_LABEL, "Ctrl + Alt + G");
  assert.equal(command.options.env.XSOAR_ASSISTANT_HOTKEY_MODIFIERS, "3");
  assert.equal(command.options.env.XSOAR_ASSISTANT_HOTKEY_VIRTUAL_KEY, "71");
  assert.throws(() => keyboardTriggerCommand({ endpoint: "http://127.0.0.1", token: "token", activationHotkey: "win_r" }), /Activation hotkey/);
});

test("keyboard trigger stops a listener that misses its startup deadline", async () => {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.exitCode = null;
  child.kill = () => {
    child.exitCode = 1;
    queueMicrotask(() => child.emit("exit", 1));
    return true;
  };
  await assert.rejects(
    () => startKeyboardTrigger({
      endpoint: "http://127.0.0.1:45123/internal/keyboard-trigger",
      token: "keyboard-session-token",
      spawnProcess: () => child,
      platform: "win32",
      readyTimeoutMs: 1
    }),
    /did not start/
  );
  assert.equal(child.exitCode, 1);
});

test("Windows keyboard trigger registers and stops its physical Numpad+ listener", { timeout: 10000 }, async (context) => {
  if (process.platform !== "win32" || process.env.GITHUB_ACTIONS === "true") context.skip("Requires an interactive Windows desktop");

  const trigger = await startKeyboardTrigger({
    endpoint: "http://127.0.0.1:45123/internal/keyboard-trigger",
    token: "keyboard-session-token"
  });
  await trigger.stop();
});
