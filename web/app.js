const { createApp, reactive } = Vue;

/* ───────────── helpers ───────────── */

async function api(path, options = {}) {
    const res = await fetch(path, {
        ...options,
        headers: options.body ? { "Content-Type": "application/json" } : {},
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.error || res.statusText);
    return body;
}

const splitList = text => String(text ?? "").split(/[\s,]+/).map(s => s.trim()).filter(Boolean);

const KB = 1024;
const UNITS = ["B", "KB", "MB", "GB", "TB", "PB"];

const fmt = {
    int: n => (n == null ? "–" : Number(n).toLocaleString()),
    compact: n => (n == null ? "–" : Intl.NumberFormat(undefined, { notation: "compact", maximumFractionDigits: 1 }).format(n)),
    usd(n) {
        if (n == null) return "–";
        if (n > 0 && n < 0.01) return "<$0.01";
        if (n >= 10000) return "$" + Intl.NumberFormat(undefined, { notation: "compact", maximumFractionDigits: 1 }).format(n);
        return "$" + n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    },
    bytes(n) {
        if (n == null) return "–";
        let i = 0;
        while (n >= KB && i < UNITS.length - 1) {
            n /= KB;
            i++;
        }
        return (i === 0 ? n.toFixed(0) : n.toFixed(n < 10 ? 2 : n < 100 ? 1 : 0)) + " " + UNITS[i];
    },
    ms(n) {
        if (n == null || !Number.isFinite(n)) return "–";
        if (n < 1000) return Math.round(n) + " ms";
        const s = n / 1000;
        if (s < 60) return s.toFixed(s < 10 ? 2 : 1) + " s";
        const m = Math.floor(s / 60);
        if (m < 60) return `${m}m ${Math.round(s % 60)}s`;
        return `${Math.floor(m / 60)}h ${m % 60}m`;
    },
    pct: n => (n == null ? "–" : (n < 10 ? n.toFixed(1) : n.toFixed(0)) + "%"),
    time: t => (t ? new Date(t).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" }) : "–"),
};

/** Server time buckets are already in local time; format them without re-shifting. */
function bucketLabel(t, kind, long = false) {
    if (kind === "instant") return new Date(t).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
    const d = new Date(t + (t.length === 10 ? "T00:00Z" : "Z"));
    if (kind === "hour") {
        return long
            ? d.toLocaleString(undefined, { timeZone: "UTC", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })
            : d.toLocaleString(undefined, { timeZone: "UTC", hour: "2-digit", minute: "2-digit" });
    }
    if (kind === "day") return d.toLocaleDateString(undefined, { timeZone: "UTC", month: "short", day: "numeric", ...(long ? { weekday: "short" } : {}) });
    return t;
}

const STATE_ICONS = { SUCCEEDED: "✓", FAILED: "✕", CANCELLED: "⊘", RUNNING: "▶", QUEUED: "…" };

/* ───────────── routing: #/page?filters or #/query/<id> ───────────── */

const RANGES = [
    { key: "24h", label: "24h", ms: 24 * 3600e3 },
    { key: "7d", label: "7 days", ms: 7 * 86400e3 },
    { key: "30d", label: "30 days", ms: 30 * 86400e3 },
    { key: "90d", label: "90 days", ms: 90 * 86400e3 },
    { key: "all", label: "All", ms: null },
];
const DIMS = [
    { key: "account", label: "Account", plural: "accounts" },
    { key: "region", label: "Region", plural: "regions" },
    { key: "workgroup", label: "Workgroup", plural: "workgroups" },
    { key: "database", label: "Database", plural: "databases" },
    { key: "state", label: "State", plural: "states" },
];
const PAGES = ["overview", "expensive", "slow", "failures", "query", "data"];

function parseHash() {
    const raw = location.hash.replace(/^#\/?/, "");
    const [path, qs = ""] = raw.split("?");
    const [page, ...rest] = path.split("/");
    const params = Object.fromEntries(new URLSearchParams(qs));
    return { page: PAGES.includes(page) ? page : "overview", id: rest.length ? decodeURIComponent(rest.join("/")) : null, params };
}

const route = reactive(parseHash());
window.addEventListener("hashchange", () => Object.assign(route, parseHash()));

const filterKeys = ["range", ...DIMS.map(d => d.key)];

/** The API query string for the current filters: from/to computed from the range preset. */
function apiQueryFor(params) {
    const q = new URLSearchParams();
    const range = RANGES.find(r => r.key === (params.range || "7d")) ?? RANGES[1];
    if (range.ms) {
        // Round to the minute so the query string is stable while the page is open.
        const to = Math.ceil(Date.now() / 60000) * 60000;
        q.set("from", new Date(to - range.ms).toISOString());
        q.set("to", new Date(to).toISOString());
    }
    for (const d of DIMS) if (params[d.key]) q.set(d.key, params[d.key]);
    q.set("tz", String(-new Date().getTimezoneOffset()));
    return q.toString();
}

function filterQueryString(params, override = {}) {
    const q = new URLSearchParams();
    for (const k of filterKeys) {
        const v = k in override ? override[k] : params[k];
        if (v) q.set(k, v);
    }
    return q.toString();
}

/** Global fetch progress, shared by the header pill and the Data page. */
const fetchState = reactive({ running: null, progress: null, log: [], lastEnd: null, percent: 0, listeners: new Set() });

function listenFetchEvents() {
    const es = new EventSource("/api/fetch/events");
    es.onmessage = msg => {
        const e = JSON.parse(msg.data);
        if (e.type === "snapshot") {
            fetchState.running = e.running;
            if (e.running) {
                fetchState.progress = e.running.progress;
                fetchState.log = e.running.log;
            }
        } else if (e.type === "start") {
            Object.assign(fetchState, { running: { runId: e.runId }, lastEnd: null, log: [], progress: null });
        } else if (e.type === "progress") {
            fetchState.progress = e;
        } else if (e.type === "log" || e.type === "warning") {
            fetchState.log = [...fetchState.log.slice(-99), e];
        } else if (e.type === "end") {
            fetchState.running = null;
            fetchState.lastEnd = e;
        }
        fetchState.percent = fetchState.progress?.percent ?? 0;
        for (const fn of fetchState.listeners) fn(e);
    };
}

/* ───────────── chart theming ───────────── */

function cssVar(name) {
    return getComputedStyle(document.documentElement).getPropertyValue("--" + name).trim();
}

function withAlpha(hex, alpha) {
    const n = parseInt(hex.slice(1), 16);
    return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
}

const darkQuery = matchMedia("(prefers-color-scheme: dark)");

/* ───────────── theme: system / light / dark ───────────── */

const THEME_KEY = "aqi-theme";
const THEMES = [
    { key: "light", label: "Light", icon: '<circle cx="10" cy="10" r="3.5"/><path d="M10 1.5v2.2M10 16.3v2.2M1.5 10h2.2M16.3 10h2.2M4 4l1.6 1.6M14.4 14.4 16 16M4 16l1.6-1.6M14.4 5.6 16 4"/>' },
    { key: "system", label: "System", icon: '<rect x="2.5" y="3.5" width="15" height="10" rx="1.5"/><path d="M7 17h6M10 13.5V17"/>' },
    { key: "dark", label: "Dark", icon: '<path d="M16.5 12.2A7 7 0 0 1 7.8 3.5a7 7 0 1 0 8.7 8.7Z"/>' },
];

function savedTheme() {
    try {
        const t = localStorage.getItem(THEME_KEY);
        return t === "light" || t === "dark" ? t : "system";
    } catch {
        return "system";
    }
}

function applyTheme(theme) {
    if (theme === "system") delete document.documentElement.dataset.theme;
    else document.documentElement.dataset.theme = theme;
    try {
        if (theme === "system") localStorage.removeItem(THEME_KEY);
        else localStorage.setItem(THEME_KEY, theme);
    } catch {
        /* storage blocked: the choice lasts for this page only */
    }
    window.dispatchEvent(new Event("aqi-theme"));
}

const FORMATTERS = { usd: fmt.usd, int: fmt.int, ms: fmt.ms, bytes: fmt.bytes, pct: fmt.pct };
const AXIS_FORMATTERS = {
    usd: v => (v >= 1000 ? "$" + fmt.compact(v) : "$" + (v < 1 && v > 0 ? v.toFixed(2) : Math.round(v * 100) / 100)),
    int: v => fmt.compact(v),
    ms: v => (v === 0 ? "0" : fmt.ms(v)),
    bytes: v => (v === 0 ? "0" : fmt.bytes(v)),
    pct: v => v + "%",
};

/* ───────────── components ───────────── */

const KpiTile = {
    template: "#tpl-kpi",
    props: { label: String, value: String, delta: Number, goodWhen: String, previous: String, hint: String },
    computed: {
        deltaClass() {
            if (!this.goodWhen || Math.abs(this.delta) < 0.1) return "neutral";
            const up = this.delta > 0;
            return (this.goodWhen === "up") === up ? "good" : "bad";
        },
    },
};

const ChartCard = {
    template: "#tpl-chart",
    props: {
        title: String,
        subtitle: String,
        type: { type: String, default: "bar" },
        horizontal: Boolean,
        points: Boolean,
        labels: { type: Array, default: () => [] },
        labelKind: { type: String, default: "text" },
        series: { type: Array, default: () => [] },
        format: { type: String, default: "int" },
    },
    data: () => ({ showTable: false }),
    computed: {
        boxHeight() {
            // Horizontal bars: one ≤24px bar + gap per row, plus the axis band.
            return this.horizontal ? Math.max(140, this.labels.length * 30 + 40) : 240;
        },
    },
    watch: {
        labels() { this.draw(); },
        series: { handler() { this.draw(); }, deep: true },
    },
    mounted() {
        this.draw();
        this.onTheme = () => this.draw();
        darkQuery.addEventListener("change", this.onTheme);
        window.addEventListener("aqi-theme", this.onTheme);
    },
    unmounted() {
        darkQuery.removeEventListener("change", this.onTheme);
        window.removeEventListener("aqi-theme", this.onTheme);
        this.chart?.destroy();
    },
    methods: {
        fmtValue(v) {
            return (FORMATTERS[this.format] ?? fmt.int)(v);
        },
        labelText(l) {
            return bucketLabel(l, this.labelKind, true);
        },
        draw() {
            this.chart?.destroy();
            this.chart = null;
            if (!this.labels.length || !this.$refs.canvas) return;
            const ink = { text: cssVar("text"), muted: cssVar("axis-text"), grid: cssVar("grid"), baseline: cssVar("baseline"), card: cssVar("card"), border: cssVar("border") };
            const horizontal = this.horizontal;
            const isLine = this.type === "line";
            const datasets = this.series.map(s => {
                const color = cssVar(s.color || "series-1");
                return isLine
                    ? {
                          label: s.label, data: s.data, borderColor: color, backgroundColor: color,
                          borderWidth: 2, borderJoinStyle: "round", borderCapStyle: "round", tension: 0,
                          pointRadius: this.points && this.labels.length <= 60 ? 4 : 0, pointHoverRadius: 5, pointBorderColor: ink.card, pointBorderWidth: 2,
                          spanGaps: true,
                          ...(this.series.length === 1 ? { fill: "origin", backgroundColor: withAlpha(color, 0.1) } : {}),
                      }
                    : {
                          label: s.label, data: s.data, backgroundColor: color, hoverBackgroundColor: color,
                          maxBarThickness: 24, borderRadius: 4, borderSkipped: "start", categoryPercentage: 0.8, barPercentage: 0.9,
                      };
            });
            const valueAxis = {
                beginAtZero: true,
                grid: { color: ink.grid, lineWidth: 1, drawTicks: false },
                border: { display: false },
                ticks: { color: ink.muted, padding: 6, maxTicksLimit: 5, callback: v => (AXIS_FORMATTERS[this.format] ?? fmt.compact)(v) },
            };
            const kind = this.labelKind;
            const categoryAxis = {
                grid: { display: false },
                border: { color: ink.baseline },
                ticks: {
                    color: ink.muted,
                    // Thin out time labels; every category label must stay visible.
                    autoSkip: kind === "day" || kind === "hour" || kind === "instant",
                    maxRotation: 0,
                    autoSkipPadding: 12,
                    callback(value) {
                        const l = this.getLabelForValue(value);
                        const text = bucketLabel(l, kind);
                        return horizontal && text.length > 22 ? text.slice(0, 21) + "…" : text;
                    },
                },
            };
            this.chart = new Chart(this.$refs.canvas, {
                type: isLine ? "line" : "bar",
                data: { labels: this.labels, datasets },
                options: {
                    responsive: true,
                    maintainAspectRatio: false,
                    animation: matchMedia("(prefers-reduced-motion: reduce)").matches ? false : { duration: 250 },
                    indexAxis: horizontal ? "y" : "x",
                    interaction: { mode: "index", intersect: false, axis: horizontal ? "y" : "x" },
                    scales: horizontal ? { x: valueAxis, y: categoryAxis } : { x: categoryAxis, y: valueAxis },
                    plugins: {
                        legend: {
                            display: datasets.length > 1,
                            position: "top",
                            align: "end",
                            labels: {
                                color: ink.text,
                                boxWidth: isLine ? 14 : 10,
                                boxHeight: isLine ? 3 : 10,
                                // Solid key in the series colour (line datasets may carry a translucent fill).
                                generateLabels: chart => chart.data.datasets.map((d, i) => ({
                                    text: d.label, fillStyle: d.borderColor ?? d.backgroundColor, strokeStyle: "transparent", lineWidth: 0,
                                    fontColor: ink.text, hidden: !chart.isDatasetVisible(i), datasetIndex: i,
                                })),
                            },
                        },
                        tooltip: {
                            backgroundColor: ink.card,
                            titleColor: ink.text,
                            bodyColor: ink.text,
                            borderColor: ink.border,
                            borderWidth: 1,
                            padding: 10,
                            boxPadding: 4,
                            usePointStyle: true,
                            callbacks: {
                                title: items => bucketLabel(items[0].label, kind, true),
                                label: item => ` ${item.dataset.label}: ${this.fmtValue(item.raw)}`,
                            },
                        },
                    },
                },
            });
        },
    },
};

const SqlText = { template: "#tpl-sql", props: { text: String, hash: String } };

const PhaseBars = {
    template: "#tpl-phases",
    props: { phases: Object },
    data: () => ({ fmt }),
    computed: {
        rows() {
            const p = this.phases ?? {};
            const rows = [
                { key: "queue_ms", label: "Queued" },
                { key: "preprocessing_ms", label: "Pre-processing" },
                { key: "planning_ms", label: "Planning" },
                { key: "engine_ms", label: "Engine" },
                { key: "processing_ms", label: "Writing results" },
            ].map(r => ({ ...r, ms: p[r.key] ?? 0 }));
            // Athena's engine time includes planning; show planning separately when present.
            const [, , planning, engine] = rows;
            if (planning.ms && engine.ms >= planning.ms) engine.ms -= planning.ms;
            const total = rows.reduce((s, r) => s + r.ms, 0);
            return total ? rows.map(r => ({ ...r, pct: (r.ms / total) * 100 })) : [];
        },
    },
};

const LoadingState = { template: "#tpl-loading", props: { loading: Boolean, error: String, first: Boolean } };

/** Shared behaviour for analysis pages: load `endpoint` whenever the filter query changes. */
const analysisPage = endpoint => ({
    props: { query: String },
    data: () => ({ data: null, loading: false, error: null, fmt }),
    computed: {
        buckets() { return this.data?.series?.buckets ?? []; },
        times() { return this.buckets.map(b => b.t); },
        gran() { return this.data?.series?.granularity ?? "day"; },
    },
    watch: { query: { handler: "load", immediate: true } },
    mounted() {
        this.onFetch = e => e.type === "end" && this.load();
        fetchState.listeners.add(this.onFetch);
    },
    unmounted() {
        fetchState.listeners.delete(this.onFetch);
    },
    methods: {
        async load() {
            const seq = (this.seq = (this.seq ?? 0) + 1);
            this.loading = true;
            this.error = null;
            try {
                const data = await api(`/api/${endpoint}?${this.query}`);
                if (seq === this.seq) this.data = data;
            } catch (e) {
                if (seq === this.seq) this.error = e.message;
            } finally {
                if (seq === this.seq) this.loading = false;
            }
        },
        open(id) {
            location.hash = "#/query/" + encodeURIComponent(id);
        },
        withParam(key, value) {
            return filterQueryString(route.params, { [key]: value });
        },
    },
});

const OverviewPage = {
    template: "#tpl-overview",
    mixins: [analysisPage("overview")],
    computed: {
        k() { return this.data.kpis; },
        p() { return this.data.previous; },
    },
    methods: {
        delta(key) {
            const a = this.k?.[key];
            const b = this.p?.[key];
            if (a == null || b == null || b === 0) return null;
            return ((a - b) / b) * 100;
        },
    },
};
const ExpensivePage = { template: "#tpl-expensive", mixins: [analysisPage("expensive")] };
const SlowPage = { template: "#tpl-slow", mixins: [analysisPage("slow")] };
const FailuresPage = { template: "#tpl-failures", mixins: [analysisPage("failures")] };

const QueryPage = {
    template: "#tpl-query",
    props: { id: String },
    data: () => ({ data: null, loading: false, error: null, copied: false, fmt }),
    computed: {
        q() { return this.data.query; },
        runsAsc() { return [...this.data.runs].reverse(); },
        consoleUrl() {
            const r = encodeURIComponent(this.q.region);
            return `https://${r}.console.aws.amazon.com/athena/home?region=${r}#/query-editor/history/${encodeURIComponent(this.q.query_execution_id)}`;
        },
    },
    watch: { id: { handler: "load", immediate: true } },
    methods: {
        async load() {
            this.loading = true;
            this.error = null;
            try {
                this.data = await api("/api/query/" + encodeURIComponent(this.id));
                this.$nextTick(() => window.scrollTo(0, 0));
            } catch (e) {
                this.error = e.message;
            } finally {
                this.loading = false;
            }
        },
        open(id) {
            location.hash = "#/query/" + encodeURIComponent(id);
        },
        back() {
            history.length > 1 ? history.back() : (location.hash = "#/overview");
        },
        stateIcon: s => STATE_ICONS[s] ?? "",
        async copy() {
            try {
                await navigator.clipboard.writeText(this.q.query_text);
                this.copied = true;
                setTimeout(() => (this.copied = false), 1500);
            } catch {
                /* clipboard blocked; the text is selectable */
            }
        },
    },
};

const PAGE_INFO = {
    overview: { title: "Overview", description: "Spend, volume, failures and latency across your Athena workgroups." },
    expensive: { title: "Expensive queries", description: "Where the data-scanned bill comes from, grouped by query shape." },
    slow: { title: "Slow queries", description: "Queue and engine time, and the queries that use the most of it." },
    failures: { title: "Failures", description: "What failed, how often, and the error behind it." },
    query: { title: "Query detail", description: "One execution and every stored run of the same SQL." },
    data: { title: "Data & settings", description: "Fetch query history from AWS and choose what to collect." },
};

const SOURCE_LABELS = { default: "default", "aws-env": "AWS env", file: "config file", ui: "saved", env: "env var", cli: "CLI flag" };

const DataPage = {
    template: "#tpl-data",
    emits: ["changed"],
    components: {
        "src-badge": {
            props: ["s"],
            template: `<span class="badge" :class="s?.key" :title="s?.title">{{ s?.label }}</span>`,
        },
    },
    data: () => ({
        fmt,
        config: {},
        status: {},
        profiles: [],
        form: { profile: "", regions: "", workgroups: "", roleArns: "", states: [], days: 7, pricePerTb: 5, storeQueryText: true },
        busy: false,
        savedMsg: "",
        saveError: "",
        wgOptions: [],
        wgLoading: false,
        wgError: "",
    }),
    computed: {
        inv() { return this.status.inventory ?? {}; },
        running() { return fetchState.running; },
        progress() { return fetchState.progress; },
        log() { return fetchState.log; },
        lastEnd() { return fetchState.lastEnd; },
        percent() {
            if (this.lastEnd && !this.running) return this.lastEnd.status.startsWith("completed") ? 100 : this.progress?.percent ?? 0;
            return this.progress?.percent ?? 0;
        },
        pstats() {
            return this.running ? this.progress?.stats : this.lastEnd?.stats ?? this.progress?.stats;
        },
    },
    async mounted() {
        this.onFetch = e => {
            if (e.type === "start" || e.type === "end") this.loadStatus();
            if (e.type === "end") this.$emit("changed");
        };
        fetchState.listeners.add(this.onFetch);
        await Promise.all([this.loadConfig(), this.loadStatus(), this.loadProfiles()]);
    },
    unmounted() {
        fetchState.listeners.delete(this.onFetch);
    },
    methods: {
        async loadConfig() {
            this.config = await api("/api/config");
            const v = this.config.values;
            this.form = {
                profile: v.profile ?? "",
                regions: v.regions.join(", "),
                workgroups: v.workgroups.join(", "),
                roleArns: v.roleArns.join("\n"),
                states: [...v.states],
                days: v.days,
                pricePerTb: v.pricePerTb,
                storeQueryText: v.storeQueryText,
            };
        },
        async loadStatus() {
            this.status = await api("/api/status");
        },
        async loadProfiles() {
            this.profiles = (await api("/api/aws/profiles")).profiles;
        },
        isLocked(key) {
            return this.config.locked?.includes(key);
        },
        src(key) {
            const s = this.config.sources?.[key];
            if (!s) return null;
            const f = this.config.fields?.[key];
            const title = s === "env" ? `Set by ${f.env}` : s === "cli" ? `Set by ${f.flag}` : `Value from ${SOURCE_LABELS[s]}`;
            return { key: s, label: SOURCE_LABELS[s], title };
        },
        formValues() {
            const all = {
                profile: this.form.profile || null,
                regions: splitList(this.form.regions),
                workgroups: splitList(this.form.workgroups),
                roleArns: splitList(this.form.roleArns),
                states: this.form.states,
                days: this.form.days,
                pricePerTb: this.form.pricePerTb,
                storeQueryText: this.form.storeQueryText,
            };
            for (const k of this.config.locked ?? []) delete all[k];
            return all;
        },
        async saveSettings() {
            this.busy = true;
            this.saveError = this.savedMsg = "";
            try {
                await api("/api/config", { method: "PUT", body: JSON.stringify(this.formValues()) });
                await Promise.all([this.loadConfig(), this.loadStatus()]);
                this.savedMsg = "Saved";
                setTimeout(() => (this.savedMsg = ""), 2500);
                this.$emit("changed");
            } catch (e) {
                this.saveError = e.message;
            } finally {
                this.busy = false;
            }
        },
        async loadWorkgroups() {
            this.wgLoading = true;
            this.wgError = "";
            try {
                const region = splitList(this.form.regions)[0] ?? "";
                const r = await api("/api/aws/workgroups?region=" + encodeURIComponent(region));
                this.wgOptions = r.workgroups;
            } catch (e) {
                this.wgError = e.message;
            } finally {
                this.wgLoading = false;
            }
        },
        wgSelected(name) {
            return splitList(this.form.workgroups).includes(name);
        },
        toggleWg(name) {
            const cur = splitList(this.form.workgroups);
            this.form.workgroups = (cur.includes(name) ? cur.filter(w => w !== name) : [...cur, name]).join(", ");
        },
        async startFetch() {
            this.busy = true;
            this.saveError = "";
            try {
                // Save first so the run uses what's on screen.
                await api("/api/config", { method: "PUT", body: JSON.stringify(this.formValues()) });
                await this.loadConfig();
                await api("/api/fetch", { method: "POST", body: "{}" });
            } catch (e) {
                this.saveError = e.message;
            } finally {
                this.busy = false;
            }
        },
        async cancelFetch() {
            await api("/api/fetch/cancel", { method: "POST", body: "{}" });
        },
        list(arr, empty) {
            return arr?.length ? arr.join(", ") : empty;
        },
        statusLabel(s) {
            return { completed: "Completed", completed_with_warnings: "Completed with warnings", failed: "Failed", cancelled: "Cancelled", running: "Running", abandoned: "Interrupted" }[s] ?? s;
        },
        range(t) {
            return t?.first_at ? `${fmt.time(t.first_at)} → ${fmt.time(t.last_at)}` : "–";
        },
    },
};

/* ───────────── root ───────────── */

createApp({
    components: {
        "overview-page": OverviewPage,
        "expensive-page": ExpensivePage,
        "slow-page": SlowPage,
        "failures-page": FailuresPage,
        "query-page": QueryPage,
        "data-page": DataPage,
    },
    data: () => ({
        route,
        fetchState,
        fmt,
        ranges: RANGES,
        dims: DIMS,
        filterOptions: {},
        hasData: true,
        meta: {},
        theme: savedTheme(),
        themes: THEMES,
        tabs: [
            { page: "overview", label: "Overview" },
            { page: "expensive", label: "Expensive" },
            { page: "slow", label: "Slow" },
            { page: "failures", label: "Failures" },
        ],
    }),
    computed: {
        apiQuery() {
            return apiQueryFor(this.route.params);
        },
        filterQuery() {
            const q = filterQueryString(this.route.params);
            return q ? "?" + q : "";
        },
        pageInfo() {
            return PAGE_INFO[this.route.page];
        },
        activeRange() {
            return RANGES.some(r => r.key === this.route.params.range) ? this.route.params.range : "7d";
        },
        hasDimFilter() {
            return DIMS.some(d => this.route.params[d.key]);
        },
    },
    async mounted() {
        listenFetchEvents();
        fetchState.listeners.add(e => e.type === "end" && this.loadFilterOptions());
        api("/api/meta").then(m => (this.meta = m)).catch(() => {});
        await this.loadFilterOptions();
    },
    methods: {
        async loadFilterOptions() {
            this.filterOptions = await api("/api/filters");
            this.hasData = (this.filterOptions.range?.queries ?? 0) > 0;
        },
        setTheme(theme) {
            this.theme = theme;
            applyTheme(theme);
        },
        go(page) {
            location.hash = "#/" + page;
        },
        setParam(key, value) {
            const page = route.page === "query" ? "overview" : route.page;
            const q = filterQueryString(route.params, { [key]: value });
            location.hash = `#/${page}${q ? "?" + q : ""}`;
        },
        clearFilters() {
            const q = filterQueryString({ range: route.params.range });
            location.hash = `#/${route.page}${q ? "?" + q : ""}`;
        },
    },
})
    .component("kpi-tile", KpiTile)
    .component("chart-card", ChartCard)
    .component("sql-text", SqlText)
    .component("phase-bars", PhaseBars)
    .component("loading-state", LoadingState)
    .mount("#app");
