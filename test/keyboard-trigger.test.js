import test from "node:test";
import assert from "node:assert/strict";

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
  assert.equal(command.args.join(" ").includes("keyboard-session-token"), false);
});

test("Windows keyboard trigger registers and stops its physical Numpad+ listener", { timeout: 10000 }, async (context) => {
  if (process.platform !== "win32") context.skip("Windows-only keyboard trigger");

  const trigger = await startKeyboardTrigger({
    endpoint: "http://127.0.0.1:45123/internal/keyboard-trigger",
    token: "keyboard-session-token"
  });
  await trigger.stop();
});
