// Usage: the local index built from assistant entries, counted once across flushes, restarts, and replays, the
// window summaries over it, and the parsing of each provider's own usage payloads. The quota endpoints are not
// fetched for real here: where a test signs a provider in, `fetch` answers with the fixtures below.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { ConversationId, EntryId } from "@earendil-works/pi-durable";
import {
    checkedReport,
    commandCodeOrgId,
    normalizeCodex,
    normalizeCommandCode,
    normalizeOpenCodeZen,
    querySources,
} from "../src/server/usage-providers.ts";
import { UsageIndexDoc, UsageQuotaDoc } from "../src/server/docs.ts";
import type { UsageSummary, UsageWindow } from "../src/server/usage.ts";
import { WINDOWS } from "../src/server/usage.ts";
import {
    until,
    fakeTab,
    cleanUp,
    context,
    newSession,
    openApp,
    owner,
    scriptedModel,
} from "./helpers.ts";

// ─── Fixtures, as the endpoints answered when the provider modules were ported ─

const codexPayload = {
    plan_type: "team",
    rate_limit: {
        primary_window: { used_percent: 4, limit_window_seconds: 18_000, reset_at: 1_792_000_000 },
        secondary_window: {
            used_percent: 14,
            limit_window_seconds: 604_800,
            reset_at: 1_792_500_000,
        },
    },
    rate_limit_reset_credits: { available_count: 3 },
};

const zenPayload = {
    usage: {
        rolling: { status: "ok", percent: 1, resetsAt: "2026-10-14T09:14:02.000Z" },
        weekly: { status: "ok", percent: 9, resetsAt: "2026-10-19T00:00:00.000Z" },
        monthly: { status: "ok", percent: 7, resetsAt: "2026-11-07T04:27:31.000Z" },
    },
};

const commandCodeBundle = {
    account: { user: { userName: "caesariorcuv" }, org: null },
    credits: {
        credits: { monthlyCredits: 77.29, purchasedCredits: 0, freeCredits: 0 },
        windowLimits: {
            limited: true,
            fiveHour: { used: 0, cap: 16, exceeded: false, resetAt: 0 },
            weekly: { used: 2.7, cap: 40, exceeded: false, resetAt: 1_792_030_817_000 },
        },
    },
    subscription: {
        data: {
            planId: "individual-pro-v1",
            status: "active",
            currentPeriodStart: "2026-10-07T06:15:51.000Z",
            currentPeriodEnd: "2026-11-07T06:15:51.000Z",
        },
    },
    usage: {
        totalCount: 402,
        totalCost: 2.7,
        totalTokens: 42_343_594,
        totalTokensIn: 42_057_524,
        totalTokensOut: 286_070,
    },
};

// ─── The parsers ──────────────────────────────────────────────────────────────

test("the Codex payload reads as its windows, its plan, and its reset credits", () => {
    const report = normalizeCodex(codexPayload, 0);

    assert.equal(report.providerName, "OpenAI Codex");
    assert.deepEqual(
        report.buckets.map((bucket) => [bucket.label, bucket.used, bucket.resetsAt]),
        [
            ["5h window", 4, 1_792_000_000],
            ["7d window", 14, 1_792_500_000],
        ],
    );
    assert.deepEqual(report.metrics, [
        { id: "reset-credits", label: "Usage limit resets available", value: 3, unit: "count" },
    ]);
    assert.deepEqual(report.notes, ["Plan: team"]);
});

test("the OpenCode Zen payload reads as its three percentage windows", () => {
    const report = normalizeOpenCodeZen(zenPayload, 0);

    assert.deepEqual(
        report.buckets.map((bucket) => [bucket.label, bucket.used]),
        [
            ["Rolling window", 1],
            ["Weekly window", 9],
            ["Monthly window", 7],
        ],
    );
    assert.equal(
        report.buckets.find((bucket) => bucket.id === "weekly")?.resetsAt,
        Math.floor(Date.parse("2026-10-19T00:00:00.000Z") / 1000),
    );
});

