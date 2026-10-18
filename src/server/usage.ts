/**
 * Usage as Pi Pocket's own sessions made it, and each provider's own quota. Local usage is built from the assistant
 * entries every commit brings, one cell per hour per person per model, backfilled from history at startup and counted
 * once per entry (a watermark per conversation); the quota comes from each provider's own usage endpoint
 * (`usage-providers.ts`), refreshed in the background and shown with its reset times. Past a threshold, a window warns
 * once, in the app and the log.
 */
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { Usage as AiUsage } from "@earendil-works/pi-ai";
import type { ConversationId, Cursor, EntryId, EntryRecord } from "@earendil-works/pi-durable";
import type { PocketApp } from "./app.ts";
import type { User } from "./config.ts";
import { type UsageCell, UsageIndexDoc, UsageQuotaDoc } from "./docs.ts";
import { describe } from "./errors.ts";
import type { ProviderQuota } from "./usage-providers.ts";
import { queryAll, readCredentials, renderQuota, SUPPORTED } from "./usage-providers.ts";

const context = BACKGROUND_CONTEXT;

/** Local windows the sheet offers, in seconds; "all" is everything. */
export const WINDOWS = [
    { id: "5h", label: "5h", seconds: 5 * 3_600 },
    { id: "24h", label: "24h", seconds: 24 * 3_600 },
    { id: "7d", label: "7d", seconds: 7 * 86_400 },
    { id: "30d", label: "30d", seconds: 30 * 86_400 },
    { id: "all", label: "All", seconds: Number.POSITIVE_INFINITY },
] as const;

/** Background quota refresh, and the longest a failing one waits before the next try. */
const QUOTA_EVERY_MS = 10 * 60_000;
const QUOTA_RETRY_MS = 20 * 60_000;
/** A refresh younger than this is not asked again: the sheet and the tool share it. */
const QUOTA_MIN_MS = 30_000;

/** A bucket past this share of its limit warns, once per window. */
const WARN_AT = 0.8;

const FLUSH_MS = 250;

/** What a window's cells add to, per model and per person, with the window's cards. */
export type UsageWindow = {
    id: string;
    label: string;
    cards: { tokens: number; cacheRate?: number; cost: number; calls: number; sessions: number };
    models: (UsageCell & { key: string; provider: string; modelId: string })[];
    people: (UsageCell & { id: string; name: string })[];
};

export type UsageSummary = {
    windows: Record<string, UsageWindow>;
    quota: Record<string, ProviderQuota>;
};

/** The usage an assistant message carries, as the entry holds it. */
type MessageUsage = {
    usage?: Partial<AiUsage>;
    model?: unknown;
    provider?: unknown;
    timestamp?: unknown;
};

/** A doc value as plain JSON: what a commit leaves behind cannot be read after it settles. */
function plain<T>(value: T): T {
    return JSON.parse(JSON.stringify(value)) as T;
}

/** The hours of a doc, as plain data, read inside its commit. */
function plainHours(
    hours: Record<string, Record<string, UsageCell>>,
): Record<string, Record<string, UsageCell>> {
    const out: Record<string, Record<string, UsageCell>> = {};

    for (const [hour, cells] of Object.entries(hours)) {
        out[hour] = {};

        for (const [key, cell] of Object.entries(cells)) {
            out[hour][key] = { ...cell };
        }
    }

    return out;
}

function addCell(into: UsageCell | undefined, cell: UsageCell): UsageCell {
    if (into === undefined) {
        return { ...cell };
    }

    return {
        calls: into.calls + cell.calls,
        input: into.input + cell.input,
        output: into.output + cell.output,
        cacheRead: into.cacheRead + cell.cacheRead,
        cacheWrite: into.cacheWrite + cell.cacheWrite,
        cost: into.cost + cell.cost,
    };
}

/** The weight a cell sorts by: its cost, or its tokens when the cost is none. */
function weight(cell: UsageCell): number {
    return cell.cost > 0 ? cell.cost : cell.input + cell.output + cell.cacheRead + cell.cacheWrite;
}

export class Usage {
    readonly #app: PocketApp;
    /** The index in memory, as the doc holds it; a flush keeps them equal. */
    #hours: Record<string, Record<string, UsageCell>> = {};
    /** Per conversation, the newest assistant entry already counted (in memory ahead of the doc until a flush). */
    #watermarks: Record<string, number> = {};
    /** Entries counted since the last flush, by conversation. */
    readonly #pending = new Map<
        ConversationId,
        { entryId: number; at: number; key: string; cell: UsageCell }[]
    >();
    #timer: NodeJS.Timeout | undefined;
    /** The quota snapshot as last stored, its warning marks, and the refresh timer; one refresh at a time. */
    #quota: Record<string, ProviderQuota> = {};
    #warned: Record<string, number> = {};
    #quotaTimer: NodeJS.Timeout | undefined;
    #quotaRunning = false;
    #polling = false;
    #lastRefreshAt = 0;

