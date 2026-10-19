// The usage sheet's rows as a browser lays them out: a row's stats are one line of text beside a label, and on a
// phone they must not break word by word inside the spend sheet's fixed 64px mono column. Real Chromium, measured.
import {
    type App,
    cleanUp,
    context,
    newSession,
    openApp,
    owner,
    root,
    scriptedModel,
    until,
} from "./helpers.ts";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { join } from "node:path";
import { after, before, test } from "node:test";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { ConversationId } from "@earendil-works/pi-durable";
import { Browsers } from "../src/server/browser.ts";
import { findBrowser } from "../src/server/browser/discovery.ts";
import type { BrowserPage } from "../src/server/browser/page.ts";
import { VIEWPORTS, type Viewport } from "../src/server/browser/viewport.ts";

// Loaded inside the test: importing `http.ts` statically next to this file's own top-level await in `helpers.ts`
// leaves `PocketApp` uninitialized under Node v26 (the whole suite of UI tests fails the same way), and the handler
// is only needed once the app is open.
const { createHandler } = await import("../src/server/http.ts");

const chromium = findBrowser();
const real = {
    skip: chromium === undefined ? "no Chromium-based browser on this machine" : false,
} as const;

let app: App;
let server: Server;
let browsers: Browsers;
let page: BrowserPage;
let base = "";

/** Run a script in the page and read back the JSON it returns. */
async function inPage<T>(script: string): Promise<T> {
    return JSON.parse(await page.evaluate(script)) as T;
}

/** An assistant entry carrying `tokensIn` and `cost`, as a response's own usage would. */
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

const append = (id: ConversationId, message: AssistantMessage) =>
    app.harness.commit(
        (tx) => tx.appendEntry(id, { kind: "pi.assistant", model: [message] }),
        context,
    );

/** What the browser says about one drawn usage row. */
type Row = {
    label: string;
    stats: string;
    lines: number;
    height: number;
    lineHeight: number;
    labelWidth: number;
    pastRight: number;
    boxesPastRight: number;
    scrollOver: number;
};

/** Every usage row now on screen, as laid out: line boxes, widths, and what passes the sheet's edges. */
const measure = () =>
    inPage<Row[]>(`
        const body = document.querySelector(".sheet-body");
        const bodyRect = body.getBoundingClientRect();

        return JSON.stringify([...document.querySelectorAll(".usage-row")].map((row) => {
            const mono = row.querySelector(".mono");
            const label = row.querySelector(".grow");
            const range = document.createRange();
            const style = getComputedStyle(mono);

            range.selectNodeContents(mono);

            return {
                label: label.textContent,
                stats: mono.textContent,
                lines: range.getClientRects().length,
                height: mono.getBoundingClientRect().height,
                lineHeight: parseFloat(style.lineHeight) || parseFloat(style.fontSize) * 1.2,
                labelWidth: label.getBoundingClientRect().width,
                pastRight: row.getBoundingClientRect().right - bodyRect.right,
                boxesPastRight: [...row.querySelectorAll("*")].filter(
                    (node) => node.getBoundingClientRect().right > bodyRect.right + 2,
                ).length,
                scrollOver: body.scrollWidth - body.clientWidth,
            };
        }));
    `);

/** Every row reads as one line of stats, with a label, inside the sheet — or say which row and how it failed. */
function check(rows: Row[], where: string): void {
    assert.ok(rows.length > 0, `${where}: the sheet draws usage rows`);

    for (const row of rows) {
        const at = `${where}: "${row.label}" (${row.stats})`;

        assert.equal(row.lines, 1, `${at} — the stats stay on one line`);
        assert.ok(
            row.height <= row.lineHeight * 1.5,
            `${at} — one line tall, not ${row.height}px against a ${row.lineHeight}px line`,
        );
        assert.ok(row.labelWidth >= 80, `${at} — the label keeps room, ${row.labelWidth}px`);
        assert.ok(row.pastRight <= 2, `${at} — the row stays inside the sheet, ${row.pastRight}px`);
        assert.equal(row.boxesPastRight, 0, `${at} — nothing in it hangs out of the sheet`);
        assert.ok(
            row.scrollOver <= 2,
            `${at} — the sheet does not scroll sideways, ${row.scrollOver}px`,
        );
    }
}

/** The session list, then the usage sheet open over it, at `viewport`, with its rows drawn. */
async function openUsage(viewport: Viewport): Promise<void> {
    await page.setViewport(viewport);
    await page.navigate(`${base}/`);
    await until(
        async () =>
            await inPage<boolean>(
                `return JSON.stringify(document.querySelector(".home-list .session-row") !== null)`,
            ),
        "the session list",
        20_000,
    );
    await page.evaluate(`(await import("/store.js")).openSheet({ type: "usage" })`);
    await until(
        async () =>
            (await inPage<number>(
                `return JSON.stringify(document.querySelectorAll(".usage-row").length)`,
            )) >= 2,
        "the usage sheet's rows",
        20_000,
    );
}

before(async () => {
    if (chromium === undefined) {
        return;
    }

    app = await openApp(scriptedModel());
    const session = await newSession(app);

    // Ten million tokens and a cost, so the row's stats are as long as a real one's: one line, which is the point.
    await append(session, digest(Date.now(), 10_000_000, 0, 9.05));
    await until(
        () => (app.usage.summary(owner(app)).windows["24h"]?.models.length ?? 0) > 0,
        "the usage index to count the entry",
    );

    server = createServer(
        createHandler({ app, listen: { host: "127.0.0.1", port: 0 }, restart: () => {} }),
    );
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    browsers = new Browsers({
        dataDir: mkdtempSync(join(root, "usage-ui-")),
        load: async () => undefined,
        save: () => {},
    });
    page = await browsers.open(1);
    await page.setViewport(VIEWPORTS.mobile);
    await page.navigate(`${base}/login?token=${encodeURIComponent(app.config.ownerToken)}`);
    await until(
        async () =>
            await inPage<boolean>(
                `return JSON.stringify(document.querySelector(".home-list .session-row") !== null)`,
            ),
        "the session list",
        20_000,
    );
});

after(async () => {
    await browsers?.closeAll({ final: true });
    server?.closeAllConnections();
    server?.close();
    await app?.close();
    cleanUp();
});

test(
    "on a phone, every usage row keeps its stats on one line, inside the sheet",
    real,
    async () => {
        await openUsage(VIEWPORTS.mobile);
        const rows = await measure();

        check(rows, "the phone");
        assert.ok(
            rows.some((row) => row.label === "faux/faux-1"),
            "the model's row is among them",
        );
        assert.ok(
            rows.some((row) => row.label === owner(app).name),
            "the person's row is among them",
        );
    },
);

test("on a desktop, the same rows stay one line and inside the sheet", real, async () => {
    await openUsage(VIEWPORTS.desktop);

    check(await measure(), "the desktop");
});