test("the Command Code bundle reads as windows in dollars, the plan, and the period's work", () => {
    const report = normalizeCommandCode(
        commandCodeBundle.account,
        commandCodeBundle.credits,
        commandCodeBundle.subscription,
        commandCodeBundle.usage,
        0,
    );

    assert.equal(commandCodeOrgId(commandCodeBundle.account), undefined);
    assert.equal(report.accountLabel, "caesariorcuv");
    assert.deepEqual(
        report.buckets.map((bucket) => [
            bucket.id,
            bucket.used,
            Number((bucket.limit ?? 0).toFixed(2)),
        ]),
        [
            ["five-hour", 0, 16],
            ["weekly", 2.7, 40],
            ["monthly", 2.7, 79.99],
        ],
    );
    assert.ok(
        report.metrics.some((metric) => metric.id === "plan" && metric.value === "Pro v1 (active)"),
        "the plan line names the plan",
    );
    assert.ok(report.metrics.some((metric) => metric.id === "requests" && metric.value === 402));
    assert.ok(
        report.metrics.some((metric) => metric.id === "tokens" && metric.value === 42_343_594),
    );
});

test("a payload without a readable account name is an error, not a blank row", () => {
    assert.throws(
        () => normalizeCommandCode({ user: undefined }, undefined, undefined, undefined, 0),
        /account response omitted an account name/,
    );
});

// ─── The local index ──────────────────────────────────────────────────────────

let app: Awaited<ReturnType<typeof openApp>>;

const digest = (at: number, tokensIn: number, out: number, cost: number) =>
    ({
        role: "assistant",
        content: [{ type: "text", text: "ok" }],
        provider: "faux",
        model: "faux-1",
        stopReason: "stop",
        timestamp: at,
        usage: {
            input: tokensIn,
            output: out,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: tokensIn + out,
            cost: { input: 0, output: cost, cacheRead: 0, cacheWrite: 0, total: cost },
        },
    }) as unknown as AssistantMessage;

const append = async (id: ConversationId, message: AssistantMessage): Promise<EntryId> =>
    (
        await app.harness.commit(
            (tx) => tx.appendEntry(id, { kind: "pi.assistant", model: [message] }),
            context,
        )
    ).id;

const flushWait = () => new Promise((resolve) => setTimeout(resolve, 400));

const summary = async (): Promise<UsageSummary> => app.usage.summary(owner(app));

const windowOf = (data: UsageSummary, id: string): UsageWindow => data.windows[id]!;

before(async () => {
    app = await openApp(scriptedModel());
});

after(async () => {
    await app?.close();
    cleanUp();
});

test("entries a commit brings are counted once, for the person Pi works for, in their hour", async () => {
    const id = await newSession(app);
    const at = Date.now();

    await append(id, digest(at, 1000, 100, 0.5));
    await flushWait();

    const view = windowOf(await summary(), "24h");

    assert.equal(view.cards.calls, 1);
    assert.equal(view.cards.tokens, 1100);
    assert.equal(view.cards.cost, 0.5);
    assert.equal(view.cards.sessions, 1);
    assert.deepEqual(
        view.models.map((model) => [model.key, model.calls]),
        [["faux/faux-1", 1]],
    );
    assert.deepEqual(
        view.people.map((person) => [person.name, person.calls]),
        [[owner(app).name, 1]],
    );
});

test("an entry the listener hears again is not counted twice", async () => {
    const id = await newSession(app);
    const entryId = await append(id, digest(Date.now(), 500, 50, 0.1));

    await flushWait();

    const before = windowOf(await summary(), "24h").cards.calls;

    const { items } = await app.harness.commit(
        (tx) => tx.scanConversations({}, 256, undefined),
        context,
    );
    const record = (await app.harness.commit((tx) => tx.entry(entryId as never), context))!;
    const conversation = items.find((each) => each.id === id);
    const stored = { ...record, conversationId: conversation!.id } as never;

    app.usage.entryCommitted(stored);
    app.usage.entryCommitted(stored);
    await flushWait();

    assert.equal(
        windowOf(await summary(), "24h").cards.calls,
        before,
        "the watermark kept the repeats out",
    );
});

