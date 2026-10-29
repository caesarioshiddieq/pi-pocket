// Hiding a session from the lists, in a dedicated headless browser: a phone's row actions hide one, the notice undoes
// it, and the desktop menu hides and shows it, with the search, the launcher, a reload, and a direct link.
import { type App, cleanUp, newSession, openApp, root, scriptedModel, until } from "./helpers.ts";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { join } from "node:path";
import { after, before, test } from "node:test";
import type { ConversationId } from "@earendil-works/pi-durable";
import { Browsers } from "../src/server/browser.ts";
import { findBrowser } from "../src/server/browser/discovery.ts";
import type { BrowserPage } from "../src/server/browser/page.ts";
import { VIEWPORTS } from "../src/server/browser/viewport.ts";
import { createHandler } from "../src/server/http.ts";

const chromium = findBrowser();
const real = {
    skip: chromium === undefined ? "no Chromium-based browser on this machine" : false,
} as const;
const DESKTOP = { width: 1440, height: 900, scale: 1, mobile: false };

let app: App;
let server: Server;
let browsers: Browsers;
let page: BrowserPage;
let base = "";
let active: ConversationId;
let kept: ConversationId;
let tucked: ConversationId;

let list = ".sidebar";
const row = (id: ConversationId) => `${list} .session-row[data-id="${id}"]`;
const ROWS = `${list} .session-row`;

async function inPage<T>(script: string): Promise<T> {
    return JSON.parse(await page.evaluate(script)) as T;
}

/** Whether the list shows that session now. */
const listed = (id: ConversationId) =>
    inPage<boolean>(
        `return JSON.stringify(document.querySelector(${JSON.stringify(row(id))}) !== null)`,
    );

/** Wait until the list shows the session, or stops showing it. */
const shows = (id: ConversationId, want: boolean, what: string) =>
    until(async () => (await listed(id)) === want, what);

const notices = () =>
    inPage<string[]>(
        `const { store } = await import("/store.js");
        return JSON.stringify(store.state.notices.map((each) => each.message));`,
    );

/** Wait until a notice says `words`. */
const noticed = (words: RegExp, what: string) =>
    until(async () => (await notices()).some((message) => words.test(message)), what);

async function selectTab(name: "Recent" | "Folders" | "Archived"): Promise<void> {
    const index = await inPage<number>(`
        const tabs = [...document.querySelectorAll(${JSON.stringify(`${list} .session-tabs [role="tab"]`)})];
        return JSON.stringify(tabs.findIndex((tab) => tab.textContent.trim() === ${JSON.stringify(name)}));
    `);

    assert.ok(index >= 0, `${name} tab exists in the current list`);
    await page.click({ selector: `${list} .session-tabs [role="tab"]:nth-of-type(${index + 1})` });
    await until(
        async () =>
            await inPage<boolean>(`
                const tab = document.querySelector(${JSON.stringify(`${list} .session-tabs [aria-selected="true"]`)});
                return JSON.stringify(tab?.textContent.trim() === ${JSON.stringify(name)});
            `),
        `${name} tab selected`,
    );
}

async function fresh(mobile = false): Promise<void> {
    list = mobile ? ".home-list" : ".sidebar";
    await page.setViewport(mobile ? VIEWPORTS.mobile : DESKTOP);
    await page.navigate(`${base}/`);
    await until(
        async () =>
            await inPage<boolean>(
                `return JSON.stringify(document.querySelector(${JSON.stringify(row(active))}) !== null)`,
            ),
        "the session list",
        20_000,
    );
    await selectTab("Recent");
    await page.hover({ x: 1, y: 1 });
}

/** A finger held on a row: down, held `ms`, and lifted with the click a lift makes. */
const finger = (id: ConversationId, { ms }: { ms: number }) =>
    inPage(`
        const button = document.querySelector(${JSON.stringify(`${row(id)} > .session`)});
        const box = button.getBoundingClientRect();
        const x = box.x + box.width / 2;
        const y = box.y + box.height / 2;
        const fire = (type) =>
            button.dispatchEvent(
                new PointerEvent(type, {
                    bubbles: true,
                    cancelable: true,
                    pointerId: 7,
                    pointerType: "touch",
                    isPrimary: true,
                    button: 0,
                    clientX: x,
                    clientY: y,
                }),
            );
        const wait = (time) => new Promise((resolve) => setTimeout(resolve, time));

        fire("pointerdown");
        await wait(${ms});
        fire("pointerup");
        for (const type of ["mousedown", "mouseup", "click"]) {
            document.elementFromPoint(x, y).dispatchEvent(
                new MouseEvent(type, { bubbles: true, cancelable: true, detail: 1, clientX: x, clientY: y }),
            );
        }

        return JSON.stringify({});
    `);

