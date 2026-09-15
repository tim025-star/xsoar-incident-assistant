import { ORPCError, os } from "@orpc/server";

import { BrowserSessionManager } from "./browser-session.js";
import { appConfigInputSchema, loadConfig, resolvedAppConfigSchema, saveConfig } from "./config.js";
import { runIncidentDraft } from "./workflow.js";

function messageFor(error) {
  return error instanceof Error ? error.message : String(error);
}

export function createAssistantRouter({
  sessions = new BrowserSessionManager(),
  configStore = { load: loadConfig, save: saveConfig },
  generateDraft = runIncidentDraft
} = {}) {
  let activity = {
    detail: "Configure the assistant, then connect your current Chrome window.",
    draft: ""
  };
  let runningWorkflow = false;

  const status = () => ({ ...activity, session: sessions.status() });
  const fail = (error, code = "BAD_REQUEST") => {
    activity = { detail: messageFor(error), draft: activity.draft };
    throw new ORPCError(code, { message: activity.detail });
  };
  const generate = async () => {
    if (runningWorkflow) {
      throw new ORPCError("CONFLICT", { message: "A draft is already being generated." });
    }
    runningWorkflow = true;
    try {
      const config = await configStore.load({ requireTenant: true });
      await sessions.start();
      const result = await generateDraft({
        adapter: sessions.adapter(config.xsoar),
        settings: config.xsoar,
        onProgress: async (detail) => {
          activity = { detail, draft: activity.draft };
        }
      });
      activity = {
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
          throw new ORPCError("CONFLICT", { message: "Disconnect Chrome before changing settings." });
        }
        try {
          const config = await configStore.save(input);
          activity = { ...activity, detail: "Settings saved." };
          return config;
        } catch (error) {
          return fail(error);
        }
      })
    },
    status: os.handler(() => status()),
    browser: {
      setup: os.handler(async () => {
        try {
          sessions.openSetup();
          activity = {
            ...activity,
            detail: "Chrome setup opened. Enable remote debugging, accept Chrome's prompt, then return here and connect."
          };
          return status();
        } catch (error) {
          return fail(error);
        }
      }),
      open: os.handler(async () => {
        try {
          await configStore.load({ requireTenant: true });
          activity = { ...activity, detail: "Connecting to your current Chrome window." };
          await sessions.start();
          activity = {
            ...activity,
            detail: "Connected to the current Chrome window. Open one XSOAR incident, then generate a draft from this tab."
          };
          return status();
        } catch (error) {
          return fail(error);
        }
      }),
      stop: os.handler(async () => {
        try {
          await sessions.stop();
          activity = {
            ...activity,
            detail: "Disconnected from current Chrome. Chrome and its tabs remain open."
          };
          return status();
        } catch (error) {
          return fail(error);
        }
      })
    },
    draft: { generate: os.handler(generate) }
  };

  return { router, sessions, status, generate };
}
