const runButton = document.getElementById("run");
const settingsButton = document.getElementById("settings");
const copyButton = document.getElementById("copy");
const clearButton = document.getElementById("clear");
const stateDot = document.getElementById("state-dot");
const stateTitle = document.getElementById("state-title");
const stateDetail = document.getElementById("state-detail");
const draftSection = document.getElementById("draft-section");
const draft = document.getElementById("draft");

function render(state = {}) {
  const status = state.status || "idle";
  stateDot.className = `state-dot ${status}`;
  stateTitle.textContent = {
    idle: "Ready",
    running: "Working",
    complete: "Draft ready",
    error: "Action needed"
  }[status] || "Ready";
  stateDetail.textContent = state.detail || "Open an XSOAR incident, then generate a draft.";
  runButton.disabled = status === "running";
  runButton.textContent = status === "running" ? "Generating…" : "Generate draft";
  if (state.draft) {
    draft.value = state.draft;
    draftSection.hidden = false;
  } else if (status !== "complete") {
    draftSection.hidden = true;
  }
}

runButton.addEventListener("click", async () => {
  render({ status: "running", detail: "Starting." });
  render(await chrome.runtime.sendMessage({ type: "RUN_ASSISTANT" }));
});

settingsButton.addEventListener("click", () => chrome.runtime.openOptionsPage());

copyButton.addEventListener("click", async () => {
  await navigator.clipboard.writeText(draft.value);
  stateDetail.textContent = "Draft copied to the clipboard.";
});

clearButton.addEventListener("click", async () => {
  draft.value = "";
  draftSection.hidden = true;
  render(await chrome.runtime.sendMessage({ type: "CLEAR_STATE" }));
});

chrome.runtime.onMessage.addListener((message) => {
  if (message?.type === "STATE_CHANGED") render(message.state);
});

render(await chrome.runtime.sendMessage({ type: "GET_STATE" }));
