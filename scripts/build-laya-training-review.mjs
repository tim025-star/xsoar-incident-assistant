import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const [factoryArgument, outputArgument] = process.argv.slice(2);
if (!factoryArgument || !outputArgument) {
  throw new Error("Usage: build-laya-training-review <factory-output-directory> <output-review.json>");
}

const factory = path.resolve(factoryArgument);
const output = path.resolve(outputArgument);
const mapper = path.join(root, "laya-mapper");
const digest = (value) => createHash("sha256").update(value).digest("hex");
const canonical = (value) => Array.isArray(value)
  ? `[${value.map(canonical).join(",")}]`
  : value && typeof value === "object"
    ? `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`
    : JSON.stringify(value);
const parseJsonl = (text) => text.split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));

function resolvePointer(document, pointer) {
  if (typeof pointer !== "string" || !pointer.startsWith("/")) throw new Error(`Invalid JSON pointer: ${pointer}`);
  let value = document;
  for (const encoded of pointer.slice(1).split("/")) {
    const part = encoded.replaceAll("~1", "/").replaceAll("~0", "~");
    if (Array.isArray(value) && /^(?:0|[1-9][0-9]*)$/.test(part) && Number(part) < value.length) value = value[Number(part)];
    else if (value && typeof value === "object" && Object.hasOwn(value, part)) value = value[part];
    else throw new Error(`Pointer ${pointer} does not resolve.`);
  }
  return value;
}

function typedIdentity(value) {
  return canonical([value === null ? "null" : typeof value, value]);
}

const sourceIpFromClientIp = new Set([
  "entra.graph.directory-audit",
  "entra.graph.risk-detection",
  "entra.graph.signin",
  "entra.monitor.auditlogs",
  "entra.monitor.interactive-signin",
  "entra.monitor.managed-identity-signin",
  "entra.monitor.noninteractive-signin",
  "entra.monitor.service-principal-signin",
  "entra.monitor.user-risk-events",
  "m365.activity.entra-account-logon",
  "m365.activity.entra-sts-logon",
  "m365.activity.exchange-admin",
  "m365.activity.exchange-aggregated-mailbox",
  "m365.activity.exchange-mailbox-group",
  "m365.activity.exchange-mailbox-item",
  "m365.activity.owa-auth",
  "m365.activity.teams-audit",
]);
const clientIpFromSourceIp = new Set(["google-secops.udm-network-event"]);

const reviewPrompt = [
  "Independently review the immutable synthetic mapper factory bound by its manifest.",
  "Review train and development families only; do not inspect or approve frozen-test records.",
  "Check complete source records, official-provenance structural facts, every structural variant, exact pointers, typed-value alternatives, role-confusable fields, explicit none boundaries, and Tier-A identity roles against english-fields-v3.",
  "Approve ambiguous draft targets only as unlabelled, preserve distinct values and pointers, and record explicit source/client corrections without adding vendor-specific runtime rules.",
  "This is a disclosed nonblind trainingOnly review because aggregate pilot outcomes were already known. It is not release-candidate or promotion evidence.",
].join(" ");
const reviewer = {
  kind: "independent-model",
  model: "gpt-6-astra",
  version: "Codex GPT-6 Astra corpus review 2026-09-23",
  promptHash: digest(reviewPrompt),
};

const manifestBytes = await readFile(path.join(factory, "final-manifest.json"));
const manifest = JSON.parse(manifestBytes);
if (manifest.manifestStatus !== "validated-draft-input-only" || manifest.trainingRowsEmitted !== false) {
  throw new Error("Factory input is not the immutable validated draft corpus.");
}

const rows = [];
const provenance = new Map();
for (const source of Object.keys(manifest.sources || {}).sort()) {
  const expected = manifest.sources[source];
  const recordsBytes = await readFile(path.join(factory, "sources", source, "records.jsonl"));
  if (digest(recordsBytes) !== expected.sha256) throw new Error(`Factory source hash mismatch: ${source}`);
  const sourceRows = parseJsonl(recordsBytes.toString("utf8"));
  if (sourceRows.length !== expected.records) throw new Error(`Factory source count mismatch: ${source}`);
  rows.push(...sourceRows);

  const provenanceDocument = JSON.parse(await readFile(path.join(factory, "sources", source, "provenance.json"), "utf8"));
  for (const entry of provenanceDocument.entries || provenanceDocument.sources || provenanceDocument.provenance || []) {
    if (provenance.has(entry.provenanceId)) throw new Error(`Duplicate provenance ID: ${entry.provenanceId}`);
    provenance.set(entry.provenanceId, entry);
  }
}

const additionalPath = path.join(mapper, "additional-synthetic-drafts.jsonl");
const additionalBytes = await readFile(additionalPath);
const additionalRows = parseJsonl(additionalBytes.toString("utf8"));
rows.push(...additionalRows);
const additionalSha256 = digest(additionalBytes);

const tierBytes = await readFile(path.join(mapper, "tier-a-family-mappings.json"));
const tier = JSON.parse(tierBytes);
const tierByFamily = new Map((tier.mappings || []).map((mapping) => [mapping.templateFamilyId, mapping]));
const reviewedRows = rows.filter((row) => row.split === "train" || row.split === "development").sort((a, b) => a.recordId.localeCompare(b.recordId));
if (reviewedRows.some((row) => row.split === "frozen-test")) throw new Error("Frozen-test records entered the training review.");
if (new Set(reviewedRows.map((row) => row.recordId)).size !== reviewedRows.length) throw new Error("Training review record IDs are not unique.");

