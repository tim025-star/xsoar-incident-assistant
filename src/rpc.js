import { ORPCError, os } from "@orpc/server";
import { z } from "zod";

import { BrowserSessionManager } from "./browser-session.js";
import { appConfigInputSchema, loadConfig, resolvedAppConfigSchema, saveConfig } from "./config.js";
import { createLocalAiInstaller } from "./local-ai-installer.js";
import { createOllamaClient, localAiSettingsSchema } from "./local-ai.js";
import { runIncidentDraft } from "./workflow.js";

const draftRequestSchema = z.object({
  incidentId: z.string().trim().max(32).regex(/^\d*$/, "Incident ID must contain digits only.")
}).strict();

function messageFor(error) {
  return error instanceof Error ? error.message : String(error);
}

export function createAssistantRouter({
  sessions = new BrowserSessionManager(),
  configStore = { load: loadConfig, save: saveConfig },
  generateDraft = runIncidentDraft,
  localAi = createOllamaClient(),
  localAiInstaller
} = {}) {
  localAiInstaller ||= createLocalAiInstaller({ localAi });
  let activity = {
    detail: "Connect Chrome, open an XSOAR incident, then build the response.",
    draft: "",
    aiOutput: "",
    aiDraft: false,
    draftVersion: 0
  };
  let runningWorkflow = false;
  let activeOperation = "";
  let pullAbortController;

  const status = () => ({ ...activity, session: sessions.status(), operation: activeOperation || undefined });
  const withOperationLock = async (operation, action) => {
    if (activeOperation) throw new ORPCError("CONFLICT", { message: `Cannot start ${operation} while ${activeOperation} is running.` });
    activeOperation = operation;
    try { return await action(); } finally { activeOperation = ""; }
  };
  const fail = (error, code = "BAD_REQUEST") => {
    activity = { ...activity, detail: messageFor(error) };
    throw new ORPCError(code, { message: activity.detail });
  };
  const generate = async ({ incidentId = "" } = {}) => {
    if (runningWorkflow) {
      throw new ORPCError("CONFLICT", { message: "An analyst response is already being built." });
    }
    runningWorkflow = true;
    try {
      return await withOperationLock("response build", async () => {
        const draftVersion = activity.draftVersion + 1;
        activity = { detail: "Collecting incident evidence.", draft: "", aiOutput: "", aiDraft: false, draftVersion };
        const config = await configStore.load({ requireTenant: true });
        await sessions.start();
        const result = await generateDraft({
          adapter: sessions.adapter(config.xsoar),
          settings: config.xsoar,
          incidentId,
          enrichDraft: config.localAi.enabled ? (input) => localAi.enrich({
            ...input,
            model: config.localAi.model,
            onToken: (token) => {
              activity = { ...activity, aiOutput: `${activity.aiOutput}${token}`.slice(0, 20000) };
            }
          }) : undefined,
          onProgress: async (detail) => { activity = { ...activity, detail, aiDraft: false, draftVersion }; }
        });
        activity = {
          detail: result.warning || `Analyst response ready. Reviewed ${result.reviewed} related incident(s).`,
          draft: result.draft,
          aiOutput: activity.aiOutput,
          aiDraft: result.aiEnriched,
          draftVersion
        };
        try { await sessions.showConsole?.(); } catch {}
        return { ...result, draftVersion };
      });
    } catch (error) {
      if (error instanceof ORPCError) throw error;
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
          activity = { ...activity, detail: "XSOAR config saved." };
          return config;
        } catch (error) {
          return fail(error);
        }
      }),
      saveLocalAi: os.input(localAiSettingsSchema).output(localAiSettingsSchema).handler(async ({ input }) => {
        try {
          const current = await configStore.load({ requireTenant: false });
          const saved = await configStore.save(
            { ...current, localAi: input },
            { requireTenant: false, allowRouteMismatch: true }
          );
          activity = { ...activity, detail: "Local AI config saved." };
          return saved.localAi;
        } catch (error) {
          return fail(error);
        }
      })
    },
    status: os.handler(() => status()),
    localAi: {
      status: os.handler(async () => localAi.status()),
      pull: os.input(z.object({ model: localAiSettingsSchema.shape.model }).strict())
        .output(z.object({ models: z.array(z.string()) }).strict())
        .handler(async ({ input }) => withOperationLock("model download", async () => {
          pullAbortController = new AbortController();
          activity = { ...activity, detail: `Pulling local model ${input.model}.` };
          try {
            const models = await localAiInstaller.installModel(input.model, {
              signal: pullAbortController.signal,
              onProgress: ({ status: progress, completed, total }) => {
                const percent = total > 0 ? ` (${Math.min(100, Math.round((completed / total) * 100))}%)` : "";
                activity = { ...activity, detail: `${progress}${percent}` };
              }
            });
            activity = { ...activity, detail: `Model ${input.model} is ready for analysis.` };
            return { models };
          } catch (error) {
            return fail(error);
          } finally {
            pullAbortController = undefined;
          }
        })),
      cancelPull: os.handler(() => {
        if (activeOperation !== "model download" || !pullAbortController) {
          throw new ORPCError("CONFLICT", { message: "No local model download is running." });
        }
        pullAbortController.abort();
        return status();
      })
    },
    browser: {
      setup: os.handler(async () => {
        try {
          sessions.openSetup();
          activity = {
            ...activity,
            detail: "Chrome access setup opened. Enable remote debugging, approve the prompt, then connect."
          };
          return status();
        } catch (error) {
          return fail(error);
        }
      }),
      open: os.handler(async () => {
        try {
          await configStore.load({ requireTenant: true });
          activity = { ...activity, detail: "Connecting to the analyst Chrome session." };
          await sessions.start();
          activity = {
            ...activity,
            detail: "Chrome connected. Enter an Incident ID, or leave one XSOAR incident open, then build the response."
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
            detail: "Chrome disconnected. Your browser and tabs are still open."
          };
          return status();
        } catch (error) {
          return fail(error);
        }
      })
    },
    draft: { generate: os.input(draftRequestSchema).handler(({ input }) => generate(input)) }
  };

  return { router, sessions, status, generate };
}
