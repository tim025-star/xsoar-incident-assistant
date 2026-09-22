// Development diagnostics with in-memory settings; never overwrites user configuration.
import { createAssistantServer } from "../src/server.js";
import { resolveAppConfig } from "../src/config.js";
import { createLayaMapper } from "../src/laya-mapper.js";
let config = resolveAppConfig({}, { requireTenant: false });
const mapper = createLayaMapper();
const app = createAssistantServer({ routerOptions: { layaMapper: mapper, configStore: {
  load: async () => config,
  save: async (input, options) => (config = resolveAppConfig(input, options))
} } });
console.log(await app.listen(0));
for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, () => { mapper.close(); app.server.close(() => process.exit(0)); });
