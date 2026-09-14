import { defineConfig } from "vite";
import solid from "vite-plugin-solid";
import tailwindcss from "@tailwindcss/vite";
import path from "node:path";
import { fileURLToPath } from "node:url";

const rootDirectory = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  root: path.join(rootDirectory, "web"),
  plugins: [solid(), tailwindcss()],
  build: {
    outDir: path.join(rootDirectory, "dist", "web"),
    emptyOutDir: true
  }
});