test("windows cut by time: an old entry is in All, not in 5h", async () => {
    const id = await newSession(app);
    const old = new Date(Date.now() - 40 * 86_400_000).getTime();
    const before = await summary();

    await append(id, digest(old, 2000, 0, 1));
    await flushWait();

    const after = await summary();

    assert.equal(
        windowOf(after, "all").cards.calls,
        windowOf(before, "all").cards.calls + 1,
        "everything so far, plus the old one",
    );
    assert.equal(
        windowOf(after, "5h").cards.calls,
        windowOf(before, "5h").cards.calls,
        "the old one is out of 5h",
    );
    assert.equal(
        windowOf(after, "30d").cards.calls,
        windowOf(before, "30d").cards.calls,
        "and out of 30d",
    );
});

test("a restart backfills the index from history, counting nothing twice", async () => {
    const data = await summary();
    const before = windowOf(data, "all").cards;

    // A restart: the first server closes (0.21's lock refuses a second one on the same folder), then the
    // same folder opens again. Usage loads, backfills, and subscribes after.
    await app.close();
    app = await openApp(scriptedModel());
    const after = windowOf(app.usage.summary(owner(app)), "all").cards;

    assert.equal(after.calls, before.calls, "nothing added, nothing lost");
    assert.equal(after.tokens, before.tokens);
});

test("WINDOWS has the window the sheet shows, newest first", () => {
    assert.deepEqual(
        WINDOWS.map((spec) => spec.id),
        ["5h", "24h", "7d", "30d", "all"],
    );
});

test("without sign-ins, a quota refresh reports why instead of fetching", async () => {
    const quota = await app.usage.refreshQuota();
    const providers = Object.keys(quota);

    assert.ok(providers.length >= 3, "every supported provider is accounted for");

    for (const id of providers) {
        if (quota[id]!.report === undefined) {
            assert.match(quota[id]!.error ?? "", /no sign-in|expired/);
        }
    }
});

// ─── Signed-in providers, answered by fetch fixtures (never the real endpoints) ─

const agentDir = process.env.PI_CODING_AGENT_DIR!;
const codexCredential = "test-codex-oauth-token-000";
const mainKey = "test-command-code-key-main-000";
const zenKey = "test-zen-key-000";
const backupKey = "test-command-code-key-back-000";

/** A codex payload whose window resets are epoch milliseconds, as the endpoint sends them. */
const codexPayloadInMs = {
    plan_type: "pro",
    rate_limit: {
        primary_window: {
            used_percent: 85,
            limit_window_seconds: 18_000,
            reset_at: 1_792_000_000_000,
        },
    },
    rate_limit_reset_credits: { available_count: 1 },
};

/** Command Code payloads: one account past its threshold, one whose credits endpoint fails. */
let fixtureWeeklyResets = 1_792_050_000_000;

const commandCodePayloads = {
    main: {
        account: { user: { userName: "caesariorcuv" }, org: null },
        credits: {
            credits: { monthlyCredits: 8, purchasedCredits: 0, freeCredits: 0 },
            windowLimits: {
                limited: true,
                fiveHour: { used: 14, cap: 16, exceeded: false, resetAt: 0 },
                weekly: { used: 39, cap: 40, exceeded: false, resetAt: fixtureWeeklyResets },
            },
        },
        subscription: {
            data: {
                planId: "individual-pro-v1",
                status: "active",
                currentPeriodStart: "2026-10-07T06:15:51.000Z",
                currentPeriodEnd: "2026-11-07T06:15:51.000Z",
            },
        },
        usage: { totalCount: 500, totalCost: 39, totalTokens: 40_000_000 },
    },
    backup: {
        account: { user: { userName: "caesariopamungkpezx" }, org: null },
        subscription: { data: { planId: "individual-goat", status: "active" } },
    },
};

let fetchFixture: ((url: string, bearer: string) => { status: number; body: unknown }) | undefined;
const realFetch = globalThis.fetch;

