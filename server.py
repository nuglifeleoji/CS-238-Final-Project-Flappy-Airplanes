#!/usr/bin/env python3
"""Local testbed server (standard library only).

    python server.py            # opens http://localhost:8000
    python server.py --port 9000 --no-browser

Serves the web UI and a small JSON API:

    GET  /api/levels                 all 20 courses (terrain for rendering)
    GET  /api/config                 game constants
    GET  /api/policies               *.py files in policies/
    GET  /api/runs                   past runs + summaries (leaderboard)
    GET  /api/runs/<id>?since=k      run status and level results from index k
    GET  /api/runs/<id>/raw          download the run's JSONL
    POST /api/submit                 {"filename","code"} upload  |  {"policy": "x.py"} from policies/
    POST /api/runs/<id>/stop         kill a running evaluation

Each submission is evaluated in its own subprocess (python -m flappy.evaluate),
which streams results to results/<id>.jsonl; the UI polls and animates levels
as soon as they are ready.
"""
import argparse
import json
import re
import subprocess
import sys
import threading
import time
import webbrowser
from datetime import datetime
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

ROOT = Path(__file__).resolve().parent
WEB = ROOT / "web"
RESULTS = ROOT / "results"
SUBMISSIONS = ROOT / "submissions"
POLICIES = ROOT / "policies"
sys.path.insert(0, str(ROOT))

from flappy.config import DEFAULT_CONFIG  # noqa: E402
from flappy.course import load_levels  # noqa: E402

RUN_ID_RE = re.compile(r"^[\w.-]{1,120}$")
JOBS = {}            # run_id -> {"proc", "started"}
JOBS_LOCK = threading.Lock()
MAX_RUN_SECONDS = 60 * 60
TIME_LIMIT_PER_LEVEL = 120


def safe_stem(name):
    stem = Path(name).stem or "policy"
    return re.sub(r"[^\w.-]", "_", stem)[:60]


def new_run_id(name):
    base = datetime.now().strftime("%Y%m%d-%H%M%S") + "_" + safe_stem(name)
    run_id, k = base, 1
    with JOBS_LOCK:
        while run_id in JOBS or (RESULTS / f"{run_id}.jsonl").exists():
            k += 1
            run_id = f"{base}-{k}"
    return run_id


def tail_text(path, n_bytes=4000):
    try:
        data = path.read_bytes()
        return data[-n_bytes:].decode("utf-8", "replace")
    except FileNotFoundError:
        return ""


def read_run(run_id, since=0):
    path = RESULTS / f"{run_id}.jsonl"
    if not path.exists():
        with JOBS_LOCK:
            job = JOBS.get(run_id)
        if job is None:
            return None
        # the evaluator subprocess has not created its output file yet (or died before it could)
        running = job["proc"].poll() is None
        return {
            "id": run_id, "status": "running" if running else "failed", "meta": None,
            "summary": None, "fatal": None if running else "evaluator exited before starting",
            "log": "" if running else tail_text(RESULTS / f"{run_id}.log"),
            "count": 0, "since": since, "levels": [],
        }
    meta, summary, fatal, levels = None, None, None, []
    with open(path, "r") as f:
        for line in f:
            if not line.endswith("\n"):
                break  # partially written line; pick it up next poll
            try:
                obj = json.loads(line)
            except json.JSONDecodeError:
                continue
            t = obj.get("type")
            if t == "meta":
                meta = obj
            elif t == "level":
                levels.append(obj)
            elif t == "summary":
                summary = obj
            elif t == "fatal":
                fatal = obj.get("error")

    with JOBS_LOCK:
        job = JOBS.get(run_id)
    if job is not None and job["proc"].poll() is None:
        status = "running"
    elif summary is not None:
        status = "done"
    elif fatal is not None or (job is not None and job["proc"].returncode not in (0, None)):
        status = "failed"
    else:
        status = "incomplete"

    log = ""
    if status in ("failed", "incomplete") or fatal:
        log = tail_text(RESULTS / f"{run_id}.log")
    return {
        "id": run_id, "status": status, "meta": meta, "summary": summary,
        "fatal": fatal, "log": log, "count": len(levels),
        "since": since, "levels": levels[since:],
    }


def read_head_tail(path):
    """First and last complete JSON lines of a JSONL file, without parsing the middle."""
    with open(path, "rb") as f:
        head = f.readline()
        f.seek(0, 2)
        size = f.tell()
        f.seek(max(0, size - 4096))
        chunk = f.read()
    lines = [ln for ln in chunk.split(b"\n") if ln.strip()]
    meta = summary = None
    try:
        meta = json.loads(head)
    except Exception:
        pass
    if lines:
        try:
            last = json.loads(lines[-1])
            if last.get("type") == "summary":
                summary = last
        except Exception:
            pass
    return meta, summary


def list_runs():
    out = []
    if not RESULTS.exists():
        return out
    for path in sorted(RESULTS.glob("*.jsonl"), reverse=True):
        run_id = path.stem
        meta, summary = read_head_tail(path)
        with JOBS_LOCK:
            job = JOBS.get(run_id)
        running = job is not None and job["proc"].poll() is None
        out.append({
            "id": run_id,
            "policy": (meta or {}).get("policy", run_id),
            "started": (meta or {}).get("started"),
            "status": "running" if running else ("done" if summary else "incomplete"),
            "summary": summary,
        })
    return out


