import test from "node:test";
import assert from "node:assert/strict";

import { activationHotkeyFromKeyboardEvent, activationHotkeySpec } from "../src/hotkey.js";

test("the recorder converts a pressed key combination into a browser shortcut", () => {
  assert.deepEqual(
    activationHotkeyFromKeyboardEvent({ code: "KeyK", key: "k", ctrlKey: true, altKey: true }),
    { label: "Ctrl + Alt + K", modifiers: 3, code: "KeyK" }
  );
  assert.deepEqual(
    activationHotkeyFromKeyboardEvent({ code: "NumpadAdd", key: "+" }),
    { label: "Numpad +", modifiers: 0, code: "NumpadAdd" }
  );
  assert.equal(activationHotkeyFromKeyboardEvent({ code: "ControlLeft", key: "Control", ctrlKey: true }), undefined);
  assert.deepEqual(
    activationHotkeyFromKeyboardEvent({ code: "MediaPlayPause", key: "MediaPlayPause" }),
    { label: "Play/Pause", modifiers: 0, code: "MediaPlayPause" }
  );
  assert.throws(() => activationHotkeyFromKeyboardEvent({ code: "Power", key: "Power" }), /not supported/);
});

test("custom activation shortcuts are validated independently of legacy presets", () => {
  assert.deepEqual(
    activationHotkeySpec({ label: "Ctrl + Shift + F12", modifiers: 6, code: "F12" }),
    { label: "Ctrl + Shift + F12", modifiers: 6, code: "F12" }
  );
  assert.throws(() => activationHotkeySpec({ label: "Bad", modifiers: 16, code: "KeyA" }), /modifiers/);
  assert.throws(() => activationHotkeySpec({ label: "Bad", modifiers: 2, code: "Power" }), /key code/);
});
