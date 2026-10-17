"""Persistent Manim render worker for the Obsidian plugin.

Imports manim once, then renders each job in a fork()ed child so every render starts warm
(no ~1s import) and isolated (manim's global config and the user's code die with the child).

Protocol: JSON lines.
  stdin:  {"id", "source", "scene", "quality", "fps", "dir"}  |  {"cancel": id}
  stdout: {"ready": true, "version"}  |  {"id", "file"}  |  {"id", "error"}
"""

import json
import os
import sys
import threading
import time
import traceback
import warnings

warnings.filterwarnings("ignore")
import manim  # noqa: E402  (the whole point: pay the import once)
from manim import config  # noqa: E402

QUALITY = {
    "l": "low_quality",
    "m": "medium_quality",
    "h": "high_quality",
    "p": "production_quality",
    "k": "fourk_quality",
}
MEDIA = (".mp4", ".png", ".gif", ".mov", ".webm")


def render(job):
    config.quality = QUALITY[job["quality"]]
    if job.get("fps"):
        config.frame_rate = job["fps"]
    config.media_dir = job["dir"]
    config.output_file = "out"
    config.progress_bar = "none"
    config.verbosity = "WARNING"
    config.disable_caching = True  # the plugin caches by content hash; manim's hashing costs ~30%
    if hasattr(type(config), "video_encoder_options"):
        # veryfast: ~20% less CPU than x264's default "medium" at 1080p, with smaller files at the same crf
        config.video_encoder_options = {"crf": "23", "preset": "veryfast"}
    namespace = {"__name__": "__manim_block__"}
    exec(compile(job["source"], "<manim block>", "exec"), namespace)
    namespace[job["scene"]]().render()


def run_child(job):
    """Runs one job and exits; never returns. Writes the traceback to <dir>/error.txt on failure."""
    parent = os.getppid()

    def exit_if_orphaned():
        while True:
            time.sleep(1)
            if os.getppid() != parent:
                os._exit(1)

    threading.Thread(target=exit_if_orphaned, daemon=True).start()
    log = os.open(os.path.join(job["dir"], "log.txt"), os.O_WRONLY | os.O_CREAT)
    os.dup2(log, 1)
    os.dup2(log, 2)
    try:
        render(job)
        os._exit(0)
    except BaseException:
        with open(os.path.join(job["dir"], "error.txt"), "w") as f:
            f.write(traceback.format_exc())
        os._exit(1)


def find_output(directory):
    for root, dirs, files in os.walk(directory):
        dirs[:] = [d for d in dirs if d != "partial_movie_files"]
        for name in files:
            if os.path.splitext(name)[0] == "out" and name.endswith(MEDIA):
                return os.path.join(root, name)
    return None


def result(job, ok):
    if ok:
        file = find_output(job["dir"])
        return (
            {"id": job["id"], "file": file} if file else {"id": job["id"], "error": "Manim produced no video or image."}
        )
    try:
        with open(os.path.join(job["dir"], "error.txt")) as f:
            error = f.read()
    except OSError:
        with open(os.path.join(job["dir"], "log.txt"), errors="replace") as f:
            error = f.read()[-4000:] or "Manim exited unexpectedly."
    return {"id": job["id"], "error": error.strip()}


class SpawnedChild:
    """Windows has no fork(): fall back to one fresh interpreter per job (cold import, still correct)."""

    def __init__(self, job):
        import subprocess

        self.proc = subprocess.Popen([sys.executable, __file__, "--job"], stdin=subprocess.PIPE)
        self.proc.stdin.write(json.dumps(job).encode())
        self.proc.stdin.close()

    def poll(self):
        return self.proc.poll()

    def kill(self):
        self.proc.kill()


class ForkedChild:
    def __init__(self, job):
        self.pid = os.fork()
        if self.pid == 0:
            run_child(job)

    def poll(self):
        pid, status = os.waitpid(self.pid, os.WNOHANG)
        return None if pid == 0 else os.waitstatus_to_exitcode(status)

    def kill(self):
        try:
            os.kill(self.pid, 9)
            os.waitpid(self.pid, 0)
        except (ProcessLookupError, ChildProcessError):
            pass


def message_reader():
    """Returns read(timeout) -> list of JSON lines. select() on POSIX keeps the parent single-threaded,
    which keeps fork() safe; Windows can't select() on pipes, so it uses a thread instead."""
    if os.name != "nt":
        import selectors

        selector = selectors.DefaultSelector()
        selector.register(sys.stdin.fileno(), selectors.EVENT_READ)
        pending = b""

        def read(timeout):
            nonlocal pending
            if not selector.select(timeout):
                return []
            chunk = os.read(sys.stdin.fileno(), 1 << 20)
            if not chunk:
                raise EOFError
            pending += chunk
            *lines, pending = pending.split(b"\n")
            return lines

        return read

    import queue

    lines = queue.Queue()

    def pump():
        for raw in sys.stdin.buffer:
            lines.put(raw)
        lines.put(None)

    threading.Thread(target=pump, daemon=True).start()

    def read(timeout):
        try:
            line = lines.get(timeout=timeout)
        except queue.Empty:
            return []
        if line is None:
            raise EOFError
        return [line]

    return read


def send(message):
    sys.stdout.write(json.dumps(message) + "\n")
    sys.stdout.flush()


def prepare_parent():
    """Work every render would repeat, done once before forking.

    Only pure-Python state belongs here. Initialising Pango (e.g. via Text.font_list()) in the parent
    makes forked children segfault on macOS, because CoreText is not fork-safe.
    """
    # tqdm (manim's progress bars, even when disabled) lazily builds a multiprocessing lock, which
    # imports multiprocessing and spawns a resource_tracker process in every render.
    from tqdm import tqdm

    tqdm.set_lock(threading.RLock())


def main():
    prepare_parent()
    Child = ForkedChild if hasattr(os, "fork") else SpawnedChild
    read = message_reader()
    running = {}  # id -> (child, job)
    send({"ready": True, "version": manim.__version__})
    while True:
        try:
            lines = read(0.02)
        except EOFError:  # Obsidian closed the pipe
            for child, _ in running.values():
                child.kill()
            return
        for line in filter(None, (raw.strip() for raw in lines)):
            message = json.loads(line)
            if "cancel" in message:
                entry = running.pop(message["cancel"], None)
                if entry:
                    entry[0].kill()
            else:
                running[message["id"]] = (Child(message), message)
        for job_id, (child, job) in list(running.items()):
            code = child.poll()
            if code is not None:
                del running[job_id]
                send(result(job, code == 0))


if __name__ == "__main__":
    if sys.argv[1:] == ["--job"]:
        run_child(json.loads(sys.stdin.read()))
    else:
        main()
