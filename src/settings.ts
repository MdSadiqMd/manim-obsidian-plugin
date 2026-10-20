import { type App, debounce, PluginSettingTab, SettingGroup } from "obsidian";
import { describeError } from "./errors.ts";
import type ManimPlugin from "./main.ts";
import type { Quality, Variant } from "./renderer.ts";

export interface ManimSettings {
    manimPath: string;
    quality: Quality;
    smooth: boolean;
    renderWhileTyping: boolean;
    speed: number;
}

export const DEFAULT_SETTINGS: Readonly<ManimSettings> = {
    manimPath: "manim",
    quality: "l",
    smooth: false,
    renderWhileTyping: true,
    speed: 1,
};

/** The variant to show once rendering is done; above Low, a 30 fps cap halves the work unless 60 fps is on. */
export function finalVariant({ quality, smooth }: ManimSettings): Variant {
    return quality === "l" ? { quality } : { quality, fps: smooth ? 60 : 30 };
}

const QUALITY_OPTIONS: Record<Quality, string> = {
    l: "480p",
    m: "720p",
    h: "1080p",
    p: "1440p",
    k: "4K",
};

const SPEEDS = [0.5, 1, 1.5, 1.75, 2];

export class ManimSettingTab extends PluginSettingTab {
    /** Bumped on every check so a slow, outdated check can't overwrite a newer result. */
    private checkId = 0;

    constructor(
        app: App,
        private plugin: ManimPlugin,
    ) {
        super(app, plugin);
    }

    display() {
        const { containerEl, plugin } = this;
        const { settings } = plugin;
        containerEl.empty();
        containerEl.addClass("manim-settings");
        const save = () => plugin.saveData(settings);

        let status!: HTMLElement;
        const recheck = debounce(() => this.checkManim(status, true), 800, true);
        new SettingGroup(containerEl).setHeading("Setup").addSetting((setting) => {
            setting
                .setName("Manim executable")
                .setDesc(
                    createFragment((desc) => {
                        desc.appendText("Command, full path (");
                        desc.createEl("code", { text: "which manim" });
                        desc.appendText("), or its Python");
                        status = desc.createDiv({ cls: "manim-check" });
                    }),
                )
                .addText((text) =>
                    text
                        .setPlaceholder(DEFAULT_SETTINGS.manimPath)
                        .setValue(settings.manimPath)
                        .onChange(async (value) => {
                            settings.manimPath = value.trim() || DEFAULT_SETTINGS.manimPath;
                            await save();
                            recheck();
                        }),
                );
        });
        void this.checkManim(status, false);

        new SettingGroup(containerEl)
            .setHeading("Rendering")
            .addSetting((setting) => {
                setting.setName("Quality").setDesc("Above 480p, a quick draft shows first");
                segmented(
                    setting.controlEl,
                    "Quality",
                    Object.entries(QUALITY_OPTIONS),
                    settings.quality,
                    async (value) => {
                        settings.quality = value as Quality;
                        await save();
                        plugin.rerenderBlocks();
                    },
                );
            })
            .addSetting((setting) =>
                setting
                    .setName("Smooth 60 fps")
                    .setDesc("Above 480p, render at 60 fps instead of 30. About 2× slower")
                    .addToggle((toggle) =>
                        toggle.setValue(settings.smooth).onChange(async (value) => {
                            settings.smooth = value;
                            await save();
                            plugin.rerenderBlocks();
                        }),
                    ),
            )
            .addSetting((setting) =>
                setting
                    .setName("Render while typing")
                    .setDesc("Render in the background when you pause in a block")
                    .addToggle((toggle) =>
                        toggle.setValue(settings.renderWhileTyping).onChange(async (value) => {
                            settings.renderWhileTyping = value;
                            if (!value) plugin.renderer.cancelSpeculation();
                            await save();
                        }),
                    ),
            );

        new SettingGroup(containerEl).setHeading("Playback").addSetting((setting) => {
            setting.setName("Default speed").setDesc("How fast every animation plays");
            segmented(
                setting.controlEl,
                "Default speed",
                SPEEDS.map((speed) => [String(speed), `${speed}×`]),
                String(settings.speed),
                async (value) => {
                    settings.speed = Number(value);
                    await save();
                    plugin.applySpeed();
                },
            );
        });

        new SettingGroup(containerEl).setHeading("Cache").addSetting((setting) => {
            const showSize = async () => {
                const { files, bytes } = await plugin.renderer.cacheSize();
                setting.setDesc(
                    files
                        ? `${files} ${files === 1 ? "animation" : "animations"} · ${formatBytes(bytes)}. Notes reopen instantly`
                        : "Empty. Renders are kept so notes reopen instantly",
                );
            };
            setting.setName("Rendered animations").addButton((button) =>
                button.setButtonText("Clear cache").onClick(async () => {
                    await plugin.clearCache();
                    await showSize();
                }),
            );
            void showSize();
        });

        const credits = containerEl.createDiv({ cls: "manim-credits" });
        credits.appendText("Made by ");
        credits.createEl("a", { text: "@Md_Sadiq_Md", href: "https://x.com/Md_Sadiq_Md" });
    }

    /** Shows whether manim runs with the current setting; after an edit, re-renders blocks once it does. */
    private async checkManim(status: HTMLElement, changed: boolean) {
        const id = ++this.checkId;
        setStatus(status, "pending", "Checking Manim…");
        try {
            const version = await this.plugin.renderer.version();
            if (id !== this.checkId) return;
            setStatus(status, "ok", `Manim ${version} is ready.`);
            if (changed) this.plugin.rerenderBlocks();
        } catch (err) {
            if (id !== this.checkId) return;
            const message = (err as Error).message;
            setStatus(status, "error", describeError(message).summary).setAttr("title", message);
        }
    }
}

/** A row of buttons for picking one option. Visually hidden native radios keep arrow-key navigation and screen reader semantics for free. */
function segmented(
    parent: HTMLElement,
    label: string,
    options: [value: string, text: string][],
    current: string,
    onChange: (value: string) => void,
) {
    const group = parent.createDiv({ cls: "manim-segmented", attr: { role: "radiogroup", "aria-label": label } });
    for (const [value, text] of options) {
        const option = group.createEl("label");
        const radio = option.createEl("input", { type: "radio", attr: { name: `manim-${label}` } });
        radio.checked = value === current;
        radio.addEventListener("change", () => onChange(value));
        option.appendText(text);
    }
}

function setStatus(el: HTMLElement, state: "pending" | "ok" | "error", text: string): HTMLElement {
    el.setText(text);
    el.dataset.state = state;
    el.removeAttribute("title");
    return el;
}

function formatBytes(bytes: number): string {
    if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
    return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
