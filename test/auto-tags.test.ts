// Automatic session tags: after a session's first answer, its own model names 1–3 tags once. The tests cover the
// prompt and its cleaning, the run that writes the tags, manual tags that win, the extension being off, a reply that
// is no tags, a first run without an answer, a spend hold, a cut-off attempt, another conversation's run, and the
// `session.tagged` event.
import {
    type App,
    cleanUp,
    context,
    lastText,
    newSession,
    openApp,
    owner,
    root,
    say,
    scriptedModel,
    until,
} from "./helpers.ts";
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import type { FauxResponseStep, Usage } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxText } from "@earendil-works/pi-ai/providers/faux";
import { type ConversationId, UsageDoc } from "@earendil-works/pi-durable";
import { AutoTagsDoc, SessionTagsDoc } from "../src/server/docs.ts";
import { cleanTags, TAG_PROMPT } from "../src/server/auto-tags.ts";
import { TITLE_PROMPT } from "../src/server/titles.ts";

let app: App;
let tagPrompts = 0;
let tagReply = '{"tags":["Deploy","CI-Fix","third","fourth"]}';
let failAnswer = false;

/** Names sessions and tags them when asked to; everything else is one short answer, or an error once. */
const route: FauxResponseStep = (request) => {
    const { text } = lastText(request as never);

    if (text.startsWith(TITLE_PROMPT)) {
        return fauxAssistantMessage([fauxText("A Written Title")]);
    }

    if (text.startsWith(TAG_PROMPT)) {
        tagPrompts += 1;

        return fauxAssistantMessage([fauxText(tagReply)]);
    }

    if (failAnswer) {
        failAnswer = false;

        return fauxAssistantMessage([], { stopReason: "error", errorMessage: "boom" });
    }

    return fauxAssistantMessage([
        fauxText("The deploy pipeline fails on a test that reads the old config."),
    ]);
};

const snapshot = (id: ConversationId) => app.harness.snapshot(AutoTagsDoc, context);
const tagsOf = async (id: ConversationId) =>
    (await app.harness.snapshot(SessionTagsDoc, context))?.tags[String(id)] ?? [];
const triedOf = async (id: ConversationId) => (await snapshot(id))?.tried[String(id)];
const startedOf = async (id: ConversationId) => (await snapshot(id))?.started[String(id)];
const tokensOf = async (id: ConversationId, model = "faux/faux-1") =>
    (await app.harness.snapshot(UsageDoc, id, context))?.models[model]?.totalTokens ?? 0;

/** After the run's event was sent: the listeners it queues have run. */
const settled = () => new Promise<void>((resolve) => setImmediate(resolve));

before(async () => {
    app = await openApp(scriptedModel(route), `${root}/auto-tags-data`);
    await app.setExtensionEnabled(owner(app), "session-tags.ts", true);
});

after(async () => {
    await app?.close();
    cleanUp();
});

test("clean tags: JSON, lowercase, three at most, with reasoning and generic words left out", () => {
    assert.deepEqual(cleanTags('{"tags":["Deploy","CI-Fix","third","fourth"]}'), [
        "deploy",
        "ci-fix",
        "third",
    ]);
    assert.deepEqual(cleanTags('```json\n{"tags":["#Go Tests","code","session"]}\n```'), [
        "go tests",
    ]);
    assert.deepEqual(cleanTags('<think>{"tags":["wrong"]}</think>\n{"tags":["ok"]}'), ["ok"]);
    assert.deepEqual(cleanTags('{"tags":["a tag that is far too long for any session list"]}'), []);
    assert.deepEqual(cleanTags("I could not decide."), []);
    assert.deepEqual(cleanTags('{"tags":"deploy"}'), []);
    assert.deepEqual(cleanTags('{"tags":["Deploy","deploy","DEPLOY"]}'), ["deploy"]);
    assert.deepEqual(cleanTags('{"tags":["two\\u0000"]}'), []);
    assert.deepEqual(cleanTags(`{"tags":["${"a".repeat(24)}"]}`), ["a".repeat(24)]);
    assert.deepEqual(cleanTags(`{"tags":["${"b".repeat(25)}"]}`), []);
    assert.deepEqual(cleanTags('{"tags":["dep'), []);
});

