/**
 * Automatic session tags: after a session's first answer, its own model names 1–3 topics once. A session that already
 * has tags, someone's own or an extension's, is left as it is. The call counts as the session's spend, like the title's,
 * and never waits for a limit. An attempt is marked before the request goes out: a restart after the provider took it
 * does not pay again, though that answer and its usage are lost. The Session tags extension shows the tags;
 * `session.tagged` tells it to look again.
 */
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { AssistantMessage, Usage } from "@earendil-works/pi-ai";
import { type ConversationId, UsageDoc } from "@earendil-works/pi-durable";
import type { PocketApp } from "./app.ts";
import { AutoTagsDoc, SessionTagsDoc } from "./docs.ts";
import { describe } from "./errors.ts";
import { noWait } from "./limit-gate.ts";
import type { ClientEntry } from "./projection.ts";
import { addUsage, providerSessionId, withoutReasoning } from "./titles.ts";

const context = BACKGROUND_CONTEXT;
const SESSION_TAGS = "session-tags.ts";
const MAX_TAGS = 3;
const MAX_TAG_LENGTH = 24;
const MAX_TAG_WORDS = 2;
const READ_CHARS = 3000;

/** Words that name no topic: a session tagged with one is not easier to find, and they crowd out the useful ones. */
const GENERIC = new Set([
    "chat",
    "code",
    "coding",
    "conversation",
    "development",
    "general",
    "help",
    "programming",
    "project",
    "question",
    "session",
    "task",
    "work",
]);

/** What the model is asked, before the first message and Pi's reply. */
export const TAG_PROMPT =
    'You name the topics of chat sessions. Read the first message and Pi\'s reply below. Reply with JSON only, like {"tags":["deploy","ci-fix"]}: 1 to 3 tags. Each tag is 1 or 2 lowercase words, at most 24 characters, in English, and names the topic or the kind of work. Do not name the format, a tool, or a generic word such as "code", "chat", "question", or "task".';

