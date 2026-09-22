import { readFile, mkdir, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";

const inputs = process.argv.slice(2);
if (!inputs.length) throw new Error("Usage: compare-laya-mapper <completed-evaluation.json> [...]");
const reports = [];
for (const input of inputs) {
  const text = await readFile(input, "utf8");
  const report = JSON.parse(text);
  if (!report.byExperiment?.baseline) throw new Error("Comparison needs a completed report containing the baseline experiment.");
  const rows = (cases) => new Map(cases.flatMap((c) => c.targets.map((t) => [JSON.stringify([c.id, c.run, t.target]), { case: c.id, split: c.split, ...t }])));
  const baseline = rows(report.cases.filter((c) => c.experiment === "baseline"));
  const changes = {};
  for (const experiment of report.experiments.filter((name) => name !== "baseline")) {
    const current = rows(report.cases.filter((c) => c.experiment === experiment));
    if (current.size !== baseline.size || [...baseline.keys()].some((key) => !current.has(key))) throw new Error("Experiment cases do not match the baseline.");
    const differences = [...current].map(([key, after]) => {
      const before = baseline.get(key);
      return { case: after.case, target: after.target, split: after.split, before: before.actual, after: after.actual, pointerGain: !before.accepted && after.accepted, pointerRegression: before.accepted && !after.accepted, valueGain: !before.valueCorrect && after.valueCorrect, valueRegression: before.valueCorrect && !after.valueCorrect };
    });
    changes[experiment] = {
      pointerGains: differences.filter((d) => d.pointerGain), pointerRegressions: differences.filter((d) => d.pointerRegression),
      valueGains: differences.filter((d) => d.valueGain), valueRegressions: differences.filter((d) => d.valueRegression)
    };
  }
  reports.push({ input, sha256: createHash("sha256").update(text).digest("hex"), metrics: report.byExperiment, changes });
}
const output = path.resolve("artifacts/laya-improvements/comparison.json");
await mkdir(path.dirname(output), { recursive: true });
await writeFile(output, JSON.stringify({ reports }, null, 2) + "\n");
console.log(JSON.stringify({ output, reports }));
