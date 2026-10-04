#!/usr/bin/env python3
"""Unscored real-delegation integration probes; all provider traffic is loopback.

Scripted responses exercise native APIs, not model intelligence/performance.
The server never writes task outputs. Native Pi tools do all task filesystem IO.
"""
import argparse
import copy
import json
import os
import signal
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
import re
import subprocess
import sys
import tempfile
import threading
import time
import run as bench

MODEL = {"provider": "benchmark-fixture", "id": "fixture", "thinking": "medium"}


def body(message):
    value = message.get("content", "")
    return value if isinstance(value, str) else "\n".join(item.get("text", "") for item in value or [] if isinstance(item, dict))


def objects(text):
    decoder = json.JSONDecoder()
    for match in re.finditer(r"\{", text):
        try:
            value, _ = decoder.raw_decode(text[match.start():])
            yield value
        except ValueError:
            continue


def nested(value):
    if isinstance(value, dict):
        yield value
        for entry in value.values():
            yield from nested(entry)
    elif isinstance(value, list):
        for entry in value:
            yield from nested(entry)


def records(messages):
    rows = {}
    for message in messages:
        if message.get("role") not in {"user", "tool"}:
            continue
        for value in objects(body(message)):
            for row in nested(value):
                if isinstance(row.get("id"), str) and row.get("state") in {"starting", "running", "waiting_for_parent", "cancelling", "completed", "failed", "cancelled", "cleanup_unknown"}:
                    rows[row["id"]] = row
    return rows


