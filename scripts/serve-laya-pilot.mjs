// Portable pilot diagnostics with in-memory state. This build cannot activate,
// install, train, or persist a model and never overwrites the stable app config.
import { spawn } from "node:child_process";
import { createAssistantServer } from "../src/server.js";
import { resolveAppConfig } from "../src/config.js";
import { createLayaMapper } from "../src/laya-mapper.js";

let config = resolveAppConfig({}, { requireTenant: false });
const disabled = async () => { throw new Error("This portable pilot is diagnostics-only."); };
const mapper = createLayaMapper();
const app = createAssistantServer({ routerOptions: {
  sessions: {
    status: () => ({ running: false }), start: disabled, stop: async () => {},
    openSetup: disabled, showConsole: async () => false, setConsoleUrl: () => {}, adapter: () => { throw new Error("Disabled."); }
  },
  configStore: {
    load: async () => config,
    save: async (input, options) => (config = resolveAppConfig(input, options))
  },
  generateDraft: disabled,
  layaMapper: mapper,
  layaMapperInstaller: { installInference: disabled, installTrainingTools: disabled },
  layaDataset: {
    list: async () => [], get: disabled, add: disabled, remove: disabled,
    clear: disabled, exportJsonl: disabled, importJsonl: disabled
  },
  layaTraining: {
    status: async () => ({ running: false, available: false, detail: "Disabled in the portable pilot." }),
    start: disabled, cancel: disabled, activate: disabled
  },
  localAi: { status: async () => ({ available: false, models: [], detail: "Disabled in the portable pilot." }), enrich: disabled },
  localAiInstaller: { installModel: disabled }
} });

const url = await app.listen(0);
const parsed = new URL(url);
parsed.pathname = "/configuration";
console.log("Experimental Laya pilot diagnostics is running locally.");
console.log("Keep this window open while testing. Press Ctrl+C to stop.");
console.log(parsed.href);
if (process.env.XSOAR_ASSISTANT_NO_OPEN !== "1") {
  if (process.platform === "win32") {
    const browser = spawn("rundll32.exe", ["url.dll,FileProtocolHandler", parsed.href], { detached: true, stdio: "ignore", windowsHide: true });
    browser.once("error", () => console.error("The default browser could not be opened automatically. Copy the local URL above into an approved browser."));
    browser.unref();
  } else {
    console.error("Copy the local URL above into an approved browser.");
  }
}

const shutdown = () => {
  mapper.close();
  app.server.close(() => process.exit(0));
};
for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, shutdown);
