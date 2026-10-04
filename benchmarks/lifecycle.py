"""Benchmark-only POSIX containment; argv/environment never enter the ledger.

Discovery is only a hint. Every ownership/ancestry observation is bracketed by
precise generation queries around a NEW per-PID inspection, not a stale ps row.
"""
import ctypes
import json
import os
from pathlib import Path
import re
import signal
import subprocess
import sys
import time


class BsdInfo(ctypes.Structure):
    _fields_ = [("ids", ctypes.c_uint32 * 12), ("comm", ctypes.c_char * 16),
                ("name", ctypes.c_char * 32), ("counts", ctypes.c_uint32 * 6),
                ("start_seconds", ctypes.c_uint64), ("start_microseconds", ctypes.c_uint64)]


def generation(pid):
    if sys.platform == "darwin":
        info = BsdInfo()
        function = ctypes.CDLL("/usr/lib/libproc.dylib").proc_pidinfo
        function.argtypes = [ctypes.c_int, ctypes.c_int, ctypes.c_uint64, ctypes.c_void_p, ctypes.c_int]
        result = function(pid, 3, 0, ctypes.byref(info), ctypes.sizeof(info))
        if result != ctypes.sizeof(info) or info.ids[3] != pid:
            return None
        return f"{info.start_seconds}:{info.start_microseconds}"
    if sys.platform.startswith("linux"):
        try:
            return Path(f"/proc/{pid}/stat").read_text().rsplit(")", 1)[1].split()[19]
        except (OSError, IndexError):
            return None
    raise RuntimeError("Containment currently supports Darwin/Linux only")


class Interrupted(RuntimeError):
    pass


class ProcessOwner:
    def __init__(self, marker, root):
        self.marker, self.root = marker, Path(root)
        self.observed, self.actions, self.inspection_errors = {}, [], []
        self.marker_pattern = re.compile(r"(?:^|\s)PI_BENCH_OWNER=" + re.escape(marker) + r"(?:\s|$)")

    def _ps(self, pid=None, deadline=None):
        remaining = 3 if deadline is None else min(3, deadline - time.monotonic())
        if remaining <= 0:
            raise TimeoutError("Process inspection deadline")
        selection = ["-U", str(os.getuid())] if pid is None else ["-p", str(pid)]
        try:
            result = subprocess.run(["ps", "eww", *selection, "-o", "pid=,ppid=,lstart=,stat=,command="],
                capture_output=True, text=True, timeout=remaining,
                env={**{key: value for key, value in os.environ.items() if key != "PI_BENCH_OWNER"}, "LC_ALL": "C"})
            if result.returncode == 1 and pid is not None and not result.stdout.strip():
                return ""  # Disappeared PID, not a global inspector failure.
            result.check_returncode()
            return result.stdout
        except (OSError, subprocess.SubprocessError) as error:
            self.inspection_errors.append(type(error).__name__)
            raise RuntimeError("Owned-process inspection unavailable") from error

    def _rows(self, output):
        rows = {}
        for line in output.splitlines():
            fields = line.strip().split(None, 8)
            if len(fields) != 9 or not fields[0].isdigit() or not fields[1].isdigit():
                continue
            pid = int(fields[0])
            if pid == os.getpid():
                continue
            rows[pid] = ({"pid": pid, "ppid": int(fields[1]), "birth": " ".join(fields[2:7]), "state": fields[7]},
                         bool(self.marker_pattern.search(fields[8])))
        return rows

    def _inspect(self, pid, deadline=None):
        before = generation(pid)
        if before is None:
            return None
        row = self._rows(self._ps(pid, deadline)).get(pid)
        after = generation(pid)
        if row is None or before != after or after is None:
            return None  # Never associate stale marker/ancestry with a replacement incarnation.
        identity, marked = row
        return {**identity, "generation": after}, marked

    def sample(self, deadline=None):
        hints = self._rows(self._ps(deadline=deadline))
        current = {}
        previous = {pid for pid, _birth in self.observed}
        for pid, (_hint, marked_hint) in hints.items():
            if not marked_hint and pid not in previous:
                continue
            inspected = self._inspect(pid, deadline)
            if inspected is None:
                continue
            identity, marked = inspected
            if marked or (pid, identity["generation"]) in self.observed:
                current[pid] = identity
        # Protected system binaries may conceal environ. A fresh, bracketed PPID
        # observation is accepted only while that parent's incarnation is unchanged.
        changed = True
        while changed:
            changed = False
            for pid, (hint, _marked) in hints.items():
                parent = current.get(hint["ppid"])
                if pid in current or parent is None:
                    continue
                if generation(parent["pid"]) != parent["generation"]:
                    continue
                inspected = self._inspect(pid, deadline)
                if inspected is None:
                    continue
                identity, _marked = inspected
                if identity["ppid"] != parent["pid"] or generation(parent["pid"]) != parent["generation"]:
                    continue
                current[pid] = identity
                changed = True
        for pid, identity in current.items():
            self.observed[(pid, identity["generation"])] = identity
        return current

    def signal_owned(self, requested_signal, deadline=None):
        for pid, identity in self.sample(deadline).items():
            if identity["state"].startswith("Z") or generation(pid) != identity["generation"]:
                continue
            try:
                os.kill(pid, requested_signal)
                self.actions.append({**identity, "signal": int(requested_signal), "at": time.time()})
            except ProcessLookupError:
                pass

    def live(self, deadline=None):
        return [value for value in self.sample(deadline).values() if not value["state"].startswith("Z")]

    def unknown(self, error):
        return {"quiescent": False, "cleanup_state": "unknown", "remaining": None,
                "escalations": self.actions, "observed": list(self.observed.values()),
                "inspection_errors": [*self.inspection_errors, type(error).__name__]}

    def contain(self, grace=3, deadline=None):
        deadline = deadline if deadline is not None else time.monotonic() + 2 * grace + 3
        try:
            for requested_signal in (signal.SIGTERM, signal.SIGKILL):
                if not self.live(deadline):
                    break
                self.signal_owned(requested_signal, deadline)
                phase_deadline = min(deadline, time.monotonic() + grace)
                while time.monotonic() < phase_deadline and self.live(deadline):
                    time.sleep(0.1)
            remaining = self.live(deadline)
            quiet = not remaining and not self.inspection_errors
            return {"quiescent": quiet, "cleanup_state": "quiescent" if quiet else "unknown",
                    "remaining": remaining, "escalations": self.actions,
                    "observed": list(self.observed.values()), "inspection_errors": self.inspection_errors}
        except (OSError, RuntimeError, TimeoutError) as error:
            return self.unknown(error)  # Inspection failure must never bypass the caller's direct-child fallback.


