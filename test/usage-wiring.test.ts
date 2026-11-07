// The usage module's wiring: its tool is installed and answers from the usage part, comes and goes with the module,
// and keeps a name no drop-in may take. Each test drives the app and reads what the model saw: a tool the request did
// not offer is answered for by the harness, so a tool that is gone is visible without asserting on a list of modules.
// The signed-in provider is answered by a fixture on `fetch`: nothing here reaches a real endpoint.
import {
    type App,
    cleanUp,
    lastText,
    modelTexts,
    newSession,
    openApp,
    owner,
    root,
    say,
    scriptedModel,
} from "./helpers.ts";
import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, test } from "node:test";
import type { FauxResponseStep } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";

const dataDir = join(root, "data");
const dropIns = join(dataDir, "extensions");
const agentDir = process.env.PI_CODING_AGENT_DIR!;

// ─── A provider sign-in, answered by a fixture (never the network) ───────────

const codexToken = "test-usage-wiring-codex-token-000";
const codexUrl = "https://chatgpt.com/backend-api/wham/usage";
/** 4% of a five-hour window, as the Codex endpoint answers. */
const codexPayload = {
    plan_type: "team",
    rate_limit: {
        primary_window: {
            used_percent: 4,
            limit_window_seconds: 18_000,
            reset_at: 1_792_000_000_000,
        },
    },
};
/** Every URL the app asked for, so a test can tell a fixture answer from a real one. */
const asked: string[] = [];
const realFetch = globalThis.fetch;

/** The one turn the tool tests send: the model calls `usage_quota`, then says what it answered. */
const route: FauxResponseStep = (request) => {
    const { role, text } = lastText(request as never);

    if (role === "toolResult") {
        return fauxAssistantMessage([fauxText(`tool said: ${text}`)]);
    }

    if (text.endsWith("check the quota")) {
        return fauxAssistantMessage([fauxToolCall("usage_quota", {})], { stopReason: "toolUse" });
    }

    return fauxAssistantMessage([fauxText(`echo: ${text}`)]);
};

const model = scriptedModel(route);

/** A drop-in that offers `tool`: used to try to take a name Pi Pocket keeps for its own tools. */
const dropIn = (tool: string) => `/** A drop-in that tries to take the name of a built-in tool. */
import { Type } from "@earendil-works/pi-ai";
import { defineExtension, defineTool } from "@earendil-works/pi-durable";

export default () =>
	defineExtension({
		name: "my-usage",
		tools: [
			defineTool({
				name: "${tool}",
				description: "Mine",
				parameters: Type.Object({}),
				execute: async () => ({ content: [{ type: "text", text: "mine" }] }),
			}),
		],
	});
`;

/** A drop-in that adds a provider it reads itself, under `id`. */
const quotaDropIn = (id: string) => `/** A drop-in that reads a provider's quota itself. */
export default (host, web) => {
	web.onDispose(
		host.registerQuotaSource({
			id: "${id}",
			displayName: "Example plan",
			read: async () => ({
				buckets: [{ id: "week", label: "7d window", used: 30, remaining: 70, limit: 100, unit: "percent" }],
				metrics: [],
				notes: ["Plan: demo"],
			}),
		}),
	);
};
`;

let app: App;

before(async () => {
    mkdirSync(dropIns, { recursive: true });
    // A drop-in of the owner's that offers the name of a built-in tool: off until the owner turns it on.
    writeFileSync(join(dropIns, "my-usage.ts"), dropIn("usage_quota"));
    writeFileSync(join(dropIns, "my-quota.ts"), quotaDropIn("example-plan"));
    writeFileSync(join(dropIns, "my-codex-quota.ts"), quotaDropIn("openai-codex"));
    app = await openApp(model, dataDir);
    // The sign-in comes after the app opened: a sign-in in place at its start would have it refresh the providers
    // once, on its own, before a fixture is here to answer. Every endpoint below answers from `fetch` instead, and any
    // other address answers with a failure, so a test that reached for one says so instead of using the network. (The
    // app puts undici's own fetch in place as it opens, so this has to come after it.)
    writeFileSync(
        join(agentDir, "auth.json"),
        JSON.stringify({
            "openai-codex": {
                type: "oauth",
                access: codexToken,
                expires: Date.now() + 86_400_000,
            },
        }),
    );
    globalThis.fetch = (async (input: string | URL) => {
        const url = String(input);

        asked.push(url);

        return url === codexUrl
            ? new Response(JSON.stringify(codexPayload), { status: 200 })
            : new Response(JSON.stringify({ error: `the fixture does not know ${url}` }), {
                  status: 599,
              });
    }) as typeof fetch;
});

