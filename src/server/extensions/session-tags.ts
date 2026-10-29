/** Session tags: shared labels on sessions, shown on their rows, found by search, and used to filter the session list. */
// Types only: at run time this module uses nothing of Pi Pocket's but the host and web, as a drop-in would.
import type { ExtensionWeb, PocketHost, WebRequest } from "../host.ts";

const MAX_TAGS = 10;
const MAX_LENGTH = 32;
const MAX_IDS = 500;

export default function createSessionTags(host: PocketHost, web?: ExtensionWeb) {
    // A server that runs older code, which loaded this file as its checkout changed, has no `host.sessionTags` and
    // would turn this module on: it then adds nothing, until a restart.
    if (web === undefined || host.sessionTags === undefined) {
        return;
    }

    const tags = host.sessionTags;
    const appWeb = web;

    // Everyone who sees every session sees the tags; people invited to one session do not load it.
    appWeb.client("session-tags", { access: "view" });

    /** Tag names as stored: trimmed and lowercased, 1 to 32 characters, no control characters, each once. */
    const names = (value: unknown): string[] => {
        if (value === undefined) {
            return [];
        }

        if (!Array.isArray(value) || value.length > MAX_TAGS * 2) {
            throw appWeb.error(400, "Tags are a list of names.");
        }

        const out = new Set<string>();

        for (const item of value) {
            const name = typeof item === "string" ? item.trim().toLowerCase() : "";

            if (
                name === "" ||
                [...name].length > MAX_LENGTH ||
                /[\p{Cc}\p{Bidi_Control}\u2028\u2029]/u.test(name)
            ) {
                throw appWeb.error(400, `A tag is 1 to ${MAX_LENGTH} characters, on one line.`);
            }

            out.add(name);
        }

        return [...out];
    };

    /**
     * The sessions this person can see, by id. Hidden ones are out of the listing the routes give back, and a write on
     * one the browser names still goes through: what it changes is that session's own tags.
     */
    const visible = (
        request: WebRequest,
        options: { includeHidden?: boolean } = {},
    ): Set<number> => {
        if (typeof request.sessions !== "function") {
            throw appWeb.error(503, "Session tags needs a server restart before it can be used.");
        }

        return new Set(request.sessions(options).map((session) => session.id));
    };

    // The tags of the sessions this person can see.
    appWeb.route(
        "GET",
        "tags",
        async (request) => {
            const shown = visible(request);

            return {
                tags: Object.fromEntries(
                    Object.entries(await tags.read()).filter(([id]) => shown.has(Number(id))),
                ),
            };
        },
        { access: "view" },
    );

    // Add and remove tags on sessions, all of them or none: the other tags they have stay.
    appWeb.route(
        "POST",
        "tags",
        async (request) => {
            const { ids, add: added, remove: removed } = request.body;

            if (
                !Array.isArray(ids) ||
                ids.length === 0 ||
                !ids.every((id) => typeof id === "number" && Number.isSafeInteger(id) && id > 0)
            ) {
                throw appWeb.error(400, "Choose the sessions to tag.");
            }

            if (ids.length > MAX_IDS) {
                throw appWeb.error(400, `Tag ${MAX_IDS} sessions at most at once.`);
            }

            const add = names(added);
            const remove = new Set(names(removed));

            if (add.some((name) => remove.has(name))) {
                throw appWeb.error(400, "A tag cannot be added and removed at once.");
            }

            // A tag write on a hidden session is still a write on a session this person may steer.
            const shown = visible(request, { includeHidden: true });

            if (!ids.every((id) => shown.has(id))) {
                throw appWeb.error(404, "A session to tag is not there anymore.");
            }

            let changed: Record<string, string[]>;

            try {
                changed = await tags.change({ ids: ids as number[], add, remove: [...remove] });
            } catch (error) {
                throw appWeb.error(
                    409,
                    error instanceof Error ? error.message : "The tags did not save.",
                );
            }

            // Each tab asks again, for the sessions its person can see.
            appWeb.send("changed");

            return { tags: changed };
        },
        { access: "steer" },
    );

    // Automatic tags are written by core after a session's first answer: tell each tab to look again. A server that
    // has the tags but not the event does without.
    if (typeof host.on === "function") {
        appWeb.onDispose(host.on("session.tagged", () => appWeb.send("changed")));
    }
}
