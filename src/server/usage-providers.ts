/**
 * Each provider's own usage endpoint, fetched with Pi's stored sign-ins: OpenAI Codex (ChatGPT OAuth),
 * OpenCode Go (OpenCode Zen), and Command Code. The parsing follows `@narumitw/pi-usage` 0.66.0 (MIT), trimmed to the
 * providers this server signs in to; only read-only GETs are made, and no credential is ever put in a result.
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";

/** Timeouts. */
const REQUEST_MS = 15_000;
const ERROR_CHARS = 300;

// ─── Types (as @narumitw/pi-usage's, trimmed) ─────────────────────────────────

export type UsageUnit = "percent" | "usd" | "count";

export type UsageBucket = {
    id: string;
    label: string;
    used?: number;
    remaining?: number;
    limit?: number;
    unit: UsageUnit;
    windowMinutes?: number;
    /** Epoch seconds; 0 means the window is not running. */
    resetsAt?: number;
};

export type UsageMetric = {
    id: string;
    label: string;
    value: string | number;
    unit?: UsageUnit;
};

export type UsageReport = {
    providerId: string;
    providerName: string;
    accountLabel?: string;
    capturedAt: number;
    buckets: UsageBucket[];
    metrics: UsageMetric[];
    notes?: string[];
};

/** What a refresh left for one provider: its report, or why there is none. */
export type ProviderQuota = {
    report?: UsageReport;
    error?: string;
    capturedAt: number;
};

// ─── Payload guards (as upstream's) ──────────────────────────────────────────

type Row = Record<string, unknown>;

function asObject(value: unknown): Row | undefined {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
        return undefined;
    }

    return value as Row;
}

function asString(value: unknown, maxLength = 80): string | undefined {
    if (typeof value !== "string") {
        return undefined;
    }

    // Control characters out, one line, bounded: text from outside is shown to people.
    const clean = value
        .replace(/[\u0000-\u001f\u007f-\u009f]+/gu, " ")
        .replace(/\s+/gu, " ")
        .trim()
        .slice(0, maxLength);

    return clean || undefined;
}

function asNumber(value: unknown): number | undefined {
    if (typeof value === "number" && Number.isFinite(value)) {
        return value;
    }

    if (typeof value === "string" && value.trim()) {
        const parsed = Number(value);

        return Number.isFinite(parsed) ? parsed : undefined;
    }

    return undefined;
}

function asNonnegativeNumber(value: unknown): number | undefined {
    const parsed = asNumber(value);

    return parsed !== undefined && parsed >= 0 ? parsed : undefined;
}

function asNonnegativeInteger(value: unknown): number | undefined {
    const parsed = asNumber(value);

    return parsed !== undefined && Number.isSafeInteger(parsed) ? Math.max(0, parsed) : undefined;
}

/** Epoch seconds from epoch seconds, epoch milliseconds, or an ISO date string. */
export function asEpochSeconds(value: unknown): number | undefined {
    if (typeof value === "string" && value.trim() && !/^\d+$/u.test(value.trim())) {
        return fromIsoDate(value);
    }

    const raw =
        typeof value === "number" && Number.isFinite(value)
            ? value
            : typeof value === "string" && /^\d+$/u.test(value.trim())
              ? Number(value.trim())
              : undefined;

    if (raw === undefined || raw < 0) {
        return undefined;
    }

    return Math.floor(raw >= 1e12 ? raw / 1000 : raw);
}

function fromIsoDate(value: unknown): number | undefined {
    if (typeof value !== "string" || !value.trim()) {
        return undefined;
    }

    const parsed = Date.parse(value);

    return Number.isNaN(parsed) ? undefined : Math.floor(parsed / 1000);
}

function clampPercent(value: number): number {
    return Math.min(100, Math.max(0, value));
}

function capitalize(value: string): string {
    return `${value[0]?.toUpperCase() ?? ""}${value.slice(1)}`;
}

// ─── Fetching: one bearer token, JSON responses, secrets redacted from errors ─