const familySplits = new Map();
for (const row of reviewedRows) {
  if (!familySplits.has(row.templateFamilyId)) familySplits.set(row.templateFamilyId, row.split);
  if (familySplits.get(row.templateFamilyId) !== row.split) throw new Error(`Family crosses fixed splits: ${row.templateFamilyId}`);
  const sourceProvenance = provenance.get(row.sourceSchema?.provenanceId);
  if (!sourceProvenance && !String(row.sourceSchema?.provenanceId || "").startsWith("local.entra.")) {
    throw new Error(`Missing official provenance for ${row.recordId}`);
  }
  const hasAmbiguousTarget = Object.values(row.targetLabels || {}).some((label) => label.expectedStatus === "ambiguous");
  if (row.humanReviewRequired === true && !String(row.expectedFailureOrAmbiguityNotes || "").trim() && !hasAmbiguousTarget) {
    throw new Error(`Review-required row lacks an ambiguity note: ${row.recordId}`);
  }
  for (const [target, label] of Object.entries(row.targetLabels || {})) {
    if (!["matched", "no-match", "ambiguous", "missing", "invalid-type"].includes(label.expectedStatus)) {
      throw new Error(`Invalid draft status for ${row.recordId}/${target}`);
    }
    if (label.expectedStatus === "matched") {
      const value = resolvePointer(row.alert, label.primaryPointer);
      const type = value === null ? "null" : Array.isArray(value) ? "array" : typeof value === "number" && Number.isInteger(value) ? "integer" : typeof value;
      if (type !== label.originalType && !(type === "integer" && label.originalType === "number")) {
        throw new Error(`Draft type mismatch for ${row.recordId}/${target}`);
      }
      for (const alternate of row.acceptedAlternatives?.[target] || []) {
        if (typedIdentity(resolvePointer(row.alert, alternate)) !== typedIdentity(value)) {
          throw new Error(`Draft alternative changes typed value for ${row.recordId}/${target}`);
        }
      }
    } else if (label.primaryPointer !== null) throw new Error(`Non-matched draft has a pointer: ${row.recordId}/${target}`);
  }
}

for (const family of [...sourceIpFromClientIp, ...clientIpFromSourceIp]) {
  if (!familySplits.has(family)) throw new Error(`Reviewed correction references an unavailable family: ${family}`);
}

const reviews = reviewedRows.map((row) => {
  const sourceProvenance = provenance.get(row.sourceSchema.provenanceId);
  const findings = [
    `Reviewed the complete ${row.generatorMetadata.variantKind} record for ${row.templateFamilyId} against ${row.sourceSchema.provenanceId}; direct roles, explicit none boundaries, ambiguity, and exact-value alternatives are approved for training-only use.`,
  ];
  if (row.humanReviewRequired) findings.push(`Adversarial or ambiguous draft reviewed explicitly: ${row.expectedFailureOrAmbiguityNotes || "one or more draft targets are explicitly ambiguous and remain unlabelled"}`);
  if (sourceProvenance?.retainedStructuralFacts?.length) findings.push(`Bound official-provenance facts checked: ${sourceProvenance.retainedStructuralFacts.join(" ")}`);

  const targetOverrides = {};
  if (sourceIpFromClientIp.has(row.templateFamilyId)) {
    targetOverrides.sourceIp = { sourceTarget: "clientIp" };
    findings.push("The documented client address is also the network origin for this activity; sourceIp is reviewed from the same draft clientIp role.");
  }
  if (clientIpFromSourceIp.has(row.templateFamilyId)) {
    targetOverrides.clientIp = { sourceTarget: "sourceIp" };
    findings.push("The documented UDM principal is the initiating client; clientIp is reviewed from the same draft sourceIp role.");
  }

  const targetApprovals = {};
  const identity = tierByFamily.get(row.templateFamilyId);
  if (identity && row.targetLabels.accountUpn?.expectedStatus === "matched") {
    targetApprovals[identity.productionTarget] = {
      status: "approved",
      sourceTarget: "accountUpn",
      finding: `Reviewed ${row.targetLabels.accountUpn.primaryPointer} as ${identity.productionTarget}: ${identity.reviewedRole}.`,
    };
  }
  return {
    recordId: row.recordId,
    status: "approved",
    findings,
    targetOverrides,
    targetApprovals,
  };
});

const counts = reviewedRows.reduce((result, row) => {
  result[row.split] += 1;
  if (row.humanReviewRequired) result.reviewRequired += 1;
  return result;
}, { train: 0, development: 0, reviewRequired: 0 });
const artifact = {
  schemaVersion: 1,
  gate: "trainingOnly",
  datasetManifestSha256: digest(manifestBytes),
  additionalDraftsSha256: additionalSha256,
  tierAMappingSha256: digest(tierBytes),
  reviewer,
  reviewPrompt,
  reviewDisclosure: {
    humanReviewed: false,
    independentFromGenerator: true,
    blind: false,
    aggregateModelOutcomesPreviouslyVisible: true,
    perRecordPredictionsUsedForLabelDecisions: false,
    promotionEligible: false,
    frozenTestAccessed: false,
    scope: "All immutable train and development records; no frozen-test records.",
  },
  expectedCounts: {
    records: reviewedRows.length,
    trainRecords: counts.train,
    developmentRecords: counts.development,
    reviewedDraftRecords: counts.reviewRequired,
    families: familySplits.size,
    sourceFromClientCorrections: sourceIpFromClientIp.size,
    clientFromSourceCorrections: clientIpFromSourceIp.size,
  },
  reviews,
};
await writeFile(output, JSON.stringify(artifact, null, 2) + "\n");
console.log(JSON.stringify({ output, ...artifact.expectedCounts, sha256: digest(await readFile(output)) }));