/** Tap one of the open sheet's items by its label. */
async function choose(label: string): Promise<void> {
    await page.evaluate(`
        [...document.querySelectorAll(".sheet-host:not(.leaving) .list-item")]
            .find((each) => each.firstElementChild.textContent.trim() === ${JSON.stringify(label)})
            .click();
    `);
}

/** Open one session by its address, once its conversation is there to act on. */
async function open(id: ConversationId): Promise<void> {
    await page.navigate(`${base}/s/${id}`);
    await until(
        async () =>
            await inPage<boolean>(`return JSON.stringify(
                document.querySelector(".composer textarea") !== null &&
                document.querySelector(".title-open")?.disabled === false,
            )`),
        "the session, open",
    );
}

/** The labels of the open sheet's items, top to bottom. */
const labels = () =>
    inPage<string[]>(
        `return JSON.stringify([...document.querySelectorAll(".sheet-host:not(.leaving) .list-item")]
            .map((each) => each.firstElementChild.textContent.trim()))`,
    );

/** The number of notices still showing: they sit over the top bar, and a pointer on one holds it there. */
const noticesShowing = () =>
    inPage<number>(`return JSON.stringify(document.querySelectorAll(".notice").length)`);

/** The open session menu, from the title in the top bar, with the visibility item it offers. */
async function menu(item: "Hide from lists" | "Show in lists"): Promise<void> {
    // A notice covers the title until it counts down: take the pointer off it, and wait it out, as a person would.
    await page.hover({ x: 1, y: 1 });
    await until(async () => (await noticesShowing()) === 0, "the notices to go", 12_000);
    await page.click({ selector: ".title-open" });

    let seen: string[] = [];

    try {
        await until(async () => (seen = await labels()).includes(item), "the session menu");
    } catch {
        assert.fail(`the session menu has ${JSON.stringify(seen)}`);
    }
}

const ownerOf = () => app.config.users.find((user) => user.role === "owner")!;

before(async () => {
    if (chromium === undefined) {
        return;
    }

    app = await openApp(scriptedModel());
    active = await newSession(app);
    kept = await newSession(app);
    tucked = await newSession(app);
    await app.commands.updateSession(kept, ownerOf(), { title: "Kept session", archived: true });
    await app.commands.updateSession(tucked, ownerOf(), {
        title: "Tucked session",
        archived: true,
    });
    server = createServer(
        createHandler({ app, listen: { host: "127.0.0.1", port: 0 }, restart: () => {} }),
    );
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    browsers = new Browsers({
        dataDir: mkdtempSync(join(root, "session-visibility-ui-")),
        load: async () => undefined,
        save: () => {},
        // A mouse, whatever this machine has: rows show their buttons only where a pointer can hover.
        args: [
            "--blink-settings=primaryHoverType=2,availableHoverTypes=2,primaryPointerType=4,availablePointerTypes=4",
        ],
    });
    page = await browsers.open(1);
    await page.navigate(`${base}/login?token=${encodeURIComponent(app.config.ownerToken)}`);
});

after(async () => {
    await browsers?.closeAll({ final: true });
    server?.closeAllConnections();
    server?.close();
    await app?.close();
    cleanUp();
});

test(
    "a phone hides one archived session from its row, and the notice undoes it",
    real,
    async () => {
        await fresh(true);
        await selectTab("Archived");
        await shows(tucked, true, "the archived session, before");
        await shows(kept, true, "the other archived session");

        await finger(tucked, { ms: 1000 });
        await until(
            async () =>
                await inPage<boolean>(
                    `const { store } = await import("/store.js"); return JSON.stringify(store.state.sheet?.type === "session")`,
                ),
            "the row's actions",
        );
        await choose("Hide from lists");
        await shows(tucked, false, "the hidden session, out of the archive");
        await shows(kept, true, "the other archived session stays");
        await noticed(/^Hidden “Tucked session”/, "the notice");

        await page.evaluate(`
        [...document.querySelectorAll(".notices .notice")]
            .find((each) => each.textContent.includes("Hidden"))
            .click();
    `);
        await shows(tucked, true, "shown again by the notice");
    },
);

