import { ORPCError, os } from "@orpc/server";

import { BrowserSessionManager } from "./browser-session.js";
import {
  browserProfileImportSchema,
  browserProfileSchema,
  detectBrowserProfiles,
  importBrowserProfile
} from "./browser-profiles.js";
import { appConfigInputSchema, loadConfig, resolvedAppConfigSchema, saveConfig } from "./config.js";
import { runIncidentDraft } from "./workflow.js";

function messageFor(error) {
  return error instanceof Error ? error.message : String(error);
}

export function createAssistantRouter({
  sessions = new BrowserSessionManager(),
  configStore = { load: loadConfig, save: saveConfig },
  profileStore = { list: detectBrowserProfiles, import: importBrowserProfile },
  generateDraft = runIncidentDraft
} = {}) {
  let activity = {
    phase: "idle",
    detail: "Configure the assistant, then open a browser session.",
    draft: ""
  };
  let runningWorkflow = false;

  const status = () => ({
    ...activity,
    session: sessions.status(),
    hotkey: { active: sessions.status().running, error: "" }
  });
  const fail = (error, code = "BAD_REQUEST") => {
    activity = { phase: "error", detail: messageFor(error), draft: activity.draft };
    throw new ORPCError(code, { message: activity.detail });
  };
  const generate = async () => {
    if (runningWorkflow) {
      throw new ORPCError("CONFLICT", { message: "A draft is already being generated." });
    }
    runningWorkflow = true;
    try {
      const config = await configStore.load({ requireTenant: true });
      await sessions.start(config, { onActivationShortcut: generate });
      const result = await generateDraft({
        adapter: sessions.adapter(config.xsoar),
        settings: config.xsoar,
        onProgress: async (phase, detail) => {
          activity = { phase, detail, draft: activity.draft };
        }
      });
      activity = {
        phase: "complete",
        detail: result.warning || `Draft ready. Reviewed ${result.reviewed} historical incident(s).`,
        draft: result.draft
      };
      return result;
    } catch (error) {
      return fail(error);
    } finally {
      runningWorkflow = false;
    }
  };

  const router = {
    config: {
      get: os.output(resolvedAppConfigSchema).handler(async () => configStore.load()),
      save: os.input(appConfigInputSchema).output(resolvedAppConfigSchema).handler(async ({ input }) => {
        if (sessions.status().running) {
          throw new ORPCError("CONFLICT", { message: "Close the current browser session before changing settings." });
        }
        try {
          const config = await configStore.save(input);
          activity = { ...activity, phase: "ready", detail: "Settings saved." };
          return config;
        } catch (error) {
          return fail(error);
        }
      })
    },
    status: os.handler(() => status()),
    browser: {
      profiles: os.output(browserProfileSchema.array()).handler(async () => {
        try {
          return await profileStore.list();
        } catch (error) {
          throw new ORPCError("BAD_REQUEST", { message: messageFor(error) });
        }
      }),
      importProfile: os.input(browserProfileImportSchema).output(resolvedAppConfigSchema).handler(async ({ input }) => {
        if (sessions.status().running) {
          throw new ORPCError("CONFLICT", { message: "Close the current browser session before importing a profile." });
        }
        try {
          const current = await configStore.load();
          const imported = await profileStore.import(input.id);
          const config = await configStore.save({
            ...current,
            session: {
              ...current.session,
              browser: imported.browser,
              profileDirectory: imported.profileDirectory
            }
          }, { requireTenant: false });
          activity = {
            ...activity,
            phase: "ready",
            detail: imported.reused
              ? "The previously imported browser profile is selected."
              : "Browser sign-in data was imported into a dedicated assistant profile."
          };
          return config;
        } catch (error) {
          return fail(error);
        }
      }),
      open: os.handler(async () => {
        try {
          const config = await configStore.load({ requireTenant: true });
          activity = { ...activity, phase: "opening", detail: "Opening the configured browser session." };
          await sessions.start(config, { onActivationShortcut: generate });
          activity = {
            ...activity,
            phase: "ready",
            detail: config.session.mode === "diagnostics"
              ? "Diagnostics browser ready with DevTools open. Sign in to XSOAR if prompted, then open an incident."
              : "Managed browser ready. Sign in to XSOAR if prompted, then open an incident."
          };
          return status();
        } catch (error) {
          return fail(error);
        }
      }),
      stop: os.handler(async () => {
        try {
          const previousMode = sessions.status().mode;
          await sessions.stop();
          activity = {
            ...activity,
            phase: "idle",
            detail: previousMode === "diagnostics"
              ? "Diagnostics browser closed. Its dedicated sign-in profile was retained."
              : "Managed browser closed. Its dedicated sign-in profile was retained."
          };
          return status();
        } catch (error) {
          return fail(error);
        }
      })
    },
    draft: {
      generate: os.handler(generate)
    }
  };

  return { router, sessions, status, generate };
}
