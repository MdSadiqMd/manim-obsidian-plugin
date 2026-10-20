import { debounce, type Editor, type FileSystemAdapter, Notice, Plugin } from "obsidian";
import { ManimBlock } from "./block.ts";
import { DRAFT, ManimRenderer } from "./renderer.ts";
import { DEFAULT_SETTINGS, type ManimSettings, ManimSettingTab } from "./settings.ts";
import { manimBlockAt } from "./source.ts";
import workerSource from "./worker.py";

/** Pause inside a block this long before render-ahead starts. */
const RENDER_AHEAD_DELAY_MS = 700;

interface CodeMirror5 {
    defineMode(name: string, factory: (config: unknown) => unknown): void;
    getMode(config: unknown, name: string): unknown;
    modes: Record<string, unknown>;
}

export default class ManimPlugin extends Plugin {
    settings: ManimSettings = { ...DEFAULT_SETTINGS };
    renderer!: ManimRenderer;
    /** Blocks currently on screen, so cache and settings changes can re-render them in place. */
    readonly blocks = new Set<ManimBlock>();
    private cacheDir = "";

    async onload() {
        this.settings = { ...DEFAULT_SETTINGS, ...(await this.loadData()) };
        const adapter = this.app.vault.adapter as FileSystemAdapter;
        this.cacheDir = `${this.manifest.dir}/cache`;
        const workerFile = await this.installWorker(adapter);
        this.renderer = new ManimRenderer(
            adapter.getFullPath(this.cacheDir),
            adapter.getFullPath(workerFile),
            () => this.settings.manimPath,
        );

        this.highlightAsPython();
        this.renderWhileTyping();
        this.registerMarkdownCodeBlockProcessor("manim", (code, el, ctx) => {
            ctx.addChild(new ManimBlock(el, code, this));
        });

        this.addCommand({
            id: "clear-cache",
            name: "Clear rendered animation cache",
            callback: () => this.clearCache(),
        });
        this.addSettingTab(new ManimSettingTab(this.app, this));
    }

    onunload() {
        this.renderer?.stop(); // undefined when unloaded before onload finished
    }

    async clearCache() {
        await this.renderer.clear();
        this.rerenderBlocks();
        new Notice("Manim cache cleared.");
    }

    rerenderBlocks() {
        for (const block of this.blocks) block.rerender();
    }

    /** Sets every on-screen animation to the default speed, without re-rendering. */
    applySpeed() {
        for (const block of this.blocks) block.applySpeed();
    }

    resourceUrl(file: string): string {
        return this.app.vault.adapter.getResourcePath(`${this.cacheDir}/${file}`);
    }

    /** Writes the bundled worker.py next to the plugin (only when it changed), returning its vault path. */
    private async installWorker(adapter: FileSystemAdapter): Promise<string> {
        const workerFile = `${this.manifest.dir}/worker.py`;
        if (!(await adapter.exists(workerFile)) || (await adapter.read(workerFile)) !== workerSource) {
            await adapter.write(workerFile, workerSource);
        }
        return workerFile;
    }

    /** Live Preview and Source mode highlight fenced code with CodeMirror 5 modes; ```manim is just Python. */
    private highlightAsPython() {
        const cm = (window as unknown as { CodeMirror?: CodeMirror5 }).CodeMirror;
        if (!cm) return;
        cm.defineMode("manim", (config) => cm.getMode(config, "python"));
        this.register(() => delete cm.modes.manim);
    }

    /** Renders the 480p version while the user pauses inside a block, so closing it shows the result at once. */
    private renderWhileTyping() {
        const speculate = debounce(
            (editor: Editor) => {
                const code = manimBlockAt(editor);
                if (code?.trim()) this.renderer.speculate(code, DRAFT);
            },
            RENDER_AHEAD_DELAY_MS,
            true,
        );
        this.registerEvent(
            this.app.workspace.on("editor-change", (editor) => {
                if (!this.settings.renderWhileTyping) return;
                this.renderer.cancelSpeculation();
                speculate(editor);
            }),
        );
    }
}