/** Answer every provider URL from the fixtures, and nothing else; the two Command Code accounts differ by their key. */
function stubFetch(): void {
    fetchFixture = (url, bearer) => {
        const backup = bearer === backupKey;

        if (url.startsWith("https://chatgpt.com/")) {
            return { status: 200, body: codexPayloadInMs };
        }

        if (url.startsWith("https://opencode.ai/")) {
            return { status: 500, body: { error: `rejected key ${zenKey}` } };
        }

        if (url.includes("/alpha/whoami")) {
            return {
                status: 200,
                body: backup
                    ? commandCodePayloads.backup.account
                    : commandCodePayloads.main.account,
            };
        }

        if (url.includes("/alpha/billing/credits")) {
            return backup
                ? { status: 401, body: { error: `bad key ${backupKey}` } }
                : { status: 200, body: commandCodePayloads.main.credits };
        }

        if (url.includes("/alpha/billing/subscriptions")) {
            return {
                status: 200,
                body: backup
                    ? commandCodePayloads.backup.subscription
                    : commandCodePayloads.main.subscription,
            };
        }

        if (url.includes("/alpha/usage/summary")) {
            return backup
                ? { status: 404, body: { message: "404 not found" } }
                : { status: 200, body: commandCodePayloads.main.usage };
        }

        throw new Error(`the fixture does not know ${url}`);
    };

    globalThis.fetch = (async (input: string | URL, init?: RequestInit) => {
        const url = String(input);
        const headers = Object.entries(init?.headers ?? {}).find(
            ([name]) => name.toLowerCase() === "authorization",
        );
        const bearer = /Bearer\s+(\S+)/.exec(String(headers?.[1] ?? ""))?.[1] ?? "";
        const answer = fetchFixture?.(url, bearer);

        if (answer === undefined) {
            return realFetch(input as never);
        }

        return new Response(JSON.stringify(answer.body), {
            status: answer.status,
        });
    }) as typeof fetch;
}

test("with sign-ins, each provider's own endpoint answers, in dollars and percent, and past the limit warns once", async () => {
    writeFileSync(
        join(agentDir, "auth.json"),
        JSON.stringify({
            "openai-codex": {
                type: "oauth",
                access: codexCredential,
                expires: Date.now() + 3_600_000,
            },
            "opencode-go": { type: "api_key", key: zenKey },
            commandcode: { type: "api_key", key: mainKey },
            "commandcode-b": { type: "api_key", key: backupKey },
        }),
    );
    stubFetch();

    try {
        // The owner's tab hears the warning past the threshold; nobody else is here.
        const tab = fakeTab(undefined, owner(app));

        app.attach(tab.client);

        const quota = await app.usage.refreshQuota(true);

        app.detach(tab.client);

        // The Codex resets came as milliseconds and are read back as seconds.
        const codex = quota["openai-codex"]?.report;

        assert.equal(
            codex?.buckets[0]?.resetsAt,
            1_792_000_000,
            "epoch milliseconds divide to seconds",
        );
        assert.equal(codex?.notes?.[0], "Plan: pro");

        // A command-code account whose credits endpoint failed keeps its account and plan, and says so.
        assert.equal(quota["commandcode-b"]?.report?.accountLabel, "caesariopamungkpezx");
        assert.deepEqual(quota["commandcode-b"]?.report?.notes ?? [], [
            "Credits were unavailable.",
            "Billing-period usage was unavailable.",
        ]);
        // An error body that echoed the credential comes back covered.
        assert.ok(!JSON.stringify(quota).includes(mainKey), "no credential in the answer");
        assert.ok(!JSON.stringify(quota).includes(backupKey), "no second credential either");
        assert.ok(!JSON.stringify(quota).includes(zenKey), "no third credential either");
        assert.match(
            quota["opencode-go"]?.error ?? "",
            /rejected key/,
            "the failure is an error, not notes",
        );

        // The windows past their threshold warned, once, keyed by their reset, and the doc remembers it by that reset.
        const warnings = tab.events.filter((event) => event.event === "notice");
        const messages = warnings.map((event) => String(event.data.message ?? ""));

        assert.ok(
            messages.some((message) => message.includes("85% of its 5h window")),
            messages.join(" | "),
        );
        assert.ok(messages.some((message) => message.includes("98% of its weekly window")));

        const stored = await app.harness.snapshot(UsageQuotaDoc, context);

        assert.equal(stored?.warned["openai-codex:primary_window"], 1_792_000_000);

        // The same window again warns nobody; a new window resets the warning.
        await app.usage.refreshQuota(true);
        fixtureWeeklyResets += 60_000;
        commandCodePayloads.main.credits.windowLimits.weekly = {
            used: 39,
            cap: 40,
            exceeded: false,
            resetAt: fixtureWeeklyResets,
        };
        const after = await app.usage.refreshQuota(true);
        const now = await app.harness.snapshot(UsageQuotaDoc, context);

        assert.equal(
            now?.warned["openai-codex:primary_window"],
            1_792_000_000,
            "the threshold window warns once",
        );
        assert.notEqual(
            now?.warned["commandcode:weekly"],
            undefined,
            "the weekly warning carries its reset time",
        );
        assert.equal(now?.warned["commandcode:weekly"], Math.floor(fixtureWeeklyResets / 1000));
        assert.match(after["opencode-go"]?.error ?? "", /rejected key/);
    } finally {
        // Clean-up even after a failed assert: no sign-in and real fetch for the tests after this one.
        unlinkSync(join(agentDir, "auth.json"));
        globalThis.fetch = realFetch;
        fetchFixture = undefined;
    }
});

