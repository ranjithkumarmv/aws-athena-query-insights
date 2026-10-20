import { describeError, runFetch } from "./fetch.js";

const FETCH_KEYS = ["profile", "regions", "roleArns", "workgroups", "states", "days", "storeQueryText"];

/** Runs one fetch at a time, records it in fetch_runs, and fans events out to listeners (SSE, CLI). */
export class FetchManager {
    constructor(store) {
        this.store = store;
        this.current = null;
        this.listeners = new Set();
    }

    subscribe(fn) {
        this.listeners.add(fn);
        return () => this.listeners.delete(fn);
    }

    emit(event) {
        if (this.current) {
            if (event.type === "progress") this.current.progress = event;
            else this.current.log.push(event);
            if (this.current.log.length > 200) this.current.log.shift();
        }
        for (const fn of this.listeners) fn(event);
    }

    /** State to replay to a client that connects mid-run. */
    snapshot() {
        if (!this.current) return null;
        const { runId, startedAt, progress, log } = this.current;
        return { runId, startedAt, progress, log };
    }

    start(config) {
        if (this.current) throw Object.assign(new Error("A fetch is already running"), { status: 409 });
        const params = Object.fromEntries(FETCH_KEYS.map(k => [k, config[k]]));
        const runId = this.store.startRun(params);
        const controller = new AbortController();
        this.current = { runId, controller, startedAt: new Date().toISOString(), progress: null, log: [] };
        this.emit({ type: "start", runId, params });

        const done = (async () => {
            try {
                const stats = await runFetch(config, { store: this.store, signal: controller.signal, onEvent: e => this.emit(e) });
                const status = stats.warnings.length ? "completed_with_warnings" : "completed";
                this.store.finishRun(runId, { status, stats });
                this.emit({ type: "end", runId, status, stats });
                return { status, stats };
            } catch (e) {
                const status = controller.signal.aborted ? "cancelled" : "failed";
                const error = describeError(e);
                this.store.finishRun(runId, { status, error });
                this.emit({ type: "end", runId, status, error });
                return { status, error };
            } finally {
                this.current = null;
            }
        })();
        return { runId, done };
    }

    cancel() {
        if (!this.current) return false;
        this.current.controller.abort();
        return true;
    }
}
