import { createLocalAiInstaller } from "../src/local-ai-installer.js";

const installer = createLocalAiInstaller();
let lastPercent = -1;

try {
  const models = await installer.installDefaultModel({
    onProgress: ({ status, completed, total }) => {
      const percent = total > 0 ? Math.min(100, Math.floor((completed / total) * 100)) : 0;
      if (status.includes("part") || percent !== lastPercent) {
        console.log(`${status}${total > 0 ? ` ${percent}%` : ""}`);
        lastPercent = percent;
      }
    }
  });
  console.log(`Local AI is ready. Installed models: ${models.join(", ")}`);
} catch (error) {
  console.error(error instanceof Error ? error.message : "Local AI installation failed.");
  process.exitCode = 1;
  if (process.stdin.isTTY) {
    console.error("Press Enter to close this window.");
    process.stdin.resume();
    await new Promise((resolve) => process.stdin.once("data", resolve));
  }
}