test("the doc's hour keys are epoch-second hour starts, and the watermark is the newest entry", async () => {
    const id = await newSession(app);
    const at = Date.now();
    const entryId = await append(id, digest(at, 700, 7, 0.07));

    await flushWait();

    const index = await app.harness.snapshot(UsageIndexDoc, context);
    const hour = String(Math.floor(at / 3_600_000) * 3_600);

    assert.ok(index?.hours[hour] !== undefined, `an hour-start key ${hour}`);

    for (const key of Object.keys(index?.hours ?? {})) {
        assert.equal(Number(key) % 3_600, 0, `epoch-second hour start: ${key}`);
    }

    assert.ok((index?.watermarks[String(id)] ?? 0) >= entryId);
});

test("the tool's text names what is unavailable, and refuses an unknown provider", async () => {
    await assert.rejects(() => app.usage.toolText("not-a-provider"), /No provider not-a-provider/);

    // Without the rig's sign-ins a forced refresh reports each provider by why, and the text says so.
    await app.usage.refreshQuota(true);

    assert.match(await app.usage.toolText(), /not available — .*no sign-in for openai-codex/);
    assert.match(await app.usage.toolText(), /0\/4 from their own APIs/);
});

test("a flush the ledger refuses counts nothing, and the next counts each entry once", async () => {
    const id = await newSession(app);
    const before = windowOf(await summary(), "24h").cards.calls;
    const entryId = await append(id, digest(Date.now(), 20, 2, 0.02));

    // The very next commit refuses: the flush above the fresh entry is the next thing the ledger sees.
    const original = app.harness.commit.bind(app.harness);
    let failNext = 1;
    const harness = app.harness as unknown as { commit: typeof original };

    harness.commit = ((fn: never, ctx: never) => {
        if (failNext > 0) {
            failNext -= 1;

            return Promise.reject(new Error("the ledger refuses for the test"));
        }

        return original(fn, ctx);
    }) as typeof original;

    await flushWait();
    harness.commit = original;

    await until(
        async () => (await summary()).windows["24h"]!.cards.calls === before + 1,
        "the refused entry to be counted by the flush after it",
    );

    assert.equal(
        windowOf(await summary(), "24h").cards.calls,
        before + 1,
        "the refused entry landed once",
    );
    void entryId;
});

// ─── Providers a module reads itself (host.registerQuotaSource) ──────────────