test("after the first answer the session's model writes tags once, and the event says so", async () => {
    const id = await newSession(app);
    const seen: { conversationId: number; tags: readonly string[] }[] = [];
    const stop = app.events.on("session.tagged", (data) => {
        seen.push(data as { conversationId: number; tags: readonly string[] });
    });

    try {
        await say(app, id, "the deploy pipeline fails on main");
        await until(async () => (await tagsOf(id)).length > 0, "the tags");

        assert.deepEqual(await tagsOf(id), ["ci-fix", "deploy", "third"]);
        assert.equal(typeof (await triedOf(id)), "number", "the session is marked as tagged");
        assert.equal(await startedOf(id), undefined);
        assert.equal(tagPrompts, 1);
        await until(() => seen.length > 0, "the session.tagged event");
        await settled();
        assert.equal(seen.length, 1);
        assert.equal(seen[0]!.conversationId, Number(id));
        assert.deepEqual(seen[0]!.tags, ["ci-fix", "deploy", "third"]);

        // A second answer does not ask again.
        await say(app, id, "and the test reads the old config");
        await settled();
        assert.equal(tagPrompts, 1);
    } finally {
        stop();
    }
});

test("the tag call uses the session's model, counts its usage, and tags made meanwhile win", async () => {
    const id = await newSession(app);

    // A name someone gave first: the title call does not run, so the tag's usage is the only one after the answer.
    await app.commands.updateSession(id, owner(app), { title: "Named first" });
    await app.commands.configure(id, owner(app), {
        model: { provider: "faux", modelId: "faux-2" },
    });

    const complete = app.models.completeSimple;
    const waiting: (() => void)[] = [];
    let asked: (() => void) | undefined;
    const tagAsked = new Promise<void>((resolve) => {
        asked = resolve;
    });
    let tagModel = "";
    let tagUsage: Usage | undefined;

    app.models.completeSimple = async function (...args) {
        const [model, request] = args;
        const first = request.messages[0]?.content[0] as
            | { type: string; text?: string }
            | undefined;

        if (first?.type === "text" && first.text?.startsWith(TAG_PROMPT)) {
            tagModel = `${model.provider}/${model.id}`;
            asked?.();
            await new Promise<void>((resolve) => waiting.push(resolve));
            const reply = await complete.apply(app.models, args);

            tagUsage = reply.usage;

            return reply;
        }

        return complete.apply(app.models, args);
    } as typeof complete;

    const seen: unknown[] = [];
    const stop = app.events.on("session.tagged", (data) => seen.push(data));

    try {
        await say(app, id, "the deploy pipeline fails on main");
        await tagAsked;

        const before = await tokensOf(id, "faux/faux-2");

        // A second look while the first is in flight asks once.
        await app.autoTags.maybeTag(id, id);
        // Someone tags it while the model is still answering: their tags win.
        await app.sessionTags.change({ ids: [Number(id)], add: ["manual"], remove: [] });
        waiting.splice(0).forEach((resolve) => resolve());
        await until(async () => (await triedOf(id)) !== undefined, "the marker");

        const after = await tokensOf(id, "faux/faux-2");

        assert.equal(tagModel, "faux/faux-2");
        assert.equal(
            after - before,
            tagUsage!.totalTokens,
            "the tag call's usage is in the ledger",
        );
        assert.deepEqual(await tagsOf(id), ["manual"]);
        assert.equal(await startedOf(id), undefined);
        assert.equal(seen.length, 0, "no tags were written by the model");
    } finally {
        app.models.completeSimple = complete;
        stop();
    }
});

test("tags someone already put on the session win, and no model is asked", async () => {
    const id = await newSession(app);
    const before = tagPrompts;

    await app.sessionTags.change({ ids: [Number(id)], add: ["manual"], remove: [] });
    await say(app, id, "this session is about the deploy pipeline");
    await until(async () => (await triedOf(id)) !== undefined, "the session to be marked");

    assert.deepEqual(await tagsOf(id), ["manual"]);
    assert.equal(await startedOf(id), undefined);
    assert.equal(tagPrompts, before);
});

