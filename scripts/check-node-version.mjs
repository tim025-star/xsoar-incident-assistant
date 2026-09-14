import path from "node:path";
import { pathToFileURL } from "node:url";

export function isSupportedNodeVersion(version) {
  const match = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(String(version));
  if (!match) return false;
  const major = Number(match[1]);
  const minor = Number(match[2]);
  return (major === 20 && minor >= 19)
    || (major === 22 && minor >= 12)
    || major > 22;
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  process.exitCode = isSupportedNodeVersion(process.versions.node) ? 0 : 1;
}