def native_ledger(root):
    root = Path(root)
    rows, errors = [], []
    files = list((root / "agent/minimal-subagents").glob("**/run.json"))
    files += list((root / "upstream-temp/async-subagent-runs").glob("**/status.json"))
    for path in sorted(files):
        try:
            value = json.loads(path.read_text())
            state = value.get("state")
            rows.append({"path": str(path), "id": value.get("id", value.get("runId")), "state": state,
                         "pid": value.get("pid"), "processTerminal": value.get("processTerminal"),
                         "terminal": state in {"completed", "complete", "failed", "cancelled", "stopped"}})
        except (ValueError, OSError) as error:
            errors.append({"path": str(path), "error": type(error).__name__})
    snapshot_path = root / "native-status.json"
    snapshot = None
    if snapshot_path.exists():
        try:
            snapshot = json.loads(snapshot_path.read_text())
        except (ValueError, OSError) as error:
            errors.append({"path": str(snapshot_path), "error": type(error).__name__})
    return {"runs": rows, "errors": errors, "live_snapshot": snapshot,
            "all_terminal": not errors and all(row["terminal"] for row in rows) and (snapshot is None or snapshot.get("quiescent") is True)}


def control(root, action, reason):
    path = Path(root) / "control.json"
    temporary = path.with_suffix(".tmp")
    temporary.write_text(json.dumps({"action": action, "reason": reason,
                                     "run_ids": [row["id"] for row in native_ledger(root)["runs"] if row["id"]]}))
    temporary.replace(path)


def credentials_cleanup(root):
    root = Path(root)
    removed, errors = [], []
    for directory in (root / "agent", root / "home/.pi/agent"):
        for name in ("auth.json", "models.json", "models-store.json"):
            path = directory / name
            try:
                if path.exists():
                    path.unlink(); removed.append(str(path))
            except OSError as error:
                errors.append({"path": str(path), "error": type(error).__name__})
    return {"removed": removed, "errors": errors, "complete": not errors}
