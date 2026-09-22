import { randomUUID } from "node:crypto";
import { access, mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { z } from "zod";

import { flattenAlertDocuments, LAYA_MAPPER_TARGETS, resolveAlertPointer } from "./laya-mapper.js";

const MAX_DATASET_EXAMPLES = 10000;
const MAX_JSONL_BYTES = 64 * 1024 * 1024;
const MAX_EXAMPLE_BYTES = 96 * 1024;

export const trainingLabelSchema = z.object({
  state: z.enum(["mapped", "absent", "unlabelled"]),
  value: z.string().max(10000).optional(),
  pointer: z.string().max(2000).optional()
}).strict();

const partialLabelsSchema = z.object(Object.fromEntries(
  LAYA_MAPPER_TARGETS.map((target) => [target, trainingLabelSchema.optional()])
)).strict();
const completeLabelsSchema = z.object(Object.fromEntries(
  LAYA_MAPPER_TARGETS.map((target) => [target, trainingLabelSchema])
)).strict();

export const trainingExampleInputSchema = z.object({
  documents: z.array(z.unknown()).min(1).max(100),
  labels: partialLabelsSchema
}).strict();

const storedTrainingExampleSchema = z.object({
  schemaVersion: z.literal(1),
  id: z.string().uuid(),
  createdAt: z.string().datetime(),
  documents: z.array(z.unknown()).min(1).max(100),
  labels: completeLabelsSchema
}).strict();

function defaultDatasetDirectory() {
  const localAppData = process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local");
  return path.join(localAppData, "XSOAR Incident Assistant", "laya-mapper", "datasets", "default");
}

function scalarText(value) {
  if (value === null || value === undefined) return "";
  return typeof value === "string" ? value.trim() : String(value);
}

async function atomicJson(filePath, value) {
  await mkdir(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await rename(temporary, filePath);
}

function resolveLabels(documents, labels) {
  const leaves = flattenAlertDocuments(documents);
  const resolved = {};
  for (const target of LAYA_MAPPER_TARGETS) {
    const label = labels[target] || { state: "unlabelled" };
    if (label.state !== "mapped") {
      resolved[target] = { state: label.state };
      continue;
    }
    const value = scalarText(label.value);
    if (!value) throw new Error(`${target} requires a non-empty mapped value.`);
    if (label.pointer) {
      if (scalarText(resolveAlertPointer(documents, label.pointer)) !== value) {
        throw new Error(`${target} does not match the value at the confirmed JSON pointer.`);
      }
      resolved[target] = { state: "mapped", value, pointer: label.pointer };
      continue;
    }
    const matches = leaves.filter((leaf) => scalarText(leaf.value) === value);
    if (!matches.length) throw new Error(`${target} was not found in the supplied alert JSON.`);
    if (matches.length > 1) {
      const pointers = matches.slice(0, 20).map((leaf) => leaf.pointer).join(", ");
      throw new Error(`${target} matches multiple JSON pointers; confirm one of: ${pointers}.`);
    }
    resolved[target] = { state: "mapped", value, pointer: matches[0].pointer };
  }
  return resolved;
}

function parseStored(value) { return storedTrainingExampleSchema.parse(value); }

export function createLayaDatasetStore({ directory = defaultDatasetDirectory() } = {}) {
  const examplesDirectory = path.join(directory, "examples");
  const examplePath = (id) => {
    if (!/^[0-9a-f-]{36}$/i.test(id)) throw new Error("Invalid Laya training example ID.");
    return path.join(examplesDirectory, `${id}.json`);
  };
  const readAll = async () => {
    let names;
    try { names = await readdir(examplesDirectory); } catch (error) { if (error?.code === "ENOENT") return []; throw error; }
    const values = [];
    for (const name of names.filter((item) => /^[0-9a-f-]{36}\.json$/i.test(item)).sort()) {
      values.push(parseStored(JSON.parse(await readFile(path.join(examplesDirectory, name), "utf8"))));
    }
    return values;
  };
  return {
    directory,
    async list() {
      return (await readAll()).map(({ id, createdAt, labels }) => ({
        id,
        createdAt,
        mappedFields: Object.entries(labels).filter(([, label]) => label.state === "mapped").map(([target]) => target),
        absentFields: Object.entries(labels).filter(([, label]) => label.state === "absent").map(([target]) => target)
      }));
    },
    async get(id) { return parseStored(JSON.parse(await readFile(examplePath(id), "utf8"))); },
    async add(input) {
      input = trainingExampleInputSchema.parse(input);
      if (Buffer.byteLength(JSON.stringify(input.documents)) > MAX_EXAMPLE_BYTES) throw new Error("The training alert JSON is too large.");
      const existing = await this.list();
      if (existing.length >= MAX_DATASET_EXAMPLES) throw new Error("The Laya training dataset is full.");
      const example = {
        schemaVersion: 1,
        id: randomUUID(),
        createdAt: new Date().toISOString(),
        documents: input.documents,
        labels: resolveLabels(input.documents, input.labels)
      };
      await atomicJson(examplePath(example.id), example);
      return example;
    },
    async remove(id) { await rm(examplePath(id), { force: true }); },
    async clear() { await rm(examplesDirectory, { recursive: true, force: true }); },
    async exportJsonl() {
      const output = (await readAll()).map((example) => JSON.stringify(example)).join("\n");
      return output ? `${output}\n` : "";
    },
    async importJsonl(value) {
      if (typeof value !== "string" || Buffer.byteLength(value) > MAX_JSONL_BYTES) throw new Error("The Laya training dataset import is too large.");
      const imported = value.split(/\r?\n/).filter(Boolean).map((line) => parseStored(JSON.parse(line)));
      if ((await this.list()).length + imported.length > MAX_DATASET_EXAMPLES) throw new Error("The Laya training dataset is full.");
      for (const example of imported) {
        if (Buffer.byteLength(JSON.stringify(example.documents)) > MAX_EXAMPLE_BYTES) throw new Error("A training alert JSON document is too large.");
        resolveLabels(example.documents, example.labels);
        await atomicJson(examplePath(example.id), example);
      }
      return this.list();
    },
    async exists(id) { try { await access(examplePath(id)); return true; } catch { return false; } }
  };
}
