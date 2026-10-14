// Usage: what Pi's sessions here spent, by window, person, and model, and each provider's own quota.
import { h } from "preact";
import { useEffect, useState } from "preact/hooks";
import { api, attempt, closeSheet } from "../store.js";
import { html, Loader, Sheet } from "../ui.js";

/** While the sheet is open, it asks again after this long. */
const REFRESH_MS = 60_000;

const WINDOWS = [
    { id: "5h", label: "5h" },
    { id: "24h", label: "24h" },
    { id: "7d", label: "7d" },
    { id: "30d", label: "30d" },
    { id: "all", label: "All" },
];

const money = (amount) => `$${amount.toFixed(2)}`;

/** Tokens as people read them: billions, millions, thousands — not 42343594. */
function tokens(amount) {
    if (amount >= 1e9) {
        return `${(amount / 1e9).toFixed(2)}B`;
    }

    if (amount >= 1e6) {
        return `${(amount / 1e6).toFixed(2)}M`;
    }

    if (amount >= 1e3) {
        return `${(amount / 1e3).toFixed(1)}k`;
    }

    return String(amount);
}

/** When a reset time is, as people say it: today without the day, else the day and hour. */
function resetAt(seconds) {
    if (!seconds) {
        return "";
    }

    const at = new Date(seconds * 1000);
    const now = new Date();
    const time = at.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    const day = at.toLocaleDateString([], { day: "numeric", month: "short" });

    return `${at.toDateString() === now.toDateString() ? "today" : day} ${time}`;
}

/** One number with what it is, as the old panel's cards were. */
function Card({ label, value, note }) {
    return h(
        "div",
        { class: "usage-card" },
        h("div", { class: "usage-card-label" }, label),
        h("div", { class: "usage-card-value" }, value),
        note !== undefined && h("div", { class: "muted small" }, note),
    );
}

/** A window's cards, from its summary. */
function Cards({ window: view }) {
    const { cards } = view;
    const inTokens = view.models.reduce(
        (sum, model) => sum + model.input + model.cacheRead + model.cacheWrite,
        0,
    );
    const outTokens = view.models.reduce((sum, model) => sum + model.output, 0);

    return h(
        "div",
        { class: "usage-cards" },
        h(Card, {
            label: "Tokens",
            value: tokens(cards.tokens),
            note: `in ${tokens(inTokens)} · out ${tokens(outTokens)}`,
        }),
        h(Card, {
            label: "Cache hit rate",
            value: cards.cacheRate !== undefined ? `${Math.round(cards.cacheRate * 100)}%` : "—",
        }),
        h(Card, { label: "Cost (est.)", value: money(cards.cost) }),
        h(Card, {
            label: "API calls",
            value: cards.calls.toLocaleString(),
            note: "usage-bearing model calls",
        }),
        h(Card, {
            label: "Sessions",
            value: String(cards.sessions),
            note: "with activity in range",
        }),
    );
}

/** One window's bar: what share of its limit is gone, and when it resets. */
function QuotaBar({ bucket }) {
    const used = bucket.used ?? 0;
    const share =
        bucket.unit === "percent"
            ? used / 100
            : bucket.limit !== undefined && bucket.limit > 0
              ? used / bucket.limit
              : 0;
    const shareText =
        bucket.unit === "percent"
            ? `${Math.round(used)}% used`
            : `$${used.toFixed(2)}${bucket.limit !== undefined ? ` of $${bucket.limit.toFixed(2)}` : ""}`;
    const resets = resetAt(bucket.resetsAt);

    return h(
        "div",
        { class: "usage-bar-row" },
        h(
            "div",
            { class: "usage-bar-labels" },
            h("span", null, bucket.label),
            h("span", { class: "muted small" }, shareText + (resets ? ` · resets ${resets}` : "")),
        ),
        h(
            "div",
            { class: "usage-bar" },
            h("div", {
                class: `usage-bar-fill${share >= 0.8 ? " hot" : ""}`,
                style: `width: ${Math.min(100, Math.round(share * 100))}%`,
            }),
        ),
    );
}