/** One model reply as tags: the first JSON object's `tags`, cleaned and at most three. */
export function cleanTags(reply: string): string[] {
    const text = withoutReasoning(reply);
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");

    if (start < 0 || end <= start) {
        return [];
    }

    let parsed: unknown;

    try {
        parsed = JSON.parse(text.slice(start, end + 1));
    } catch {
        return [];
    }

    const list = (parsed as { tags?: unknown } | null)?.tags;

    if (!Array.isArray(list)) {
        return [];
    }

    const out: string[] = [];

    for (const item of list) {
        if (typeof item !== "string") {
            continue;
        }

        const name = item
            .normalize("NFC")
            .toLowerCase()
            .trim()
            .replace(/\s+/g, " ")
            .replace(/^["'‘“*#`\s]+|["'’”,.;:!?*`\s]+$/g, "");

        if (
            name === "" ||
            [...name].length > MAX_TAG_LENGTH ||
            name.split(" ").length > MAX_TAG_WORDS ||
            GENERIC.has(name) ||
            /[\p{Cc}\p{Bidi_Control}\u2028\u2029]/u.test(name) ||
            out.includes(name)
        ) {
            continue;
        }

        out.push(name);

        if (out.length === MAX_TAGS) {
            break;
        }
    }

    return out;
}

/** An answer's words, from the text blocks of its entry. */
function answerText(entry: ClientEntry): string {
    return entry.kind === "assistant"
        ? entry.blocks.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("")
        : "";
}

export class AutoTags {
    readonly #app: PocketApp;
    /** Sessions whose tags are being looked at now, so two runs that end together ask once. */
    readonly #busy = new Set<number>();

    constructor(app: PocketApp) {
        this.#app = app;
    }

    /**
     * Pi stopped working in `conversationId`: when that is a session's own run, and the session has no tags yet and was
     * never looked at, ask its model for some. A subagent's run is not the session's, and the Session tags extension
     * being off means nobody would see the tags.
     */
    async maybeTag(conversationId: ConversationId, session: ConversationId): Promise<void> {
        const id = Number(session);

        if (conversationId !== session || !this.#app.loader.enabled(SESSION_TAGS)) {
            return;
        }

        const meta = this.#app.sessionMeta(session);

        // PiP's conversation is in the catalogue but not the session list, and sends no run events. Anything else
        // without an entry is a conversation the app does not tag.
        if (meta === undefined || meta.pip !== undefined || this.#busy.has(id)) {
            return;
        }

        this.#busy.add(id);

        try {
            await this.#look(id);
        } catch (error) {
            this.#app.log(`no tags for session ${String(id)}: ${describe(error)}`);
        } finally {
            this.#busy.delete(id);
        }
    }

    async #look(id: number): Promise<void> {
        const marker = await this.#app.harness.snapshot(AutoTagsDoc, context);

        if (marker?.tried[String(id)] !== undefined) {
            return;
        }

        // A server stopped after an attempt began: the provider may have taken the request. Do not pay again.
        if (marker?.started[String(id)] !== undefined) {
            await this.#mark(id);

            return;
        }

        // Someone tagged it already, or another extension did: tags are theirs, not the model's to add to.
        if ((await this.#app.sessionTags.of(id)).length > 0) {
            await this.#mark(id);

            return;
        }

        const session = id as ConversationId;

        // A title also costs money: when the session's spend is held back, neither goes out.
        if (this.#app.spend.heldBack(session) !== undefined) {
            return;
        }

        const agent = await this.#app.agentState(session);
        const model =
            agent?.model === undefined
                ? undefined
                : this.#app.models.getModel(agent.model.provider, agent.model.modelId);

        if (model === undefined) {
            return;
        }

        const entries = await this.#app.transcripts.allEntries(session, true);
        const first = entries.find(
            (entry): entry is Extract<ClientEntry, { kind: "user" }> =>
                entry.kind === "user" && entry.text.trim() !== "",
        );
        const answer = entries.findLast(
            (entry): entry is Extract<ClientEntry, { kind: "assistant" }> =>
                entry.kind === "assistant" && answerText(entry).trim() !== "",
        );

        // Nothing to read: a `!` command alone names no task. Without an answer yet there is nothing to tag: a later run
        // looks again.
        if (first === undefined) {
            await this.#mark(id);

            return;
        }

        if (answer === undefined) {
            return;
        }

        const asked = first.text.replace(/^\[from: [^\]]+\]\s*/, "");
        const sessionId = await providerSessionId(this.#app, session);
        // Mark the attempt before it is paid for: a restart from here on does not ask again.
        const began = await this.#app.harness.commit(async (tx) => {
            const doc = await tx.doc(AutoTagsDoc);

            if (doc.tried[String(id)] !== undefined || doc.started[String(id)] !== undefined) {
                return false;
            }

            doc.started[String(id)] = Date.now();

            return true;
        }, context);

        if (!began) {
            return;
        }

        const reply = await this.#app.models
            .completeSimple(
                model,
                {
                    messages: [
                        {
                            role: "user",
                            content: [
                                {
                                    type: "text",
                                    text: `${TAG_PROMPT}\n\n<message>\n${asked.slice(0, READ_CHARS)}\n</message>\n\n<reply>\n${answerText(
                                        answer,
                                    )
                                        .slice(0, READ_CHARS)
                                        .trim()}\n</reply>`,
                                },
                            ],
                            timestamp: Date.now(),
                        },
                    ],
                },
                // Tags are never worth a wait for a limit.
                noWait({ maxTokens: 256, cacheRetention: "none", sessionId }),
            )
            .catch(async (error) => {
                // The request did not finish: let a later run ask again. A restart is not an error, and keeps its mark.
                await this.#clearStarted(id).catch(() => {});

                throw error;
            });
        // A reply cut off at its token limit may be half a JSON object: leave the tags as they are.
        const tags = reply.stopReason === "stop" ? cleanTags(textOf(reply)).sort() : [];

        const wrote = await this.#app.harness.commit(async (tx) => {
            const usage = await tx.doc(UsageDoc, session);
            const key = `${model.provider}/${model.id}`;

            usage.models[key] ??= {
                input: 0,
                output: 0,
                cacheRead: 0,
                cacheWrite: 0,
                totalTokens: 0,
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
            };
            addUsage(usage.models[key] as Usage, reply.usage);

            const marker = await tx.doc(AutoTagsDoc);

            // Another run, or another server, looked first: its answer stays, and so do its tags.
            if (marker.tried[String(id)] !== undefined) {
                return [] as string[];
            }

            marker.tried[String(id)] = Date.now();
            delete marker.started[String(id)];

            const doc = await tx.doc(SessionTagsDoc);
            const existing = doc.tags[String(id)] ?? [];

            if (existing.length > 0 || tags.length === 0) {
                return [] as string[];
            }

            doc.tags[String(id)] = tags;

            return tags;
        }, context);

        if (wrote.length > 0) {
            this.#app.events.emit("session.tagged", { conversationId: id, tags: wrote });
        }
    }

    /** Remember that this session was looked at, so no later run asks again. */
    async #mark(id: number): Promise<void> {
        await this.#app.harness.commit(async (tx) => {
            const doc = await tx.doc(AutoTagsDoc);

            delete doc.started[String(id)];

            if (doc.tried[String(id)] === undefined) {
                doc.tried[String(id)] = Date.now();
            }
        }, context);
    }

    /** A request that failed before it finished: a later run may ask again. */
    async #clearStarted(id: number): Promise<void> {
        await this.#app.harness.commit(async (tx) => {
            delete (await tx.doc(AutoTagsDoc)).started[String(id)];
        }, context);
    }
}

/** A reply's text parts. */
function textOf(reply: AssistantMessage): string {
    return reply.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("");
}
