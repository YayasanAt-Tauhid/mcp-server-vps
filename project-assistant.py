"""Dependency-free remote project knowledge and detached Linux job runner."""
import contextlib
import datetime
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import selectors
import signal
import stat
import subprocess
import sys
import time
import unicodedata
import uuid

MAX_RECORD_BYTES = 96000
MAX_ENTRIES = 1000
MAX_LOG_BYTES = 1024 * 1024
MAX_ACTIVE_JOBS = 2
ACTIVE = {"queued", "running", "cancel_requested"}
TERMINAL = {"succeeded", "failed", "cancelled", "timed_out", "interrupted"}
SLUG = re.compile(r"[a-z0-9][a-z0-9._-]{0,63}\Z")
SENSITIVE = re.compile(
    r"-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----|"
    r"\b(?:api[_-]?key|access[_-]?token|refresh[_-]?token|password|passwd|secret|private[_-]?key)\b\s*[:=]\s*[\"']?[^\s\"']{8,}|"
    r"\bsk-[A-Za-z0-9_-]{20,}\b|\bgh[pousr]_[A-Za-z0-9]{20,}\b|\bAKIA[0-9A-Z]{16}\b|"
    r"https?://[^\s/@]+:[^\s/@]+@|\bBearer\s+[A-Za-z0-9._~-]{12,}", re.I
)


def now():
    return datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="milliseconds")


def slug(value, field):
    if not isinstance(value, str) or not SLUG.fullmatch(value):
        raise ValueError(field + " harus slug lowercase 1-64 karakter")
    return value


def integer(value, field, low, high):
    if type(value) is not int or not low <= value <= high:
        raise ValueError(field + " di luar batas")
    return value


def text(value, field, maximum, multiline=False):
    if not isinstance(value, str) or not value.strip() or len(value) > maximum:
        raise ValueError(field + " kosong/terlalu panjang")
    if any(ord(ch) < 32 and (not multiline or ch not in "\n\r\t") for ch in value):
        raise ValueError(field + " memiliki karakter kontrol")
    if SENSITIVE.search(value):
        raise ValueError(field + " ditolak karena pola credential/secret")
    return value if multiline else value.strip()


def directory(path):
    try:
        path.mkdir(mode=0o700)
    except FileExistsError:
        pass
    info = path.lstat()
    if not stat.S_ISDIR(info.st_mode) or info.st_uid != os.getuid():
        raise ValueError("Direktori penyimpanan tidak aman")
    path.chmod(0o700)
    return path


def root_dir():
    home = Path.home().resolve(strict=True)
    return directory(directory(home / ".mcp-workflow") / "assistant")


def project_dir(project_id):
    return directory(root_dir() / slug(project_id, "projectId"))


