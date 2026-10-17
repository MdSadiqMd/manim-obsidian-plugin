import assert from "node:assert/strict";
import { describeError } from "../src/errors.ts";

const traceback = `Traceback (most recent call last):
  File "<manim block>", line 4, in construct
NameError: name 'Nope' is not defined
`;
assert.deepEqual(describeError(traceback), {
    summary: "NameError: name 'Nope' is not defined",
    hint: undefined,
    details: traceback.trim(),
});

const latex = describeError("Traceback ...\nFileNotFoundError: [Errno 2] No such file or directory: 'latex'");
assert.equal(latex.summary, "FileNotFoundError: [Errno 2] No such file or directory: 'latex'");
assert.match(latex.hint ?? "", /LaTeX/);

const missingPython = describeError('Python for Manim not found ("python3", from "manim").');
assert.equal(missingPython.details, undefined);
assert.match(missingPython.hint ?? "", /Settings/);

assert.match(
    describeError("Could not run Manim with /x/python.\nModuleNotFoundError: No module named 'manim'").summary,
    /No module named 'manim'/,
);
assert.equal(describeError("").summary, "Manim failed without an error message.");

console.log("errors.test.ts: ok");