const planReport = {
    providerId: "ignored",
    providerName: "Ignored",
    capturedAt: 1,
    accountLabel: "me",
    buckets: [
        {
            id: "five_hour",
            label: "5h window",
            used: 24,
            remaining: 76,
            limit: 100,
            unit: "percent",
            windowMinutes: 300,
            resetsAt: 1_794_024_000,
        },
        { id: "bad-unit", label: "Tokens", used: 3, unit: "tokens" },
        { id: "five_hour", label: "Duplicate", used: 99, unit: "percent" },
        { id: "seven_day", label: "7d window", used: 81, unit: "percent" },
        { label: "No id", used: 1, unit: "percent" },
    ],
    metrics: [{ id: "extra", label: "Extra usage", value: "off", secret: "never-shown" }],
    notes: ["Plan: team", 42, "x".repeat(500)],
    token: "never-shown",
};

test("a module's report keeps only what the sheet shows, under the source's own id and name", () => {
    const report = checkedReport(
        { id: "claude-code", displayName: "Claude (Claude Code)" },
        planReport,
        99,
    );

    assert.equal(report.providerId, "claude-code");
    assert.equal(report.providerName, "Claude (Claude Code)");
    assert.equal(report.capturedAt, 99);
    assert.deepEqual(
        report.buckets,
        [
            planReport.buckets[0],
            { id: "seven_day", label: "7d window", used: 81, limit: 100, unit: "percent" },
        ],
        "an unknown unit, no id, or an id seen before is dropped; a percentage is of 100",
    );
    assert.deepEqual(report.metrics, [{ id: "extra", label: "Extra usage", value: "off" }]);
    assert.equal(report.notes?.[0], "Plan: team");
    assert.equal(report.notes?.length, 2, "a note that is not text is dropped");
    assert.ok(report.notes![1]!.length <= 200, "a long note is cut");
    assert.doesNotMatch(
        JSON.stringify(report),
        /never-shown/,
        "fields Pi does not show never pass through",
    );

    for (const empty of [
        undefined,
        "text",
        { buckets: [], metrics: [] },
        { buckets: [{ id: "x", label: "y", unit: "nope" }] },
    ]) {
        assert.throws(
            () => checkedReport({ id: "x", displayName: "X" }, empty, 1),
            /no report|nothing|no window/,
        );
    }
});

test("module sources answer each for itself: a failure or a hang is that source's error alone", async () => {
    let aborted = false;
    const quota = await querySources(
        [
            { id: "good", displayName: "Good", read: async () => planReport as never },
            {
                id: "broken",
                displayName: "Broken",
                read: async () => {
                    throw new Error("no login\n  here");
                },
            },
            {
                id: "slow",
                displayName: "Slow",
                read: (signal) =>
                    new Promise((resolve) => {
                        signal.addEventListener("abort", () => {
                            aborted = true;
                        });
                        setTimeout(() => resolve(planReport as never), 5_000).unref();
                    }),
            },
        ],
        50,
    );

    assert.equal(quota.good?.report?.buckets[0]?.used, 24);
    assert.equal(quota.broken?.error, "Broken: no login here");
    assert.match(quota.slow?.error ?? "", /^Slow: timed out/);
    assert.equal(aborted, true, "the hung read's signal is aborted");
});

