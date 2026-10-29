// Hiding a session from the lists (`SessionMeta.hidden`): it leaves every session list, keeps its data, folder,
// title, and archive status, and comes back when it is shown again — over HTTP too, where the checks apply.
import {
    type App,
    cleanUp,
    fakeTab,
    modelTexts,
    newSession,
    openApp,
    owner,
    root,
    say,
    scriptedModel,
    until,
} from "./helpers.ts";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { join } from "node:path";
import { after, before, test } from "node:test";
import type { ConversationId } from "@earendil-works/pi-durable";
import type { User } from "../src/server/config.ts";
import { createHandler } from "../src/server/http.ts";

let app: App;
let server: Server;
let base = "";
let kept: ConversationId;
let tucked: ConversationId;
const people: Record<string, { token: string; user: User }> = {};

const ids = (list: { id: number }[]) => list.map((each) => each.id).sort((a, b) => a - b);

async function call(who: string, path: string, body?: unknown) {
    const response = await fetch(`${base}${path}`, {
        method: body === undefined ? "GET" : "POST",
        headers: {
            authorization: `Bearer ${people[who]!.token}`,
            "x-pocket": "1",
            ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });

    return { status: response.status, data: (await response.json()) as Record<string, unknown> };
}

before(async () => {
    app = await openApp(scriptedModel());
    server = createServer(
        createHandler({ app, listen: { host: "127.0.0.1", port: 0 }, restart: () => {} }),
    );
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;

    kept = await newSession(app);
    tucked = await newSession(app);
    await say(app, kept, "kept words");
    await say(app, tucked, "tucked words");
    await app.commands.updateSession(tucked, owner(app), { title: "Tucked away", archived: true });

    for (const [name, role, sessions] of [
        ["Gale", "guest", undefined],
        ["Sid", "guest", [String(kept), String(tucked)]],
        ["Vic", "viewer", undefined],
    ] as const) {
        const added = app.config.addUser(name, role, sessions ? [...sessions] : undefined);

        people[name] = { token: added.token, user: added.user };
    }

    people.owner = { token: app.config.ownerToken, user: owner(app) };
});

after(async () => {
    server?.closeAllConnections();
    server?.close();
    await app?.close();
    cleanUp();
});

test("hiding a session takes it out of every list, and keeps its data, folder, title, and archive status", async () => {
    await app.commands.updateSession(tucked, owner(app), { hidden: true });

    assert.deepEqual(ids(app.sessions()), [Number(kept)], "the owner's list");
    assert.deepEqual(ids(app.sessions(people.Gale!.user)), [Number(kept)], "a guest's list");
    assert.deepEqual(
        ids(app.sessions(people.Sid!.user)),
        [Number(kept)],
        "the list of someone invited to both sessions",
    );

    const meta = app.sessionMeta(tucked)!;

    assert.equal(meta.hidden, true);
    assert.equal(meta.archived, true, "hiding leaves the archive status alone");
    assert.equal(meta.title, "Tucked away");
    const entries = await app.transcripts.allEntries(tucked, true);

    assert.ok(JSON.stringify(entries).includes("tucked words"), "its messages stay");

    // A direct link still opens it, with its history and its own view of itself.
    const history = await call("owner", `/api/c/${tucked}/history`);

    assert.equal(history.status, 200);
    assert.match(JSON.stringify(history.data), /tucked words/, "the history comes back in full");
    const tab = fakeTab(tucked, people.owner!.user);

    await app.attach(tab.client);
    await until(() => tab.field("conversation") !== undefined, "the session's view");
    const conversation = tab.field("conversation") as { hidden?: boolean; archived?: boolean };

    app.detach(tab.client);
    assert.equal(conversation.hidden, true);
    assert.equal(conversation.archived, true, "PiP's views, and the menu, read the same field");
});

test("showing a hidden session puts it back in the lists, still archived", async () => {
    await app.commands.updateSession(tucked, owner(app), { hidden: false });

    const listed = app.sessions().find((each) => each.id === Number(tucked));

    assert.ok(listed, "back in the owner's list");
    assert.equal(listed.archived, true, "and still in the archive");
    assert.equal(app.sessionMeta(tucked)?.title, "Tucked away");
    assert.equal(app.sessions(people.Gale!.user).length, 2, "a guest sees it again too");
});

test("hidden must be true or false, and only someone who may steer a session they can see changes it", async () => {
    const refusedType = await call("owner", `/api/sessions/${tucked}`, { hidden: "yes" });

    assert.equal(refusedType.status, 400);
    assert.match(String(refusedType.data.error), /hidden must be true or false/);
    assert.equal(
        (await call("Vic", `/api/sessions/${tucked}`, { hidden: true })).status,
        403,
        "a viewer cannot hide it",
    );
    assert.equal(
        (await call("Sid", `/api/sessions/${kept}`, { hidden: true })).status,
        200,
        "someone invited to it can",
    );
    await call("Sid", `/api/sessions/${kept}`, { hidden: false });

    const stranger = app.config.addUser("Una", "guest", ["1"]);

    people.Una = { token: stranger.token, user: stranger.user };

    try {
        assert.equal(
            (await call("Una", `/api/sessions/${tucked}`, { hidden: true })).status,
            404,
            "a session that is not shared with her is not hers to hide",
        );
    } finally {
        delete people.Una;
        app.config.removeUser(stranger.user.id);
    }

    // Nothing of the refused changes was stored.
    assert.equal(app.sessionMeta(tucked)?.hidden, false);
    assert.deepEqual(
        ids(app.sessions()),
        [Number(kept), Number(tucked)].sort((a, b) => a - b),
    );
});

test("hiding the session under a linked one leaves the linked session in the list", async () => {
    const source = await newSession(app);

    await say(app, source, "hello");
    const { session: linked } = await app.linkedSessions.start(
        source,
        { title: "Linked work", message: "a task" },
        crypto.randomUUID(),
    );

    await app.commands.updateSession(source, owner(app), { hidden: true });

    const listed = ids(app.sessions());

    assert.equal(listed.includes(Number(source)), false, "the one that was hidden");
    assert.equal(listed.includes(Number(linked)), true, "the linked session stays");
    assert.equal(app.sessionMeta(linked)?.hidden, undefined);
    assert.deepEqual(app.sessionMeta(linked)?.linkedFrom, { id: Number(source) });
    assert.equal(app.canSee(people.owner!.user, linked), true);
});

test("a hidden session stays hidden after the store closes and opens again, and shows again from there", async () => {
    const dataDir = join(root, "visibility-persistence");
    const first = await openApp(scriptedModel(), dataDir);
    let id: ConversationId | undefined;

    try {
        id = await newSession(first);
        await first.commands.updateSession(id, owner(first), { archived: true, hidden: true });
        assert.deepEqual(ids(first.sessions()), [], "hidden from the list");
    } finally {
        await first.close();
    }

    const again = await openApp(scriptedModel(), dataDir);

    try {
        assert.equal(
            again.sessionMeta(id!)?.hidden,
            true,
            "the flag is stored, not kept in memory",
        );
        assert.deepEqual(ids(again.sessions()), [], "still out of the list");

        await again.commands.updateSession(id!, owner(again), { hidden: false });
        const listed = again.sessions().find((each) => each.id === Number(id));

        assert.equal(listed?.archived, true, "shown again, back in the archive as it was");
        assert.equal(listed?.hidden, false);
    } finally {
        await again.close();
    }
});

test("a session-scoped invite and a tag write still admit a hidden session, while the lists leave it out", async () => {
    await app.setExtensionEnabled(owner(app), "session-tags.ts", true);
    await app.commands.updateSession(tucked, owner(app), { hidden: true });

    const invite = await call("owner", "/api/invite", {
        role: "guest",
        session: Number(tucked),
    });

    assert.equal(invite.status, 200, "an invite for the session itself");
    assert.deepEqual((invite.data as { grant?: unknown }).grant, {
        role: "guest",
        session: String(tucked),
    });

    const tagged = await call("owner", "/api/x/session-tags/tags", {
        ids: [Number(tucked)],
        add: ["kept"],
    });

    assert.equal(tagged.status, 200, "a tag write on the session itself");
    assert.deepEqual(
        (await call("owner", "/api/x/session-tags/tags")).data.tags,
        {},
        "the extension's default listing omits it",
    );

    // The tag was stored: shown again, the listing has it.
    await app.commands.updateSession(tucked, owner(app), { hidden: false });
    assert.deepEqual((await call("owner", "/api/x/session-tags/tags")).data.tags, {
        [String(tucked)]: ["kept"],
    });
});

test("a linked session still replies to its hidden parent", async () => {
    const parent = await newSession(app);

    await say(app, parent, "hello");
    const { session: child } = await app.linkedSessions.start(
        parent,
        { title: "Child", message: "a first task" },
        crypto.randomUUID(),
    );
    const [origin] = await app.linkedSessions.list(child);

    assert.ok(origin?.address, "the child knows its parent before it is hidden");
    await app.commands.updateSession(parent, owner(app), { hidden: true });

    assert.deepEqual(
        await app.linkedSessions.list(child),
        [],
        "its list leaves the hidden parent out",
    );
    await app.linkedSessions.send(
        child,
        { to: origin!.address, message: "a reply to the hidden parent" },
        crypto.randomUUID(),
    );
    await until(
        async () =>
            (await modelTexts(app, parent)).some((text) =>
                text.includes("a reply to the hidden parent"),
            ),
        "the reply to reach the hidden parent",
    );
    await app.commands.updateSession(parent, owner(app), { hidden: false });
});

test("a hidden relative stays connected to the visible ones through their parent", async () => {
    const parent = await newSession(app);

    await say(app, parent, "hello");
    await app.linkedSessions.start(
        parent,
        { title: "Hidden worker", message: "a first task" },
        crypto.randomUUID(),
    );
    const { session: shown } = await app.linkedSessions.start(
        parent,
        { title: "Shown worker", message: "a second task" },
        crypto.randomUUID(),
    );

    // Each session saves the addresses it may write to, so the shown worker learns its sibling's while both show.
    const sibling = (await app.linkedSessions.list(shown)).find(
        (each) => each.title === "Hidden worker",
    );

    assert.ok(sibling?.address, "the shown worker knows the other session of the same parent");
    const hiddenId = Number(
        Object.entries(app.sessionCatalogue()).find(
            ([, meta]) => meta.title === "Hidden worker",
        )![0],
    ) as unknown as ConversationId;

    await app.commands.updateSession(hiddenId, owner(app), { hidden: true });
    await app.linkedSessions.send(
        shown,
        { to: sibling!.address, message: "a message through the parent" },
        crypto.randomUUID(),
    );
    await until(
        async () =>
            (await modelTexts(app, hiddenId)).some((text) =>
                text.includes("a message through the parent"),
            ),
        "the message to reach the hidden session",
    );
    await app.commands.updateSession(hiddenId, owner(app), { hidden: false });
});

test("hiding the parent keeps its visible children connected to each other", async () => {
    const parent = await newSession(app);

    await say(app, parent, "hello");
    const { session: first } = await app.linkedSessions.start(
        parent,
        { title: "First child", message: "a first task" },
        crypto.randomUUID(),
    );
    const { session: second } = await app.linkedSessions.start(
        parent,
        { title: "Second child", message: "a second task" },
        crypto.randomUUID(),
    );

    // While the parent connects them, the children save each other's addresses.
    const sibling = (await app.linkedSessions.list(first)).find(
        (each) => each.title === "Second child",
    );

    assert.ok(sibling?.address, "the first child knows the second while their parent shows");
    await app.commands.updateSession(parent, owner(app), { hidden: true });

    assert.equal(
        ids(app.sessions()).includes(Number(parent)),
        false,
        "the hidden parent stays out of the lists",
    );
    assert.deepEqual(
        (await app.linkedSessions.list(first)).map((each) => each.title),
        ["Second child"],
        "the first child still lists the second, through the hidden parent",
    );

    await app.linkedSessions.send(
        first,
        { to: sibling!.address, message: "a message through the hidden parent" },
        crypto.randomUUID(),
    );
    await until(
        async () =>
            (await modelTexts(app, second)).some((text) =>
                text.includes("a message through the hidden parent"),
            ),
        "the message to reach the second child",
    );
    await app.commands.updateSession(parent, owner(app), { hidden: false });
});