test(
    "the desktop menu hides a session from the search, the launcher, the archive, and a reload; a link still opens it",
    real,
    async () => {
        await fresh(false);
        await selectTab("Archived");
        await shows(tucked, true, "the archived session, before");

        // Its search finds it, as it did.
        await page.type({ selector: `${list} .search input` }, "Tucked");
        await until(
            async () =>
                (await inPage<number>(
                    `return JSON.stringify(document.querySelectorAll(${JSON.stringify(ROWS)}).length)`,
                )) === 1,
            "the search's one match",
        );
        await page.type({ selector: `${list} .search input` }, "");

        await page.navigate(`${base}/s/${tucked}`);
        await until(
            async () =>
                await inPage<boolean>(
                    `return JSON.stringify(document.querySelector(".composer textarea") !== null)`,
                ),
            "the session, open",
        );
        await menu("Hide from lists");
        await choose("Hide from lists");
        await noticed(/^Hidden “Tucked session”/, "the notice");

        // Out of the archive, and out of the search.
        await fresh(false);
        await selectTab("Archived");
        await shows(tucked, false, "the hidden session, out of the archive");
        await shows(kept, true, "the other archived session stays");
        await page.type({ selector: `${list} .search input` }, "Tucked");
        await until(
            async () =>
                (await inPage<number>(
                    `return JSON.stringify(document.querySelectorAll(${JSON.stringify(ROWS)}).length)`,
                )) === 0,
            "no match for the hidden session",
        );
        await page.type({ selector: `${list} .search input` }, "");

        // Nor does the launcher offer it, while the other archived one is there.
        await page.press("Control+K");
        await until(
            async () =>
                await inPage<boolean>(
                    `return JSON.stringify(document.querySelector(".launcher input") !== null)`,
                ),
            "the launcher",
        );
        await page.type({ selector: ".launcher input" }, "session");
        await until(async () => {
            const found = await inPage<string[]>(
                `return JSON.stringify([...document.querySelectorAll(".launcher-item")].map((each) => each.textContent))`,
            );

            return found.some((text) => text.includes("Kept session")) && found.length > 0;
        }, "the launcher's results");
        assert.deepEqual(
            await inPage<string[]>(
                `return JSON.stringify([...document.querySelectorAll(".launcher-item")]
                .map((each) => each.textContent).filter((text) => text.includes("Tucked session")))`,
            ),
            [],
            "no launcher result for the hidden session",
        );
        await page.press("Escape");

        // A reload keeps it hidden, and a direct link still opens it, with its history.
        await fresh(false);
        await selectTab("Archived");
        await shows(tucked, false, "still hidden after a reload");
        await page.navigate(`${base}/s/${tucked}`);
        await until(
            async () =>
                await inPage<boolean>(
                    `return JSON.stringify(document.querySelector(".title-main")?.textContent.includes("Tucked session") === true)`,
                ),
            "the hidden session, open from its link",
        );

        // The menu shows it in the lists again: back in the archive, where it was.
        await menu("Show in lists");
        await choose("Show in lists");
        await noticed(/^Shown “Tucked session”/, "the notice");
        await fresh(false);
        await selectTab("Archived");
        await shows(tucked, true, "back in the archive");
        await shows(kept, true, "with the other archived session");
    },
);

test("a refused Show or Undo says so and changes nothing, and the retry works", real, async () => {
    await fresh(false);
    await selectTab("Archived");
    await shows(kept, true, "the archived session");

    // The server refuses every session change, as one would when it is down or the person lost the right.
    const refuse = () =>
        page.evaluate(`
            const { actions } = await import("/store.js");
            window.__updateSession ??= actions.updateSession;
            actions.updateSession = () => Promise.reject(new Error("the server said no"));
            return JSON.stringify({});
        `);
    const allow = () =>
        page.evaluate(`
            const { actions } = await import("/store.js");
            actions.updateSession = window.__updateSession;
            return JSON.stringify({});
        `);

    await open(kept);
    await menu("Hide from lists");
    await choose("Hide from lists");
    await noticed(/^Hidden “Kept session”/, "the notice");

    // A refused Show: the error shows, and nothing claims it worked.
    const beforeShow = await notices();

    await refuse();
    await menu("Show in lists");
    await choose("Show in lists");
    await noticed(/^the server said no$/, "the refused Show");
    assert.deepEqual(
        (await notices()).filter(
            (message) => !beforeShow.includes(message) && /^Shown/.test(message),
        ),
        [],
        "no false success notice",
    );
    await fresh(false);
    await selectTab("Archived");
    await shows(kept, false, "still hidden after the refused Show");

    // The retry, with the server back, shows it again.
    await allow();
    await open(kept);
    await menu("Show in lists");
    await choose("Show in lists");
    await noticed(/^Shown “Kept session”/, "the retried Show");

    // A refused undo of a hide: the notice's action says why, and the retry works.
    await menu("Hide from lists");
    await choose("Hide from lists");
    await noticed(/^Hidden “Kept session”/, "the second notice");
    const beforeUndo = await notices();

    await refuse();
    await page.evaluate(`
        const { store } = await import("/store.js");
        [...store.state.notices]
            .reverse()
            .find((each) => /^Hidden/.test(each.message) && each.action)
            .action();
        return JSON.stringify({});
    `);
    await noticed(/^the server said no$/, "the refused undo");
    assert.deepEqual(
        (await notices()).filter(
            (message) => !beforeUndo.includes(message) && /^Shown/.test(message),
        ),
        [],
        "no false success notice for the refused undo",
    );
    await fresh(false);
    await selectTab("Archived");
    await shows(kept, false, "still hidden after the refused undo");

    await allow();
    await open(kept);
    await menu("Show in lists");
    await choose("Show in lists");
    await noticed(/^Shown “Kept session”/, "the retried undo");
    await fresh(false);
    await selectTab("Archived");
    await shows(kept, true, "back in the archive");
});

