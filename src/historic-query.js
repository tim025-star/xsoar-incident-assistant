import { Worker } from "node:worker_threads";

import { buildSearchQuery, cleanText } from "./domain.js";

const MAX_QUERY_LENGTH = 2048;
const JAVASCRIPT_TIMEOUT_MS = 2500;

function runJavaScript(source, incident) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL("./historic-query-worker.js", import.meta.url), {
      workerData: { source, incident }
    });
    let settled = false;
    const finish = (error, query) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      worker.terminate().catch(() => {});
      if (error) reject(error);
      else resolve(query);
    };
    const timer = setTimeout(() => finish(new Error("Historic query JavaScript exceeded its time limit.")), JAVASCRIPT_TIMEOUT_MS);
    worker.once("message", (message) => finish(message.error ? new Error(message.error) : null, message.query));
    worker.once("error", (error) => finish(error));
    worker.once("exit", (code) => finish(new Error(`Historic query JavaScript stopped before returning a query (exit ${code}).`)));
  });
}

export async function renderHistoricQuery(settings, incident) {
  const incidentName = cleanText(incident?.incidentName);
  const tenantName = cleanText(incident?.tenantName);
  if (!incidentName || !tenantName) {
    throw new Error("The incident must expose both Incident Name and Tenant Name before a historic search can run.");
  }
  let query;
  if (settings.historicQueryMode === "json") {
    const config = JSON.parse(settings.historicQueryJson);
    query = buildSearchQuery(incidentName, tenantName, config.query);
  } else if (settings.historicQueryMode === "javascript") {
    query = await runJavaScript(settings.historicQueryJavaScript, {
      incidentName,
      tenantName,
      ticketId: cleanText(incident?.ticketId)
    });
  } else if (settings.historicQueryMode === "template") {
    query = buildSearchQuery(incidentName, tenantName, settings.historicQueryTemplate);
  } else {
    throw new Error("Historic query mode is not supported.");
  }
  if (typeof query !== "string" || !query.trim() || query.length > MAX_QUERY_LENGTH
    || /[\r\n\u0000-\u001f]/.test(query)) {
    throw new Error("Historic query must be a single-line string no longer than 2048 characters.");
  }
  return query.trim();
}
