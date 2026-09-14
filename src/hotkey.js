export const ACTIVATION_HOTKEYS = Object.freeze([
  { id: "numpad_plus", label: "Numpad +", modifiers: 0, virtualKey: 0x6B },
  { id: "ctrl_alt_g", label: "Ctrl + Alt + G", modifiers: 3, virtualKey: 0x47 },
  { id: "ctrl_shift_g", label: "Ctrl + Shift + G", modifiers: 6, virtualKey: 0x47 },
  { id: "ctrl_alt_i", label: "Ctrl + Alt + I", modifiers: 3, virtualKey: 0x49 }
]);

const activationHotkeysById = new Map(ACTIVATION_HOTKEYS.map((hotkey) => [hotkey.id, hotkey]));

export const DEFAULT_ACTIVATION_HOTKEY = "numpad_plus";

export function activationHotkeySpec(value = DEFAULT_ACTIVATION_HOTKEY) {
  const hotkey = activationHotkeysById.get(value);
  if (!hotkey) {
    throw new Error(`Activation hotkey must be one of: ${ACTIVATION_HOTKEYS.map(({ label }) => label).join(", ")}.`);
  }
  return hotkey;
}
