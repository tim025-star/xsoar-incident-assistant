const MOD_ALT = 1;
const MOD_CONTROL = 2;
const MOD_SHIFT = 4;
const MOD_WINDOWS = 8;
const ALLOWED_MODIFIERS = MOD_ALT | MOD_CONTROL | MOD_SHIFT | MOD_WINDOWS;

export const ACTIVATION_HOTKEYS = Object.freeze([
  Object.freeze({ label: "Numpad +", modifiers: 0, code: "NumpadAdd" }),
  Object.freeze({ label: "Ctrl + Alt + G", modifiers: MOD_CONTROL | MOD_ALT, code: "KeyG" }),
  Object.freeze({ label: "Ctrl + Shift + G", modifiers: MOD_CONTROL | MOD_SHIFT, code: "KeyG" }),
  Object.freeze({ label: "Ctrl + Alt + I", modifiers: MOD_CONTROL | MOD_ALT, code: "KeyI" })
]);

const legacyHotkeysById = new Map([
  ["numpad_plus", ACTIVATION_HOTKEYS[0]],
  ["ctrl_alt_g", ACTIVATION_HOTKEYS[1]],
  ["ctrl_shift_g", ACTIVATION_HOTKEYS[2]],
  ["ctrl_alt_i", ACTIVATION_HOTKEYS[3]]
]);

const namedKeys = new Map([
  ["Backspace", "Backspace"], ["Tab", "Tab"], ["Enter", "Enter"], ["Pause", "Pause"],
  ["CapsLock", "Caps Lock"], ["Escape", "Escape"], ["Space", "Space"], ["PageUp", "Page Up"],
  ["PageDown", "Page Down"], ["End", "End"], ["Home", "Home"], ["ArrowLeft", "Left Arrow"],
  ["ArrowUp", "Up Arrow"], ["ArrowRight", "Right Arrow"], ["ArrowDown", "Down Arrow"],
  ["PrintScreen", "Print Screen"], ["Insert", "Insert"], ["Delete", "Delete"],
  ["NumpadMultiply", "Numpad *"], ["NumpadAdd", "Numpad +"], ["NumpadSubtract", "Numpad -"],
  ["NumpadDecimal", "Numpad ."], ["NumpadDivide", "Numpad /"], ["NumLock", "Num Lock"],
  ["ScrollLock", "Scroll Lock"], ["BrowserBack", "Browser Back"], ["BrowserForward", "Browser Forward"],
  ["BrowserRefresh", "Browser Refresh"], ["BrowserStop", "Browser Stop"], ["BrowserSearch", "Browser Search"],
  ["BrowserFavorites", "Browser Favorites"], ["BrowserHome", "Browser Home"], ["VolumeMute", "Volume Mute"],
  ["VolumeDown", "Volume Down"], ["VolumeUp", "Volume Up"], ["MediaTrackNext", "Next Track"],
  ["MediaTrackPrevious", "Previous Track"], ["MediaStop", "Media Stop"], ["MediaPlayPause", "Play/Pause"],
  ["Semicolon", ";"], ["Equal", "="], ["Comma", ","], ["Minus", "-"], ["Period", "."],
  ["Slash", "/"], ["Backquote", "`"], ["BracketLeft", "["], ["Backslash", "\\"],
  ["BracketRight", "]"], ["Quote", "'"]
]);

const modifierCodes = new Set([
  "AltLeft", "AltRight", "ControlLeft", "ControlRight", "MetaLeft", "MetaRight", "ShiftLeft", "ShiftRight"
]);

export const DEFAULT_ACTIVATION_HOTKEY = ACTIVATION_HOTKEYS[0];

function recordedKey(code) {
  if (/^Key[A-Z]$/.test(code)) return code.slice(3);
  if (/^Digit[0-9]$/.test(code)) return code.slice(5);
  if (/^Numpad[0-9]$/.test(code)) return `Numpad ${code.slice(6)}`;
  if (/^F(?:[1-9]|1[0-9]|2[0-4])$/.test(code)) return code;
  return namedKeys.get(code);
}

export function activationHotkeySpec(value = DEFAULT_ACTIVATION_HOTKEY) {
  if (typeof value === "string") {
    const legacy = legacyHotkeysById.get(value);
    if (legacy) return { ...legacy };
    throw new Error("Activation hotkey is not supported.");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Activation hotkey must describe one keyboard shortcut.");
  }
  if (Object.keys(value).some((key) => !["label", "modifiers", "code"].includes(key))) {
    throw new Error("Activation hotkey contains an unsupported setting.");
  }
  const label = typeof value.label === "string" ? value.label.trim() : "";
  if (!label || label.length > 80 || /[\u0000-\u001F\u007F]/.test(label)) {
    throw new Error("Activation hotkey label must contain 1 to 80 printable characters.");
  }
  if (!Number.isInteger(value.modifiers) || value.modifiers < 0 || (value.modifiers & ~ALLOWED_MODIFIERS) !== 0) {
    throw new Error("Activation hotkey modifiers are invalid.");
  }
  const code = typeof value.code === "string" ? value.code : "";
  if (!recordedKey(code) || modifierCodes.has(code)) {
    throw new Error("Activation hotkey key code is invalid.");
  }
  return { label, modifiers: value.modifiers, code };
}

export function activationHotkeyFromKeyboardEvent(event) {
  if (modifierCodes.has(event.code)) return undefined;
  const key = recordedKey(String(event.code || ""));
  if (!key) throw new Error("That key is not supported by the browser shortcut listener.");
  const modifiers = (event.altKey ? MOD_ALT : 0)
    | (event.ctrlKey ? MOD_CONTROL : 0)
    | (event.shiftKey ? MOD_SHIFT : 0)
    | (event.metaKey ? MOD_WINDOWS : 0);
  const labels = [];
  if (event.ctrlKey) labels.push("Ctrl");
  if (event.altKey) labels.push("Alt");
  if (event.shiftKey) labels.push("Shift");
  if (event.metaKey) labels.push("Windows");
  labels.push(key);
  return activationHotkeySpec({ label: labels.join(" + "), modifiers, code: event.code });
}
