/**
 * Session tags' stored data and rules, owned by Pi Pocket: each session's tags, the limits, and all-or-nothing changes.
 * The Session tags extension shows and edits them, and automatic tagging (`auto-tags.ts`) writes them after a session's
 * first answer. The kind is the one the extension stored them under, so the tags that are there already stay.
 */
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { PocketApp } from "./app.ts";
import { SessionTagsDoc } from "./docs.ts";

const context = BACKGROUND_CONTEXT;

export const MAX_TAGS = 10;
export const MAX_LENGTH = 32;
export const MAX_IDS = 500;

/** Tag names as stored: trimmed and lowercased, 1 to 32 characters, no control characters, each once. */
export function tagNames(value: unknown): string[] {
    if (value === undefined) {
        return [];
    }

    if (!Array.isArray(value) || value.length > MAX_TAGS * 2) {
        throw new Error("Tags are a list of names.");
    }

    const out = new Set<string>();

    for (const item of value) {
        const name = typeof item === "string" ? item.trim().toLowerCase() : "";

        if (
            name === "" ||
            [...name].length > MAX_LENGTH ||
            /[\p{Cc}\p{Bidi_Control}\u2028\u2029]/u.test(name)
        ) {
            throw new Error(`A tag is 1 to ${MAX_LENGTH} characters, on one line.`);
        }

        out.add(name);
    }

    return [...out];
}

/** One change to sessions' tags: which sessions, what to add, and what to take away. */
export interface TagChange {
    ids: number[];
    add: string[];
    remove: string[];
}

export class SessionTags {
    readonly #app: PocketApp;

    constructor(app: PocketApp) {
        this.#app = app;
    }

    /** Every session's tags, by id. A session with no tags has no key. */
    async read(): Promise<Record<string, string[]>> {
        return (await this.#app.harness.snapshot(SessionTagsDoc, context))?.tags ?? {};
    }

    /** The tags one session has. */
    async of(id: number): Promise<string[]> {
        return (await this.read())[String(id)] ?? [];
    }

    /**
     * Add and remove tags on sessions, all of them or none: the other tags they have stay. Answers those sessions' tags
     * now. A change that would put a session past `MAX_TAGS` changes nothing.
     */
    async change({ ids, add, remove }: TagChange): Promise<Record<string, string[]>> {
        if (
            !Array.isArray(ids) ||
            ids.length === 0 ||
            !ids.every((id) => typeof id === "number" && Number.isSafeInteger(id) && id > 0)
        ) {
            throw new Error("Choose the sessions to tag.");
        }

        if (ids.length > MAX_IDS) {
            throw new Error(`Tag ${MAX_IDS} sessions at most at once.`);
        }

        const added = tagNames(add);
        const removed = new Set(tagNames(remove));

        if (added.some((name) => removed.has(name))) {
            throw new Error("A tag cannot be added and removed at once.");
        }

        return this.#app.harness.commit(async (tx) => {
            const doc = await tx.doc(SessionTagsDoc);
            const next = new Map<string, string[]>();

            // Every session first, then the change: one over the limit changes none.
            for (const id of new Set(ids)) {
                const key = String(id);
                const tags = [
                    ...new Set([
                        ...(doc.tags[key] ?? []).filter((name) => !removed.has(name)),
                        ...added,
                    ]),
                ].sort();

                if (tags.length > MAX_TAGS) {
                    throw new Error(
                        `A session can have ${MAX_TAGS} tags at most. Nothing was saved.`,
                    );
                }

                next.set(key, tags);
            }

            for (const [key, tags] of next) {
                if (tags.length === 0) {
                    delete doc.tags[key];
                } else {
                    doc.tags[key] = tags;
                }
            }

            return Object.fromEntries(next);
        }, context);
    }
}