    constructor(app: PocketApp) {
        this.#app = app;
    }

    /**
     * Start from what is stored: count every assistant entry newer than its conversation's watermark (the backfill),
     * then take up the background quota refresh. Runs before the commit listener is subscribed, so nothing is counted
     * twice; an entry committed while this reads is published after, and the listener takes it.
     */
    async load(ids: readonly ConversationId[]): Promise<void> {
        const stored = await this.#app.harness.snapshot(UsageIndexDoc, context);

        this.#hours = { ...(stored?.hours ?? {}) };
        this.#watermarks = { ...(stored?.watermarks ?? {}) };

        await this.#backfill(ids);

        // Nothing signed in to ask: no background poll at all. The tool and the sheet still refresh on demand.
        if (Object.keys(await readCredentials(getAgentDir())).length > 0) {
            this.#polling = true;
            this.#scheduleQuota(0);
        }
    }

    async #backfill(ids: readonly ConversationId[]): Promise<void> {
        const batches: { id: ConversationId; entries: EntryRecord[] }[] = [];

        for (const id of ids) {
            const watermark = this.#watermarks[String(id)] ?? 0;
            const entries: EntryRecord[] = [];
            let cursor: Cursor | undefined;

            do {
                const page = await this.#app.harness.commit(
                    (tx) =>
                        tx.scanEntries(
                            {
                                conversationId: id,
                                minEntryId: watermark as unknown as EntryId,
                                order: "ascending",
                            },
                            512,
                            cursor,
                        ),
                    context,
                );

                for (const entry of page.items) {
                    if (entry.kind === "pi.assistant" && entry.id > watermark) {
                        entries.push(entry);
                    }
                }

                cursor = page.next;
            } while (cursor !== undefined);