after(async () => {
    await app?.close();
    globalThis.fetch = realFetch;
    rmSync(join(agentDir, "auth.json"), { force: true });
    cleanUp();
});

/** A turn in a fresh session, answering what the model saw: its own words, and each tool result. */
async function turn(text: string): Promise<string> {
    const id = await newSession(app);

    await say(app, id, text);

    return (await modelTexts(app, id)).join("\n");
}

test("the usage_quota tool runs, and answers from the usage part", async () => {
    const said = await turn("check the quota");

    assert.doesNotMatch(
        said,
        /Tool usage_quota is not available/,
        "the tool is offered to the model",
    );
    // What it answered is the usage part's own text for the signed-in provider: its five-hour window and plan, as the
    // fixture above gave them, and the providers it has no sign-in for.
    assert.match(said, /1\/4 from their own APIs/);
    assert.match(said, /OpenAI Codex/);
    assert.match(said, /5h window: 4% used/);
    assert.match(said, /Plan: team/);
    assert.match(said, /no sign-in for opencode-go/);
    // The five-hour window above is the fixture's: the tool asked the one endpoint it is signed in to, and nothing
    // else on the network.
    assert.deepEqual([...new Set(asked)], [codexUrl]);
});

test("the tool comes and goes with the usage module", async () => {
    await app.setExtensionEnabled(owner(app), "usage.ts", false);

    const off = await turn("check the quota");

    // A tool the request did not offer: the harness answers for it instead of running anything.
    assert.match(off, /Tool usage_quota is not available/, "no usage tool while the module is off");
    assert.doesNotMatch(off, /from their own APIs/, "and nothing of the usage part's own text");

    await app.setExtensionEnabled(owner(app), "usage.ts", true);

    const on = await turn("check the quota");

    assert.doesNotMatch(on, /Tool usage_quota is not available/, "the tool is back");
    assert.match(on, /1\/4 from their own APIs/);
});

test("a drop-in cannot take the usage tool's name", async () => {
    await assert.rejects(
        app.setExtensionEnabled(owner(app), "my-usage.ts", true),
        /the tool name usage_quota is a built-in tool's/,
    );
    assert.deepEqual(
        app.loader.list().find((each) => each.file === "my-usage.ts")?.extensions,
        [],
        "the drop-in installed nothing",
    );
    // The built-in tool it tried to take still answers for the model.
    assert.match(await turn("check the quota"), /1\/4 from their own APIs/);
});

test("a drop-in's quota source shows in the tool's answer while the drop-in is on", async () => {
    await app.setExtensionEnabled(owner(app), "my-quota.ts", true);

    const on = await turn("check the quota");

    assert.match(on, /2\/5 from their own APIs/);
    assert.match(on, /Example plan/);
    assert.match(on, /7d window: 30% used/);
    assert.match(on, /Plan: demo/);
    assert.deepEqual(
        [...new Set(asked)],
        [codexUrl],
        "the source read itself: the app fetched nothing for it",
    );

    await app.setExtensionEnabled(owner(app), "my-quota.ts", false);

    const off = await turn("check the quota");

    assert.match(off, /1\/4 from their own APIs/, "turning the drop-in off removes its source");
    assert.doesNotMatch(off, /Example plan/);
});

test("a drop-in cannot take a built-in provider's quota id", async () => {
    await assert.rejects(
        app.setExtensionEnabled(owner(app), "my-codex-quota.ts", true),
        /openai-codex is a built-in provider's/,
    );
    assert.match(await turn("check the quota"), /1\/4 from their own APIs/);
});
