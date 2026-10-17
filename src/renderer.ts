import { createHash } from "node:crypto";
import { existsSync, promises as fs, readdirSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { prepareSource } from "./source.ts";
import { ManimWorker } from "./worker-client.ts";

export type Quality = "l" | "m" | "h" | "p" | "k";

/** What to render: a manim quality preset, optionally with a frame rate override. */
export interface Variant {
    quality: Quality;
    fps?: number;
}

/** Fast 480p15 render shown first above Low quality, and what render-ahead produces. */
export const DRAFT: Variant = { quality: "l" };

interface Job {
    promise: Promise<string>;
    abort: AbortController;
    refs: number;
}

// ponytail: measured on a 16-core M4 Max, 4 parallel finished a 4-block note 28% sooner but showed the
// first block 50% later (renders slow each other down); 2 favours what's on screen.
const MAX_PARALLEL = 2;

/**
 * Renders manim code to a media file in `cacheDir`, named by a hash of code + variant,
 * so each animation is rendered once and then served from disk (offline, instant).
 */
export class ManimRenderer {
    private cache = new Map<string, string>();
    private jobs = new Map<string, Job>();
    private active = 0;
    private waiting: (() => void)[] = [];
    private worker: ManimWorker;
    /** The render-ahead in flight, and render-ahead results no block has asked for yet. */
    private speculation?: { key: string; abort: AbortController };
    private unclaimed = new Set<string>();

    constructor(
        private cacheDir: string,
        workerFile: string,
        manimPath: () => string,
    ) {
        this.worker = new ManimWorker(workerFile, manimPath);
        if (!existsSync(cacheDir)) return;
        for (const name of readdirSync(cacheDir)) this.cache.set(path.parse(name).name, name);
    }

    key(code: string, variant: Variant): string {
        return createHash("sha1")
            .update(`${variant.quality}\0${variant.fps ?? ""}\0${code}`)
            .digest("hex")
            .slice(0, 16);
    }

    /** Cached file name for this code, if it was rendered before. */
    cached(code: string, variant: Variant): string | undefined {
        const key = this.key(code, variant);
        this.unclaimed.delete(key);
        return this.cache.get(key);
    }

    /** Starts the Python worker early so the first render doesn't pay for `import manim`. */
    warm(): void {
        this.worker.start().catch(() => {});
    }

    /** Resolves to the installed manim version, or rejects with why manim can't run. */
    version(): Promise<string> {
        return this.worker.start();
    }

    /** Number and total size of cached renders. */
    async cacheSize(): Promise<{ files: number; bytes: number }> {
        const stats = await Promise.all(
            [...this.cache.values()].map((name) => fs.stat(path.join(this.cacheDir, name)).catch(() => undefined)),
        );
        const present = stats.filter((stat) => stat !== undefined);
        return { files: present.length, bytes: present.reduce((sum, stat) => sum + stat.size, 0) };
    }

    /**
     * Resolves to the cached file name. Identical blocks share one render; the render is
     * killed once every caller has aborted (e.g. the note was closed or the block edited).
     */
    render(code: string, variant: Variant, signal: AbortSignal): Promise<string> {
        const key = this.key(code, variant);
        this.unclaimed.delete(key);
        return this.join(key, code, variant, signal);
    }

    /**
     * Renders `code` ahead of time while the user is still typing, so closing the block finds it cached.
     * Replaces the previous render-ahead; if no block claimed that one, it is cancelled and its file deleted.
     */
    speculate(code: string, variant: Variant): void {
        const key = this.key(code, variant);
        if (this.speculation?.key === key) return;
        this.cancelSpeculation();
        if (this.cache.has(key)) return;
        const abort = new AbortController();
        this.speculation = { key, abort };
        this.unclaimed.add(key);
        this.join(key, code, variant, abort.signal).catch(() => {});
    }

    cancelSpeculation(): void {
        const current = this.speculation;
        if (!current) return;
        this.speculation = undefined;
        current.abort.abort();
        const file = this.cache.get(current.key);
        if (this.unclaimed.delete(current.key) && file) {
            this.cache.delete(current.key);
            fs.rm(path.join(this.cacheDir, file), { force: true }).catch(() => {});
        }
    }

    async clear(): Promise<void> {
        this.cancelSpeculation();
        for (const job of this.jobs.values()) job.abort.abort();
        this.cache.clear();
        await fs.rm(this.cacheDir, { recursive: true, force: true });
    }

    stop(): void {
        this.cancelSpeculation();
        for (const job of this.jobs.values()) job.abort.abort();
        this.worker.stop();
    }

    private join(key: string, code: string, variant: Variant, signal: AbortSignal): Promise<string> {
        let job = this.jobs.get(key);
        // an aborted job lingers in the map until its promise settles; joining it would only yield an AbortError
        if (!job || job.abort.signal.aborted) {
            const abort = new AbortController();
            const created: Job = {
                abort,
                refs: 0,
                promise: this.withSlot(() => this.run(key, code, variant, abort.signal)).finally(() => {
                    if (this.jobs.get(key) === created) this.jobs.delete(key);
                }),
            };
            job = created;
            this.jobs.set(key, created);
        }
        const current = job;
        current.refs++;
        signal.addEventListener(
            "abort",
            () => {
                current.refs--;
                if (current.refs === 0) current.abort.abort();
            },
            { once: true },
        );
        return current.promise;
    }

    private async withSlot<T>(fn: () => Promise<T>): Promise<T> {
        // A finishing job hands its slot straight to the next waiter, so `active` never overshoots.
        if (this.active >= MAX_PARALLEL) await new Promise<void>((resolve) => this.waiting.push(resolve));
        else this.active++;
        try {
            return await fn();
        } finally {
            const next = this.waiting.shift();
            if (next) next();
            else this.active--;
        }
    }

    private async run(key: string, code: string, variant: Variant, signal: AbortSignal): Promise<string> {
        signal.throwIfAborted();
        const work = await fs.mkdtemp(path.join(os.tmpdir(), "obsidian-manim-"));
        try {
            const { source, scene } = prepareSource(code);
            const output = await this.worker.render(
                { source, scene, quality: variant.quality, fps: variant.fps ?? null, dir: work },
                signal,
            );
            // cancelled after the worker finished: nobody wants this file, so don't cache it
            signal.throwIfAborted();
            const name = key + path.extname(output);
            await fs.mkdir(this.cacheDir, { recursive: true });
            // copy, not rename: the temp dir is often on a different volume than the vault
            await fs.copyFile(output, path.join(this.cacheDir, name));
            this.cache.set(key, name);
            return name;
        } finally {
            await fs.rm(work, { recursive: true, force: true });
        }
    }
}