test("a registered source joins the refresh and the tool's text, and leaves with its removal", async () => {
    assert.throws(
        () =>
            app.usage.registerQuotaSource({
                id: "openai-codex",
                displayName: "Fake",
                read: async () => planReport as never,
            }),
        /built-in provider/,
    );
    assert.throws(
        () =>
            app.usage.registerQuotaSource({
                id: "Bad Id",
                displayName: "Fake",
                read: async () => planReport as never,
            }),
        /lower-case/,
    );
    assert.throws(
        () =>
            app.usage.registerQuotaSource({
                id: "fake-codex",
                displayName: "openai codex",
                read: async () => planReport as never,
            }),
        /name OpenAI Codex|name openai codex is a built-in/,
    );
    assert.throws(
        () =>
            app.usage.registerQuotaSource({
                id: "blank",
                displayName: "\n\t ",
                read: async () => planReport as never,
            }),
        /display name/,
    );

    let reads = 0;
    const older = app.usage.registerQuotaSource({
        id: "example-plan",
        displayName: "Old plan",
        read: async () => planReport as never,
    });
    const remove = app.usage.registerQuotaSource({
        id: "example-plan",
        displayName: "Example plan",
        read: async () => {
            reads++;

            return planReport as never;
        },
    });

    older(); // the older registration's removal leaves the newer one in place
    const quota = await app.usage.refreshQuota(true);

    assert.equal(reads, 1);
    assert.equal(quota["example-plan"]?.report?.providerName, "Example plan");

    const text = await app.usage.toolText("example-plan");

    assert.match(text, /1\/1 from their own APIs/);
    assert.match(text, /Example plan — me/);
    assert.match(text, /5h window: 24% used/);

    remove();
    await app.usage.refreshQuota(true);
    await assert.rejects(() => app.usage.toolText("example-plan"), /No provider example-plan/);
    assert.equal(
        (await app.usage.refreshQuota(true))["example-plan"],
        undefined,
        "a removed source leaves the snapshot",
    );
});

test("a module source is read at most every five minutes, however often the sheet forces a refresh", async () => {
    let reads = 0;
    const remove = app.usage.registerQuotaSource({
        id: "counted-plan",
        displayName: "Counted\nplan\u0007",
        read: async () => {
            reads++;

            return planReport as never;
        },
    });

    try {
        await app.usage.refreshQuota(true);
        await app.usage.refreshQuota(true);
        await app.usage.refreshQuota(true);

        assert.equal(reads, 1, "the sheet's forced refreshes reuse the source's answer");

        const text = await app.usage.toolText("counted-plan");

        assert.match(text, /Counted plan — me/, "the name is one line of plain text");
        assert.equal(reads, 1);
    } finally {
        remove();
    }
});

test("a source registered after start is read without anyone asking, and one removed mid-read leaves no answer", async () => {
    // Nobody asks for a refresh here: the registration alone has the source read (it starts the poll, or wakes it).
    let polled = 0;
    const removePolled = app.usage.registerQuotaSource({
        id: "polled-plan",
        displayName: "Polled plan",
        read: async () => {
            polled++;

            return planReport as never;
        },
    });

    await until(() => polled === 1, "the new source is read without a refresh asked for");
    removePolled();

    let release: () => void = () => {};

    const gate = new Promise<void>((resolve) => {
        release = resolve;
    });
    let started = false;
    const removeSlow = app.usage.registerQuotaSource({
        id: "removed-plan",
        displayName: "Removed plan",
        read: async () => {
            started = true;
            await gate;

            return planReport as never;
        },
    });
    const running = app.usage.refreshQuota(true);

    await until(() => started, "the slow source started its read");
    removeSlow();
    release();

    const quota = await running;

    assert.equal(quota["removed-plan"], undefined, "an answer for a removed source is not kept");
    assert.equal(quota["polled-plan"], undefined);
});

test("a source replaced while its old read runs gets its own answer, not the old one", async () => {
    let release: () => void = () => {};

    const gate = new Promise<void>((resolve) => {
        release = resolve;
    });
    let started = false;
    const removeOld = app.usage.registerQuotaSource({
        id: "replaced-plan",
        displayName: "Replaced plan",
        read: async () => {
            started = true;
            await gate;

            return { ...planReport, notes: ["old answer"] } as never;
        },
    });
    const running = app.usage.refreshQuota(true);

    await until(() => started, "the old registration started its read");
    removeOld();

    let newReads = 0;
    const removeNew = app.usage.registerQuotaSource({
        id: "replaced-plan",
        displayName: "Replaced plan",
        read: async () => {
            newReads++;

            return { ...planReport, notes: ["new answer"] } as never;
        },
    });

    try {
        release();
        await running;

        const text = await app.usage.toolText("replaced-plan");

        assert.doesNotMatch(
            text,
            /old answer/,
            "the old registration's answer is not kept for the new one",
        );
        assert.match(text, /new answer/);
        assert.ok(newReads >= 1);
    } finally {
        removeNew();
    }
});