test("with Session tags off, nothing is asked and no tags are written", async () => {
    await app.setExtensionEnabled(owner(app), "session-tags.ts", false);

    try {
        const id = await newSession(app);
        const before = tagPrompts;

        await say(app, id, "this session is about the deploy pipeline");
        await settled();

        assert.equal(tagPrompts, before);
        assert.deepEqual(await tagsOf(id), []);
        assert.equal(await triedOf(id), undefined);
    } finally {
        await app.setExtensionEnabled(owner(app), "session-tags.ts", true);
    }
});

test("a reply that is no tags marks the session, so the model is not asked again", async () => {
    tagReply = "The user wants tags, but I will answer in prose instead.";
    const before = tagPrompts;
    const id = await newSession(app);

    try {
        await say(app, id, "the deploy pipeline fails on main");
        await until(async () => (await triedOf(id)) !== undefined, "the session to be marked");
        assert.deepEqual(await tagsOf(id), []);
        assert.equal(await startedOf(id), undefined);

        await say(app, id, "please look again");
        await settled();
        assert.equal(tagPrompts, before + 1, "asked once, in prose, and not again");
    } finally {
        tagReply = '{"tags":["Deploy","CI-Fix","third","fourth"]}';
    }
});

test("a first run without an answer leaves the session for the next run", async () => {
    await app.setExtensionEnabled(owner(app), "session-tags.ts", false);
    const before = tagPrompts;
    const id = await newSession(app);

    try {
        failAnswer = true;
        await say(app, id, "the deploy pipeline fails on main").catch(() => {});
        await app.setExtensionEnabled(owner(app), "session-tags.ts", true);

        // Nothing to tag yet: no marker, so the next answer may still ask.
        await app.autoTags.maybeTag(id, id);
        assert.equal(tagPrompts, before);
        assert.equal(await triedOf(id), undefined);

        await say(app, id, "please try again");
        await until(async () => (await tagsOf(id)).length > 0, "the tags after the next run");
        assert.equal(tagPrompts, before + 1);
    } finally {
        failAnswer = false;
        await app.setExtensionEnabled(owner(app), "session-tags.ts", true);
    }
});

test("a spend hold stops the tag call, and the hold being raised lets it go", async () => {
    await app.setExtensionEnabled(owner(app), "session-tags.ts", false);
    const before = tagPrompts;
    const id = await newSession(app);

    try {
        await say(app, id, "the deploy pipeline fails on main");
        await app.setExtensionEnabled(owner(app), "session-tags.ts", true);
        await app.spend.setSessionBudget(owner(app), id, 0.001);

        await app.autoTags.maybeTag(id, id);
        assert.equal(tagPrompts, before);
        assert.equal(await triedOf(id), undefined);

        await app.spend.setSessionBudget(owner(app), id, null);
        await app.autoTags.maybeTag(id, id);
        await until(async () => (await tagsOf(id)).length > 0, "the tags after the hold");
    } finally {
        await app.spend.setSessionBudget(owner(app), id, null);
        await app.setExtensionEnabled(owner(app), "session-tags.ts", true);
    }
});

test("an attempt a restart cut off is not paid for again", async () => {
    const id = await newSession(app);
    const before = tagPrompts;

    // A restart after the request left its start behind, without the answer or the usage.
    await app.harness.commit(async (tx) => {
        (await tx.doc(AutoTagsDoc)).started[String(id)] = Date.now();
    }, context);

    await app.autoTags.maybeTag(id, id);

    assert.equal(tagPrompts, before);
    assert.equal(typeof (await triedOf(id)), "number");
    assert.equal(await startedOf(id), undefined);
});

test("a run of another conversation, such as a subagent's, is not the session's", async () => {
    const id = await newSession(app);
    const before = tagPrompts;

    await app.autoTags.maybeTag((Number(id) + 1) as ConversationId, id);

    assert.equal(tagPrompts, before);
    assert.equal(await triedOf(id), undefined);
});
