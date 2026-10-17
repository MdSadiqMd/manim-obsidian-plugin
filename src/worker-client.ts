import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { closeSync, existsSync, openSync, readSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createInterface } from "node:readline";

/** One render request for worker.py; `dir` is a scratch directory the worker renders into. */
export interface RenderJob {
    source: string;
    scene: string;
    quality: string;
    fps: number | null;
    dir: string;
}

type WorkerMessage = { ready: true; version: string } | { id: string; file: string } | { id: string; error: string };

interface Waiter {
    resolve: (file: string) => void;
    reject: (err: Error) => void;
}

// Obsidian launched from Finder/Dock gets a minimal PATH, so manim, ffmpeg and LaTeX would not be found.
const EXTRA_PATH = [
    path.join(os.homedir(), ".local", "bin"),
    "/opt/homebrew/bin",
    "/usr/local/bin",
    "/Library/TeX/texbin",
];
const SEARCH_PATH = [process.env.PATH, ...EXTRA_PATH].filter(Boolean).join(path.delimiter);

/** Client for worker.py: one long-lived Python process with manim imported, forking per render. */
export class ManimWorker {
    private proc?: ChildProcessWithoutNullStreams;
    /** Resolves to the manim version once the worker has imported it. */
    private ready?: Promise<string>;
    /** The manim setting the running worker was started with. */
    private command?: string;
    private pending = new Map<string, Waiter>();
    private nextId = 0;

    constructor(
        private workerFile: string,
        private manimPath: () => string,
    ) {}

    /** Starts the worker if needed and resolves to the manim version. Restarts it when the setting changed. */
    start(): Promise<string> {
        const command = this.manimPath();
        if (this.ready && command === this.command) return this.ready;
        this.stop();
        if (/[\\/]/.test(command) && !existsSync(command)) {
            this.command = undefined; // not cached, so installing manim there later just works
            return Promise.reject(new Error(`Nothing found at "${command}". Check the Manim executable setting.`));
        }
        this.command = command;
        // per process: when a replaced worker exits, it must only fail its own renders
        const pending = new Map<string, Waiter>();
        this.pending = pending;
        const python = pythonFor(command);
        const proc = spawn(python, ["-u", this.workerFile], {
            env: { ...process.env, PATH: SEARCH_PATH, PYTHONWARNINGS: "ignore" },
            stdio: "pipe",
        });
        let stderr = "";
        proc.stderr.on("data", (chunk: Buffer) => {
            stderr = (stderr + chunk.toString()).slice(-4000);
        });
        // writes to a worker that just died fail with EPIPE; its "exit" handler already reports that
        proc.stdin.on("error", () => {});
        this.proc = proc;
        this.ready = new Promise<string>((resolve, reject) => {
            createInterface({ input: proc.stdout }).on("line", (line) => {
                const msg = parseMessage(line);
                if (!msg) return;
                if ("ready" in msg) return resolve(msg.version);
                const waiter = pending.get(msg.id);
                pending.delete(msg.id);
                if ("file" in msg) waiter?.resolve(msg.file);
                else waiter?.reject(new Error(msg.error));
            });
            proc.on("error", (err: NodeJS.ErrnoException) => {
                // a failed spawn emits no "exit", so forget it here or every later render would reuse the failure
                this.forget(proc);
                reject(
                    err.code === "ENOENT"
                        ? new Error(
                              `Python for Manim not found ("${python}", from "${command}"). Install manim or set its path in the plugin settings.`,
                          )
                        : err,
                );
            });
            proc.on("exit", () => {
                const err = new Error(`Could not run Manim with ${python}.\n${stderr.trim()}`);
                reject(err);
                for (const waiter of pending.values()) waiter.reject(err);
                pending.clear();
                this.forget(proc);
            });
        });
        return this.ready;
    }

    /** Resolves to the path of the rendered file; aborting kills the render's child process. */
    async render(job: RenderJob, signal: AbortSignal): Promise<string> {
        await this.start();
        signal.throwIfAborted();
        const { proc, pending } = this;
        if (!proc) throw new Error("Manim worker stopped");
        const id = String(++this.nextId);
        return new Promise((resolve, reject) => {
            pending.set(id, { resolve, reject });
            proc.stdin.write(`${JSON.stringify({ id, ...job })}\n`);
            signal.addEventListener(
                "abort",
                () => {
                    pending.delete(id);
                    proc.stdin.write(`${JSON.stringify({ cancel: id })}\n`);
                    reject(signal.reason);
                },
                { once: true },
            );
        });
    }

    stop(): void {
        const proc = this.proc;
        this.forget(proc);
        proc?.kill();
    }

    private forget(proc?: ChildProcessWithoutNullStreams): void {
        if (this.proc !== proc) return;
        this.proc = undefined;
        this.ready = undefined;
    }
}

function parseMessage(line: string): WorkerMessage | undefined {
    try {
        return JSON.parse(line) as WorkerMessage;
    } catch {
        return undefined; // not protocol output (the worker itself never prints anything else)
    }
}

/**
 * The worker must run on the Python that has manim installed. `manim` is a console script, so its
 * shebang names that interpreter (pip, pipx, uv, Homebrew and conda all install it this way).
 */
function pythonFor(manimCommand: string): string {
    const file = manimCommand.includes("/") || manimCommand.includes("\\") ? manimCommand : findOnPath(manimCommand);
    if (!file) return "python3";
    if (/^python[\d.]*(\.exe)?$/i.test(path.basename(file))) return file;
    const text = readHead(file);
    // pip writes `#!/bin/sh` + `'''exec' "/path/python" "$0" "$@"` when the interpreter path has spaces
    const exec = text.match(/^'''exec' "?([^"\n]+?)"? "\$0"/m);
    if (exec) return exec[1];
    const shebang = text.match(/^#!\s*(\S+)(?:\s+(\S+))?/);
    if (!shebang) return "python3";
    return path.basename(shebang[1]) === "env" && shebang[2] ? shebang[2] : shebang[1];
}

function readHead(file: string): string {
    try {
        const head = Buffer.alloc(512);
        const fd = openSync(file, "r");
        try {
            return head.subarray(0, readSync(fd, head, 0, head.length, 0)).toString("utf8");
        } finally {
            closeSync(fd);
        }
    } catch {
        return "";
    }
}

function findOnPath(command: string): string | undefined {
    const names = process.platform === "win32" ? [`${command}.exe`, command] : [command];
    for (const dir of SEARCH_PATH.split(path.delimiter)) {
        for (const name of names) {
            const candidate = path.join(dir, name);
            if (existsSync(candidate)) return candidate;
        }
    }
    return undefined;
}
