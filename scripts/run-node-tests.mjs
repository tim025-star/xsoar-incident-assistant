import { readdir } from "node:fs/promises";
import { spawn } from "node:child_process";
import path from "node:path";

const directories = process.argv.slice(2);
if (!directories.length) throw new Error("At least one test directory is required.");

const files = [];
for (const directory of directories) {
  const absoluteDirectory = path.resolve(directory);
  for (const entry of await readdir(absoluteDirectory, { withFileTypes: true })) {
    if (entry.isFile() && entry.name.endsWith(".test.js")) files.push(path.join(absoluteDirectory, entry.name));
  }
}
files.sort();
if (!files.length) throw new Error("No Node test files were found.");

const child = spawn(process.execPath, ["--test", ...files], { stdio: "inherit" });
child.once("error", (error) => { throw error; });
child.once("exit", (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exitCode = code ?? 1;
});
