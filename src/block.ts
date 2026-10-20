import { MarkdownRenderChild } from "obsidian";
import { describeError } from "./errors.ts";
import type ManimPlugin from "./main.ts";
import { DRAFT } from "./renderer.ts";
import { finalVariant } from "./settings.ts";

/**
 * One rendered ```manim block. Above Low quality it shows a fast 480p draft first, then swaps in the
 * final render. Aborting on unload kills renders nobody else needs.
 */
export class ManimBlock extends MarkdownRenderChild {
    private abort = new AbortController();

    constructor(
        containerEl: HTMLElement,
        private code: string,
        private plugin: ManimPlugin,
    ) {
        super(containerEl);
    }

    onload() {
        this.containerEl.addClass("manim-block");
        this.plugin.blocks.add(this);
        void this.render(this.abort.signal);
    }

    onunload() {
        this.plugin.blocks.delete(this);
        this.abort.abort();
    }

    /** Starts over with the current settings, e.g. after the cache was cleared or the quality changed. */
    rerender() {
        this.abort.abort();
        this.abort = new AbortController();
        void this.render(this.abort.signal);
    }

    /** One render pass; `signal` is aborted when the block unloads or a newer pass replaces this one. */
    private async render(signal: AbortSignal) {
        const { renderer } = this.plugin;
        const final = finalVariant(this.plugin.settings);
        const done = renderer.cached(this.code, final);
        if (done) return this.show(done, signal);

        const draft = final.quality === "l" ? undefined : renderer.cached(this.code, DRAFT);
        if (draft) this.show(draft, signal, true);
        else this.showStatus();
        try {
            // Draft first, then final: running both at once delays the draft (the first thing you see) by
            // 40-80% for a 25% sooner final. With render-ahead the draft is usually cached already.
            if (final.quality !== "l" && !draft)
                this.show(await renderer.render(this.code, DRAFT, signal), signal, true);
            this.show(await renderer.render(this.code, final, signal), signal);
        } catch (err) {
            // cancelled renders (block unloaded or re-rendered, cache cleared) are not errors worth showing
            if (signal.aborted || (err as Error).name === "AbortError") return;
            this.showError((err as Error).message);
        }
    }

    private showError(message: string) {
        const { summary, hint, details } = describeError(message);
        this.containerEl.empty();
        const box = this.containerEl.createDiv({ cls: "manim-error", attr: { role: "alert" } });
        box.createDiv({ cls: "manim-error-title", text: "Manim couldn't render this block" });
        box.createDiv({ cls: "manim-error-summary", text: summary });
        if (hint) box.createDiv({ cls: "manim-error-hint", text: hint });
        if (!details) return;
        const more = box.createEl("details");
        more.createEl("summary", { text: "Full traceback" });
        more.createEl("pre", { text: details });
    }

    private showStatus() {
        this.containerEl.empty();
        this.containerEl.createDiv({ cls: "manim-status", text: "Rendering Manim animation…" });
    }

    private show(file: string, signal: AbortSignal, isDraft = false) {
        if (signal.aborted) return; // a shared render can finish after this pass was superseded
        // keep the playhead when the final render replaces the draft, so the swap is seamless
        const resumeAt = this.containerEl.querySelector("video")?.currentTime ?? 0;
        this.containerEl.empty();
        const src = this.plugin.resourceUrl(file);
        if (file.endsWith(".png") || file.endsWith(".gif")) {
            this.containerEl.createEl("img", { attr: { src, alt: "Manim render" } });
            return;
        }
        const video = this.containerEl.createEl("video", {
            attr: { src, autoplay: "", loop: "", playsinline: "", controls: "", "aria-label": "Manim animation" },
        });
        video.muted = true;
        video.currentTime = resumeAt;
        this.applySpeed();
        if (isDraft) this.containerEl.createDiv({ cls: "manim-badge", text: "Draft · rendering full quality…" });
        this.playWhileVisible(video);
    }

    applySpeed() {
        const video = this.containerEl.querySelector("video");
        // defaultPlaybackRate survives a reload of the source; playbackRate is what plays now
        if (video) video.defaultPlaybackRate = video.playbackRate = this.plugin.settings.speed;
    }

    /**
     * Only decodes while on screen, so long notes with many animations stay cheap. Before the first
     * layout, reading view reports a single 0x0 "not intersecting" entry that must not pause autoplay.
     */
    private playWhileVisible(video: HTMLVideoElement) {
        let laidOut = false;
        const observer = new IntersectionObserver(([entry]) => {
            laidOut ||= entry.boundingClientRect.width > 0;
            if (entry.isIntersecting) video.play().catch(() => {});
            else if (laidOut) video.pause();
        });
        observer.observe(video);
        this.register(() => observer.disconnect());
    }
}
