// The frozen baseline remains available to the offline evaluator. Diagnostics use
// exact typed-value grouping; neither mode contains vendor-specific answers.
export const DEFAULT_LAYA_EXPERIMENT = "grouped";
export const LAYA_EXPERIMENTS = Object.freeze({
  baseline: { label: "Frozen v3 baseline", groupValues: false },
  grouped: { label: "Exact typed-value grouping", groupValues: true }
});
// Shared semantic contract sent unchanged to the Python prompt renderer.
const text = (description, excludes = "") => ({ description, excludes, valueType: "text" });
const identifier = (description, excludes) => ({ description, excludes, valueType: "identifier" });
export const LAYA_TARGET_CATALOGUE = Object.freeze({
  customerName: text("the customer or organisation display name", "application, network, tenant identifier, or inferred organisation"),
  classification: text("the explicitly recorded incident classification", "a newly inferred classification"),
  occurred: { description: "the time the activity or event occurred", excludes: "collection, ingestion, receipt time, duration, or identifier", valueType: "timestamp" },
  incidentOutcome: text("the explicitly recorded outcome of the incident or activity"),
  closeNotes: text("the incident closure notes or recorded resolution"),
  ruleName: text("the name of the detection rule that raised the alert"),
  caseType: text("the incident, case, event, or alert type"),
  clientIp: { description: "the IP address of the client initiating the activity", excludes: "destination or collector address", valueType: "ip" },
  clientHostname: identifier("the hostname of the client involved in the activity", "collector, server, application, network, or session identifier"),
  clientUserName: identifier("the account name or principal identifier of the client user", "person display name, application name, or session identifier"),
  destinationIp: { description: "the destination IP address of the activity", excludes: "source or collector address", valueType: "ip" },
  deviceHostname: identifier("the hostname of the affected device", "collector, application, or session identifier"),
  eventInfo: text("the original event information or original event message"),
  eventName: text("the event display name"),
  detectionUrl: { description: "the URL of the source detection or event record", excludes: "unrelated website or documentation URL", valueType: "url" },
  errorMessage: text("the source error message"),
  serviceMessage: text("the source service message"),
  sourceHostname: identifier("the hostname from which the activity originated", "destination or collector hostname"),
  sourceIp: { description: "the source IP address from which the activity originated", excludes: "destination or collector address", valueType: "ip" },
  sourceUsername: identifier("the account name or principal identifier of the source user", "person display name, application name, or session identifier"),
  descriptionLong: text("the long factual event or incident description"),
  historicalSummary: text("the recorded summary of the historic incident"),
  historicalRecommendations: text("the recorded historic resolution or recommendations", "newly generated recommendations")
});
export const LAYA_MAPPER_TARGETS = Object.freeze(Object.keys(LAYA_TARGET_CATALOGUE));
export const HISTORIC_LAYA_TARGETS = Object.freeze(["customerName", "ruleName", "caseType", "incidentOutcome", "closeNotes", "historicalRecommendations"]);
export const LAYA_MODEL = Object.freeze({ id: "base-english", repository: "convaiinnovations/laya", revision: "1c5edc17a7acd8701df6fc341c0d179f1c62c982", sdkVersion: "0.3.5", protocolVersion: 2 });
export const LAYA_PROMPT_VERSION = "english-fields-v3";