def start_job(policy_path, display_name, run_id):
    RESULTS.mkdir(exist_ok=True)
    out = RESULTS / f"{run_id}.jsonl"
    log = open(RESULTS / f"{run_id}.log", "w")
    cmd = [sys.executable, "-u", "-m", "flappy.evaluate", "--policy", str(policy_path),
           "--out", str(out), "--name", display_name, "--quiet",
           "--time-limit", str(TIME_LIMIT_PER_LEVEL)]
    proc = subprocess.Popen(cmd, cwd=str(ROOT), stdout=log, stderr=subprocess.STDOUT)
    with JOBS_LOCK:
        JOBS[run_id] = {"proc": proc, "started": time.time()}

    def watchdog():
        try:
            proc.wait(timeout=MAX_RUN_SECONDS)
        except subprocess.TimeoutExpired:
            proc.kill()
        log.close()

    threading.Thread(target=watchdog, daemon=True).start()


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(WEB), **kwargs)

    def log_message(self, fmt, *args):
        if args and "/api/runs/" in str(args[0]):
            return  # polling noise
        sys.stderr.write("  %s\n" % (fmt % args))

    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    # ---------------------------------------------------------------
    def send_json(self, obj, code=200):
        body = json.dumps(obj, separators=(",", ":")).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def read_json(self, limit=2_000_000):
        n = int(self.headers.get("Content-Length") or 0)
        if n <= 0 or n > limit:
            raise ValueError("request body missing or too large")
        return json.loads(self.rfile.read(n))

    # ---------------------------------------------------------------
    def do_GET(self):
        url = urlparse(self.path)
        p = url.path
        if not p.startswith("/api/"):
            return super().do_GET()
        q = parse_qs(url.query)
        if p == "/api/levels":
            return self.send_json([c.to_dict() for c in load_levels()])
        if p == "/api/config":
            return self.send_json(DEFAULT_CONFIG.to_dict())
        if p == "/api/policies":
            names = sorted(f.name for f in POLICIES.glob("*.py") if not f.name.startswith("_"))
            return self.send_json(names)
        if p == "/api/runs":
            return self.send_json(list_runs())
        m = re.match(r"^/api/runs/([^/]+)(/raw)?$", p)
        if m and RUN_ID_RE.match(m.group(1)):
            run_id = m.group(1)
            if m.group(2):
                path = RESULTS / f"{run_id}.jsonl"
                if not path.exists():
                    return self.send_json({"error": "not found"}, 404)
                data = path.read_bytes()
                self.send_response(200)
                self.send_header("Content-Type", "application/x-ndjson")
                self.send_header("Content-Disposition", f'attachment; filename="{run_id}.jsonl"')
                self.send_header("Content-Length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)
                return
            since = int((q.get("since") or ["0"])[0])
            run = read_run(run_id, since)
            if run is None:
                return self.send_json({"error": "run not found"}, 404)
            return self.send_json(run)
        return self.send_json({"error": "unknown endpoint"}, 404)

    def do_POST(self):
        p = urlparse(self.path).path
        try:
            if p == "/api/submit":
                body = self.read_json()
                if body.get("policy"):
                    name = Path(body["policy"]).name
                    path = POLICIES / name
                    if not (path.exists() and path.suffix == ".py"):
                        return self.send_json({"error": f"policies/{name} not found"}, 404)
                    run_id = new_run_id(name)
                    start_job(path, name, run_id)
                    return self.send_json({"id": run_id})
                code = body.get("code")
                filename = body.get("filename") or "submission.py"
                if not isinstance(code, str) or not code.strip():
                    return self.send_json({"error": "empty file"}, 400)
                if not filename.endswith(".py"):
                    return self.send_json({"error": "please submit a .py file"}, 400)
                SUBMISSIONS.mkdir(exist_ok=True)
                run_id = new_run_id(filename)
                path = SUBMISSIONS / f"{run_id}.py"
                path.write_text(code)
                start_job(path, Path(filename).name, run_id)
                return self.send_json({"id": run_id})
            m = re.match(r"^/api/runs/([^/]+)/stop$", p)
            if m and RUN_ID_RE.match(m.group(1)):
                with JOBS_LOCK:
                    job = JOBS.get(m.group(1))
                if job and job["proc"].poll() is None:
                    job["proc"].kill()
                return self.send_json({"ok": True})
            return self.send_json({"error": "unknown endpoint"}, 404)
        except (ValueError, json.JSONDecodeError) as e:
            return self.send_json({"error": str(e)}, 400)


def main():
    ap = argparse.ArgumentParser(description="Flappy Airplanes testbed server")
    ap.add_argument("--port", type=int, default=8000)
    ap.add_argument("--no-browser", action="store_true")
    args = ap.parse_args()

    server = None
    for port in range(args.port, args.port + 20):
        try:
            server = ThreadingHTTPServer(("127.0.0.1", port), Handler)
            break
        except OSError:
            continue
    if server is None:
        sys.exit("no free port found")
    url = f"http://localhost:{server.server_address[1]}/"
    print(f"\n  ✈  Flappy Airplanes testbed running at {url}\n     (Ctrl+C to stop)\n")
    if not args.no_browser:
        threading.Timer(0.6, lambda: webbrowser.open(url)).start()
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\n  bye")


if __name__ == "__main__":
    main()