            if (entries.length > 0) {
                batches.push({ id, entries });
            }
        }

        if (batches.length === 0) {
            return;
        }

        try {
            const stored = await this.#app.harness.commit(async (tx) => {
                const doc = await tx.doc(UsageIndexDoc);

                for (const batch of batches) {
                    // From the doc's watermark, as the flush does: nothing already counted is counted again.
                    let highest = doc.watermarks[String(batch.id)] ?? 0;

                    for (const entry of batch.entries) {
                        if (entry.id <= highest) {
                            continue;
                        }

                        this.#count(doc, batch.id, entry);
                        highest = entry.id;
                    }

                    doc.watermarks[String(batch.id)] = highest;
                    this.#watermarks[String(batch.id)] = highest;
                }

                return { hours: plainHours(doc.hours), watermarks: { ...doc.watermarks } };
            }, context);

            this.#hours = stored.hours;
            this.#watermarks = stored.watermarks;
        } catch (error) {
            // Nothing was stored: go back to what the doc holds, so a restart counts what is missing.
            const stored = await this.#app.harness.snapshot(UsageIndexDoc, context);

            this.#hours = { ...(stored?.hours ?? {}) };
            this.#watermarks = { ...(stored?.watermarks ?? {}) };
            this.#app.log(`usage index not backfilled: ${describe(error)}`);
        }
    }

    /** An assistant entry a commit brought: its usage is counted once, for the person Pi works for. */
    entryCommitted(entry: EntryRecord): void {
        const id = entry.conversationId as ConversationId;

        if ((this.#watermarks[String(id)] ?? 0) >= entry.id) {
            return;
        }

        this.#watermarks[String(id)] = entry.id;

        const message = entry.model?.[0] as MessageUsage | undefined;
        const batch = this.#pending.get(id) ?? [];

        batch.push({
            entryId: entry.id,
            at:
                typeof message?.timestamp === "number" && message.timestamp > 0
                    ? message.timestamp
                    : Date.now(),
            key: `${this.#payer(id)}|${stringOf(message?.provider)}/${stringOf(message?.model)}`,
            cell: usageCellOf(message),
        });
        this.#pending.set(id, batch);

        this.#scheduleFlush();
    }

    /** One flush waits a moment, in case more answers of the same run land beside it. */
    #scheduleFlush(): void {
        if (this.#timer !== undefined) {
            return;
        }

        this.#timer = setTimeout(() => {
            this.#timer = undefined;
            void this.#flush().catch((error: unknown) => {
                this.#app.log(`usage not counted: ${describe(error)}`);
            });
        }, FLUSH_MS);
    }

    /** Store what is pending: the cells and the watermarks in one commit, so a crash cannot count anything twice. */
    async #flush(): Promise<void> {
        const pending = [...this.#pending];

        this.#pending.clear();

        if (pending.length === 0) {
            return;
        }

        try {
            const stored = await this.#app.harness.commit(async (tx) => {
                const doc = await tx.doc(UsageIndexDoc);

                for (const [id, batch] of pending) {
                    // From what the doc holds, not the live watermark: an entry committed while this flush runs is
                    // queued, not counted here — its cells and its watermark must land in one commit, together.
                    let highest = doc.watermarks[String(id)] ?? 0;

                    for (const item of batch) {
                        this.#add(doc, item.at, item.key, item.cell);
                        highest = Math.max(highest, item.entryId);
                    }

                    doc.watermarks[String(id)] = highest;
                }

                return { hours: plainHours(doc.hours), watermarks: { ...doc.watermarks } };
            }, context);

            this.#hours = stored.hours;
            this.#watermarks = stored.watermarks;
        } catch (error) {
            // Nothing was stored: the watermarks go back behind every pending entry, and the next flush counts them.
            for (const [id, batch] of pending) {
                this.#watermarks[String(id)] = Math.min(...batch.map((item) => item.entryId)) - 1;

                const held = this.#pending.get(id) ?? [];

                held.unshift(...batch);
                this.#pending.set(id, held);
            }

            this.#scheduleFlush();

            throw error;
        }
    }

    /** Add one entry's usage to the doc's hours, at its message's time, for its person and model. */
    #count(
        doc: { hours: Record<string, Record<string, UsageCell>> },
        id: ConversationId,
        entry: EntryRecord,
    ): void {
        const message = entry.model?.[0] as MessageUsage | undefined;
        const at =
            typeof message?.timestamp === "number" && message.timestamp > 0
                ? message.timestamp
                : Date.now();

        this.#add(
            doc,
            at,
            `${this.#payer(id)}|${stringOf(message?.provider)}/${stringOf(message?.model)}`,
            usageCellOf(message),
        );
    }

    #add(
        doc: { hours: Record<string, Record<string, UsageCell>> },
        at: number,
        key: string,
        cell: UsageCell,
    ): void {
        const hour = String(Math.floor(at / 3_600_000) * 3_600);
        const hourCells = doc.hours[hour] ?? {};

        hourCells[key] = addCell(hourCells[key], cell);
        doc.hours[hour] = hourCells;
    }

    /** Who a conversation's work counts for, as spend counts it. */
    #payer(id: ConversationId): string {
        return this.#app.spend.payerOf(id);
    }

    // ─── Reading ──────────────────────────────────────────────────────────────

    /** Every window's view of the index: cards, per model, per person. */
    summary(user: User): UsageSummary {
        const windows: Record<string, UsageWindow> = {};

        for (const spec of WINDOWS) {
            windows[spec.id] = this.#window(spec, user);
        }

        return { windows, quota: this.#quota };
    }

    #window(spec: (typeof WINDOWS)[number], user: User): UsageWindow {
        // The index is keyed by epoch-seconds hours; the sessions' own times are milliseconds.
        const cutoff =
            spec.seconds === Number.POSITIVE_INFINITY
                ? 0
                : Math.floor((Date.now() - spec.seconds * 1000) / 1000);
        const cells = new Map<string, UsageCell>();

        for (const [hour, hourCells] of Object.entries(this.#hours)) {
            if (Number(hour) < cutoff) {
                continue;
            }

            for (const [key, cell] of Object.entries(hourCells)) {
                cells.set(key, addCell(cells.get(key), cell));
            }
        }

        const models: UsageWindow["models"] = [];
        const people = new Map<string, UsageCell>();
        let tokens = 0;
        let cost = 0;
        let calls = 0;
        let input = 0;
        let cacheRead = 0;
        let cacheWrite = 0;

        for (const [key, cell] of cells) {
            const at = key.indexOf("|");
            const person = at === -1 ? "" : key.slice(0, at);
            const modelKey = at === -1 ? key : key.slice(at + 1);
            const slash = modelKey.indexOf("/");

            models.push({
                ...cell,
                key: modelKey,
                provider: slash === -1 ? "" : modelKey.slice(0, slash),
                modelId: slash === -1 ? modelKey : modelKey.slice(slash + 1),
            });
            people.set(person, addCell(people.get(person), cell));

            tokens += cell.input + cell.output + cell.cacheRead + cell.cacheWrite;
            input += cell.input;
            cacheRead += cell.cacheRead;
            cacheWrite += cell.cacheWrite;
            cost += cell.cost;
            calls += cell.calls;
        }

        const prompt = input + cacheRead + cacheWrite;
        // The sessions' own times are milliseconds; the index's are seconds.
        const sessionCutoff =
            spec.seconds === Number.POSITIVE_INFINITY ? 0 : Date.now() - spec.seconds * 1000;

        return {
            id: spec.id,
            label: spec.label,
            cards: {
                tokens,
                ...(prompt > 0 ? { cacheRate: cacheRead / prompt } : {}),
                cost,
                calls,
                sessions: this.#app
                    .sessions(user)
                    .filter((session) => (session.updatedAt ?? 0) >= sessionCutoff).length,
            },
            models: models.sort((a, b) => weight(b) - weight(a)),
            people: [...people]
                .map(([person, cell]) => ({
                    ...cell,
                    id: person,
                    name: this.#app.config.userById(person)?.name ?? person,
                }))
                .sort((a, b) => weight(b) - weight(a)),
        };
    }

    // ─── Quota ────────────────────────────────────────────────────────────────

    /** Refresh every provider now — unless one just answered and `force` is not set — store it, warn past the threshold. */
    async refreshQuota(force = false): Promise<Record<string, ProviderQuota>> {
        if (this.#quotaRunning || (!force && Date.now() - this.#lastRefreshAt < QUOTA_MIN_MS)) {
            return this.#quota;
        }

        this.#quotaRunning = true;

        try {
            const providers = await queryAll(getAgentDir());
            const stored = await this.#app.harness.commit(async (tx) => {
                const doc = await tx.doc(UsageQuotaDoc);

                doc.providers = plain(providers);
                doc.errors = 0;
                doc.nextAt = Date.now() + QUOTA_EVERY_MS;
                this.#warnWithin(doc, providers);

                return { providers: plain(doc.providers), warned: { ...doc.warned } };
            }, context);

            this.#quota = stored.providers;
            this.#warned = stored.warned;
            this.#lastRefreshAt = Date.now();
            this.#scheduleQuota(QUOTA_EVERY_MS);

            return this.#quota;
        } catch (error) {
            this.#app.log(`quota not refreshed: ${describe(error)}`);
            this.#scheduleQuota(QUOTA_RETRY_MS);

            return this.#quota;
        } finally {
            this.#quotaRunning = false;
        }
    }

    #scheduleQuota(afterMs: number): void {
        if (!this.#polling) {
            return;
        }

        clearTimeout(this.#quotaTimer);
        this.#quotaTimer = setTimeout(() => {
            this.#quotaTimer = undefined;
            void this.refreshQuota();
        }, afterMs);
    }

    /** The owner hears, once per window, of a bucket past the threshold. */
    #warnWithin(
        doc: { warned: Record<string, number> },
        providers: Record<string, ProviderQuota>,
    ): void {
        for (const [id, quota] of Object.entries(providers)) {
            for (const bucket of quota.report?.buckets ?? []) {
                if (bucket.limit === undefined || bucket.limit <= 0) {
                    continue;
                }

                const share = (bucket.used ?? 0) / bucket.limit;

                if (share < WARN_AT) {
                    continue;
                }

                const key = `${id}:${bucket.id}`;
                const resetsAt = bucket.resetsAt ?? 0;

                if (this.#warned[key] === resetsAt) {
                    continue;
                }

                doc.warned[key] = resetsAt;
                this.#warned[key] = resetsAt;
                this.#app.notice(
                    "warning",
                    `${displayNameOf(id)} is at ${Math.round(share * 100)}% of its ${bucket.label.toLowerCase()}${
                        resetsAt > 0
                            ? `, resets ${new Date(resetsAt * 1000).toLocaleString("en-US")}`
                            : ""
                    }.`,
                );
            }
        }
    }

    /** The tool's answer: the snapshot, refreshed first so it is fresh. */
    async toolText(provider?: string): Promise<string> {
        await this.refreshQuota();

        const ids = SUPPORTED.map((target) => target.id).filter(
            (id) => provider === undefined || id === provider,
        );

        if (ids.length === 0) {
            throw new Error(
                `No provider ${provider}. Supported: ${SUPPORTED.map((target) => target.id).join(", ")}.`,
            );
        }

        const quota = this.#quota;

        return `Provider usage and quota (${ids.filter((id) => quota[id]?.error === undefined).length}/${ids.length} from their own APIs):\n\n${renderQuota(quota, Date.now(), ids)}`;
    }

    close(): void {
        clearTimeout(this.#timer);
        clearTimeout(this.#quotaTimer);
    }
}

function stringOf(value: unknown): string {
    return typeof value === "string" ? value : "";
}

function usageCellOf(message: MessageUsage | undefined): UsageCell {
    const used = message?.usage;

    return {
        calls: 1,
        input: used?.input ?? 0,
        output: used?.output ?? 0,
        cacheRead: used?.cacheRead ?? 0,
        cacheWrite: used?.cacheWrite ?? 0,
        cost: used?.cost?.total ?? 0,
    };
}

function displayNameOf(id: string): string {
    return SUPPORTED.find((target) => target.id === id)?.displayName ?? id;
}
