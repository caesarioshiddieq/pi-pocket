// `/api/usage`: who may read the sheet's summary, and that a refresh asks each provider's own endpoint — a fixture on
// `fetch` here, never the network. The providers' answers are the fixture's own, so a run that reached a real endpoint
// would fail rather than pass.
import { type App, cleanUp, newSession, openApp, owner, root, scriptedModel } from "./helpers.ts";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, test } from "node:test";
import type { UsageSummary } from "../src/server/usage.ts";

// Imported here, not above: on Node 26 a static import of this module beside helpers' top-level await fails to
// initialize (the same reason the UI tests load it this way).
const { createHandler } = await import("../src/server/http.ts");

const dataDir = join(root, "data");
const agentDir = process.env.PI_CODING_AGENT_DIR!;
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
/** Every URL the app asked for, so a test can tell its own request from a provider's. */
const asked: string[] = [];
const realFetch = globalThis.fetch;

let app: App;
let server: Server;
let base = "";
const people: Record<string, { token: string; id: string }> = {};

before(async () => {
    app = await openApp(scriptedModel(), dataDir);
    server = createServer(
        createHandler({ app, listen: { host: "127.0.0.1", port: 0 }, restart: () => {} }),
    );
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;

    people.owner = { token: app.config.ownerToken, id: owner(app).id };

    for (const [name, role] of [
        ["Gale", "guest"],
        ["Vic", "viewer"],
    ] as const) {
        const added = app.config.addUser(name, role);

        people[name] = { token: added.token, id: added.user.id };
    }

    // A session of the owner's, so there is something of this server's to count.
    await newSession(app);
    // The sign-in stays out of Pi's auth store until now: one in place at the app's start would have it ask the
    // providers once, on its own, before a fixture is here to answer. (The app puts undici's own fetch in place as it
    // opens, so this has to come after it either way.)
    writeFileSync(
        join(agentDir, "auth.json"),
        JSON.stringify({
            "openai-codex": {
                type: "oauth",
                access: "test-usage-route-codex-token-000",
                expires: Date.now() + 86_400_000,
            },
        }),
    );
    // The provider's endpoint answers from the fixture; this test's own requests to the server go where they always
    // did. Any other address fails, so a second provider asked for real shows up as one.
    globalThis.fetch = (async (input: string | URL, init?: RequestInit) => {
        const url = String(input);

        asked.push(url);

        if (url === codexUrl) {
            return new Response(JSON.stringify(codexPayload), { status: 200 });
        }

        if (url.startsWith("http://127.0.0.1:")) {
            return realFetch(url, init);
        }

        return new Response(JSON.stringify({ error: `the fixture does not know ${url}` }), {
            status: 599,
        });
    }) as typeof fetch;
});

after(async () => {
    server?.closeAllConnections();
    server?.close();
    await app?.close();
    globalThis.fetch = realFetch;
    rmSync(join(agentDir, "auth.json"), { force: true });
    cleanUp();
});

/** A request as someone named in `people`, or nobody, with the header a form on another site cannot send. */
async function call(
    who: string | null,
    path: string,
    options: { method?: string; body?: unknown } = {},
) {
    const response = await fetch(`${base}${path}`, {
        method: options.method ?? "GET",
        headers: {
            ...(who === null ? {} : { authorization: `Bearer ${people[who]!.token}` }),
            "x-pocket": "1",
            ...(options.body === undefined ? {} : { "content-type": "application/json" }),
        },
        ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
    });
    const text = await response.text();
    let data: unknown = text;

    try {
        data = JSON.parse(text);
    } catch {
        // Not JSON.
    }

    return { status: response.status, data };
}

test("the owner reads the usage summary, with the windows the sheet shows", async () => {
    const answer = await call("owner", "/api/usage");

    assert.equal(answer.status, 200);

    const { windows, quota } = answer.data as UsageSummary;
    // The sheet's own window and everything: its cards count what this server's sessions spent.
    const all = windows.all!;

    assert.ok(windows["24h"] !== undefined, "the window the sheet opens on");
    assert.equal(typeof all.cards.tokens, "number");
    assert.equal(typeof all.cards.cost, "number");
    assert.equal(typeof all.cards.calls, "number");
    assert.ok(all.cards.sessions >= 1, "the owner's session is counted");
    assert.ok(Array.isArray(all.models) && Array.isArray(all.people));
    // Each provider's live quota comes with the summary; the first refresh is what fills it (the sheet's own refresh
    // button does that — see the POST below), and this server's providers have not been asked yet.
    assert.equal(typeof quota, "object");
});

test("everyone signed in reads it, as the owner chose", async () => {
    for (const name of ["Gale", "Vic"]) {
        const answer = await call(name, "/api/usage");

        assert.equal(answer.status, 200, `${name} reads the summary`);
        assert.ok(
            (answer.data as UsageSummary).windows.all !== undefined,
            `${name} sees the windows`,
        );
    }
});

test("nobody without a sign-in reads it, and the refusal carries no usage", async () => {
    const answer = await call(null, "/api/usage");

    assert.equal(answer.status, 401);
    assert.deepEqual(answer.data, { error: "Sign in first" });
});

test("the sheet's refresh answers with the summary, after asking the provider", async () => {
    const answer = await call("owner", "/api/usage", { method: "POST", body: { force: false } });

    assert.equal(answer.status, 200);

    const { windows, quota } = answer.data as UsageSummary;

    assert.ok(windows.all !== undefined);
    // The refresh reads each provider's own endpoint through `fetch`: the fixture's window is what came back, so this
    // run never asked a real one.
    assert.equal(quota["openai-codex"]?.report?.buckets?.[0]?.used, 4);
    assert.deepEqual(
        asked.filter((url) => !url.startsWith("http://127.0.0.1:")),
        [codexUrl],
        "only the signed-in provider's own endpoint, and only the fixture's",
    );
});