def atomic_write(path, value):
    if path.is_symlink():
        raise ValueError("File symlink ditolak")
    raw = value.encode("utf-8")
    tmp = path.with_name("." + path.name + "." + uuid.uuid4().hex)
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    try:
        with os.fdopen(fd, "wb") as handle:
            handle.write(raw)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(tmp, path)
        dir_fd = os.open(path.parent, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        try:
            os.fsync(dir_fd)
        finally:
            os.close(dir_fd)
    finally:
        tmp.unlink(missing_ok=True)


def write_json(path, value):
    serialized = json.dumps(value, ensure_ascii=False)
    if len(serialized.encode()) > MAX_RECORD_BYTES:
        raise ValueError("Record terlalu besar")
    atomic_write(path, serialized + "\n")


def read_json(path):
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    with os.fdopen(fd, "rb") as handle:
        info = os.fstat(handle.fileno())
        if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or info.st_size > MAX_RECORD_BYTES:
            raise ValueError("File penyimpanan tidak aman/terlalu besar")
        value = json.load(handle)
    if not isinstance(value, dict):
        raise ValueError("Record bukan object")
    return value


@contextlib.contextmanager
def locked(parent, name=".lock"):
    fd = os.open(parent / name, os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
    try:
        if not stat.S_ISREG(os.fstat(fd).st_mode):
            raise ValueError("Lock tidak aman")
        deadline = time.monotonic() + 8
        while True:
            try:
                fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
                break
            except BlockingIOError:
                if time.monotonic() > deadline:
                    raise ValueError("Penyimpanan sedang dipakai; coba lagi")
                time.sleep(0.02)
        yield
    finally:
        os.close(fd)


def fold(value):
    return unicodedata.normalize("NFKC", value).casefold()


def knowledge(request):
    kind = "memory" if request["tool"] == "ssh_memory" else "skill"
    project = slug(request["projectId"], "projectId")
    folder = directory(project_dir(project) / ("memories" if kind == "memory" else "skills"))
    action = request["action"]
    if action not in {"save", "get", "list", "search", "delete"}:
        raise ValueError("action tidak valid")
    entry_id = request.get(kind + "Id")
    if action in {"save", "get", "delete"}:
        slug(entry_id, kind + "Id")

    def read_entry(path):
        record = read_json(path)
        if record.get("projectId") != project or record.get("kind") != kind or record.get(kind + "Id") != path.stem:
            raise ValueError("Identitas record tidak sesuai")
        integer(record.get("revision"), "revision", 1, 2147483647)
        if SENSITIVE.search(json.dumps(record)):
            raise ValueError("Record berisi pola credential/secret")
        return record

    def summary(record, query_terms=None):
        body = record["content"]
        pos = 0
        if query_terms:
            index = fold(body).find(query_terms[0])
            pos = max(0, index - 60) if index >= 0 else 0
        return {key: record[key] for key in (kind + "Id", "projectId", "title", "tags", "revision", "updatedAt")} | {
            "snippet": body[pos:pos + 240], "contentChars": len(body)
        }

    with locked(folder):
        path = folder / (str(entry_id) + ".json")
        if action in {"get", "delete", "save"}:
            current = read_entry(path) if path.exists() or path.is_symlink() else None
            if action == "get":
                if current is None:
                    raise ValueError("Record tidak ditemukan")
                return {"entry": current}
            expected = integer(request.get("expectedRevision", 0), "expectedRevision", 0, 2147483647)
            actual = current["revision"] if current else 0
            if expected != actual:
                raise ValueError("REVISION_CONFLICT: baca revisi terbaru sebelum update/delete")
            if action == "delete":
                if current is None:
                    raise ValueError("Record tidak ditemukan")
                path.unlink()
                return {"deleted": True, kind + "Id": entry_id, "revision": actual}
            title = text(request.get("title"), "title", 160)
            content = text(request.get("content"), "content", 16000, True)
            tags = request.get("tags", [])
            if not isinstance(tags, list) or len(tags) > 12:
                raise ValueError("tags harus array maksimum 12 item")
            tags = list(dict.fromkeys(text(tag, "tag", 40) for tag in tags))
            if current is None and len(list(folder.glob("*.json"))) >= MAX_ENTRIES:
                raise ValueError("Batas record tercapai")
            record = {"version": 1, "kind": kind, "projectId": project, kind + "Id": entry_id,
                      "title": title, "content": content, "tags": tags, "revision": actual + 1,
                      "createdAt": current["createdAt"] if current else now(), "updatedAt": now()}
            write_json(path, record)
            return {"entry": summary(record)}

        limit = integer(request.get("limit", 20), "limit", 1, 50)
        terms = []
        if action == "search":
            query = text(request.get("query"), "query", 200)
            terms = re.findall(r"\w+", fold(query))
            if len(terms) > 12:
                raise ValueError("query maksimum 12 kata")
            if not terms:
                raise ValueError("query memerlukan huruf/angka")
        items = []
        paths = sorted(folder.glob("*.json"))
        if len(paths) > MAX_ENTRIES:
            raise ValueError("Batas record terlampaui")
        for path in paths:
            record = read_entry(path)
            title, body, tags = fold(record["title"]), fold(record["content"]), fold(" ".join(record["tags"]))
            if terms and not all(term in title + "\n" + body + "\n" + tags for term in terms):
                continue
            score = sum(6 * title.count(term) + 4 * tags.count(term) + body.count(term) for term in terms)
            items.append((score, record["updatedAt"], summary(record, terms)))
        items.sort(key=lambda item: (item[0], item[1]), reverse=True)
        return {"items": [item[2] | ({"score": item[0]} if terms else {}) for item in items[:limit]],
                "total": len(items), "limit": limit}


def identity(pid):
    try:
        fields = Path("/proc", str(pid), "stat").read_text().rsplit(") ", 1)[1].split()
        return {"pid": int(pid), "startTicks": fields[19], "state": fields[0],
                "bootId": Path("/proc/sys/kernel/random/boot_id").read_text().strip()}
    except (OSError, IndexError, ValueError):
        return None


def matches(saved, running):
    return bool(saved and running and all(saved.get(key) == running.get(key) for key in ("pid", "startTicks", "bootId")))


def alive(saved):
    actual = identity(saved["pid"]) if saved else None
    return matches(saved, actual) and actual["state"] not in {"Z", "X"}


def job_public(job):
    keys = ("jobId", "projectId", "title", "state", "cwd", "createdAt", "startedAt", "finishedAt",
            "exitCode", "timeoutSeconds", "cancelRequestedAt", "logBytes", "logTruncated", "error")
    return {key: job.get(key) for key in keys} | {"pid": (job.get("process") or {}).get("pid")}


def load_job(folder):
    data = read_json(folder / "job.json")
    if data.get("jobId") != folder.name or data.get("projectId") != folder.parent.parent.name:
        raise ValueError("Identitas job tidak sesuai")
    if data.get("state") not in ACTIVE | TERMINAL:
        raise ValueError("Status job tidak valid")
    return data


def reconcile(folder):
    with locked(folder):
        job = load_job(folder)
        log_path = folder / "output.log"
        if log_path.exists() or log_path.is_symlink():
            info = log_path.lstat()
            if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid():
                raise ValueError("Log tidak aman")
            job["logBytes"] = info.st_size
        if job["state"] in ACTIVE and not alive(job.get("worker")):
            job.update(state="interrupted", finishedAt=now(), error="Worker/reboot terdeteksi; tidak dijalankan ulang otomatis")
            write_json(folder / "job.json", job)
        return job


def jobs(request):
    project = slug(request["projectId"], "projectId")
    base = project_dir(project)
    folder = directory(base / "jobs")
    action = request["action"]
    if action not in {"start", "status", "list", "logs", "cancel"}:
        raise ValueError("action tidak valid")
    if action == "list":
        limit = integer(request.get("limit", 20), "limit", 1, 50)
        records = [reconcile(directory(path)) for path in folder.iterdir() if SLUG.fullmatch(path.name)]
        records.sort(key=lambda item: item["createdAt"], reverse=True)
        return {"jobs": [job_public(job) for job in records[:limit]], "total": len(records)}

    job_id = slug(request.get("jobId"), "jobId")
    target = folder / job_id
    if action == "start":
        command = text(request.get("command"), "command", 8000, True)
        title = text(request.get("title", job_id), "title", 160)
        timeout = integer(request.get("timeoutSeconds", 3600), "timeoutSeconds", 1, 86400)
        repo = Path(request["repoPath"]).resolve(strict=True)
        cwd_arg = request.get("cwd", ".")
        if not isinstance(cwd_arg, str) or len(cwd_arg) > 500 or "\0" in cwd_arg or Path(cwd_arg).is_absolute():
            raise ValueError("cwd harus relatif di dalam repo")
        cwd = (repo / cwd_arg).resolve(strict=True)
        if not cwd.is_dir() or not cwd.is_relative_to(repo):
            raise ValueError("cwd keluar dari repo project")
        digest = hashlib.sha256((command + "\0" + str(cwd) + "\0" + str(timeout)).encode()).hexdigest()
        with locked(root_dir(), ".jobs.lock"):
            if target.exists() or target.is_symlink():
                job = reconcile(directory(target))
                if job.get("commandHash") != digest:
                    raise ValueError("JOB_ID_CONFLICT: jobId sudah dipakai untuk perintah lain")
                return {"job": job_public(job), "reused": True}
            active_count = 0
            for project_path in root_dir().iterdir():
                if not SLUG.fullmatch(project_path.name):
                    continue
                directory(project_path)
                other_jobs = project_path / "jobs"
                if not other_jobs.exists():
                    continue
                directory(other_jobs)
                for path in other_jobs.iterdir():
                    if SLUG.fullmatch(path.name):
                        active_count += reconcile(directory(path))["state"] in ACTIVE
            if active_count >= MAX_ACTIVE_JOBS:
                raise ValueError("Maksimum 2 job aktif per target; tunggu atau cancel job lama")
            if len(list(folder.iterdir())) >= MAX_ENTRIES:
                raise ValueError("Batas riwayat job tercapai")
            directory(target)
            with locked(target):
                job = {"version": 1, "jobId": job_id, "projectId": project, "title": title, "command": command,
                       "commandHash": digest, "cwd": str(cwd), "repoPath": str(repo), "state": "queued",
                       "createdAt": now(), "timeoutSeconds": timeout, "logBytes": 0, "logTruncated": False}
                write_json(target / "job.json", job)
                atomic_write(target / "worker.py", SOURCE)
                child = subprocess.Popen([sys.executable, str(target / "worker.py"), "--worker", str(target)],
                                         stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                                         stderr=subprocess.DEVNULL, start_new_session=True, close_fds=True)
                job["worker"] = identity(child.pid)
                if not job["worker"]:
                    job.update(state="failed", finishedAt=now(), error="Gagal memulai worker")
                write_json(target / "job.json", job)
            return {"job": job_public(job), "reused": False}

    if not target.exists() and not target.is_symlink():
        raise ValueError("Job tidak ditemukan")
    directory(target)
    job = reconcile(target)
    if action == "status":
        return {"job": job_public(job)}
    if action == "cancel":
        with locked(target):
            job = load_job(target)
            if job["state"] in ACTIVE:
                job.update(state="cancel_requested", cancelRequestedAt=now())
                write_json(target / "job.json", job)
        return {"job": job_public(job), "cancellationRequested": job["state"] == "cancel_requested"}
    tail_bytes = integer(request.get("tailBytes", 8000), "tailBytes", 100, 32000)
    log_path = target / "output.log"
    output = ""
    size = 0
    if log_path.exists() or log_path.is_symlink():
        fd = os.open(log_path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
        with os.fdopen(fd, "rb") as handle:
            info = os.fstat(handle.fileno())
            if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid():
                raise ValueError("Log tidak aman")
            size = info.st_size
            handle.seek(max(0, size - tail_bytes))
            output = redact(handle.read(tail_bytes).decode("utf-8", "replace"))
    return {"job": job_public(job), "output": output, "tailTruncated": size > tail_bytes}


def redact(value):
    if not any(part in value.casefold() for part in ("pass", "token", "secret", "key", "bearer", "sk-", "gh", "akia", "http")):
        return value
    value = re.sub(r"(?i)(\b[\w-]{0,80}(?:password|passwd|token|secret|api[_-]?key|private[_-]?key)[\w-]{0,80}\s*[:=]\s*)\S+", r"\1[REDACTED]", value)
    return re.sub(r"\b(?:sk-[A-Za-z0-9_-]{20,}|gh[pousr]_[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{16})\b|(?i:Bearer\s+[A-Za-z0-9._~-]{12,})|https?://[^\s/@]+:[^\s/@]+@", "[REDACTED]", value)


def run_worker(target):
    stopped = False

    def stop_handler(_signum, _frame):
        nonlocal stopped
        stopped = True

    signal.signal(signal.SIGTERM, stop_handler)
    signal.signal(signal.SIGINT, stop_handler)
    process = None
    process_id = None
    log_bytes = 0
    truncated = False
    pending = ""
    in_private_block = False

    def send_group(sig):
        # Do not reap the leader before cleanup: its PID then cannot be reused.
        if process and matches(process_id, identity(process.pid)):
            try:
                os.killpg(process.pid, sig)
            except ProcessLookupError:
                pass

    try:
        with locked(target):
            job = load_job(target)
            if job["state"] == "cancel_requested":
                job.update(state="cancelled", finishedAt=now())
                write_json(target / "job.json", job)
                return
            cwd = Path(job["cwd"]).resolve(strict=True)
            if not cwd.is_relative_to(Path(job["repoPath"]).resolve(strict=True)):
                raise ValueError("cwd berubah keluar dari repo")
            process = subprocess.Popen(["/bin/sh", "-c", job["command"]], cwd=cwd,
                                       stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                                       start_new_session=True, close_fds=True)
            process_id = identity(process.pid)
            if not process_id:
                raise ValueError("Identitas proses tidak tersedia")
            job.update(state="running", startedAt=now(), process=process_id)
            write_json(target / "job.json", job)
        fd = os.open(target / "output.log", os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
        with os.fdopen(fd, "wb") as log:
            def emit(line):
                nonlocal log_bytes, truncated, in_private_block
                if "-----BEGIN " in line and "PRIVATE KEY-----" in line:
                    in_private_block = True
                cleaned = "[REDACTED]\n" if in_private_block else redact(line)
                if "-----END " in line and "PRIVATE KEY-----" in line:
                    in_private_block = False
                raw = cleaned.encode("utf-8")
                remaining = MAX_LOG_BYTES - log_bytes
                if len(raw) > remaining:
                    truncated = True
                if remaining > 0:
                    chunk = raw[:remaining]
                    log.write(chunk)
                    log.flush()
                    log_bytes += len(chunk)

            def accept(raw):
                nonlocal pending
                pending += raw.decode("utf-8", "replace")
                while "\n" in pending or len(pending) > 8192:
                    end = pending.find("\n") + 1
                    if not end:
                        end = 8192
                    emit(pending[:end])
                    pending = pending[end:]

            os.set_blocking(process.stdout.fileno(), False)
            selector = selectors.DefaultSelector()
            selector.register(process.stdout, selectors.EVENT_READ)
            start = time.monotonic()
            stop_reason = None
            kill_at = None
            while True:
                running = alive(process_id)
                if not running:
                    send_group(signal.SIGKILL)
                    # Drain buffered output after descendants have been stopped.
                    for _ in range(256):
                        try:
                            raw = os.read(process.stdout.fileno(), 65536)
                        except BlockingIOError:
                            break
                        if not raw:
                            break
                        accept(raw)
                    break
                with locked(target):
                    current = load_job(target)
                if not stop_reason and (stopped or current["state"] == "cancel_requested"):
                    stop_reason = "cancelled"
                if not stop_reason and time.monotonic() - start >= job["timeoutSeconds"]:
                    stop_reason = "timed_out"
                if stop_reason and kill_at is None:
                    send_group(signal.SIGTERM)
                    kill_at = time.monotonic() + 2
                elif kill_at is not None and time.monotonic() >= kill_at:
                    send_group(signal.SIGKILL)
                events = selector.select(0.1)
                if events:
                    try:
                        raw = os.read(process.stdout.fileno(), 65536)
                    except BlockingIOError:
                        continue
                    if raw:
                        accept(raw)
                    else:
                        selector.unregister(process.stdout)
            if pending:
                emit(pending)
            selector.close()
            process.stdout.close()
            code = process.wait(timeout=3)
        with locked(target):
            current = load_job(target)
            current.update(state=stop_reason or ("succeeded" if code == 0 else "failed"), exitCode=code,
                           finishedAt=now(), logBytes=log_bytes, logTruncated=truncated)
            write_json(target / "job.json", current)
    except Exception:
        send_group(signal.SIGKILL)
        if process:
            try:
                process.wait(timeout=3)
            except subprocess.TimeoutExpired:
                pass
        with locked(target):
            job = load_job(target)
            job.update(state="failed", finishedAt=now(), logBytes=log_bytes, logTruncated=truncated,
                       error="Worker gagal; periksa direktori project dan batas sumber daya")
            write_json(target / "job.json", job)


if __name__ == "__main__":
    if len(sys.argv) == 3 and sys.argv[1] == "--worker":
        run_worker(Path(sys.argv[2]))
    else:
        try:
            request = json.loads(sys.argv[1])
            if request.get("tool") not in {"ssh_memory", "ssh_skill", "ssh_job"}:
                raise ValueError("Tool tidak dikenal")
            result = jobs(request) if request["tool"] == "ssh_job" else knowledge(request)
            print(json.dumps({"ok": True, **result}, ensure_ascii=False))
        except (ValueError, OSError, KeyError, TypeError) as error:
            # No traceback or command output: persisted data may be sensitive.
            message = str(error) if isinstance(error, ValueError) else "Operasi penyimpanan gagal: " + type(error).__name__
            print(json.dumps({"ok": False, "error": message}))
