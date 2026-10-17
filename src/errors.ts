const SETUP_HINT = "Check the Manim executable in Settings → Manim.";

const HINTS: [RegExp, string][] = [
    [
        /No such file or directory: '(latex|dvisvgm)'/,
        "Tex and MathTex need LaTeX. Install MacTeX, TeX Live or MiKTeX, then reopen the note.",
    ],
    [/No module named 'manim'|Python for Manim not found|Could not run Manim/, SETUP_HINT],
];

/**
 * Splits a render error into what to show first: the final line of a Python traceback (the actual
 * error), a fix when it is a known setup problem, and the full text for the details view.
 */
export function describeError(message: string): { summary: string; hint?: string; details?: string } {
    const lines = message.trim().split("\n");
    const summary =
        lines
            .map((line) => line.trim())
            .filter(Boolean)
            .at(-1) ?? "Manim failed without an error message.";
    const hint = HINTS.find(([pattern]) => pattern.test(message))?.[1];
    return { summary, hint, details: lines.length > 1 ? message.trim() : undefined };
}