async function fetchJson(
    url: string,
    token: string,
    timeoutMs: number,
    description: string,
): Promise<Row> {
    const response = await fetch(url, {
        method: "GET",
        headers: { Authorization: `Bearer ${token}`, "User-Agent": "pi-pocket-usage/0.1" },
        redirect: "error",
        signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await response.text();

    if (!response.ok) {
        throw new Error(
            `${description} returned HTTP ${response.status}: ${redact(text.slice(0, ERROR_CHARS), [token])}`,
        );
    }

    let parsed: unknown;

    try {
        parsed = JSON.parse(text) as unknown;
    } catch {
        throw new Error(`${description} returned invalid JSON.`);
    }

    const object = asObject(parsed);

    if (!object) {
        throw new Error(`${description} returned no object.`);
    }

    return object;
}

/** Any credential a provider echoes back in an error body is covered. */
export function redact(text: string, secrets: readonly string[]): string {
    let out = text;

    for (const secret of secrets) {
        if (secret.length < 8) {
            continue;
        }

        out = out.split(secret).join("…");
    }

    return out.replace(/\s+/g, " ");
}

// ─── OpenAI Codex: chatgpt.com/backend-api/wham/usage (ChatGPT OAuth) ────────

interface CodexPayload extends Row {
    plan_type?: unknown;
    rate_limit?: unknown;
    rate_limit_reset_credits?: unknown;
}

export function normalizeCodex(payload: CodexPayload, capturedAt: number): UsageReport {
    const buckets: UsageBucket[] = [];
    const rateLimit = asObject(payload.rate_limit);

    for (const [position, label] of [
        ["primary_window", "5h window"],
        ["secondary_window", "7d window"],
    ] as const) {
        const window = asObject(rateLimit?.[position]);
        const used = window === undefined ? undefined : asNumber(window.used_percent);

        if (used === undefined) {
            continue;
        }

        const seconds = asNumber(window?.limit_window_seconds);
        const resetsAt = asEpochSeconds(window?.reset_at);

        buckets.push({
            id: position,
            label: seconds !== undefined && seconds > 0 ? windowLabel(seconds / 60) : label,
            used,
            remaining: 100 - clampPercent(used),
            limit: 100,
            unit: "percent",
            ...(resetsAt !== undefined ? { resetsAt } : {}),
        });
    }

    const metrics: UsageMetric[] = [];
    const resetCredits = asNonnegativeInteger(
        asObject(payload.rate_limit_reset_credits)?.available_count,
    );

    if (resetCredits !== undefined) {
        metrics.push({
            id: "reset-credits",
            label: "Usage limit resets available",
            value: resetCredits,
            unit: "count",
        });
    }

    if (buckets.length === 0 && metrics.length === 0) {
        throw new Error("Codex usage endpoint returned no displayable usage data.");
    }

    const plan = asString(payload.plan_type, 40);

    return {
        providerId: "openai-codex",
        providerName: "OpenAI Codex",
        capturedAt,
        buckets,
        metrics,
        ...(plan ? { notes: [`Plan: ${plan}`] } : {}),
    };
}

// ─── OpenCode Go: opencode.ai/zen/go/v1/usage (API key) ──────────────────────

const ZEN_WINDOWS = [
    { key: "rolling", label: "Rolling window" },
    { key: "weekly", label: "Weekly window" },
    { key: "monthly", label: "Monthly window" },
] as const;

export function normalizeOpenCodeZen(payload: Row, capturedAt: number): UsageReport {
    const usage = asObject(payload.usage);

    if (!usage) {
        throw new Error("OpenCode Zen usage response was not an object.");
    }

    const buckets: UsageBucket[] = [];
    const notes: string[] = [];

    for (const window of ZEN_WINDOWS) {
        const raw = asObject(usage[window.key]);

        if (!raw) {
            continue;
        }

        const status = asString(raw.status);

        if (status !== "ok" && status !== "rate-limited") {
            notes.push(`${window.label} unavailable (${status ?? "unknown status"}).`);
            continue;
        }

        const used = asNonnegativeNumber(raw.percent);

        if (used === undefined) {
            continue;
        }

        const resetsAt = asEpochSeconds(raw.resetsAt);

        buckets.push({
            id: window.key,
            label: window.label,
            used,
            remaining: 100 - clampPercent(used),
            limit: 100,
            unit: "percent",
            ...(resetsAt !== undefined ? { resetsAt } : {}),
        });
    }

    if (buckets.length === 0) {
        throw new Error("OpenCode Zen usage endpoint returned no displayable usage data.");
    }

    return {
        providerId: "opencode-go",
        providerName: "OpenCode Go",
        capturedAt,
        buckets,
        metrics: [],
        ...(notes.length > 0 ? { notes } : {}),
    };
}

// ─── Command Code: api.commandcode.ai/alpha/* (Bearer API key) ───────────────

const COMMAND_CODE_ORIGIN = "https://api.commandcode.ai";
const PLAN_LABELS: Readonly<Record<string, string>> = {
    "individual-go": "Go",
    "individual-goat": "GOAT",
    "individual-pro": "Pro",
    "individual-provider": "Provider",
    "individual-max": "Max",
    "individual-ultra": "Ultra",
};

const CC_WINDOWS = [
    { key: "fiveHour", id: "five-hour", label: "5h window", windowMinutes: 300 },
    { key: "weekly", id: "weekly", label: "Weekly window", windowMinutes: 10_080 },
] as const;

export function commandCodeOrgId(account: Row): string | undefined {
    const id = asObject(account.org)?.id;

    return typeof id === "string" && /^[A-Za-z0-9._~-]{1,128}$/u.test(id) ? id : undefined;
}

export function normalizeCommandCode(
    account: Row,
    credits: Row | undefined,
    subscription: Row | undefined,
    usage: Row | undefined,
    capturedAt: number,
): UsageReport {
    const user = asObject(account.user);
    const accountLabel = asString(user?.userName) ?? asString(user?.name);

    if (!accountLabel) {
        throw new Error("Command Code account response omitted an account name.");
    }

    const creditsPayload = asObject(credits?.credits);
    const windowLimits = asObject(credits?.windowLimits);
    const subscriptionData = asObject(subscription?.data);
    const buckets: UsageBucket[] = [];

    for (const window of CC_WINDOWS) {
        const row = asObject(windowLimits?.[window.key]);

        if (row === undefined) {
            continue;
        }

        const used = asNonnegativeNumber(row.used);
        const cap = asNonnegativeNumber(row.cap);

        if (used === undefined || cap === undefined || cap <= 0) {
            continue;
        }

        const resetsAt = asEpochSeconds(row.resetAt);

        buckets.push({
            id: window.id,
            label: window.label,
            used,
            remaining: Math.max(0, cap - used),
            limit: cap,
            unit: "usd",
            windowMinutes: window.windowMinutes,
            ...(resetsAt !== undefined ? { resetsAt } : {}),
        });
    }

    const totalCost = asNonnegativeNumber(usage?.totalCost);
    const remainingCredits = commandCodeRemainingCredits(creditsPayload);
    const monthlyReset = fromIsoDate(subscriptionData?.currentPeriodEnd);

    if (totalCost !== undefined && remainingCredits !== undefined) {
        const pool = totalCost + remainingCredits;

        if (pool > 0) {
            buckets.push({
                id: "monthly",
                label: "Monthly credits",
                used: totalCost,
                remaining: remainingCredits,
                limit: pool,
                unit: "usd",
                ...(monthlyReset !== undefined ? { resetsAt: monthlyReset } : {}),
            });
        }
    }

    const metrics: UsageMetric[] = [];
    const plan = commandCodePlanLabel(subscriptionData?.planId);
    const planStatus = asString(subscriptionData?.status, 40);

    if (plan || planStatus) {
        metrics.push({
            id: "plan",
            label: "Plan",
            value: [plan, planStatus ? `(${planStatus})` : undefined].filter(Boolean).join(" "),
        });
    }

    if (buckets.every((bucket) => bucket.id !== "monthly") && remainingCredits !== undefined) {
        metrics.push({
            id: "monthly-credits",
            label: "Monthly credits remaining",
            value: remainingCredits,
            unit: "usd",
        });
    }

    const purchased = asNonnegativeNumber(creditsPayload?.purchasedCredits);
    const free = asNonnegativeNumber(creditsPayload?.freeCredits);

    if (purchased) {
        metrics.push({
            id: "purchased",
            label: "Purchased credits remaining",
            value: purchased,
            unit: "usd",
        });
    }

    if (free) {
        metrics.push({ id: "free", label: "Free credits remaining", value: free, unit: "usd" });
    }

    const totalCount = asNonnegativeInteger(usage?.totalCount);
    const totalTokens = asNonnegativeNumber(usage?.totalTokens);

    if (totalCount !== undefined) {
        metrics.push({
            id: "requests",
            label: "Requests this period",
            value: totalCount,
            unit: "count",
        });
    }

    if (totalTokens !== undefined) {
        metrics.push({
            id: "tokens",
            label: "Tokens this period",
            value: totalTokens,
            unit: "count",
        });
    }

    const notes: string[] = [];

    if (!credits) {
        notes.push("Credits were unavailable.");
    } else if (windowLimits?.limited === false) {
        notes.push("Rolling 5-hour and weekly limits are not enabled for this plan.");
    }

    if (!subscription) {
        notes.push("Plan details were unavailable.");
    }

    if (!usage) {
        notes.push("Billing-period usage was unavailable.");
    }

    return {
        providerId: "command-code",
        providerName: "Command Code",
        accountLabel,
        capturedAt,
        buckets,
        metrics,
        ...(notes.length > 0 ? { notes } : {}),
    };
}

function commandCodeRemainingCredits(credits: Row | undefined): number | undefined {
    if (!credits) {
        return undefined;
    }

    const parts = ["monthlyCredits", "purchasedCredits", "freeCredits"]
        .map((key) => asNonnegativeNumber(credits[key]))
        .filter((value): value is number => value !== undefined);

    return parts.length === 0 ? undefined : parts.reduce((total, value) => total + value, 0);
}

function commandCodePlanLabel(value: unknown): string | undefined {
    const raw = asString(value, 40);

    if (!raw) {
        return undefined;
    }

    return (
        PLAN_LABELS[raw] ?? capitalize(raw.replace(/^individual[-_]/u, "").replace(/[-_]+/gu, " "))
    );
}

// ─── Sign-ins: Pi's own auth store, the same one the sessions use ─────────────

export type ProviderTarget = {
    id: string;
    displayName: string;
    kind: "codex" | "zen" | "command-code";
};

/** The providers this module reads, by their id in Pi's sign-in store. */
export const SUPPORTED: readonly ProviderTarget[] = [
    { id: "openai-codex", displayName: "OpenAI Codex", kind: "codex" },
    { id: "opencode-go", displayName: "OpenCode Go", kind: "zen" },
    { id: "commandcode", displayName: "Command Code", kind: "command-code" },
    { id: "commandcode-b", displayName: "Command Code (b)", kind: "command-code" },
];

export type StoredCredential = { token: string; expiresAt?: number };

export async function readCredentials(agentDir: string): Promise<Record<string, StoredCredential>> {
    let auth: Row | undefined;

    try {
        auth = asObject(JSON.parse(await readFile(join(agentDir, "auth.json"), "utf8")));
    } catch {
        return {};
    }

    const out: Record<string, StoredCredential> = {};

    for (const target of SUPPORTED) {
        const row = asObject(auth?.[target.id]);
        const token =
            typeof row?.access === "string"
                ? row.access
                : typeof row?.key === "string"
                  ? row.key
                  : undefined;

        if (token === undefined) {
            continue;
        }

        const expires = row?.expires;

        out[target.id] = { token, ...(typeof expires === "number" ? { expiresAt: expires } : {}) };
    }

    return out;
}

// ─── The queries ──────────────────────────────────────────────────────────────

async function queryProvider(target: ProviderTarget, token: string): Promise<UsageReport> {
    const capturedAt = Date.now();

    if (target.kind === "codex") {
        return normalizeCodex(
            (await fetchJson(
                "https://chatgpt.com/backend-api/wham/usage",
                token,
                REQUEST_MS,
                "The Codex usage endpoint",
            )) as CodexPayload,
            capturedAt,
        );
    }

    if (target.kind === "zen") {
        return normalizeOpenCodeZen(
            await fetchJson(
                "https://opencode.ai/zen/go/v1/usage",
                token,
                REQUEST_MS,
                "The OpenCode Zen usage endpoint",
            ),
            capturedAt,
        );
    }

    const whoami = (await fetchJson(
        `${COMMAND_CODE_ORIGIN}/alpha/whoami`,
        token,
        REQUEST_MS,
        "The Command Code account endpoint",
    )) as Row;
    const orgId = commandCodeOrgId(whoami);

    // The account is mandatory; credits, plan, and period usage degrade to notes when they fail.
    const optional = async (
        path: string,
        params: Record<string, string> = {},
    ): Promise<Row | undefined> => {
        const query = new URLSearchParams({ ...(orgId ? { orgId } : {}), ...params });
        const search = [...query].length > 0 ? `?${query}` : "";

        try {
            return await fetchJson(
                `${COMMAND_CODE_ORIGIN}${path}${search}`,
                token,
                REQUEST_MS,
                path,
            );
        } catch (error) {
            if (String(error).includes("Timed out")) {
                throw error;
            }

            return undefined;
        }
    };

    const [credits, subscription] = await Promise.all([
        optional("/alpha/billing/credits"),
        optional("/alpha/billing/subscriptions"),
    ]);
    const since = asString(asObject(subscription?.data)?.currentPeriodStart, 40);
    const usage = await optional("/alpha/usage/summary", since === undefined ? {} : { since });

    return normalizeCommandCode(whoami, credits, subscription, usage, capturedAt);
}

/**
 * Refresh every provider whose sign-in is stored: each answers for itself, so one failing never hides the others.
 * A credential with an expiry in the past is refused with why, in words for people.
 */
export async function queryAll(
    agentDir: string,
    ids: readonly string[] = SUPPORTED.map((target) => target.id),
): Promise<Record<string, ProviderQuota>> {
    const credentials = await readCredentials(agentDir);
    const secrets = Object.values(credentials).map((entry) => entry.token);
    const wanted = SUPPORTED.filter((target) => ids.includes(target.id));
    const results = await Promise.all(
        wanted.map(async (target): Promise<[string, ProviderQuota]> => {
            try {
                const credential = credentials[target.id];

                if (credential === undefined) {
                    throw new Error(`no sign-in for ${target.id} in Pi's auth store`);
                }

                if (credential.expiresAt !== undefined && credential.expiresAt < Date.now()) {
                    throw new Error(
                        `the sign-in expired ${new Date(credential.expiresAt).toLocaleString("en-US")} — renew it first (Menu → Providers)`,
                    );
                }

                return [
                    target.id,
                    {
                        report: await queryProvider(target, credential.token),
                        capturedAt: Date.now(),
                    },
                ];
            } catch (error) {
                return [
                    target.id,
                    {
                        error: redact(String(error).slice(0, ERROR_CHARS), secrets),
                        capturedAt: Date.now(),
                    },
                ];
            }
        }),
    );

    return Object.fromEntries(results);
}

// ─── Module sources: a provider a module reads itself (`host.registerQuotaSource`) ─

/**
 * A provider's quota that an extension module reads with its own means, such as a local client that keeps its own
 * sign-in. Pi's auth store has no sign-in for it; the module answers for itself.
 */
export type QuotaSource = {
    /** Lower-case letters, digits, and dashes; not a built-in provider's id. */
    id: string;
    displayName: string;
    /** The provider's report now. A failure or a timeout shows as that provider's error, never the others'. */
    read: (signal: AbortSignal) => Promise<UsageReport>;
};

export const SOURCE_ID = /^[a-z0-9][a-z0-9-]{0,39}$/u;
const UNITS: readonly UsageUnit[] = ["percent", "usd", "count"];
const NOTE_CHARS = 200;
const MAX_ROWS = 20;

/**
 * A module's report as the sheet and the tool may show it: only the fields they render, in their types, under the id
 * and name it registered. Anything else is dropped; a report with nothing to show is an error.
 */
export function checkedReport(
    source: Pick<QuotaSource, "id" | "displayName">,
    value: unknown,
    capturedAt: number,
): UsageReport {
    const row = asObject(value);

    if (row === undefined) {
        throw new Error("the module returned no report");
    }

    const buckets: UsageBucket[] = [];

    for (const each of Array.isArray(row.buckets) ? row.buckets.slice(0, MAX_ROWS) : []) {
        const bucket = asObject(each);
        const id = asString(bucket?.id, 60);
        const label = asString(bucket?.label, 80);
        const unit = UNITS.find((known) => known === bucket?.unit);

        // An id twice would share the sheet's row key and the warning's mark: the first one stays.
        if (
            bucket === undefined ||
            id === undefined ||
            label === undefined ||
            unit === undefined ||
            buckets.some((kept) => kept.id === id)
        ) {
            continue;
        }

        const used = asNumber(bucket.used);
        const remaining = asNumber(bucket.remaining);
        // A percentage is of 100, whether or not the module said so: the warning past 80% needs the limit.
        const limit = unit === "percent" ? 100 : asNumber(bucket.limit);
        const windowMinutes = asNonnegativeNumber(bucket.windowMinutes);
        const resetsAt = asEpochSeconds(bucket.resetsAt);

        buckets.push({
            id,
            label,
            unit,
            ...(used !== undefined ? { used } : {}),
            ...(remaining !== undefined ? { remaining } : {}),
            ...(limit !== undefined ? { limit } : {}),
            ...(windowMinutes !== undefined ? { windowMinutes } : {}),
            ...(resetsAt !== undefined ? { resetsAt } : {}),
        });
    }

    const metrics: UsageMetric[] = [];

    for (const each of Array.isArray(row.metrics) ? row.metrics.slice(0, MAX_ROWS) : []) {
        const metric = asObject(each);
        const id = asString(metric?.id, 60);
        const label = asString(metric?.label, 80);
        const value =
            typeof metric?.value === "number" && Number.isFinite(metric.value)
                ? metric.value
                : asString(metric?.value, 80);
        const unit = UNITS.find((known) => known === metric?.unit);

        if (
            id !== undefined &&
            label !== undefined &&
            value !== undefined &&
            !metrics.some((kept) => kept.id === id)
        ) {
            metrics.push({ id, label, value, ...(unit !== undefined ? { unit } : {}) });
        }
    }

    const notes = (Array.isArray(row.notes) ? row.notes.slice(0, MAX_ROWS) : [])
        .map((note) => asString(note, NOTE_CHARS))
        .filter((note): note is string => note !== undefined);
    const accountLabel = asString(row.accountLabel, 80);

    if (buckets.length === 0 && metrics.length === 0) {
        throw new Error("the module's report has no window or figure to show");
    }

    return {
        providerId: source.id,
        providerName: source.displayName,
        capturedAt,
        buckets,
        metrics,
        ...(accountLabel !== undefined ? { accountLabel } : {}),
        ...(notes.length > 0 ? { notes } : {}),
    };
}

/** Read each module source, each in its own time limit: one failing or hanging never holds up the others. */
export async function querySources(
    sources: readonly QuotaSource[],
    timeoutMs = REQUEST_MS,
): Promise<Record<string, ProviderQuota>> {
    const results = await Promise.all(
        sources.map(async (source): Promise<[string, ProviderQuota]> => {
            const controller = new AbortController();
            let timer: NodeJS.Timeout | undefined;

            try {
                const timeout = new Promise<never>((_, reject) => {
                    timer = setTimeout(() => {
                        controller.abort();
                        reject(new Error(`timed out after ${Math.round(timeoutMs / 1000)} s`));
                    }, timeoutMs);
                });
                const value = await Promise.race([source.read(controller.signal), timeout]);

                return [
                    source.id,
                    { report: checkedReport(source, value, Date.now()), capturedAt: Date.now() },
                ];
            } catch (error) {
                const reason = error instanceof Error ? error.message : String(error);

                return [
                    source.id,
                    {
                        error: `${source.displayName}: ${reason}`
                            .replace(/\s+/g, " ")
                            .slice(0, ERROR_CHARS),
                        capturedAt: Date.now(),
                    },
                ];
            } finally {
                clearTimeout(timer);
            }
        }),
    );

    return Object.fromEntries(results);
}

// ─── Rendering ────────────────────────────────────────────────────────────────

function windowLabel(minutes: number): string {
    if (minutes >= 1_440 && minutes % 1_440 === 0) {
        return `${minutes / 1_440}d window`;
    }

    return `${minutes >= 60 ? Math.round(minutes / 60) + "h" : Math.round(minutes) + "m"} window`;
}

function clockAt(epochSeconds: number | undefined, now: number): string {
    if (epochSeconds === undefined || epochSeconds <= 0) {
        return "";
    }

    const date = new Date(epochSeconds * 1000);
    const day = date.toLocaleDateString("en-US", { day: "numeric", month: "short" });
    const time = date.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit" });
    const year = date.getFullYear() === new Date(now).getFullYear() ? "" : ` ${date.getFullYear()}`;

    return `, resets ${day}${year} ${time}`;
}

function amount(value: number): string {
    return `$${value.toFixed(2)}`;
}

/** A whole quota snapshot as text: one block per provider, for Pi to pass on. */
export function renderQuota(
    providers: Record<string, ProviderQuota>,
    now: number,
    ids: readonly string[] = Object.keys(providers),
    names: Readonly<Record<string, string>> = {},
): string {
    const displayNameOf = (id: string): string => names[id] ?? builtInName(id);
    const blocks: string[] = [];

    for (const id of ids) {
        const quota = providers[id];

        if (quota === undefined) {
            continue;
        }

        if (quota.error !== undefined) {
            blocks.push(`${displayNameOf(id)}: not available — ${quota.error}`);
            continue;
        }

        const report = quota.report;

        if (report === undefined) {
            blocks.push(`${displayNameOf(id)}: not measured yet`);
            continue;
        }

        const lines: string[] = [];
        const captured = new Date(report.capturedAt).toLocaleTimeString("en-US", {
            hour: "2-digit",
            minute: "2-digit",
        });
        const whose = report.accountLabel ? ` — ${report.accountLabel}` : "";

        lines.push(`${report.providerName}${whose} (fresh ${captured})`);

        for (const bucket of report.buckets) {
            const resets = clockAt(bucket.resetsAt, now);
            let row: string;

            if (bucket.unit === "percent") {
                row = `  ${bucket.label}: ${bucket.used ?? 0}% used${resets}`;
            } else {
                row =
                    bucket.limit !== undefined
                        ? `  ${bucket.label}: ${amount(bucket.used ?? 0)} of ${amount(bucket.limit)} used${resets}`
                        : `  ${bucket.label}: ${amount(bucket.used ?? 0)} used${resets}`;
            }

            lines.push(row);
        }

        for (const metric of report.metrics) {
            const value =
                metric.unit === "usd" && typeof metric.value === "number"
                    ? amount(metric.value)
                    : metric.unit === "count" && typeof metric.value === "number"
                      ? metric.value.toLocaleString("en-US")
                      : String(metric.value);

            lines.push(`  ${metric.label}: ${value}`);
        }

        for (const note of report.notes ?? []) {
            lines.push(`  · ${note}`);
        }

        blocks.push(lines.join("\n"));
    }

    return blocks.join("\n\n");
}

function builtInName(id: string): string {
    return SUPPORTED.find((target) => target.id === id)?.displayName ?? id;
}