class Fixture:
    def __init__(self, variant, scenario, mode="normal", foreground=False, direct_completion=False):
        self.variant, self.scenario, self.mode = variant, scenario, mode
        self.foreground, self.direct_completion = foreground, direct_completion
        self.phase = "init"
        self.jobs, self.ids = [], []
        self.handled_questions = set()
        self.report_values = []
        self.answer = None
        self.repairs = 0
        self.requests, self.failures, self.intervals = [], [], []
        self.parallel_gate = threading.Barrier(2)
        self.parent_calls = 0
        self.activation_requested = False

    def call(self, name, arguments):
        return {"name": name, "arguments": arguments}

    def child_spec(self, label, role="reviewer", detail=""):
        return {"agent": role, "task": f"PREFLIGHT_CHILD:{label}\n{detail}", "cwd": self.workspace,
                "model": self.selector + (":medium" if self.variant == "upstream" else ""),
                **({"thinking": "medium"} if self.variant == "ours" else {"context": "fresh"})}

    def launch(self, jobs):
        self.jobs = jobs
        self.phase = "launched"
        if self.variant == "ours":
            return [self.call("subagent", {"action": "run", "tasks": jobs})]
        assert len(jobs) == 1
        return [self.call("subagent", {**jobs[0], "async": not self.foreground})]

    def workflow(self):
        def params(label, role="reviewer", detail=""):
            return json.dumps(self.child_spec(label, role, detail))
        if self.scenario == "parallel_join":
            items = [{"key": key, **self.child_spec(f"integer:{key}.txt")} for key in "ab"]
            return f'const r=await runs.all({json.dumps(items)}); const values=r.map(x=>Number(/integer: (\\d+)/.exec(x.output)[1])); return {{values,sum:values.reduce((a,b)=>a+b,0)}};'
        if self.scenario == "conditional_fanout":
            return (f'const r=await runs.run("route",{params("route")}); const route=/route: (left|right|both)/.exec(r.output)[1]; '
                    f'const names=route==="both"?["left","right"]:[route]; const base={params("unused")}; '
                    'const r2=await runs.all(names.map(key=>({...base,key,task:"PREFLIGHT_CHILD:integer:"+key+".txt"}))); '
                    'return {route,total:r2.reduce((sum,x)=>sum+Number(/integer: (\\d+)/.exec(x.output)[1]),0)};')
        return (f'let repairs=0; const review={params("review")}; const worker={params("unused", "worker")}; '
                'while(repairs<=3){const r=await runs.run("review"+repairs,review); '
                'const m=/key: (alpha|beta|gamma); expected: (\\d+)/.exec(r.output); '
                'if(!m)return {status:"PASS",repairs}; if(repairs===3)throw Error("repair bound"); '
                'await runs.run("repair"+repairs,{...worker,task:"PREFLIGHT_CHILD:repair:"+m[1]+"\\nTARGET="+m[2]}); repairs++;}')

    def worker_finish(self, summary, name, tools, preceding_tools):
        if not self.foreground:
            return [], summary
        command = "git diff --cached --quiet && printf 'NO_STAGED_FILES\\n'"
        if len(tools) == preceding_tools:
            return [self.call("bash", {"command": command})], None
        assert "NO_STAGED_FILES" in body(tools[-1]), body(tools[-1])
        # Preserve the shipped foreground writer acceptance contract. These are
        # truthful reports of actual native IO and the actual command above.
        report = {"criteriaSatisfied": [{"id": "criterion-1", "status": "satisfied", "evidence": f"Wrote only {name} through native write."}],
                  "changedFiles": [name], "testsAddedOrUpdated": [], "commandsRun": [{"command": command, "result": "passed", "summary": "No staged files."}],
                  "residualRisks": [], "noStagedFiles": True}
        return [], summary + "\n```acceptance-report\n" + json.dumps(report) + "\n```"

    def child(self, payload, prompt):
        label = prompt.splitlines()[0].removeprefix("PREFLIGHT_CHILD:")
        messages = payload["messages"]
        tools = [message for message in messages if message.get("role") == "tool"]
        available = {item["function"]["name"]: item["function"].get("parameters", {}) for item in payload.get("tools", []) or []}
        if label.startswith("integer:") or label in {"route", "review"}:
            name = label.removeprefix("integer:") if label.startswith("integer:") else ("route.txt" if label == "route" else "state.txt")
            if not tools:
                if self.scenario == "parallel_join" or (self.scenario == "conditional_fanout" and label.startswith("integer:")):
                    start = time.monotonic()
                    self.parallel_gate.wait(timeout=20)
                    self.intervals.append({"label": label, "start": start, "end": time.monotonic()})
                return [self.call("read", {"path": str(Path(self.workspace) / name)})], None
            text = body(tools[-1])
            if label.startswith("integer:"):
                value = int(re.search(r"\b\d+\b", text).group())
                return [], f"## Inspection\n{name}:1 — integer: {value}\nNo code changes requested."
            if label == "route":
                route = re.search(r"\b(left|right|both)\b", text).group()
                return [], f"## Routing evidence\nroute.txt:1 — route: {route}"
            for key, expected in (("alpha", 1), ("beta", 2), ("gamma", 3)):
                actual = int(re.search(key + r"=(\d+)", text).group(1))
                if actual != expected:
                    return [], f"## Findings\n- [P1] state.txt: key: {key}; expected: {expected}; actual: {actual}."
            return [], "No findings. All three target values match."
        if label.startswith("repair:"):
            if not tools:
                return [self.call("read", {"path": str(Path(self.workspace) / "state.txt")})], None
            if len(tools) == 1:
                key = label.removeprefix("repair:")
                value = re.search(r"TARGET=(\d+)", prompt).group(1)
                text = body(tools[-1])
                lines = [f"{name}={re.search(name + r'=(\d+)', text).group(1)}" for name in ("alpha", "beta", "gamma")]
                content = re.sub(key + r"=\d+", key + "=" + value, "\n".join(lines) + "\n")
                return [self.call("write", {"path": str(Path(self.workspace) / "state.txt"), "content": content})], None
            return [], "Corrected only the assigned key."
        if label in {"question", "obsolete"}:
            if not tools:
                assert not any(token in prompt for token in ("BLUE", "GREEN", "GOLD")), "Parent token leaked into fresh child"
                arguments = {"message": "Which token should I use?"}
                if "reason" in available["contact_supervisor"].get("properties", {}):
                    arguments["reason"] = "need_decision"
                return [self.call("contact_supervisor", arguments)], None
            if len(tools) == 1:
                token = re.search(r"\b(BLUE|GREEN|GOLD)\b", body(tools[-1])).group()
                name = "choice.txt" if label == "question" else "obsolete.txt"
                return [self.call("write", {"path": str(Path(self.workspace) / name), "content": token + "\n"})], None
            return self.worker_finish("Wrote the supervisor-selected token.", "choice.txt" if label == "question" else "obsolete.txt", tools, 2)
        if label == "replacement":
            if not tools:
                return [self.call("write", {"path": str(Path(self.workspace) / "replacement.txt"), "content": "REPLACED\n"})], None
            return self.worker_finish("Created the replacement only.", "replacement.txt", tools, 1)
        raise AssertionError(f"Unknown child label: {label}")

    def finish(self, answer):
        self.answer = answer
        self.phase = "finish_answer"
        return [self.call("write", {"path": str(Path(self.workspace) / "answer.json"), "content": json.dumps(answer)})]

    def parent(self, payload, prompt):
        self.parent_calls += 1
        assert self.parent_calls <= 45, "Unexpected parent loop"
        tool_names = {tool["function"]["name"] for tool in payload.get("tools", []) or []}
        if not self.activation_requested and "subagent" not in tool_names and "subagents_enable" in tool_names:
            self.activation_requested = True
            return [self.call("subagents_enable", {})], None
        if self.phase == "init":
            self.workspace = re.search(r"^WORKSPACE: (.+)$", prompt, re.M).group(1)
            self.selector = re.search(r"^MODEL: (.+)$", prompt, re.M).group(1)
            self.run_id = re.search(r"^RUN_ID: (.+)$", prompt, re.M).group(1)
            self.trial = int(re.search(r"^TRIAL: (\d+)$", prompt, re.M).group(1))
            if self.direct_completion:
                return self.launch([self.child_spec("replacement", "worker")]), None
            if self.variant == "upstream" and self.scenario in {"parallel_join", "conditional_fanout", "bounded_repair_loop"}:
                self.phase = "workflow_written"
                return [self.call("write", {"path": str(Path(self.workspace) / "preflight-workflow.js"), "content": self.workflow()})], None
            if self.scenario == "parallel_join":
                return self.launch([self.child_spec(f"integer:{key}.txt") for key in "ab"]), None
            if self.scenario == "conditional_fanout":
                return self.launch([self.child_spec("route")]), None
            if self.scenario == "bounded_repair_loop":
                return self.launch([self.child_spec("review")]), None
            return self.launch([self.child_spec("question" if self.scenario == "supervisor_roundtrip" else "obsolete", "worker")]), None
        messages = payload["messages"]
        tools = [message for message in messages if message.get("role") == "tool"]
        latest = body(tools[-1]) if tools else ""
        if self.phase == "workflow_written":
            self.phase = "workflow_launched"
            return [self.call("subagent", {"workflow": str(Path(self.workspace) / "preflight-workflow.js"), "async": True,
                                         "cwd": self.workspace, "model": self.selector + ":medium", "context": "fresh"})], None
        if self.phase in {"workflow_launched", "launched"}:
            if self.variant == "upstream" and self.foreground:
                if self.direct_completion:
                    assert "Created the replacement only." in latest, latest
                    return self.finish({"replacement": "REPLACED"}), None
                assert "Detached for intercom coordination" in latest, latest
                match = re.search(r'bg_wait\(\{ id: "([^"]+)"', latest)
                assert match, f"Missing retained foreground run id: {latest}"
                self.upstream_id = match.group(1)
                self.phase = "question_waited"
                return self.parent(payload, prompt)
            if self.variant == "upstream":
                match = re.search(r"Async[^\n]*\[([^\]]+)\]", latest)
                assert match, f"Missing native upstream launch receipt: {latest}"
                self.upstream_id = match.group(1)
                self.phase = "workflow_waited" if self.phase == "workflow_launched" else "question_waited"
                return [self.call("bg_wait", {"id": self.upstream_id, "timeoutMs": 60000})], None
            receipts = {row["id"]: row for value in objects(latest) for row in nested(value) if isinstance(row.get("id"), str) and row.get("model") == self.selector and row.get("workspace") == self.workspace}
            new = [row for row in receipts.values() if row["id"] not in self.ids]
            assert len(new) == len(self.jobs), f"Missing native launch receipts: {latest}"
            self.batch = [row["id"] for row in new]
            self.ids += self.batch
            self.phase = "waiting"
        if self.phase == "workflow_waited":
            assert re.search(r"complete|completed", latest, re.I), f"Workflow did not settle: {latest}"
            # The real workflow itself parsed actual reports and returned the answer.
            # This fixture also validates physical reports, files, and counts independently.
            answer = {"parallel_join": {"values": [11, 22], "sum": 33},
                      "conditional_fanout": {"route": "both", "total": 30},
                      "bounded_repair_loop": {"status": "PASS", "repairs": 2}}[self.scenario]
            return self.finish(answer), None
        if self.phase == "question_waited":
            self.phase = "pending_received"
            return [self.call("subagent_supervisor", {"action": "pending"})], None
        if self.phase == "pending_received":
            if self.mode in {"premature", "blocked"}:
                self.answer = {"intentionally_invalid": True}; self.phase = "finish_answer"
                return self.parent(payload, prompt)
            if self.mode in {"question_timeout", "sigint", "sigterm"}:
                self.phase = "held"
                return [], "Intentionally wait without replying."
            request = re.search(r'\breplyTo:\s*"([^"]+)"', latest)
            assert request, f"No exact supervisor request: {latest}"
            if self.scenario == "cancel_replace":
                self.phase = "upstream_stopped"
                return [self.call("subagent", {"action": "stop", "id": self.upstream_id})], None
            self.phase = "upstream_replied"
            return [self.call("subagent_supervisor", {"action": "reply", "replyTo": request.group(1), "message": "BLUE"})], None
        if self.phase in {"upstream_stopped", "upstream_replied", "upstream_replacement"}:
            self.phase = {"upstream_stopped": "stop_waited", "upstream_replied": "reply_waited", "upstream_replacement": "replacement_waited"}[self.phase]
            return [self.call("bg_wait", {"id": self.upstream_id, "timeoutMs": 60000})], None
        if self.phase in {"stop_waited", "stop_notice_wait"}:
            if self.phase == "stop_waited" and re.search(r"stopped|cancelled", latest, re.I):
                self.phase = "stop_verified"
                return [self.call("subagent", {"action": "status", "id": self.upstream_id})], None
            notices = [body(message) for message in messages if message.get("role") == "user"][1:]
            if any(self.upstream_id in notice and re.search(r"stopped|cancelled", notice, re.I) for notice in notices):
                self.phase = "stop_verified"
                return [self.call("subagent", {"action": "status", "id": self.upstream_id})], None
            self.phase = "stop_notice_wait"
            return [], "Waiting for the native stopped notification; the acknowledgment was not settlement."
        if self.phase == "stop_verified":
            assert re.search(r"stopped|cancelled", latest, re.I), f"Native terminal status missing: {latest}"
            calls = self.launch([self.child_spec("replacement", "worker")])
            self.phase = "replacement_launched"
            return calls, None
        if self.phase == "replacement_launched":
            match = re.search(r"Async[^\n]*\[([^\]]+)\]", latest)
            assert match, latest
            self.upstream_id = match.group(1)
            self.phase = "upstream_replacement"
            return self.parent(payload, prompt)
        if self.phase in {"reply_waited", "replacement_waited"}:
            assert re.search(r"complete|completed", latest, re.I), latest
            assert not re.search(r"Outcome:.*\bfailed\b", latest), latest
            return self.finish({"token": "BLUE"} if self.phase == "reply_waited" else {"original_cancelled": True, "replacement": "REPLACED", "obsolete_exists": False}), None
        if self.phase == "waiting":
            current = records(messages)
            batch = [current.get(id, {"id": id, "state": "running"}) for id in self.batch]
            if self.mode in {"premature", "blocked"} and any(row["state"] == "waiting_for_parent" for row in batch):
                self.answer = {"intentionally_invalid": True}
                self.phase = "finish_answer"
                return self.parent(payload, prompt)
            if self.mode in {"question_timeout", "sigint", "sigterm"} and any(row["state"] == "waiting_for_parent" for row in batch):
                self.phase = "held"
                return [], "Intentionally wait without replying."
            if any(row["state"] == "waiting_for_parent" and row["id"] not in self.handled_questions for row in batch):
                self.phase = "question_status"
                return [self.call("subagent", {"action": "status", "id": self.batch[0]})], None
            if not all(row["state"] in {"completed", "cancelled"} for row in batch):
                return [], "Waiting for native notifications."
            if self.jobs[0]["task"].startswith("PREFLIGHT_CHILD:obsolete"):
                return self.launch([self.child_spec("replacement", "worker")]), None
            self.phase = "reports_read"
            return [self.call("read", {"path": row["reportPath"]}) for row in batch], None
        if self.phase == "question_status":
            row = records([tools[-1]])[self.batch[0]]
            assert row["state"] == "waiting_for_parent" and row.get("question", {}).get("id"), latest
            self.phase = "waiting"
            self.handled_questions.add(row["id"])
            if self.scenario == "cancel_replace":
                return [self.call("subagent", {"action": "stop", "id": row["id"]})], None
            return [self.call("subagent", {"action": "reply", "id": row["id"], "requestId": row["question"]["id"], "message": "BLUE"})], None
        if self.phase == "reports_read":
            reports = [body(message) for message in tools[-len(self.batch):]]
            label = self.jobs[0]["task"].splitlines()[0].removeprefix("PREFLIGHT_CHILD:")
            if self.scenario == "parallel_join":
                values = [int(re.search(r"integer: (\d+)", report).group(1)) for report in reports]
                return self.finish({"values": values, "sum": sum(values)}), None
            if label == "route":
                route = re.search(r"route: (left|right|both)", reports[0]).group(1)
                self.route = route
                return self.launch([self.child_spec(f"integer:{key}.txt") for key in (["left", "right"] if route == "both" else [route])]), None
            if self.scenario == "conditional_fanout":
                return self.finish({"route": self.route, "total": sum(int(re.search(r"integer: (\d+)", report).group(1)) for report in reports)}), None
            if label == "review":
                match = re.search(r"key: (alpha|beta|gamma); expected: (\d+)", reports[0])
                if not match:
                    return self.finish({"status": "PASS", "repairs": self.repairs}), None
                self.repairs += 1
                return self.launch([self.child_spec("repair:" + match.group(1), "worker", "TARGET=" + match.group(2))]), None
            if label.startswith("repair:"):
                return self.launch([self.child_spec("review")]), None
            return self.finish({"token": "BLUE"} if label == "question" else {"original_cancelled": True, "replacement": "REPLACED", "obsolete_exists": False}), None
        if self.phase == "finish_answer":
            self.phase = "finished"
            claim = {"run_id": self.run_id, "scenario": self.scenario, "trial": self.trial, "model": self.selector, "thinking": "medium",
                     "outcome": "blocked" if self.mode == "blocked" else "completed", "answer": self.answer, "children": [], "controls": [], "artifacts": ["answer.json"], "errors": [], "human_intervention": False,
                     "unscored_mock": "NOT a scored solution or example benchmark evidence; scripted integration probe"}
            return [self.call("write", {"path": str(Path(self.workspace) / "result.json"), "content": json.dumps(claim)})], None
        return [], "Unscored fixture finished."

    def respond(self, payload):
        first_user = next(body(message) for message in payload["messages"] if message.get("role") == "user")
        child_prompt = first_user.removeprefix("Task: ")
        child = child_prompt.startswith("PREFLIGHT_CHILD:")
        start = time.monotonic()
        self.requests.append({"child": child, "first_user": first_user, "model": payload["model"],
                              "http_tools": [tool["function"]["name"] for tool in payload.get("tools", []) or []],
                              "payload_keys": list(payload)})
        try:
            calls, text = self.child(payload, child_prompt) if child else self.parent(payload, first_user)
        except BaseException as error:
            self.failures.append(f"{type(error).__name__}: {error}")
            raise
        response = {"id": "fixture", "object": "chat.completion.chunk", "created": 0, "model": "fixture",
                    "choices": [{"index": 0, "delta": {"role": "assistant"}, "finish_reason": None}]}
        if calls:
            response["choices"][0]["delta"]["tool_calls"] = [{"index": index, "id": f"call-{len(self.requests)}-{index}", "type": "function",
                "function": {"name": call["name"], "arguments": json.dumps(call["arguments"])}} for index, call in enumerate(calls)]
            response["choices"][0]["finish_reason"] = "tool_calls"
        else:
            response["choices"][0]["delta"]["content"] = text
            response["choices"][0]["finish_reason"] = "stop"
        response["usage"] = {"prompt_tokens": 20, "completion_tokens": 5, "total_tokens": 25}
        return response


