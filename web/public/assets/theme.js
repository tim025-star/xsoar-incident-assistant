// A blocking, same-origin script applies the theme before the app or CSS paints.
(() => {
  const storageKey = "xsoar-theme";
  const systemTheme = window.matchMedia("(prefers-color-scheme: dark)");
  const root = document.documentElement;
  const normalize = (value) => value === "light" || value === "dark" ? value : "system";
  let preference = "system";
  try { preference = normalize(localStorage.getItem(storageKey)); } catch { /* Storage can be disabled. */ }

  const applyTheme = () => {
    root.classList.toggle("dark", preference === "dark" || (preference === "system" && systemTheme.matches));
    root.dataset.themePreference = preference;
    const select = document.getElementById("themePreference");
    if (select) select.value = preference;
  };
  applyTheme();

  systemTheme.addEventListener("change", applyTheme);
  window.addEventListener("storage", (event) => {
    if (event.storageArea !== localStorage || (event.key !== storageKey && event.key !== null)) return;
    preference = normalize(event.newValue);
    applyTheme();
  });
  document.addEventListener("change", (event) => {
    if (!(event.target instanceof HTMLSelectElement) || event.target.id !== "themePreference") return;
    preference = normalize(event.target.value);
    try {
      if (preference === "system") localStorage.removeItem(storageKey);
      else localStorage.setItem(storageKey, preference);
    } catch { /* Keep the selection for this page when storage is unavailable. */ }
    applyTheme();
  });
})();
