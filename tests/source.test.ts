import assert from "node:assert/strict";
import { manimBlockAt, prepareSource } from "../src/source.ts";

const full = prepareSource("class Intro(Scene):\n    def construct(self):\n        pass");
assert.equal(full.scene, "Intro");
assert.ok(full.source.startsWith("from manim import *\nclass Intro"));

const threeD = prepareSource("from manim import *\nclass Base:\n    pass\nclass Orbit(ThreeDScene):\n    pass");
assert.equal(threeD.scene, "Orbit");
assert.ok(!threeD.source.startsWith("from manim import *\nfrom manim"));

const body = prepareSource("import numpy as np\nc = Circle()\nself.play(Create(c))\n");
assert.equal(body.scene, "ManimScene");
assert.equal(
    body.source,
    "from manim import *\nimport numpy as np\n\nclass ManimScene(Scene):\n    def construct(self):\n        c = Circle()\n        self.play(Create(c))\n",
);

assert.ok(prepareSource("   \n").source.includes("        pass"));

const note = [
    "# Note", //            0
    "```manim", //          1
    "c = Circle()", //      2
    "  self.play(Create(c))  ", // 3 (whitespace must survive: it is part of the cache key)
    "```", //               4
    "text", //              5
    "```python", //         6
    "x = 1", //             7
    "```", //               8
    "```manim", //          9  unclosed
    "self.wait()", //       10
];
const at = (line: number) =>
    manimBlockAt({ getCursor: () => ({ line }), getLine: (i) => note[i], lastLine: () => note.length - 1 });
const block = "c = Circle()\n  self.play(Create(c))  ";
assert.equal(at(2), block);
assert.equal(at(3), block);
assert.equal(at(1), block, "cursor on the opening fence");
assert.equal(at(4), block, "cursor on the closing fence right after typing it");
for (const line of [0, 5, 6, 7, 8, 9, 10])
    assert.equal(at(line), undefined, `line ${line} is not inside a closed manim block`);

console.log("source.test.ts: ok");
