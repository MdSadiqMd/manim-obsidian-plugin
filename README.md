# Manim-Obsidian Renderer

Render ` ```manim ` code blocks in Obsidian as animations, the way Mermaid renders diagrams. It uses your local [Manim Community](https://www.manim.community/) install, so it works offline.

## Features

- Write Manim in a ` ```manim ` block and the video plays in place.
- Fast renders: a warm Python worker, a 480p draft first, then full quality.
- Renders in the background while you pause typing inside a block.
- Renders are cached, so notes reopen instantly.
- Python syntax highlighting while editing.
- Readable errors with a fix for common setup problems.
- Quality from 480p to 4K, optional 60 fps.

## Installation

1. Install Manim:

   ```sh
   uv tool install manim --python 3.12   # or: pipx install manim
   brew install cairo pango               # macOS native libraries
   brew install --cask mactex-no-gui      # optional, only for Tex / MathTex
   ```

   On Linux, follow the [Manim installation guide](https://docs.manim.community/en/stable/installation.html). Windows is untested.

2. Install the plugin from source (needs Node 22+, [pnpm](https://pnpm.io/installation) and [uv](https://docs.astral.sh/uv/)):

   ```sh
   git clone https://github.com/MdSadiqMd/manim-obsidian-plugin.git
   cd manim-obsidian-plugin
   pnpm install
   pnpm vault-install ~/path/to/your/vault
   ```

   Or copy `main.js`, `manifest.json` and `styles.css` from a release into `<vault>/.obsidian/plugins/manim_renderer_sadiq/`.

3. Enable **Manim-Obsidian Renderer** under Settings → Community plugins. Its settings should say **Manim 0.x is ready**. If not, set **Manim executable** to the output of `which manim`.

Desktop only: rendering needs a local Python, which Obsidian mobile can't run.

## Usage

Write the body of a scene's `construct()`. `from manim import *` and the `Scene` class are added for you:

````markdown
```manim
circle = Circle(color=BLUE)
self.play(Create(circle))
self.play(Transform(circle, Square()))
```
````

Or write a full script. The first `Scene` subclass (`Scene`, `ThreeDScene`, `MovingCameraScene`, ...) is rendered:

````markdown
```manim
class Surface3D(ThreeDScene):
    def construct(self):
        axes = ThreeDAxes()
        surface = Surface(
            lambda u, v: axes.c2p(u, v, np.sin(u) * np.cos(v)),
            u_range=[-PI, PI], v_range=[-PI, PI],
        )
        self.set_camera_orientation(phi=70 * DEGREES, theta=-45 * DEGREES)
        self.play(Create(axes), Create(surface))
```
````

- Scenes with no animations render as a still image.
- Imports at the top of a block (`import numpy as np`) work in both styles.
- Videos loop, are muted, and only play while on screen.
- The command **Clear rendered animation cache** frees disk space.

## Settings

| Setting | What it does |
|---|---|
| Manim executable | The `manim` command, its full path, or its Python. Shows whether Manim runs |
| Quality | 480p (default) to 4K. Above 480p, a quick draft shows first |
| Smooth 60 fps | Above 480p, 60 fps instead of 30. About 2× slower |
| Render while typing | Renders in the background when you pause in a block |
| Rendered animations | Cache size, with a button to clear it |

## Troubleshooting

| You see | Fix |
|---|---|
| *Python for Manim not found* | Set **Manim executable** to the output of `which manim` |
| *No such file or directory: 'latex'* | `Tex` / `MathTex` need LaTeX: install MacTeX, TeX Live or MiKTeX |
| A Python error | Expand **Full traceback** under the error for details |

## Performance

Induction-head demo scene (`demo/induction_head.py`) on an M4 Max:

| | Plain `manim` CLI | This plugin |
|---|---|---|
| Edit, pause, click out (render while typing) | 6.0 s | 0.01 s |
| 480p15 (default), cold | 6.0 s | 2.7 s |
| 1080p, first frame on screen | 13.6 s | 2.7 s (draft) |
| 1080p30 final | | 8.1 s |
| 1080p60, like-for-like | 13.6 s | 8.9 s |

How:

- **Warm worker.** One Python process imports manim once and forks a child per render, skipping the 0.5-1.4 s import.
- **Render while typing.** A 0.7 s pause in a block renders its 480p version in the background. Superseded renders are cancelled.
- **Whole-render cache.** Renders are cached by content hash in `.obsidian/plugins/manim_renderer_sadiq/cache/`, so Manim's own per-animation hashing (about 30% of render time) is turned off.
- **Faster encoding.** x264 `veryfast` and 30 fps above 480p.
- **Draft first.** Above 480p, a 480p draft shows first and the final swaps in at the same playhead.

<details>
<summary>Tried and rejected</summary>

- Draft and final at the same time: final 25% sooner, draft 40-80% later.
- 4 parallel renders instead of 2: last block 28% sooner, first block 50% later.
- Splitting one scene across processes: each re-runs `construct()`, and x264 already uses ~3.6 cores.
- Pre-loading fonts before `fork()`: children segfault on macOS (CoreText is not fork-safe).
- macOS background QoS for finals: stuck on efficiency cores, 26-29 s.
- GC tuning, persistent text cache: no measurable gain.

</details>

## Development

| Command | What it does |
|---|---|
| `pnpm fmt` | Format and auto-fix (Biome for TS/JS/JSON, Ruff for Python) |
| `pnpm lint` | Check formatting and lint without changing files |
| `pnpm typecheck` | Type-check `src/` and `tests/` |
| `pnpm test` | Unit tests, no manim needed |
| `pnpm test-render` | Render through the real Python worker (needs manim) |
| `pnpm test-examples` | Render 21 example blocks and check every output |
| `pnpm check` | lint + typecheck + test + build |
| `pnpm build` / `pnpm dev` | Production build / rebuild on change |
| `pnpm vault-link <vault>` | Symlink the plugin into a vault for development |
| `pnpm version [patch\|minor\|major]` | Bump the version in `package.json`, `manifest.json` and `versions.json`, then commit and tag |

```
src/
  main.ts             plugin wiring: processor, highlighting, render-while-typing, commands
  block.ts            one rendered block (draft -> final, playback)
  settings.ts         settings model and tab
  renderer.ts         cache, job sharing, render-ahead, concurrency limit
  worker-client.ts    talks to worker.py, finds the Python that has manim
  source.ts           block text -> runnable scene
  errors.ts           traceback -> summary, hint and details
  worker.py           long-lived Python worker, forks one child per render
tests/                unit and integration tests
```

## License

[BSD 3-Clause](LICENSE). Made by [@MdSadiqMd](https://x.com/Md_Sadiq_Md). [Sponsor on GitHub](https://github.com/sponsors/MdSadiqMd).