test(
    "an older server offers no Hide or Show, and never reports a Hide it did not do",
    real,
    async () => {
        // Web files reload at once; core server files wait for a restart. An older server ignores `hidden` and answers
        // 200, so the web app waits for the capability in its hello before it offers or sends it.
        const capability = (present: boolean) =>
            inPage<{ said: boolean | null }>(`
            const { store } = await import("/store.js");
            const server = { ...store.state.server };

            if (${present}) {
                server.sessionHiding = true;
            } else {
                delete server.sessionHiding;
            }

            store.set({ server });
            return JSON.stringify({ said: store.state.server.sessionHiding ?? null });
        `);

        /** The labels of the session menu, opened from the title, then closed with Escape. */
        const menuLabels = async (): Promise<string[]> => {
            await page.hover({ x: 1, y: 1 });
            await until(async () => (await noticesShowing()) === 0, "the notices to go", 12_000);
            await page.click({ selector: ".title-open" });
            await until(async () => (await labels()).length > 0, "the session menu");
            const seen = await labels();

            await page.press("Escape");
            await until(async () => (await labels()).length === 0, "the menu to close");

            return seen;
        };

        await fresh(false);
        await selectTab("Archived");
        await shows(kept, true, "the archived session");
        await open(kept);
        assert.equal(
            (await capability(false)).said,
            null,
            "a server that does not say it stores hidden sessions",
        );

        // The desktop menu offers neither control.
        const desktop = await menuLabels();

        assert.ok(!desktop.includes("Hide from lists") && !desktop.includes("Show in lists"));
        assert.ok(desktop.includes("Unarchive"), "the rest of the menu is there");

        // Nor does the sheet a finger held on a row opens. The page loaded the server's hello again, so the older
        // handshake is put back first.
        await fresh(true);
        await selectTab("Archived");
        await capability(false);
        await finger(kept, { ms: 1000 });
        await until(async () => (await labels()).length > 0, "the row's actions");
        const row = await labels();

        assert.ok(!row.includes("Hide from lists") && !row.includes("Show in lists"));
        await page.press("Escape");

        // The exported operation refuses, sends nothing, and claims nothing.
        const before = await notices();
        const refused = await inPage<{ calls: number }>(`
        const { actions } = await import("/store.js");
        window.__updateSession ??= actions.updateSession;
        window.__calls = 0;
        actions.updateSession = (...args) => {
            window.__calls += 1;
            return window.__updateSession(...args);
        };
        const { setHidden } = await import("/sessions.js");

        await setHidden(${Number(kept)}, true);
        actions.updateSession = window.__updateSession;

        return JSON.stringify({ calls: window.__calls });
    `);

        assert.equal(refused.calls, 0, "no change was sent to the server");
        await noticed(/restart/i, "the restart the operation asks for");
        assert.deepEqual(
            (await notices()).filter(
                (message) => !before.includes(message) && /^(Hidden|Shown)/.test(message),
            ),
            [],
            "no success notice for a Hide that did not happen",
        );
        await fresh(false);
        await selectTab("Archived");
        await shows(kept, true, "still in the lists");

        // With the capability, the controls and the operation work.
        assert.equal((await capability(true)).said, true, "a server that stores hidden sessions");
        await open(kept);
        await menu("Hide from lists");
        await choose("Hide from lists");
        await noticed(/^Hidden “Kept session”/, "the notice");
        await fresh(false);
        await selectTab("Archived");
        await shows(kept, false, "hidden after the restart");

        await open(kept);
        await menu("Show in lists");
        await choose("Show in lists");
        await fresh(false);
        await selectTab("Archived");
        await shows(kept, true, "back in the archive");
    },
);
