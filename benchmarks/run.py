#!/usr/bin/env python3
"""Collect evidence from real, isolated Pi TUIs; operators are never scored."""
import argparse
import errno
import fcntl
import hashlib
import json
import math
import os
from pathlib import Path
import pty
import select
import shutil
import signal
import struct
import subprocess
import sys
import tempfile
import termios
import time
import uuid
from lifecycle import ProcessOwner, Interrupted, control, credentials_cleanup, native_ledger

ROOT = Path(__file__).resolve().parent
SCENARIOS = ROOT / "scenarios"
INTERRUPTED = None


def read_json(path):
    return json.loads(Path(path).read_text())


def save_json(path, value):
    Path(path).write_text(json.dumps(value, indent=2) + "\n")


def sha256(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def episode_order(config, trials):
    for trial in trials:
        for index, scenario in enumerate(config["scenarios"]):
            variants = ("ours", "upstream") if (trial + index) % 2 else ("upstream", "ours")
            for variant in variants:
                yield trial, scenario, variant


def make_fixture(workspace, trial):
    workspace.mkdir(parents=True)
    values = {1: (11, 22), 2: (4, 9), 3: (7, 3)}[trial]
    state = {1: "alpha=9\nbeta=2\ngamma=3\n", 2: "alpha=1\nbeta=2\ngamma=3\n", 3: "alpha=1\nbeta=9\ngamma=3\n"}[trial]
    files = {f"{key}.txt": f"{value}\n" for key, value in zip("ab", values)}
    files.update({"route.txt": {1: "left\n", 2: "right\n", 3: "both\n"}[trial], "left.txt": "10\n", "right.txt": "20\n", "state.txt": state})
    for name, contents in files.items():
        (workspace / name).write_text(contents)
    subprocess.run(["git", "init", "-q"], cwd=workspace, check=True)
    subprocess.run(["git", "add", "--", *files], cwd=workspace, check=True)
    subprocess.run(["git", "-c", "user.name=Benchmark Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-qm", "Initial benchmark inputs"], cwd=workspace, check=True)
    return {name: sha256(workspace / name) for name in files}


def render_prompt(model, trial, scenario, run_id, workspace, templates=SCENARIOS):
    text = (templates / "header.txt").read_text() + "\n" + (templates / f"{scenario}.txt").read_text()
    substitutions = {"RUN_ID": run_id, "TRIAL": str(trial), "SCENARIO": scenario, "MODEL": f'{model["provider"]}/{model["id"]}',
                     "THINKING": model["thinking"], "WORKSPACE": str(workspace), "TOKEN": {1: "BLUE", 2: "GREEN", 3: "GOLD"}[trial]}
    for key, value in substitutions.items():
        text = text.replace("{{" + key + "}}", value)
    assert "{{" not in text
    return text


def context_ancestors(workspace):
    names = ("AGENTS.override.md", "AGENTS.md", "AGENTS.MD", "CLAUDE.md", "CLAUDE.MD")
    found = [str(parent / name) for parent in [workspace, *workspace.parents] for name in names if (parent / name).exists()]
    if found:
        raise RuntimeError(f"Child context isolation failed: unexpected ancestor instructions {found}")
    return {"checked_directories": [str(path) for path in [workspace, *workspace.parents]], "context_files": []}


def isolated_environment(directory, manifest, model, events, config, startup_only=False, credential_environment=True):
    root = directory.parent
    directory.mkdir(mode=0o700, parents=True, exist_ok=True)
    home = root / "home"
    home.mkdir(mode=0o700, exist_ok=True)
    source = Path(manifest["source_agent_dir"])
    try:
        for name in ("auth.json", "models.json", "models-store.json"):
            if (source / name).is_file():
                shutil.copyfile(source / name, directory / name)
                (directory / name).chmod(0o600)
        save_json(directory / "settings.json", {
            "packages": [], "extensions": [], "skills": [], "prompts": [], "themes": [],
            "defaultProvider": model["provider"], "defaultModel": model["id"], "defaultThinkingLevel": model["thinking"],
            "defaultProjectTrust": "always", "cacheWarming": "off", "compaction": {"enabled": False},
            "retry": {"enabled": True, "maxRetries": 8, "baseDelayMs": 5000, "maxAgentDelayMs": 60000,
                     "provider": {"maxRetries": 0}}, "minimalSubagents": {"timeoutMs": config["episode_timeout_seconds"] * 1000},
        })
        inherited = os.environ if credential_environment else {key: os.environ[key] for key in ("PATH", "LANG", "LC_ALL", "TMPDIR", "TMP", "TEMP") if key in os.environ}
        env = {key: value for key, value in inherited.items() if not key.startswith(("PI_SUBAGENT", "PI_BENCH_")) and key not in {
            "PI_SESSION_ID", "PI_SESSION_FILE", "PI_PROVIDER", "PI_MODEL", "PI_REASONING_LEVEL", "PI_CODING_AGENT_SESSION_DIR",
            "PI_PACKAGE_DIR", "JITI_ALIAS", "NODE_OPTIONS", "NODE_PATH", "XDG_CONFIG_HOME"}}
        original_home = Path(manifest.get("source_home", os.environ["HOME"]))
        # Keep cloud credential lookup explicit without exposing user role/config discovery.
        for variable, name in (("AWS_SHARED_CREDENTIALS_FILE", "credentials"), ("AWS_CONFIG_FILE", "config")):
            if credential_environment and variable not in env and (original_home / ".aws" / name).is_file():
                env[variable] = str(original_home / ".aws" / name)
        expected = {"model": f'{model["provider"]}/{model["id"]}', "thinking": model["thinking"]}
        runtime = manifest.get("runtime", {})
        expected.update({key: runtime[key] for key in ("pi_version", "node_version", "node_executable", "pi_entrypoint") if key in runtime})
        route_key = next((key for key, route in manifest.get("model_routes", {}).items() if route["provider"] == model["provider"] and route["id"] == model["id"]), None)
        if route_key:
            expected["route"] = manifest["model_routes"][route_key]
        env.update({"HOME": str(home), "USERPROFILE": str(home), "PI_CODING_AGENT_DIR": str(directory),
                    "PI_SUBAGENTS_TEMP_ROOT": str(root / "upstream-temp"), "PI_BENCH_OWNER": uuid.uuid4().hex,
                    "PI_OFFLINE": "1", "PI_SKIP_VERSION_CHECK": "1", "PI_TELEMETRY": "0", "TERM": "xterm-256color",
                    "PI_IMAGE_PROTOCOL": "none", "PI_BENCH_EVENTS": str(events), "PI_BENCH_CONTROL": str(root / "control.json"),
                    "PI_BENCH_MODEL": json.dumps(expected), "PI_BENCH_STARTUP_ONLY": "1" if startup_only else "0",
                    "PI_BENCH_TIMEOUT_SECONDS": str(config["episode_timeout_seconds"]),
                    "PI_BENCH_CHILD_STALL_SECONDS": str(config.get("child_stall_seconds", 0))})
        return env
    except BaseException:
        credentials_cleanup(root)
        raise


def pi_command(model, package=None, prompt=None, manifest=None, recorder=None):
    manifest = manifest or read_json(ROOT / ".cache/manifest.json")
    runtime = manifest["runtime"]
    args = [runtime["node_executable"], runtime["pi_entrypoint"], "--offline", "--approve", "--no-extensions", "--no-skills",
            "--no-prompt-templates", "--no-themes", "--no-context-files", "--tui-mode", "regular", "--model", f'{model["provider"]}/{model["id"]}', "--thinking", model["thinking"]]
    if package:
        directory = ROOT / package["directory"]
        metadata = read_json(directory / "package.json")
        args.extend(["--extension", str(directory / package["entrypoint"])])
        for resource, flag in (("skills", "--skill"), ("prompts", "--prompt-template")):
            for path in metadata.get("pi", {}).get(resource, []):
                args.extend([flag, str(directory / path)])
    args.extend(["--extension", str(recorder or ROOT / ".cache/protocol/recorder.ts")])
    if prompt is not None:
        args.extend(["--", prompt])
    return args


def events_from(path):
    if not path.exists():
        return []
    rows = []
    for line in path.read_text().splitlines():
        if line.strip():
            try:
                rows.append(json.loads(line))
            except ValueError:
                # An in-flight final append is not an error until final reconciliation.
                if line != path.read_text().splitlines()[-1]:
                    raise
    return rows


TEARDOWN_SECONDS = 14


def child_assistant_progress(root):
    # Role presence only; never log or return transcript text.
    for path in Path(root).rglob("*.jsonl"):
        if path.name in {"events.jsonl", "baseline-events.jsonl"}:
            continue
        try:
            text = path.read_text()
        except OSError:
            continue
        if '"role":"assistant"' in text.replace(" ", ""):
            return True
    return False
RATE_LIMIT = ("429", "rate_limit", "rate limit", "too many requests", "throttl", "overloaded", "service unavailable")
NONRETRYABLE = ("no credits remaining", "insufficient_quota", "billing", "invalid api key", "unauthorized", "authentication")


def parent_provider_error(rows):
    for row in rows:
        message = row.get("data", {}).get("message", {}) if row.get("type") == "message_end" else {}
        if message.get("stopReason") == "error":
            return str(message.get("errorMessage") or "")
    return ""


def retryable_provider_error(text):
    lower = text.lower()
    if any(token in lower for token in NONRETRYABLE):
        return False
    return any(token in lower for token in RATE_LIMIT)


def run_tui(args, workspace, env, log_path, timeout):
    started = time.monotonic()
    root = Path(env.get("PI_CODING_AGENT_DIR", workspace / "agent")).parent
    owner = ProcessOwner(env.get("PI_BENCH_OWNER", uuid.uuid4().hex), root)
    events_path = Path(env.get("PI_BENCH_EVENTS", root / "events.jsonl"))
    pid, master = pty.fork()
    if pid == 0:
        try:
            os.chdir(workspace)
            os.execvpe(args[0], args, env)
        finally:
            os._exit(127)
    status, abort_at, finish_at, children_at = None, None, None, None
    premature, external_timeout, interrupted, child_stall = False, False, None, False
    ownership_seen = False
    direct_escalations, watchdog_errors = [], []
    direct_unknown = False

    def diagnostic(operation, error):
        watchdog_errors.append({"operation": operation, "error": type(error).__name__})

    def deliver(action, reason):
        try:
            control(root, action, reason)
        except Exception as error:
            diagnostic("control_delivery", error)

    def reap():
        nonlocal status, direct_unknown
        try:
            finished, child_status = os.waitpid(pid, os.WNOHANG)
            if finished:
                status = child_status
        except (ChildProcessError, OSError) as error:
            direct_unknown = True
            diagnostic("direct_child_reap", error)

    def signal_direct(requested_signal):
        reap()  # The unreaped direct forkpty child cannot have its PID reused.
        if status is not None or direct_unknown:
            return
        try:
            os.kill(pid, requested_signal)
            direct_escalations.append({"pid": pid, "signal": int(requested_signal), "proof": "unreaped direct forkpty child"})
        except ProcessLookupError:
            reap()
        except OSError as error:
            diagnostic("direct_child_signal", error)

    try:
        fcntl.ioctl(master, termios.TIOCSWINSZ, struct.pack("HHHH", 40, 140, 0, 0))
        with open(log_path, "wb") as output:
            while status is None and not direct_unknown:
                now = time.monotonic()
                if children_at is None and native_ledger(root)["runs"]:
                    children_at = now
                stall = int(env.get("PI_BENCH_CHILD_STALL_SECONDS") or 0)
                if abort_at is None and stall and children_at is not None and now - children_at > stall and not child_assistant_progress(root):
                    child_stall = True
                    abort_at = now
                    deliver("abort", "child produced no assistant output before stall deadline")
                if abort_at is None and (INTERRUPTED or now - started > timeout):
                    interrupted = INTERRUPTED
                    external_timeout = not bool(INTERRUPTED)
                    abort_at = now
                    deliver("abort", interrupted or "external episode deadline")
                soft_deadline = abort_at + min(6, TEARDOWN_SECONDS / 2) if abort_at is not None else None
                if soft_deadline is not None and now >= soft_deadline:
                    break
                # Three seconds bounds EACH inspector command, not a full multi-PID
                # sample. Share a ten-second total budget without extending abort's
                # absolute deadline; otherwise larger native fleets fail unfairly.
                inspection_deadline = min(now + 10, soft_deadline if soft_deadline is not None else started + timeout)
                processes = owner.sample(deadline=inspection_deadline)
                ownership_seen = ownership_seen or pid in processes
                rows = events_from(events_path)
                if any(row["type"] == "episode_timeout" for row in rows) and abort_at is None:
                    abort_at = now
                error = parent_provider_error(rows)
                if abort_at is None and error and not retryable_provider_error(error):
                    abort_at = now
                    deliver("abort", "non-retryable parent provider error; preserve unknown usage")
                if abort_at is None and error and any(row["type"] == "parent_settled" for row in rows):
                    abort_at = now
                    deliver("abort", "parent settled after provider error; retries exhausted")
                if abort_at is None and any(row["type"] == "finish_requested" for row in rows):
                    ledger = native_ledger(root)
                    snapshot_missing = env.get("PI_BENCH_VARIANT") == "upstream" and ledger["live_snapshot"] is None
                    if not ledger["all_terminal"] or snapshot_missing or not ownership_seen:
                        premature, abort_at = True, now
                        deliver("abort", "parent finish claim preceded native child settlement")
                    else:
                        live_children = [value for key, value in processes.items() if key != pid and not value["state"].startswith("Z")]
                        if not live_children:
                            if finish_at is None:
                                finish_at = now
                            if now - finish_at > 0.3:
                                deliver("finish", "native run ledger and owned processes quiescent")
                        else:
                            finish_at = None
                if abort_at is not None and now - abort_at > min(6, TEARDOWN_SECONDS / 2):
                    break  # One absolute teardown deadline, never an unbounded reap/escalation loop.
                ready, _, _ = select.select([master], [], [], 0.1)
                if ready:
                    try:
                        chunk = os.read(master, 65536)
                        if chunk:
                            output.write(chunk); output.flush()
                    except OSError as error:
                        if error.errno != errno.EIO:
                            raise
                reap()
    except Exception as error:
        diagnostic("watchdog", error)
    finally:
        deadline = (abort_at if abort_at is not None else time.monotonic()) + TEARDOWN_SECONDS
        if status is None and not direct_unknown:
            deliver("abort", "runner exception/interruption or teardown deadline")
            cooperative_deadline = min(deadline - 4, time.monotonic() + 3)
            while status is None and not direct_unknown and time.monotonic() < cooperative_deadline:
                reap()
                if status is not None:
                    break
                try:
                    owner.sample(deadline=cooperative_deadline)
                except Exception as error:
                    diagnostic("teardown_inspection", error)
                    break
                time.sleep(0.1)
            signal_direct(signal.SIGTERM)
        # Inspection/containment cannot prevent independently guarded direct-child
        # termination, PTY closure or the caller's evidence/credential finalizer.
        try:
            cleanup = owner.contain(deadline=deadline - 3)
        except Exception as error:
            diagnostic("containment", error)
            cleanup = owner.unknown(error)
        if status is None and not direct_unknown:
            signal_direct(signal.SIGKILL)
            while status is None and not direct_unknown and time.monotonic() < deadline:
                reap()
                if status is None:
                    time.sleep(0.1)
        if status is None:
            diagnostic("unresolved_direct_child", TimeoutError())
        if watchdog_errors or status is None:
            cleanup.update({"quiescent": False, "cleanup_state": "unknown",
                            "unresolved_direct_pid": pid if status is None else None})
        try:
            os.close(master)
        except OSError as error:
            diagnostic("pty_close", error)
            cleanup.update({"quiescent": False, "cleanup_state": "unknown"})
    try:
        final_native = native_ledger(root)
    except Exception as error:
        diagnostic("native_ledger", error)
        final_native = {"all_terminal": False, "runs": [], "errors": [{"error": type(error).__name__}]}
    return {"exit_code": os.waitstatus_to_exitcode(status) if status is not None else None,
            "external_timeout": external_timeout, "interrupted": interrupted, "premature_finish": premature, "child_stall": child_stall,
            "parent_ownership_observed": ownership_seen,
            "elapsed_seconds": round(time.monotonic() - started, 3), "process_cleanup": cleanup, "direct_child_escalations": direct_escalations,
            "watchdog_errors": watchdog_errors, "native_final": final_native}


def chars(text):
    return len(text.encode("utf-16-le")) // 2


def footprint(snapshot):
    return math.ceil(chars(snapshot["system_prompt"]) / 4) + sum(math.ceil(chars(tool["name"] + ": " + tool["description"] + "\n" +
        json.dumps(tool.get("parameters", {}), ensure_ascii=False, separators=(",", ":"))) / 4) for tool in snapshot["tools"])


def collect_usage(directory):
    seen, sessions, coverage, errors = set(), [], [], []
    totals = {key: 0 for key in ("input", "output", "cacheRead", "cacheWrite", "totalTokens")}
    for path in sorted(directory.rglob("*.jsonl")):
        try:
            entries = [json.loads(line) for line in path.read_text().splitlines() if line.strip()]
        except (ValueError, OSError) as error:
            errors.append({"path": str(path), "error": str(error)}); continue
        if not entries or entries[0].get("type") != "session":
            continue
        session_id, session_usage, models = entries[0]["id"], {key: 0 for key in totals}, set()
        for entry in entries[1:]:
            message = entry.get("message", {})
            assistant = message.get("role") == "assistant"
            usage = message.get("usage") if assistant else None
            if entry.get("type") in {"usage", "compaction", "branch_summary"}:
                usage = entry.get("usage")
            if usage is None:
                if assistant:
                    errors.append({"path": str(path), "entry": entry.get("id"), "missing_or_invalid_usage": "all"})
                    coverage.append({"session_id": session_id, "entry_id": entry.get("id"), "path": str(path),
                                     "stop_reason": message.get("stopReason"), "state": "unknown_or_partial", "note": "missing usage"})
                continue
            identity = (session_id, entry["id"])
            if identity in seen:
                continue
            seen.add(identity)
            if not isinstance(usage, dict):
                errors.append({"path": str(path), "entry": entry["id"], "malformed_usage_type": type(usage).__name__})
                coverage.append({"session_id": session_id, "entry_id": entry["id"], "path": str(path),
                                 "stop_reason": message.get("stopReason"), "state": "unknown_or_partial", "note": "malformed usage"})
                continue
            valid = all(isinstance(usage.get(key), (int, float)) and not isinstance(usage[key], bool) and math.isfinite(usage[key]) and usage[key] >= 0 for key in totals)
            if assistant:
                models.add(f'{message.get("provider")}/{message.get("model")}')
                reported = valid and usage["totalTokens"] > 0 and message.get("stopReason") in {"stop", "toolUse", "length"}
                coverage.append({"session_id": session_id, "entry_id": entry["id"], "path": str(path),
                                 "stop_reason": message.get("stopReason"), "state": "reported_terminal" if reported else "unknown_or_partial",
                                 "note": "SDK-normalized reported volume, not independently verified provider billing"})
            if not assistant:
                coverage.append({"session_id": session_id, "entry_id": entry["id"], "path": str(path), "stop_reason": entry.get("stopReason"),
                                 "state": "reported_terminal" if valid and usage["totalTokens"] > 0 and not entry.get("error") else "unknown_or_partial",
                                 "note": "standalone SDK-reported usage; reconcile provenance before completeness"})
            for key in totals:
                value = usage.get(key)
                if not isinstance(value, (int, float)) or isinstance(value, bool) or not math.isfinite(value) or value < 0:
                    errors.append({"path": str(path), "entry": entry["id"], "missing_or_invalid_usage": key}); continue
                totals[key] += value; session_usage[key] += value
        sessions.append({"id": session_id, "path": str(path), "models": sorted(models), "usage": session_usage})
    return {"reported_usage_lower_bound": totals, "sessions": sessions, "parse_errors": errors, "request_coverage": coverage,
            "unknown_requests": sum(row["state"] != "reported_terminal" for row in coverage),
            "completeness": "unverified until every admitted native run/session is reconciled; abort/error/zero usage is unknown, not free",
            "method": "physical assistant and standalone usage entries; session/entry deduplication; nested tool rollups excluded"}


def evidence_inventory(directory):
    return {str(path.relative_to(directory)): sha256(path) for path in sorted(directory.rglob("*")) if path.is_file() and path.name != "collection.json"}


def session_attestation(directory, package, model, parent_ids, parent_prompt):
    roles = {}
    for role in ("worker", "reviewer"):
        path = ROOT / package["directory"] / "agents" / f"{role}.md"
        body = path.read_text().split("---", 2)[-1].strip()
        roles[role] = {"path": str(path), "sha256": sha256(path), "body": body}
    children, errors = [], []
    for path in directory.rglob("*.jsonl"):
        try:
            entries = [json.loads(line) for line in path.read_text().splitlines() if line.strip()]
        except ValueError:
            continue
        if not entries or entries[0].get("type") != "session" or entries[0]["id"] in parent_ids:
            continue
        messages = [row["message"] for row in entries if row.get("type") == "message"]
        systems = [message for message in messages if message.get("role") == "system"]
        system_text = "\n".join(str(message.get("content", "")) + "\n" + "\n".join(value for value in message.get("sections", {}).values() if isinstance(value, str)) for message in systems)
        matched = [role for role, info in roles.items() if info["body"] in system_text]
        users = [message for message in messages if message.get("role") == "user"]
        raw_user = json.dumps(users, ensure_ascii=False)
        fresh = parent_prompt not in raw_user and "Execute one scored delegation benchmark episode." not in raw_user
        assistants = [message for message in messages if message.get("role") == "assistant"]
        selected = {f'{message.get("provider")}/{message.get("model")}' for message in assistants}
        thinking = [row["thinkingLevel"] for row in entries if row.get("type") == "thinking_level_change"]
        message_thinking = sorted({message["thinkingLevel"] for message in assistants if message.get("thinkingLevel")})
        child_cwd = Path(entries[0]["cwd"]).resolve()
        expected_cwd = (directory / "workspace").resolve()
        try:
            child_context = context_ancestors(child_cwd)
        except RuntimeError as error:
            child_context = {"isolation_error": str(error)}
        row = {"id": entries[0]["id"], "path": str(path), "role_matches": matched, "fresh_parent_history_absent": fresh,
               "models": sorted(selected), "thinking_changes": thinking, "assistant_thinking": message_thinking,
               "cwd": str(child_cwd), "expected_cwd": str(expected_cwd), "context_inventory": child_context, "initial_system_count": len(systems)}
        children.append(row)
        if (len(matched) != 1 or not fresh or child_cwd != expected_cwd or child_context.get("isolation_error")
                or selected - {f'{model["provider"]}/{model["id"]}'} or (thinking and set(thinking) != {model["thinking"]})
                or set(message_thinking) - {model["thinking"]}):
            errors.append(row)
    return {"children": children, "errors": errors, "expected_roles": {role: {key: value for key, value in info.items() if key != "body"} for role, info in roles.items()},
            "status": "partial static attestation; reconcile admission counts and missing thinking/session evidence before scoring"}


def evidence_ready(record):
    # Terminal scenario failures (timeout/stall/blocked claim) are collected
    # evidence and must not freeze the rest of the suite.
    errors = record.get("errors") or []
    collector_fault = [row for row in errors if isinstance(row, dict) and (
        row.get("collector_error") or row.get("type") in {"preflight_error", "invalid_result", "control_error"})]
    timed_out = (record.get("execution", {}).get("external_timeout") or record.get("execution", {}).get("child_stall")
                 or any(isinstance(row, dict) and row.get("type") == "episode_timeout" for row in errors))
    attestation_ok = timed_out or not (record.get("session_attestation") or {}).get("errors")
    return (record.get("collector_status") == "collected"
        and not collector_fault and attestation_ok
        and "usage_evidence" in record and not record["usage_evidence"].get("parse_errors")
        and "session_attestation" in record
        and record.get("credential_cleanup", {}).get("complete") is True
        and record.get("execution", {}).get("process_cleanup", {}).get("quiescent") is True
        and record.get("execution", {}).get("process_cleanup", {}).get("cleanup_state") != "unknown"
        and not record.get("execution", {}).get("watchdog_errors")
        and record["execution"].get("exit_code") is not None
        and record["execution"].get("native_final", {}).get("all_terminal") is True
        and not record["execution"].get("direct_child_escalations")
        and not record["execution"]["process_cleanup"].get("escalations"))


def admission_gate(results, campaign, protocol):
    # main holds this model's .running lock. Scan every trial before ANY admission
    # or resume; a different --trial cannot bypass incomplete earlier evidence.
    for kind in ("episodes", "smoke"):
        for directory in sorted((results / kind).glob("*")):
            assert directory.is_dir() and not directory.is_symlink(), f"Unexpected evidence path: {directory}"
            path = directory / "collection.json"
            assert path.is_file(), f"Prior partial evidence blocks admission: {directory}"
            try:
                record = read_json(path)
                valid = (record.get("campaign_sha256") == campaign and record.get("protocol_sha256") == protocol
                         and evidence_ready(record))
            except (OSError, ValueError, TypeError, KeyError, AttributeError):
                valid = False
            assert valid, f"Prior incomplete or invalid evidence blocks admission: {directory}; inspect, do not clear automatically"


def run_episode(model_key, model, trial, scenario, variant, config, manifest, results, smoke=False, preflight=False):
    run_id = f"{model_key}-t{trial}-{scenario}-{variant}" + ("-smoke" if smoke else "")
    directory = results / ("smoke" if smoke else "episodes") / run_id
    record_path = directory / "collection.json"
    campaign = sha256(ROOT / ".cache/manifest.json")
    admission_gate(results, campaign, manifest["protocol_sha256"])
    if record_path.exists():
        record = read_json(record_path)
        assert record["campaign_sha256"] == campaign and record["protocol_sha256"] == manifest["protocol_sha256"], "Different campaign/protocol in saved evidence"
        assert evidence_ready(record), "Prior incomplete or invalid evidence needs inspection; no silent retry"
        print(f"Already collected: {run_id}", flush=True); return record
    assert not directory.exists(), f"Partial evidence exists; do not overwrite {directory}"
    if INTERRUPTED:
        raise Interrupted(INTERRUPTED)
    if not preflight:
        subprocess.run([manifest["runtime"]["node_executable"], str(ROOT / "prepare.mjs"), "--check"], check=True, stdout=subprocess.DEVNULL)
    directory.mkdir(mode=0o700, parents=True)
    runtime_root = Path(tempfile.mkdtemp(prefix="pi-bench-", dir=tempfile.gettempdir())).resolve()
    save_json(directory / "runtime-location.json", {"original_root": str(runtime_root), "retained_root": "runtime", "runner_pid": os.getpid()})
    package = manifest["packages"][variant]
    record = {"schema_version": 2, "run_id": run_id, "model_key": model_key, "model": model, "trial": trial,
              "scenario": scenario, "variant": variant, "smoke_only": smoke, "unscored_preflight": preflight,
              "campaign_sha256": campaign, "protocol_sha256": manifest["protocol_sha256"], "package": package,
              "collector_status": "incomplete", "score": "not evaluated", "errors": []}
    execution = None
    try:
        workspace = runtime_root / "workspace"
        record["input_sha256"] = make_fixture(workspace, trial)
        record["context_isolation"] = context_ancestors(workspace)
        prompt = render_prompt(model, trial, scenario, run_id, workspace, ROOT / ".cache/protocol/scenarios")
        (directory / "prompt.txt").write_text(prompt)
        record["prompt_sha256"] = sha256(directory / "prompt.txt")
        baseline_path = runtime_root / "baseline-events.jsonl"
        env = isolated_environment(runtime_root / "agent", manifest, model, baseline_path, config, startup_only=True, credential_environment=not preflight)
        if preflight:
            env["NODE_OPTIONS"] = "--require=" + str(ROOT / ".cache/protocol/preflight-guard.cjs")
            env["PI_BENCH_GUARD_LOG"] = str(runtime_root / "guard-bootstrap.jsonl")
        baseline = run_tui(pi_command(model, manifest=manifest), workspace, env, runtime_root / "baseline-terminal.log", 30)
        record["baseline_execution"] = baseline
        baseline_rows = events_from(baseline_path)
        assert baseline["exit_code"] == 0 and baseline["process_cleanup"]["quiescent"], "Baseline TUI failed"
        assert not any(row["type"] == "preflight_error" for row in baseline_rows), "Baseline runtime/model attestation failed"
        baseline_snapshot = next(row["data"] for row in baseline_rows if row["type"] == "startup")
        events_path = runtime_root / "events.jsonl"
        env.update({"PI_BENCH_EVENTS": str(events_path), "PI_BENCH_STARTUP_ONLY": "1" if smoke else "0", "PI_BENCH_VARIANT": variant})
        execution = run_tui(pi_command(model, package, None if smoke else prompt, manifest), workspace, env,
                            runtime_root / "terminal.log", 30 if smoke else config["episode_timeout_seconds"] + 15)
        record["execution"] = execution  # Preserve ownership/unknown-PID evidence BEFORE any parser or assertion.
        rows = events_from(events_path)
        startup = next((row["data"] for row in rows if row["type"] == "startup"), None)
        assert startup is not None, "Package failed before recorder startup"
        assert {"subagent", "subagents_enable"} & {tool["name"] for tool in startup["tools"]}, "Delegation tool absent"
        errors = [row for row in rows if row["type"] in {"preflight_error", "invalid_result", "episode_timeout", "control_error"}]
        collector_faults = [row for row in errors if row["type"] != "episode_timeout"]
        claim = read_json(workspace / "result.json") if (workspace / "result.json").exists() else None
        requests = [row["data"] for row in rows if row["type"] == "request_context"]
        active = next((request for request in requests if any(tool["name"] == "subagent" for tool in request["tools"])), None)
        record.update({"execution": execution, "claim": claim, "errors": errors,
            "parent_runtime": {key: startup[key] for key in ("pid", "session_id", "model", "thinking", "pi_version", "node_version", "node_executable", "pi_entrypoint", "route")},
            "footprint_estimates": {"estimator": "ceil(JS UTF-16 characters / 4), matched shared baseline subtracted",
                "startup_declared_package_delta": footprint(startup) - footprint(baseline_snapshot),
                "first_request_declared_package_delta": footprint(requests[0]) - footprint(baseline_snapshot) if requests else None,
                "delegation_active_declared_package_delta": footprint(active) - footprint(baseline_snapshot) if active else None,
                "scope": "declared system/tool context only; on-demand guide/skill message reads are excluded here but included in total usage"}})
        contained = (execution["process_cleanup"]["quiescent"] and execution["native_final"]["all_terminal"]
                     and not execution["direct_child_escalations"] and not execution["process_cleanup"]["escalations"]
                     and not execution["watchdog_errors"])
        good = (execution["exit_code"] == 0 and not execution["external_timeout"] and not execution.get("child_stall")
                and not execution["interrupted"] and not execution["premature_finish"] and contained
                and not collector_faults and (smoke or claim is not None))
        record["usage_evidence"] = collect_usage(runtime_root)
        record["session_attestation"] = session_attestation(runtime_root, package, model,
            {baseline_snapshot["session_id"], startup["session_id"]}, prompt)
        good = good and not record["usage_evidence"]["parse_errors"] and not record["session_attestation"]["errors"]
        failed_closed = (contained and not record["usage_evidence"]["parse_errors"] and execution["exit_code"] is not None
                         and (execution["external_timeout"] or execution.get("child_stall") or any(row["type"] == "episode_timeout" for row in errors)
                              or (claim or {}).get("outcome") == "blocked"))
        record["collector_status"] = "collected" if good or failed_closed else "incomplete"
    except BaseException as error:
        record["collector_status"] = "incomplete"
        record["errors"].append({"collector_error": type(error).__name__, "message": str(error)})
    finally:
        # Guard encompasses environment construction and interruption, not just execution.
        record["credential_cleanup"] = credentials_cleanup(runtime_root)
        if execution is None:
            # run_tui preserves its existing ledger and returns diagnostic failure
            # evidence; setup-only failures may require a fresh marker inspection.
            try:
                record["exception_process_cleanup"] = (ProcessOwner(env["PI_BENCH_OWNER"], runtime_root).contain()
                    if "env" in locals() else {"quiescent": True, "observed": []})
            except Exception as error:
                record["exception_process_cleanup"] = {"quiescent": False, "cleanup_state": "unknown", "error": type(error).__name__}
                record["collector_status"] = "incomplete"
        if not record["credential_cleanup"]["complete"]:
            record["collector_status"] = "incomplete"
        shutil.copytree(runtime_root, directory / "runtime")
        record["evidence_sha256"] = evidence_inventory(directory)
        save_json(record_path, record)
        quiet = (execution or {}).get("process_cleanup", record.get("exception_process_cleanup", {})).get("quiescent", False)
        if "baseline_execution" in record:
            quiet = quiet and record["baseline_execution"]["process_cleanup"].get("quiescent", False)
        if quiet and record["credential_cleanup"]["complete"]:
            try:
                shutil.rmtree(runtime_root)
            except OSError as error:
                record["collector_status"] = "incomplete"
                record["errors"].append({"runtime_cleanup_error": type(error).__name__})
                record["retained_private_runtime"] = str(runtime_root)
        else:
            record["retained_private_runtime"] = str(runtime_root)
        save_json(record_path, record)
    print(f'{record["collector_status"]}: {run_id}; not scored', flush=True)
    if record["collector_status"] != "collected":
        raise RuntimeError(f"Collection stopped; inspect {directory}. Do not clear partial evidence automatically.")
    return record


def install_signal_handlers():
    def interrupted(number, _frame):
        global INTERRUPTED
        INTERRUPTED = signal.Signals(number).name
    return {number: signal.signal(number, interrupted) for number in (signal.SIGINT, signal.SIGTERM)}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("model", choices=tuple(read_json(ROOT / "config.json")["models"]))
    parser.add_argument("--trial", type=int, choices=(1, 2, 3))
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--smoke", action="store_true")
    args = parser.parse_args()
    config = read_json(ROOT / "config.json")
    model = config["models"][args.model]
    order = list(episode_order(config, [args.trial] if args.trial else config["trials"]))
    if args.dry_run:
        print(json.dumps({"model": model, "episodes": order, "count": len(order), "live_calls": False}, indent=2)); return
    subprocess.run(["node", str(ROOT / "prepare.mjs"), "--check"], check=True)
    manifest = read_json(ROOT / ".cache/manifest.json")
    results = ROOT / args.model / "results"
    results.mkdir(parents=True, exist_ok=True)
    lock = results / ".running"
    descriptor = os.open(lock, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
    old_handlers = install_signal_handlers()
    try:
        os.write(descriptor, str(os.getpid()).encode())
        if args.smoke:
            order = [(1, "parallel_join", "ours"), (1, "parallel_join", "upstream")]
        records = []
        for index, (trial, scenario, variant) in enumerate(order):
            if records and not args.smoke:
                time.sleep(max(0, int(config.get("episode_spacing_seconds", 0))))
            records.append(run_episode(args.model, model, trial, scenario, variant, config, manifest, results, args.smoke))
        save_json(results / ("smoke-summary.json" if args.smoke else f'summary{"-trial-" + str(args.trial) if args.trial else ""}.json'), {
            "model": model, "episodes_collected": len(records), "expected_episodes": len(order), "scored": False,
            "campaign_sha256": sha256(ROOT / ".cache/manifest.json"), "records": [record["run_id"] for record in records]})
        print(f"Finished {args.model}: {len(records)} collected episodes. Independent reconciliation still required.")
    finally:
        for number, handler in old_handlers.items():
            signal.signal(number, handler)
        os.close(descriptor); lock.unlink(missing_ok=True)


if __name__ == "__main__":
    main()