def probe(variant, scenario, target, mode="normal", lazy=False, foreground=False, direct_completion=False):
    fixture = Fixture(variant, scenario, mode, foreground, direct_completion)
    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *_args):
            pass
        def do_POST(self):
            payload = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
            try:
                first = next(body(message) for message in payload["messages"] if message.get("role") == "user")
                hold = (fixture.mode == "parent_stream" or (fixture.mode == "detached_stream" and "PREFLIGHT_CHILD:" in first))
                if hold:
                    fixture.requests.append({"child": "PREFLIGHT_CHILD:" in first, "first_user": first, "model": payload["model"], "incomplete_stream": True})
                    self.send_response(200); self.send_header("Content-Type", "text/event-stream"); self.end_headers()
                    self.wfile.write(b": incomplete stream\n\n"); self.wfile.flush()
                    time.sleep(15)
                    return
                response = fixture.respond(payload)
                data = ("data: " + json.dumps(response) + "\n\ndata: [DONE]\n\n").encode()
                self.send_response(200); self.send_header("Content-Type", "text/event-stream"); self.send_header("Content-Length", str(len(data))); self.end_headers()
                self.wfile.write(data)
            except BaseException as error:
                fixture.failures.append(f"HTTP handler {type(error).__name__}: {error}")
                self.send_response(500); self.end_headers()
    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True); thread.start()
    try:
        with tempfile.TemporaryDirectory(prefix="preflight-source-") as temporary:
            source = Path(temporary)
            # No real authentication or credential environment is used by these probes.
            bench.save_json(source / "models.json", {"providers": {MODEL["provider"]: {"baseUrl": f"http://127.0.0.1:{server.server_port}/v1", "api": "openai-completions", "apiKey": "dummy-loopback-only",
                "models": [{"id": "fixture", "name": "Loopback integration fixture", "reasoning": True, "input": ["text"], "contextWindow": 100000, "maxTokens": 8192,
                            "compat": {"supportsMidConvoSystemMessages": True, "supportsMidConvoToolAdditions": True} if lazy else {},
                            "cost": {"input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0}}]}}})
            manifest = copy.deepcopy(bench.read_json(bench.ROOT / ".cache/manifest.json"))
            manifest["source_agent_dir"] = str(source)
            config = bench.read_json(bench.ROOT / "config.json")
            config["episode_timeout_seconds"] = 10 if mode in {"parent_stream", "detached_stream", "question_timeout"} else 75
            trial = 3 if scenario == "conditional_fanout" else 1
            driver = target / f"{variant}-{scenario}-driver.json"
            bench.save_json(driver, {"model": MODEL, "trial": trial, "scenario": scenario, "variant": variant, "config": config, "manifest": manifest})
            code = ("import run as b; from pathlib import Path; b.install_signal_handlers(); "
                    f"d=b.read_json({str(driver)!r}); "
                    f"b.run_episode('fixture',d['model'],d['trial'],d['scenario'],d['variant'],d['config'],d['manifest'],Path({str(target)!r}),preflight=True)")
            if mode in {"sigint", "sigterm"}:
                process = subprocess.Popen([sys.executable, "-c", code], cwd=bench.ROOT, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
                deadline = time.monotonic() + 40
                while fixture.phase != "held" and process.poll() is None and time.monotonic() < deadline:
                    time.sleep(0.1)
                assert fixture.phase == "held", "Signal probe never reached a pending native question"
                process.send_signal(signal.SIGINT if mode == "sigint" else signal.SIGTERM)
                stdout, stderr = process.communicate(timeout=30)
                execution = subprocess.CompletedProcess(process.args, process.returncode, stdout, stderr)
            else:
                execution = subprocess.run([sys.executable, "-c", code], cwd=bench.ROOT, capture_output=True, text=True, timeout=180)
            (target / f"{variant}-{scenario}-driver.log").write_text(execution.stdout + execution.stderr)
            record = bench.read_json(target / "episodes" / f"fixture-t{trial}-{scenario}-{variant}" / "collection.json")
            retained = target / "episodes" / record["run_id"] / "runtime"
            if foreground:
                events = bench.events_from(retained / "events.jsonl")
                assert any(row["type"] == "tool_start" and row["data"].get("toolName") == "subagent" and row["data"].get("args", {}).get("async") is False for row in events), "No genuine foreground launch"
                attested = record["session_attestation"]
                assert len(attested["children"]) == 1 and not attested["errors"], attested
                assert set(attested["children"][0]["thinking_changes"]) == {"medium"}, attested
                launches = [row["data"]["result"].get("details", {}) for row in events if row["type"] == "tool_end" and row["data"].get("toolName") == "subagent"]
                assert len(launches) == 1 and launches[0]["mode"] == "single", launches
                native_id = launches[0]["runId"]
                assert list(retained.glob(f"agent/sessions/**/subagent-artifacts/{native_id}*_meta.json")), "Foreground native metadata missing"
                if not direct_completion:
                    assert any(child.get("detached") is True for child in launches[0]["results"]), launches
                    pending = [item for row in events if row["type"] == "tool_end" and row["data"].get("toolName") == "subagent_supervisor"
                               for item in row["data"]["result"].get("details", {}).get("pending", [])]
                    assert len(pending) == 1 and pending[0]["runId"] == native_id, pending
                    if mode == "normal":
                        assert any(row["type"] == "tool_start" and row["data"].get("toolName") == "subagent_supervisor"
                                   and row["data"].get("args", {}).get("replyTo") == pending[0]["id"] for row in events), "Reply was not correlated"
                    else:
                        assert record["usage_evidence"]["unknown_requests"] >= 1, "Aborted foreground usage was misclassified as free"
            if mode != "normal":
                assert execution.returncode != 0 and record["collector_status"] == "incomplete", record["collector_status"]
                assert record["execution"]["process_cleanup"]["quiescent"], record["execution"]
                assert record["credential_cleanup"]["complete"]
                assert not Path(bench.read_json(target / "episodes" / record["run_id"] / "runtime-location.json")["original_root"]).exists()
                assert not list((target / "episodes" / record["run_id"] / "runtime").rglob("auth.json"))
                if mode in {"premature", "blocked"}:
                    assert record["execution"]["premature_finish"]
                elif mode in {"sigint", "sigterm"}:
                    assert record["execution"]["interrupted"] == mode.upper(), record["execution"]
                else:
                    assert any(row.get("type") == "episode_timeout" for row in record["errors"]), record["errors"]
                if mode in {"parent_stream", "detached_stream"}:
                    assert record["usage_evidence"]["unknown_requests"] >= 1, record["usage_evidence"]
                return {"variant": variant, "scenario": scenario, "failure_probe": mode, "foreground": foreground, "quiescent": True, "scored": False}
            assert execution.returncode == 0, execution.stdout + execution.stderr
            assert not fixture.failures, fixture.failures
            children = {row["id"]: row for row in record["session_attestation"]["children"]}
            expected = 1 if direct_completion else {"parallel_join": 2, "conditional_fanout": 3, "bounded_repair_loop": 3, "supervisor_roundtrip": 1, "cancel_replace": 2}[scenario]
            assert len(children) == expected, (len(children), expected)
            assert not record["session_attestation"]["errors"], record["session_attestation"]["errors"]
            assert all(row["thinking_changes"] and set(row["thinking_changes"]) == {"medium"} for row in children.values()), children
            usage = record["usage_evidence"]
            # Cancelling a paused tool synthesizes a zero-usage SDK error without
            # calling this server. Keep it UNKNOWN in real collections: never free.
            expected_unknown = 1 if scenario == "cancel_replace" else 0
            assert not usage["parse_errors"] and usage["unknown_requests"] == expected_unknown, usage
            assert usage["reported_usage_lower_bound"]["totalTokens"] == 25 * len(fixture.requests), (usage, len(fixture.requests))
            retained = target / "episodes" / record["run_id"] / "runtime"
            workspace = retained / "workspace"
            guard_pids = {row["pid"] for row in bench.events_from(retained / "guard-bootstrap.jsonl")}
            native_pids = {row["pid"] for row in record["execution"]["native_final"]["runs"] if row["pid"]}
            node_pids = native_pids | {record["parent_runtime"]["pid"]}
            assert node_pids <= guard_pids, (node_pids, guard_pids)
            if lazy and variant == "upstream":
                estimates = record["footprint_estimates"]
                assert estimates["startup_declared_package_delta"] < estimates["delegation_active_declared_package_delta"], estimates
                events = bench.events_from(retained / "events.jsonl")
                assert any(row["type"] == "tool_start" and row["data"]["toolName"] == "subagents_enable" for row in events)
            if scenario == "bounded_repair_loop":
                assert (workspace / "state.txt").read_text() == "alpha=1\nbeta=2\ngamma=3\n"
            if direct_completion:
                assert (workspace / "replacement.txt").read_text() == "REPLACED\n"
            elif scenario == "supervisor_roundtrip":
                assert (workspace / "choice.txt").read_text() == "BLUE\n"
            if scenario == "cancel_replace":
                assert (workspace / "replacement.txt").read_text() == "REPLACED\n" and not (workspace / "obsolete.txt").exists()
            if scenario in {"parallel_join", "conditional_fanout"}:
                assert len(fixture.intervals) >= 2
                assert max(row["start"] for row in fixture.intervals) <= min(row["end"] for row in fixture.intervals), fixture.intervals
            return {"variant": variant, "scenario": scenario, "foreground": foreground, "direct_completion": direct_completion, "requests": len(fixture.requests), "children": len(children), "quiescent": True,
                    "unknown_cancel_records": usage["unknown_requests"], "scored": False}
    finally:
        bench.save_json(target / f"{variant}-{scenario}-mock.json", {"requests": fixture.requests, "failures": fixture.failures, "intervals": fixture.intervals, "phase": fixture.phase})
        server.shutdown(); server.server_close(); thread.join()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--variant", choices=("ours", "upstream"))
    parser.add_argument("--scenario", choices=bench.read_json(bench.ROOT / "config.json")["scenarios"])
    parser.add_argument("--lazy", action="store_true", help="Mock compatibility flags exercise upstream's native auto-lazy activation")
    parser.add_argument("--failures", action="store_true", help="Run intentionally incomplete lifecycle/stream probes, never scored")
    parser.add_argument("--foreground", action="store_true", help="Upstream direct completion, retained question/reply and five incomplete lifecycle probes")
    args = parser.parse_args()
    if args.foreground:
        assert args.variant in {None, "upstream"} and not args.scenario and not args.lazy and not args.failures, "Foreground suite is upstream-only with its own scenarios"
        args.variant = "upstream"
    subprocess.run(["node", str(bench.ROOT / "prepare.mjs"), "--check"], check=True)
    evidence_root = bench.ROOT / ".cache/preflight"
    evidence_root.mkdir(parents=True, exist_ok=True)
    target = Path(tempfile.mkdtemp(prefix=str(int(time.time())) + "-" + (args.variant or "both") + "-", dir=evidence_root))
    results = []
    for variant in ([args.variant] if args.variant else ["ours", "upstream"]):
        if args.foreground:
            for label in ("complete", "reply", "premature", "blocked", "question_timeout", "sigint", "sigterm"):
                subdir = target / ("foreground-" + label); subdir.mkdir()
                results.append(probe(variant, "supervisor_roundtrip", subdir, mode="normal" if label in {"complete", "reply"} else label,
                                     foreground=True, direct_completion=label == "complete"))
        elif args.failures:
            for mode in ("premature", "blocked", "question_timeout", "parent_stream", "detached_stream", "sigint", "sigterm"):
                subdir = target / f"{variant}-{mode}"; subdir.mkdir()
                scenario = "parallel_join" if mode in {"parent_stream", "detached_stream"} else "supervisor_roundtrip"
                results.append(probe(variant, scenario, subdir, mode=mode))
        else:
            for scenario in ([args.scenario] if args.scenario else bench.read_json(bench.ROOT / "config.json")["scenarios"]):
                results.append(probe(variant, scenario, target, lazy=args.lazy))
    bench.save_json(target / "summary.json", {"passed": True, "scored": False, "foundation_model_calls": 0,
                    "campaign_sha256": bench.sha256(bench.ROOT / ".cache/manifest.json"), "results": results})
    print(f"Unscored native-delegation probes passed: {target}")


if __name__ == "__main__":
    main()
