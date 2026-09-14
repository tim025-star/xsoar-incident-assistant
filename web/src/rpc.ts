import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";
import type { RouterClient } from "@orpc/server";
import type { createAssistantRouter } from "../../src/rpc.js";

type AppRouter = ReturnType<typeof createAssistantRouter>["router"];

const fragmentToken = location.hash.slice(1);
if (fragmentToken) {
  sessionStorage.setItem("assistant-session-token", fragmentToken);
  history.replaceState(null, "", location.pathname);
}
export const sessionToken = fragmentToken || sessionStorage.getItem("assistant-session-token") || "";

const link = new RPCLink({
  url: `${location.origin}/rpc`,
  headers: { "X-Assistant-Token": sessionToken }
});

export const rpc: RouterClient<AppRouter> = createORPCClient(link);
