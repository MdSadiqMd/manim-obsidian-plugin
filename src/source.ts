const SCENE_CLASS = /^class\s+(\w+)\s*\(([^)]*Scene[^)]*)\)\s*:/m;
const MANIM_IMPORT = /^\s*(from\s+manim\s+import|import\s+manim\b)/m;
const TOP_LEVEL_IMPORT = /^(from|import)\s/;

/**
 * Turns the text of a ```manim block into a runnable script plus the scene to render.
 * A block that defines a Scene subclass renders the first such class; a block without
 * one is treated as the body of construct(), so `self.play(Create(Circle()))` just works.
 */
export function prepareSource(code: string): { source: string; scene: string } {
    const match = code.match(SCENE_CLASS);
    if (match) {
        const header = MANIM_IMPORT.test(code) ? "" : "from manim import *\n";
        return { source: header + code, scene: match[1] };
    }

    // `from x import *` is illegal inside a function, so imports are hoisted out of construct().
    const lines = code.replace(/\s+$/, "").split("\n");
    const imports = lines.filter((l) => TOP_LEVEL_IMPORT.test(l));
    const body = lines.filter((l) => !TOP_LEVEL_IMPORT.test(l));
    if (!imports.some((l) => MANIM_IMPORT.test(l))) imports.unshift("from manim import *");
    const indented = body.some((l) => l.trim()) ? body.map((l) => `        ${l}`) : ["        pass"];

    return {
        source: [...imports, "", "class ManimScene(Scene):", "    def construct(self):", ...indented, ""].join("\n"),
        scene: "ManimScene",
    };
}

/** The slice of Obsidian's Editor that manimBlockAt needs (kept minimal so it can be tested without Obsidian). */
export interface EditorLines {
    getCursor(): { line: number };
    getLine(line: number): string;
    lastLine(): number;
}

/**
 * Text of the top-level ```manim block around the cursor, exactly as Obsidian hands it to the block
 * processor (lines between the fences joined with "\n"), so render-ahead and the block share a cache key.
 */
export function manimBlockAt(editor: EditorLines): string | undefined {
    const cursor = editor.getCursor().line;
    let start = cursor;
    // the cursor sits on the closing fence right after the user types it
    if (editor.getLine(start).trimEnd() === "```") start--;
    while (start >= 0 && !editor.getLine(start).startsWith("```")) start--;
    if (start < 0 || editor.getLine(start).trimEnd() !== "```manim") return undefined;
    for (let end = start + 1; end <= editor.lastLine(); end++) {
        if (editor.getLine(end).trimEnd() !== "```") continue;
        if (end < cursor) return undefined;
        const lines: string[] = [];
        for (let i = start + 1; i < end; i++) lines.push(editor.getLine(i));
        return lines.join("\n");
    }
    return undefined;
}