/** A provider's own quota: its windows as bars, and its plan and period lines below. */
function ProviderBlock({ quota }) {
    const report = quota.report;

    if (quota.error !== undefined || report === undefined) {
        return h(
            "div",
            { class: "usage-provider" },
            h("div", { class: "muted small" }, quota.error ?? "not measured yet"),
        );
    }

    const name = `${report.providerName}${report.accountLabel ? ` — ${report.accountLabel}` : ""}`;
    const at = new Date(report.capturedAt).toLocaleTimeString([], {
        hour: "2-digit",
        minute: "2-digit",
    });
    const lines = [
        ...(report.metrics ?? []).map((metric) =>
            metric.unit === "usd" && typeof metric.value === "number"
                ? `${metric.label}: ${money(metric.value)}`
                : `${metric.label}: ${typeof metric.value === "number" ? metric.value.toLocaleString() : metric.value}`,
        ),
        ...(report.notes ?? []),
    ].join(" · ");

    return h(
        "div",
        { class: "usage-provider" },
        h(
            "div",
            { class: "usage-provider-name" },
            h("span", { class: "usage-dot" }),
            name,
            h("span", { class: "muted small grow" }, at),
        ),
        (report.buckets ?? []).map((bucket) => h(QuotaBar, { key: bucket.id, bucket })),
        lines !== "" && h("div", { class: "muted small" }, lines),
    );
}

/** What the sessions here made, by model and by person, in the chosen window. */
function LocalRows({ window: view }) {
    const line = (cell) =>
        `${cell.calls.toLocaleString()} calls · ${tokens(
            cell.input + cell.output + cell.cacheRead + cell.cacheWrite,
        )} tok${cell.cost > 0 ? ` · ${money(cell.cost)}` : ""}`;

    return [
        h(
            "div",
            { class: "group", key: "models" },
            h("div", { class: "group-title" }, "Models"),
            view.models.length === 0 &&
                h("div", { class: "muted small" }, "Nothing in this range yet."),
            view.models
                .slice(0, 12)
                .map((model) =>
                    h(
                        "div",
                        { class: "spend-row", key: model.key || "-" },
                        h("span", { class: "grow" }, model.key || "(unknown)"),
                        h("span", { class: "mono" }, line(model)),
                    ),
                ),
        ),
        h(
            "div",
            { class: "group", key: "people" },
            h("div", { class: "group-title" }, "People"),
            view.people.map((person) =>
                h(
                    "div",
                    { class: "spend-row", key: person.id || person.name },
                    h("span", { class: "grow" }, person.name),
                    h("span", { class: "mono" }, line(person)),
                ),
            ),
        ),
    ];
}

/** The usage sheet: a window switcher, the cards, the providers' live quota, and the local rows. */
export function UsageSheet() {
    const [windowId, setWindowId] = useState("24h");
    const [data, setData] = useState(null);
    const [busy, setBusy] = useState(false);

    const load = (force) =>
        attempt(async () => {
            setBusy(true);
            setData(await api("usage", force ? { force: true } : undefined));
        }).finally(() => setBusy(false));

    useEffect(() => {
        load(false);
        const timer = setInterval(() => load(true), REFRESH_MS);

        return () => clearInterval(timer);
    }, []);

    // A cold server has no quota yet: the first view asks the providers at once.
    useEffect(() => {
        if (data !== null && Object.keys(data.quota ?? {}).length === 0) {
            load(true);
        }
    }, [data]);

    const view = data?.windows?.[windowId];

    return html`<${Sheet} title="Usage" onClose=${closeSheet}>
        ${data === null && html`<${Loader} label="Counting it up" />`}
        ${
            data &&
            html`<div class="segmented">
                    ${WINDOWS.map(
                        (spec) => html`<button
                            key=${spec.id}
                            class=${spec.id === windowId ? "on" : ""}
                            onClick=${() => setWindowId(spec.id)}
                        >
                            ${spec.label}
                        </button>`,
                    )}
                    <button class=${busy ? "on" : ""} onClick=${() => load(true)} disabled=${busy}>
                        Refresh
                    </button>
                </div>
                ${view && html`<${Cards} window=${view} key=${`cards-${windowId}`} />`}
                <div class="group">
                    <div class="group-title">Live quota</div>
                    ${
                        Object.entries(data.quota ?? {}).length === 0 &&
                        html`<div class="muted small">No provider's usage endpoint has answered yet.</div>`
                    }
                    ${Object.entries(data.quota ?? {}).map(([id, quota]) =>
                        h(ProviderBlock, { key: id, quota }),
                    )}
                </div>
                ${view && html`<${LocalRows} window=${view} key=${`rows-${windowId}`} />`}`
        }
    <//>`;
}
