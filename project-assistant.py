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


MAX_KANBAN_TASKS = 200
KANBAN_STATES = {"todo", "running", "review", "blocked", "done"}
KANBAN_FIELDS = {"version", "kind", "projectId", "taskId", "title", "content", "assignee", "reviewer",
                 "priority", "dependsOn", "state", "revision", "createdAt", "updatedAt", "createHash",
                 "owner", "leaseId", "leaseUntil", "blockedFrom", "reason", "result", "jobIds", "archived",
                 "comments", "events", "droppedComments", "droppedEvents"}


def kanban_actor(value):
    if not isinstance(value, str) or not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._:-]{0,79}", value):
        raise ValueError("agentId/assignee/reviewer tidak valid; maksimum 80 karakter")
    return value


def kanban(request):
    """Project-scoped, transactional metadata; never executes task text or spawns models."""
    allowed = {"tool", "repoPath", "projectId", "action", "taskId", "title", "content", "assignee", "reviewer",
               "priority", "dependsOn", "agentId", "leaseId", "leaseSeconds", "expectedRevision", "summary",
               "evidence", "comment", "commentId", "reason", "state", "limit", "offset", "query", "includeArchived", "jobId"}
    if set(request) - allowed:
        raise ValueError("Field Kanban tidak dikenal")
    actions = {"create", "get", "list", "update", "claim", "heartbeat", "release", "complete", "request_review",
               "request_changes", "block", "unblock", "comment", "attach_job", "archive"}
    action = request["action"]
    if action not in actions:
        raise ValueError("action Kanban tidak valid")
    project = slug(request["projectId"], "projectId")
    folder = directory(project_dir(project) / "kanban")
    moment = now()
    clock = int(time.time() * 1000)

    def spec(source, current=None):
        current = current or {}
        value = {}
        for key, maximum, multiline in [("title", 160, False), ("content", 4000, True)]:
            raw = source.get(key, current.get(key, ""))
            value[key] = "" if key == "content" and raw == "" else text(raw, key, maximum, multiline)
        for key in ("assignee", "reviewer"):
            raw = source.get(key, current.get(key))
            value[key] = kanban_actor(raw) if raw is not None else None
        if value["reviewer"] is not None and value["reviewer"] == value["assignee"]:
            raise ValueError("Reviewer harus berbeda dari assignee")
        value["priority"] = integer(source.get("priority", current.get("priority", 1)), "priority", 0, 2)
        deps = source.get("dependsOn", current.get("dependsOn", []))
        if not isinstance(deps, list) or len(deps) > 20:
            raise ValueError("dependsOn maksimum 20 taskId")
        value["dependsOn"] = sorted(set(slug(dep, "dependsOn") for dep in deps))
        return value

    def validate_task(task, path):
        if set(task) != KANBAN_FIELDS or task.get("version") != 1 or task.get("kind") != "kanban":
            raise ValueError("Schema task Kanban tidak valid")
        if task.get("projectId") != project or slug(task.get("taskId"), "taskId") != path.stem:
            raise ValueError("Identitas task Kanban tidak sesuai")
        if spec(task) != {key: task[key] for key in ("title", "content", "assignee", "reviewer", "priority", "dependsOn")}:
            raise ValueError("Spesifikasi task Kanban tidak valid")
        integer(task["revision"], "revision", 1, 2147483647)
        if task["state"] not in KANBAN_STATES or type(task["archived"]) is not bool:
            raise ValueError("State task Kanban tidak valid")
        if task["archived"] and task["state"] != "done":
            raise ValueError("Arsip task Kanban tidak valid")
        for key in ("createdAt", "updatedAt"):
            datetime.datetime.fromisoformat(task[key])
        if not isinstance(task["createHash"], str) or not re.fullmatch(r"[0-9a-f]{64}", task["createHash"]):
            raise ValueError("Identitas create Kanban tidak valid")
        if task["owner"] is not None:
            kanban_actor(task["owner"])
            if task["state"] not in {"running", "review"}:
                raise ValueError("Lease task Kanban tidak valid")
            if not isinstance(task["leaseId"], str) or not re.fullmatch(r"[0-9a-f]{32}", task["leaseId"]):
                raise ValueError("Lease ID task Kanban tidak valid")
            integer(task["leaseUntil"], "leaseUntil", 1, 9007199254740991)
        elif task["leaseId"] is not None or task["leaseUntil"] is not None or task["state"] == "running":
            raise ValueError("Owner task Kanban tidak valid")
        if task["blockedFrom"] not in {None, "work", "review"} or (task["state"] == "blocked") != (task["blockedFrom"] is not None):
            raise ValueError("Status blok task Kanban tidak valid")
        if task["reason"] is not None:
            text(task["reason"], "reason", 1000, True)
        if not isinstance(task["jobIds"], list) or len(task["jobIds"]) > 10:
            raise ValueError("Job references tidak valid")
        for job_id in task["jobIds"]:
            slug(job_id, "jobId")
        for key, maximum in [("comments", 20), ("events", 40)]:
            if not isinstance(task[key], list) or len(task[key]) > maximum:
                raise ValueError("Riwayat Kanban tidak valid")
        for item in task["comments"]:
            if not isinstance(item, dict) or set(item) != {"commentId", "agentId", "content", "at"}:
                raise ValueError("Komentar Kanban tidak valid")
            slug(item["commentId"], "commentId")
            kanban_actor(item["agentId"])
            text(item["content"], "comment", 1000, True)
            datetime.datetime.fromisoformat(item["at"])
        for event in task["events"]:
            if not isinstance(event, dict) or set(event) != {"action", "agentId", "at", "revision"}:
                raise ValueError("Event Kanban tidak valid")
            if event["action"] not in actions | {"lease_expired"}:
                raise ValueError("Action riwayat Kanban tidak valid")
            if event["agentId"] is not None:
                kanban_actor(event["agentId"])
            datetime.datetime.fromisoformat(event["at"])
            integer(event["revision"], "event revision", 1, task["revision"])
        for key in ("droppedComments", "droppedEvents"):
            integer(task[key], key, 0, 2147483647)
        result = task["result"]
        if result is not None:
            if not isinstance(result, dict) or set(result) != {"summary", "evidence", "submittedBy", "at", "reviewedBy", "reviewSummary", "reviewEvidence", "status"}:
                raise ValueError("Handoff Kanban tidak valid")
            text(result["summary"], "summary", 1600, True)
            kanban_actor(result["submittedBy"])
            datetime.datetime.fromisoformat(result["at"])
            if result["status"] not in {"pending_review", "changes_requested", "completed"}:
                raise ValueError("Status handoff tidak valid")
            for key in ("evidence", "reviewEvidence"):
                evidence(result[key])
            if result["reviewedBy"] is not None:
                kanban_actor(result["reviewedBy"])
                text(result["reviewSummary"], "reviewSummary", 1600, True)
        if task["state"] in {"review", "done"} and (result is None or result["status"] != ("pending_review" if task["state"] == "review" else "completed")):
            raise ValueError("Handoff tidak cocok dengan state Kanban")
        if SENSITIVE.search(json.dumps(task, ensure_ascii=False)):
            raise ValueError("Task berisi pola credential/secret")

    def evidence(value):
        if not isinstance(value, list) or len(value) > 10:
            raise ValueError("evidence maksimum 10 item")
        return [text(item, "evidence", 300, True) for item in value]

    def dependencies(task):
        return all(records[dep]["state"] == "done" for dep in task["dependsOn"])

    def check_graph(proposed):
        visiting, visited = set(), set()

        def visit(task_id):
            if task_id in visited:
                return
            if task_id in visiting:
                raise ValueError("Dependency Kanban membentuk cycle")
            if task_id not in proposed:
                raise ValueError("Dependency tidak ditemukan pada project yang sama")
            visiting.add(task_id)
            for dep in proposed[task_id]["dependsOn"]:
                visit(dep)
            visiting.remove(task_id)
            visited.add(task_id)

        for task_id in proposed:
            visit(task_id)

    def public(task, full=False, lease=False):
        keys = ["taskId", "projectId", "title", "state", "assignee", "reviewer", "priority", "dependsOn", "revision",
                "createdAt", "updatedAt", "owner", "leaseUntil", "reason", "archived", "jobIds"]
        value = {key: task[key] for key in keys}
        if task["state"] == "todo" and dependencies(task):
            value["state"] = "ready"
        if full:
            value.update({key: task[key] for key in ("content", "result", "comments", "events", "droppedComments", "droppedEvents")})
            value["parents"] = [{"taskId": dep, "state": records[dep]["state"], "title": records[dep]["title"],
                                 "summary": (records[dep]["result"] or {}).get("summary", "")[:300]} for dep in task["dependsOn"]]
        if lease:
            value["leaseId"] = task["leaseId"]
        return value

    def persist(task, event, actor=None):
        task["revision"] += 1
        task["updatedAt"] = moment
        task["events"].append({"action": event, "agentId": actor, "at": moment, "revision": task["revision"]})
        for key, counter, maximum in [("comments", "droppedComments", 20), ("events", "droppedEvents", 40)]:
            overflow = max(0, len(task[key]) - maximum)
            task[key] = task[key][overflow:]
            task[counter] += overflow
        while len(json.dumps(task, ensure_ascii=False).encode()) > MAX_RECORD_BYTES - 100 and (task["comments"] or len(task["events"]) > 1):
            key, counter = ("comments", "droppedComments") if task["comments"] else ("events", "droppedEvents")
            task[key].pop(0)
            task[counter] += 1
        validate_task(task, folder / (task["taskId"] + ".json"))
        write_json(folder / (task["taskId"] + ".json"), task)

    def clear_lease(task):
        task.update(owner=None, leaseId=None, leaseUntil=None)

    def revision(task):
        expected = integer(request.get("expectedRevision"), "expectedRevision", 1, 2147483647)
        if expected != task["revision"]:
            raise ValueError("REVISION_CONFLICT: baca revisi terbaru sebelum perubahan Kanban")

    def require_owner(task):
        actor = kanban_actor(request.get("agentId"))
        if task["owner"] != actor or task["leaseId"] != request.get("leaseId") or task["leaseUntil"] is None or task["leaseUntil"] <= clock:
            raise ValueError("LEASE_CONFLICT: claim aktif dan leaseId milik sesi ini diperlukan")
        return actor

    with locked(folder):
        paths = sorted(folder.glob("*.json"))
        if len(paths) > MAX_KANBAN_TASKS:
            raise ValueError("Batas 200 task Kanban per project terlampaui")
        records = {}
        for path in paths:
            task = read_json(path)
            validate_task(task, path)
            records[task["taskId"]] = task
        check_graph(records)
        moment = now()
        clock = int(time.time() * 1000)
        for task in records.values():
            if task["owner"] is not None and task["leaseUntil"] <= clock:
                owner = task["owner"]
                task.update(blockedFrom="review" if task["state"] == "review" else "work", state="blocked",
                            reason="Lease expired; periksa pekerjaan/job yang masih berjalan sebelum unblock")
                clear_lease(task)
                persist(task, "lease_expired", owner)

        if action == "create":
            task_id = slug(request.get("taskId") or "task-" + uuid.uuid4().hex[:20], "taskId")
            fields = spec(request)
            digest = hashlib.sha256(json.dumps(fields, sort_keys=True, ensure_ascii=False).encode()).hexdigest()
            if task_id in records:
                if records[task_id]["createHash"] != digest:
                    raise ValueError("TASK_ID_CONFLICT: ID sudah digunakan untuk tugas berbeda")
                return {"task": public(records[task_id], True), "reused": True}
            if len(records) >= MAX_KANBAN_TASKS:
                raise ValueError("Maksimum 200 task Kanban per project termasuk arsip")
            task = {"version": 1, "kind": "kanban", "projectId": project, "taskId": task_id, **fields,
                    "state": "todo", "revision": 0, "createdAt": moment, "updatedAt": moment, "createHash": digest,
                    "owner": None, "leaseId": None, "leaseUntil": None, "blockedFrom": None, "reason": None,
                    "result": None, "jobIds": [], "archived": False, "comments": [], "events": [],
                    "droppedComments": 0, "droppedEvents": 0}
            check_graph(records | {task_id: task})
            records[task_id] = task
            persist(task, action, kanban_actor(request["agentId"]) if request.get("agentId") is not None else None)
            return {"task": public(task, True), "reused": False}

        if action == "list":
            limit = integer(request.get("limit", 20), "limit", 1, 50)
            offset = integer(request.get("offset", 0), "offset", 0, MAX_KANBAN_TASKS)
            include_archived = request.get("includeArchived", False)
            if type(include_archived) is not bool:
                raise ValueError("includeArchived harus boolean")
            items = [public(task) for task in records.values() if include_archived or not task["archived"]]
            counts = {state: sum(item["state"] == state for item in items) for state in ("todo", "ready", "running", "review", "blocked", "done")}
            if "state" in request:
                if request["state"] not in counts:
                    raise ValueError("Filter state tidak valid")
                items = [item for item in items if item["state"] == request["state"]]
            if request.get("assignee") is not None:
                actor = kanban_actor(request["assignee"])
                items = [item for item in items if actor in (item["assignee"], item["reviewer"], item["owner"])]
            if request.get("query") is not None:
                terms = re.findall(r"\w+", fold(text(request["query"], "query", 200)))
                if not 1 <= len(terms) <= 12:
                    raise ValueError("Query memerlukan 1-12 kata")
                items = [item for item in items if all(term in fold(item["title"] + "\n" + records[item["taskId"]]["content"]) for term in terms)]
            items.sort(key=lambda item: (-item["priority"], item["createdAt"], item["taskId"]))
            end = offset + limit
            return {"items": items[offset:end], "counts": counts, "total": len(items), "limit": limit,
                    "offset": offset, "nextOffset": end if end < len(items) else None}

        task_id = request.get("taskId")
        if action == "claim" and task_id is None:
            actor = kanban_actor(request.get("agentId"))
            candidates = [task for task in records.values() if not task["archived"] and task["owner"] is None and
                          ((task["state"] == "todo" and dependencies(task) and task["assignee"] in (None, actor)) or
                           (task["state"] == "review" and task["reviewer"] == actor))]
            candidates.sort(key=lambda task: (-task["priority"], task["createdAt"], task["taskId"]))
            if not candidates:
                raise ValueError("Tidak ada task ready/review yang cocok dengan agentId")
            task_id = candidates[0]["taskId"]
        task_id = slug(task_id, "taskId")
        if task_id not in records:
            raise ValueError("Task tidak ditemukan pada project ini")
        task = records[task_id]
        if action == "get":
            return {"task": public(task, True)}
        if task["archived"]:
            raise ValueError("Task sudah diarsipkan")

        actor = kanban_actor(request["agentId"]) if request.get("agentId") is not None else None
        reveal_lease = False
        if action == "claim":
            actor = kanban_actor(request.get("agentId"))
            if any(item["owner"] == actor for item in records.values()):
                raise ValueError("Agent masih memiliki claim aktif pada project ini")
            reviewer = task["state"] == "review"
            if task["owner"] is not None or task["state"] not in {"todo", "review"} or not dependencies(task):
                raise ValueError("Task belum ready atau sudah di-claim/selesai/terblokir")
            if (task["reviewer"] if reviewer else task["assignee"]) not in (None, actor):
                raise ValueError("Task ditugaskan kepada agent lain")
            if reviewer and task["result"]["submittedBy"] == actor:
                raise ValueError("Reviewer harus berbeda dari pelaksana")
            lease = integer(request.get("leaseSeconds", 900), "leaseSeconds", 60, 3600)
            task.update(state="review" if reviewer else "running", owner=actor, leaseId=uuid.uuid4().hex,
                        leaseUntil=clock + lease * 1000, reason=None)
            reveal_lease = True
        elif action == "update":
            revision(task)
            if task["state"] not in {"todo", "blocked"} or task["blockedFrom"] == "review":
                raise ValueError("Update hanya untuk task antrean atau blocked work")
            candidate = {**task, **spec(request, task)}
            check_graph(records | {task_id: candidate})
            task.update(candidate)
        elif action == "comment":
            actor = kanban_actor(request.get("agentId"))
            content = text(request.get("comment"), "comment", 1000, True)
            comment_id = slug(request.get("commentId") or "comment-" + uuid.uuid4().hex[:16], "commentId")
            existing = next((item for item in task["comments"] if item["commentId"] == comment_id), None)
            if existing:
                if existing["content"] != content or existing["agentId"] != actor:
                    raise ValueError("COMMENT_ID_CONFLICT")
                return {"task": public(task, True), "reused": True}
            task["comments"].append({"commentId": comment_id, "agentId": actor, "content": content, "at": moment})
        elif action in {"unblock", "archive", "attach_job"}:
            revision(task)
            if action == "unblock":
                if task["state"] != "blocked":
                    raise ValueError("Hanya task blocked dapat di-unblock")
                task.update(state="review" if task["blockedFrom"] == "review" else "todo", blockedFrom=None, reason=None)
            elif action == "archive":
                if task["state"] != "done":
                    raise ValueError("Hanya task done dapat diarsipkan")
                task["archived"] = True
            else:
                if task["owner"] is not None:
                    actor = require_owner(task)
                job_id = slug(request.get("jobId"), "jobId")
                jobs_folder = project_dir(project) / "jobs"
                target = jobs_folder / job_id
                for existing in (jobs_folder, target):
                    info = existing.lstat()
                    if not stat.S_ISDIR(info.st_mode) or info.st_uid != os.getuid():
                        raise ValueError("Direktori job tidak aman")
                job = load_job(target)
                if job["projectId"] != project:
                    raise ValueError("Project job tidak cocok")
                if job_id not in task["jobIds"]:
                    if len(task["jobIds"]) >= 10:
                        raise ValueError("Maksimum 10 job references")
                    task["jobIds"].append(job_id)
        else:
            actor = require_owner(task)
            is_review = task["state"] == "review"
            if action == "heartbeat":
                lease = integer(request.get("leaseSeconds", 900), "leaseSeconds", 60, 3600)
                task["leaseUntil"] = clock + lease * 1000
                reveal_lease = True
            elif action == "release":
                task.update(state="review" if is_review else "todo", reason=None)
                clear_lease(task)
            elif action == "block":
                task.update(state="blocked", blockedFrom="review" if is_review else "work",
                            reason=text(request.get("reason"), "reason", 1000, True))
                clear_lease(task)
            elif action in {"complete", "request_review", "request_changes"}:
                summary = text(request.get("summary"), "summary", 1600, True)
                proof = evidence(request.get("evidence", []))
                if action == "request_changes":
                    if not is_review:
                        raise ValueError("request_changes hanya dari reviewer dengan claim aktif")
                    task["result"].update(reviewedBy=actor, reviewSummary=summary, reviewEvidence=proof, status="changes_requested")
                    task.update(state="todo", reason=summary)
                elif action == "request_review":
                    if is_review:
                        raise ValueError("Task sudah dalam review")
                    reviewer = kanban_actor(request.get("reviewer") or task["reviewer"])
                    if task["reviewer"] is not None and task["reviewer"] != reviewer:
                        raise ValueError("Reviewer yang sudah ditetapkan tidak boleh diganti saat handoff")
                    if reviewer == actor:
                        raise ValueError("Reviewer harus berbeda dari pelaksana")
                    task.update(state="review", reviewer=reviewer, result={"summary": summary, "evidence": proof,
                                "submittedBy": actor, "at": moment, "reviewedBy": None, "reviewSummary": None,
                                "reviewEvidence": [], "status": "pending_review"})
                else:
                    if not is_review and task["reviewer"] is not None:
                        raise ValueError("Task memerlukan request_review dan persetujuan reviewer")
                    if is_review:
                        task["result"].update(reviewedBy=actor, reviewSummary=summary, reviewEvidence=proof, status="completed")
                    else:
                        task["result"] = {"summary": summary, "evidence": proof, "submittedBy": actor, "at": moment,
                                          "reviewedBy": None, "reviewSummary": None, "reviewEvidence": [], "status": "completed"}
                    task.update(state="done", reason=None)
                clear_lease(task)
        persist(task, action, actor)
        return {"task": public(task, True, reveal_lease)}



if __name__ == "__main__":
    if len(sys.argv) == 3 and sys.argv[1] == "--worker":
        run_worker(Path(sys.argv[2]))
    else:
        try:
            request = json.loads(sys.argv[1])
            if request.get("tool") not in {"ssh_memory", "ssh_skill", "ssh_job", "ssh_kanban"}:
                raise ValueError("Tool tidak dikenal")
            result = kanban(request) if request["tool"] == "ssh_kanban" else jobs(request) if request["tool"] == "ssh_job" else knowledge(request)
            print(json.dumps({"ok": True, **result}, ensure_ascii=False))
        except (ValueError, OSError, KeyError, TypeError) as error:
            # No traceback or command output: persisted data may be sensitive.
            message = str(error) if isinstance(error, ValueError) else "Operasi penyimpanan gagal: " + type(error).__name__
            print(json.dumps({"ok": False, "error": message}))
