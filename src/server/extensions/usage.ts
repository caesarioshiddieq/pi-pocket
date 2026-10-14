/**
 * The usage_quota tool: each signed-in provider's own usage endpoint, live, as its quota and windows say. It reads the
 * app's usage part through the host (`usage.ts`), which a restart brings.
 */
import { Type } from "@earendil-works/pi-ai";
import { defineExtension, defineTool } from "@earendil-works/pi-durable";
import type { PocketHost } from "../host.ts";

export default function createUsage(host: PocketHost) {
    const usageQuota = defineTool({
        name: "usage_quota",
        description:
            "Live usage and quota for the signed-in providers (OpenAI Codex, OpenCode Go, Command Code accounts): each provider's own usage endpoint, refreshed on demand. Read-only.",
        parameters: Type.Object({
            provider: Type.Optional(
                Type.String({
                    description:
                        "One provider id (openai-codex, opencode-go, commandcode, commandcode-b); absent means all.",
                }),
            ),
        }),
        // Reads only: running it again after a restart cut it off is harmless.
        replay: "safe",
        execute: async (args) => {
            // A member new to the host may be missing while the server runs older code: it comes with a restart.
            if (typeof host.usage?.toolText !== "function") {
                return {
                    content: [
                        {
                            type: "text" as const,
                            text: "Usage is not available yet: the server needs a restart to bring it in.",
                        },
                    ],
                };
            }

            const text = await host.usage.toolText(args.provider);

            return { content: [{ type: "text" as const, text }] };
        },
    });

    return defineExtension({ name: "pocket-usage", tools: [usageQuota] });
}
