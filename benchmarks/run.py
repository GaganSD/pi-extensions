#!/usr/bin/env python3
"""Collect live evidence in real Pi TUIs. No model calls during --dry-run/--smoke.

Uses only Python's standard library. The outer Pi operator is not scored.
"""
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
import termios
import time

ROOT = Path(__file__).resolve().parent
SCENARIOS = ROOT / "scenarios"


def read_json(path):
    return json.loads(Path(path).read_text())


def save_json(path, value):
    Path(path).write_text(json.dumps(value, indent=2) + "\n")


def sha256(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def episode_order(config, trials):
    for trial in trials:
        for index, scenario in enumerate(config["scenarios"]):
            # Balanced paired order, fixed before any observed results.
            variants = ("ours", "upstream") if (trial + index) % 2 else ("upstream", "ours")
            for variant in variants:
                yield trial, scenario, variant


def make_fixture(workspace, trial):
    workspace.mkdir(parents=True)
    values = {1: (11, 22, 33), 2: (4, 9, 2), 3: (7, 3, 5)}[trial]
    state = {1: "alpha=9\nbeta=8\ngamma=3\n", 2: "alpha=1\nbeta=2\ngamma=3\n", 3: "alpha=1\nbeta=9\ngamma=3\n"}[trial]
    files = {f"{key}.txt": f"{value}\n" for key, value in zip("abc", values)}
    files.update({"route.txt": {1: "left\n", 2: "right\n", 3: "both\n"}[trial],
                  "left.txt": "10\n", "right.txt": "20\n", "state.txt": state})
    for name, contents in files.items():
        (workspace / name).write_text(contents)
    subprocess.run(["git", "init", "-q"], cwd=workspace, check=True)
    subprocess.run(["git", "add", "--", *files], cwd=workspace, check=True)
    subprocess.run(["git", "-c", "user.name=Benchmark Fixture", "-c", "user.email=fixture@example.invalid",
                    "commit", "-qm", "Initial benchmark inputs"], cwd=workspace, check=True)
    return {name: sha256(workspace / name) for name in files}


def render_prompt(model, trial, scenario, run_id, workspace):
    text = (SCENARIOS / "header.txt").read_text() + "\n" + (SCENARIOS / f"{scenario}.txt").read_text()
    substitutions = {"RUN_ID": run_id, "TRIAL": str(trial), "SCENARIO": scenario,
                     "MODEL": f'{model["provider"]}/{model["id"]}', "THINKING": model["thinking"],
                     "WORKSPACE": str(workspace), "TOKEN": {1: "BLUE", 2: "GREEN", 3: "GOLD"}[trial]}
    for key, value in substitutions.items():
        text = text.replace("{{" + key + "}}", value)
    assert "{{" not in text
    return text


def isolated_environment(directory, manifest, model, events, config, startup_only=False):
    directory.mkdir(mode=0o700, parents=True)
    source = Path(manifest["source_agent_dir"])
    for name in ("auth.json", "models.json", "models-store.json"):
        if (source / name).is_file():
            shutil.copyfile(source / name, directory / name)
            (directory / name).chmod(0o600)
    save_json(directory / "settings.json", {
        "packages": [], "extensions": [], "skills": [], "prompts": [], "themes": [],
        "defaultProvider": model["provider"], "defaultModel": model["id"],
        "defaultThinkingLevel": model["thinking"], "defaultProjectTrust": "always",
        "cacheWarming": "off", "compaction": {"enabled": False},
        "retry": {"enabled": False, "provider": {"maxRetries": 0}},
        "minimalSubagents": {"timeoutMs": config["episode_timeout_seconds"] * 1000},
    })
    env = {key: value for key, value in os.environ.items()
           if not key.startswith(("PI_SUBAGENT", "PI_BENCH_"))
           and key not in {"PI_SESSION_ID", "PI_SESSION_FILE", "PI_PROVIDER", "PI_MODEL", "PI_REASONING_LEVEL",
                           "PI_CODING_AGENT_SESSION_DIR", "PI_PACKAGE_DIR"}}
    env.update({"PI_CODING_AGENT_DIR": str(directory), "PI_OFFLINE": "1", "PI_SKIP_VERSION_CHECK": "1",
                "PI_TELEMETRY": "0", "TERM": "xterm-256color", "PI_IMAGE_PROTOCOL": "none",
                "PI_BENCH_EVENTS": str(events), "PI_BENCH_MODEL": json.dumps({
                    "model": f'{model["provider"]}/{model["id"]}', "thinking": model["thinking"]}),
                "PI_BENCH_STARTUP_ONLY": "1" if startup_only else "0",
                "PI_BENCH_TIMEOUT_SECONDS": str(config["episode_timeout_seconds"])})
    return env


def pi_command(model, package=None, prompt=None):
    args = ["pi", "--offline", "--approve", "--no-extensions", "--no-skills",
            "--no-prompt-templates", "--no-themes", "--no-context-files", "--tui-mode", "regular",
            "--model", f'{model["provider"]}/{model["id"]}', "--thinking", model["thinking"]]
    if package:
        directory = ROOT / package["directory"]
        metadata = read_json(directory / "package.json")
        args.extend(["--extension", str(directory / package["entrypoint"])])
        for resource, flag in (("skills", "--skill"), ("prompts", "--prompt-template")):
            for path in metadata.get("pi", {}).get(resource, []):
                args.extend([flag, str(directory / path)])
    args.extend(["--extension", str(ROOT / "recorder.ts")])
    if prompt is not None:
        args.extend(["--", prompt])
    return args


def run_tui(args, workspace, env, log_path, timeout):
    started = time.monotonic()
    pid, master = pty.fork()
    if pid == 0:
        os.chdir(workspace)
        os.execvpe(args[0], args, env)
    fcntl.ioctl(master, termios.TIOCSWINSZ, struct.pack("HHHH", 40, 140, 0, 0))
    timed_out = False
    status = None
    try:
        with open(log_path, "wb") as output:
            while status is None:
                if time.monotonic() - started > timeout:
                    timed_out = True
                    os.killpg(pid, signal.SIGTERM)
                    break
                ready, _, _ = select.select([master], [], [], 0.2)
                if ready:
                    try:
                        chunk = os.read(master, 65536)
                        if chunk:
                            output.write(chunk)
                            output.flush()
                    except OSError as error:
                        if error.errno != errno.EIO:
                            raise
                finished, child_status = os.waitpid(pid, os.WNOHANG)
                if finished:
                    status = child_status
            if timed_out:
                deadline = time.monotonic() + 10
                while time.monotonic() < deadline:
                    finished, child_status = os.waitpid(pid, os.WNOHANG)
                    if finished:
                        status = child_status
                        break
                    time.sleep(0.1)
                if status is None:
                    os.killpg(pid, signal.SIGKILL)
                    _, status = os.waitpid(pid, 0)
    finally:
        os.close(master)
        if status is None:
            try:
                os.killpg(pid, signal.SIGTERM)
                os.waitpid(pid, 0)
            except ProcessLookupError:
                pass
    return {"exit_code": os.waitstatus_to_exitcode(status), "external_timeout": timed_out,
            "elapsed_seconds": round(time.monotonic() - started, 3)}


def events_from(path):
    if not path.exists():
        return []
    return [json.loads(line) for line in path.read_text().splitlines() if line.strip()]


def chars(text):
    # Match JavaScript .length used by the reference's character proxy.
    return len(text.encode("utf-16-le")) // 2


def footprint(snapshot):
    prompt = snapshot["system_prompt"]
    tools = snapshot["tools"]
    return math.ceil(chars(prompt) / 4) + sum(math.ceil(chars(
        tool["name"] + ": " + tool["description"] + "\n" +
        json.dumps(tool.get("parameters", {}), ensure_ascii=False, separators=(",", ":"))) / 4) for tool in tools)


def collect_usage(directory):
    """Physical assistant usage only: never add tool-result nested rollups twice."""
    seen = set()
    sessions = []
    totals = {key: 0 for key in ("input", "output", "cacheRead", "cacheWrite", "totalTokens")}
    errors = []
    for path in sorted(directory.rglob("*.jsonl")):
        try:
            entries = [json.loads(line) for line in path.read_text().splitlines() if line.strip()]
        except (ValueError, OSError) as error:
            errors.append({"path": str(path), "error": str(error)})
            continue
        if not entries or entries[0].get("type") != "session":
            continue
        session_id = entries[0]["id"]
        session_usage = {key: 0 for key in totals}
        models = set()
        for entry in entries[1:]:
            message = entry.get("message", {})
            usage = message.get("usage") if message.get("role") == "assistant" else None
            if entry.get("type") in {"usage", "compaction", "branch_summary"}:
                usage = entry.get("usage")
            if usage is None:
                if message.get("role") == "assistant":
                    errors.append({"path": str(path), "entry": entry.get("id"), "missing_or_invalid_usage": "all"})
                continue
            identity = (session_id, entry["id"])
            if identity in seen:
                continue
            seen.add(identity)
            if message.get("role") == "assistant":
                models.add(f'{message.get("provider")}/{message.get("model")}')
            for key in totals:
                value = usage.get(key)
                if not isinstance(value, (int, float)) or value < 0:
                    errors.append({"path": str(path), "entry": entry["id"], "missing_or_invalid_usage": key})
                    continue
                totals[key] += value
                session_usage[key] += value
        sessions.append({"id": session_id, "path": str(path), "models": sorted(models), "usage": session_usage})
    return {"reported_usage": totals, "sessions": sessions, "parse_errors": errors,
            "completeness": "unverified: evaluator must reconcile every launched child, including cancelled/failed runs",
            "method": "assistant usage.totalTokens plus standalone usage entries, deduplicated by session/entry ID; tool-result rollups excluded"}


def run_episode(model_key, model, trial, scenario, variant, config, manifest, results, smoke=False):
    run_id = f"{model_key}-t{trial}-{scenario}-{variant}" + ("-smoke" if smoke else "")
    directory = results / ("smoke" if smoke else "episodes") / run_id
    record_path = directory / "collection.json"
    if record_path.exists():
        record = read_json(record_path)
        assert record["campaign_sha256"] == sha256(ROOT / ".cache/manifest.json"), "Different campaign in existing result"
        if record["collector_status"] != "collected":
            raise RuntimeError(f"Prior incomplete episode must be inspected, not silently retried: {run_id}")
        print(f"Already collected: {run_id}", flush=True)
        return record
    assert not directory.exists(), f"Partial evidence exists; inspect it rather than overwrite: {directory}"
    directory.mkdir(parents=True)
    workspace = directory / "workspace"
    hashes = make_fixture(workspace, trial)
    prompt = render_prompt(model, trial, scenario, run_id, workspace)
    (directory / "prompt.txt").write_text(prompt)
    package = manifest["packages"][variant]
    baseline_events = directory / "baseline-events.jsonl"
    agent_dir = directory / "agent"
    env = isolated_environment(agent_dir, manifest, model, baseline_events, config, startup_only=True)
    try:
        baseline = run_tui(pi_command(model), workspace, env, directory / "baseline-terminal.log", 30)
        baseline_rows = events_from(baseline_events)
        assert baseline["exit_code"] == 0 and any(row["type"] == "startup" for row in baseline_rows), "Baseline TUI failed"
        assert not any(row["type"] == "preflight_error" for row in baseline_rows), "Baseline model/thinking mismatch"
        events = directory / "events.jsonl"
        env.update({"PI_BENCH_EVENTS": str(events), "PI_BENCH_STARTUP_ONLY": "1" if smoke else "0"})
        execution = run_tui(pi_command(model, package, None if smoke else prompt), workspace, env,
                            directory / "terminal.log", 30 if smoke else config["episode_timeout_seconds"] + 30)
        rows = events_from(events)
        startup = next((row["data"] for row in rows if row["type"] == "startup"), None)
        errors = [row for row in rows if row["type"] in {"preflight_error", "invalid_result", "episode_timeout"}]
        assert startup is not None, "Package TUI failed before recorder startup; inspect terminal.log"
        assert "subagent" in {tool["name"] for tool in startup["tools"]} or "subagents_enable" in {tool["name"] for tool in startup["tools"]}, "Delegation tool not exposed"
        baseline_snapshot = next(row["data"] for row in baseline_rows if row["type"] == "startup")
        requests = [row["data"] for row in rows if row["type"] == "request_context"]
        active = next((request for request in requests if any(tool["name"] == "subagent" for tool in request["tools"])), None)
        claim_path = workspace / "result.json"
        claim = read_json(claim_path) if claim_path.exists() else None
        collected = execution["exit_code"] == 0 and not execution["external_timeout"] and not errors and (smoke or claim is not None)
        record = {
            "schema_version": 1, "run_id": run_id, "model_key": model_key, "model": model,
            "trial": trial, "scenario": scenario, "variant": variant, "smoke_only": smoke,
            "campaign_sha256": sha256(ROOT / ".cache/manifest.json"), "package": package,
            "input_sha256": hashes, "prompt_sha256": sha256(directory / "prompt.txt"),
            "protocol_sha256": {str(path.relative_to(ROOT)): sha256(path) for path in
                                [ROOT / "run.py", ROOT / "recorder.ts", ROOT / "config.json", *sorted(SCENARIOS.glob("*.txt"))]},
            "execution": execution, "collector_status": "collected" if collected else "incomplete",
            "score": "not evaluated", "claim": claim, "errors": errors,
            "footprint_estimates": {
                "estimator": "ceil(JS UTF-16 characters / 4), shared baseline subtracted",
                "startup_package_delta": footprint(startup) - footprint(baseline_snapshot),
                "first_request_package_delta": footprint(requests[0]) - footprint(baseline_snapshot) if requests else None,
                "delegation_active_package_delta": footprint(active) - footprint(baseline_snapshot) if active else None,
                "includes": "tool declarations and rendered system prompt, including bundled skill discovery/instructions; not task/history or child-result messages",
            },
            "usage_evidence": collect_usage(directory),
        }
        save_json(record_path, record)
        print(f'{record["collector_status"]}: {run_id} ({execution["elapsed_seconds"]}s; not scored)', flush=True)
        if not collected:
            raise RuntimeError(f"Incomplete episode; campaign stopped. Inspect {directory}")
        return record
    finally:
        # Keep task evidence but never retain credential/config copies in result bundles.
        for name in ("auth.json", "models.json", "models-store.json"):
            (agent_dir / name).unlink(missing_ok=True)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("model", choices=("luna", "kimi", "grok", "astra"))
    parser.add_argument("--trial", type=int, choices=(1, 2, 3))
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--smoke", action="store_true", help="Startup/loadout checks only; zero model calls")
    args = parser.parse_args()
    config = read_json(ROOT / "config.json")
    model = config["models"][args.model]
    trials = [args.trial] if args.trial else config["trials"]
    order = list(episode_order(config, trials))
    if args.dry_run:
        print(json.dumps({"model": model, "episodes": order, "count": len(order), "live_calls": False}, indent=2))
        return
    subprocess.run(["node", str(ROOT / "prepare.mjs"), "--check"], check=True)
    manifest = read_json(ROOT / ".cache/manifest.json")
    results = ROOT / args.model / "results"
    results.mkdir(parents=True, exist_ok=True)
    lock = results / ".running"
    descriptor = os.open(lock, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
    try:
        os.write(descriptor, str(os.getpid()).encode())
        records = []
        if args.smoke:
            order = [(1, "parallel_join", "ours"), (1, "parallel_join", "upstream")]
        for trial, scenario, variant in order:
            records.append(run_episode(args.model, model, trial, scenario, variant, config, manifest, results, args.smoke))
        save_json(results / ("smoke-summary.json" if args.smoke else f'summary{"-trial-" + str(args.trial) if args.trial else ""}.json'), {
            "model": model, "episodes_collected": len(records), "expected_episodes": len(order),
            "scored": False, "records": [record["run_id"] for record in records],
            "next_step": "Independent evidence reconciliation and scoring before README/image publication",
        })
        print(f"Finished collection for {args.model}: {len(records)} episodes. No scores fabricated.")
    finally:
        os.close(descriptor)
        lock.unlink(missing_ok=True)


if __name__ == "__main__":
    main()
