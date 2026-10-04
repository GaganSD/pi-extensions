import json
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
import shutil
import sys
import tempfile
import threading
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parent))
import run as bench


class BenchmarkTests(unittest.TestCase):
    def test_balanced_paired_schedule_has_30_episodes_per_model(self):
        config = bench.load_config()
        episodes = list(bench.episode_order(config, config["trials"]))
        self.assertEqual(len(episodes), 30)
        self.assertEqual(len(set(episodes)), 30)
        firsts = []
        for offset in range(0, 30, 2):
            first, second = episodes[offset:offset + 2]
            self.assertEqual(first[:2], second[:2])
            self.assertEqual({first[2], second[2]}, {"ours", "upstream"})
            firsts.append(first[2])
        self.assertEqual(firsts.count("ours"), 8)
        self.assertEqual(firsts.count("upstream"), 7)

    def test_fixtures_are_paired_and_clean(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            for trial, route, repair_count in [(1, "left", 1), (2, "right", 0), (3, "both", 1)]:
                ours, upstream = root / f"ours-{trial}", root / f"upstream-{trial}"
                self.assertEqual(bench.make_fixture(ours, trial), bench.make_fixture(upstream, trial))
                self.assertEqual((ours / "route.txt").read_text().strip(), route)
                state = dict(line.split("=") for line in (ours / "state.txt").read_text().splitlines())
                self.assertEqual(sum(state[key] != expected for key, expected in
                                     [("alpha", "1"), ("beta", "2"), ("gamma", "3")]), repair_count)
                self.assertFalse((ours / "result.json").exists())
                status = bench.subprocess.check_output(["git", "status", "--porcelain"], cwd=ours)
                self.assertEqual(status, b"")

    def test_prompts_render_exact_model_thinking_and_parent_only_decision(self):
        config = bench.load_config()
        for model in config["models"].values():
            for trial in config["trials"]:
                for scenario in config["scenarios"]:
                    text = bench.render_prompt(model, trial, scenario, "test-id", Path("/tmp/episode"))
                    self.assertNotIn("{{", text)
                    self.assertIn(f'THINKING: {model["thinking"]}', text)
                    self.assertIn(f'MODEL: {model["provider"]}/{model["id"]}', text)
                    if scenario == "supervisor_roundtrip":
                        self.assertIn({1: "BLUE", 2: "GREEN", 3: "GOLD"}[trial], text)

    def test_child_stall_ignores_parent_and_aborted_assistants(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            parent = root / "agent/sessions/parent.jsonl"
            parent.parent.mkdir(parents=True)
            parent.write_text(json.dumps({"type": "message", "message": {"role": "assistant", "stopReason": "stop"}}) + "\n")
            child = root / "agent/minimal-subagents/owner/id/transcript/child.jsonl"
            child.parent.mkdir(parents=True)
            child.write_text(json.dumps({"type": "session", "id": "child"}) + "\n")
            self.assertFalse(bench.child_assistant_progress(root))
            child.write_text(child.read_text() + json.dumps(
                {"type": "message", "message": {"role": "assistant", "stopReason": "aborted"}}) + "\n")
            self.assertFalse(bench.child_assistant_progress(root))
            child.write_text(child.read_text() + json.dumps(
                {"type": "message", "message": {"role": "assistant", "stopReason": "stop"}}) + "\n")
            self.assertTrue(bench.child_assistant_progress(root))
            other = Path(temp + "-up")
            up_child = other / "agent/sessions/enc/run-0/session.jsonl"
            up_child.parent.mkdir(parents=True)
            up_child.write_text(json.dumps({"type": "message", "message": {"role": "assistant", "stopReason": "toolUse"}}) + "\n")
            (other / "agent/sessions/enc.jsonl").write_text(
                json.dumps({"type": "message", "message": {"role": "assistant", "stopReason": "stop"}}) + "\n")
            self.assertTrue(bench.child_assistant_progress(other))

    def test_timeout_failure_is_collected_and_does_not_block_resume(self):
        record = {"collector_status": "collected", "errors": [{"type": "episode_timeout"}],
                  "usage_evidence": {"parse_errors": []}, "session_attestation": {"errors": []},
                  "credential_cleanup": {"complete": True},
                  "execution": {"exit_code": 1, "external_timeout": True, "child_stall": True,
                                "interrupted": None, "premature_finish": False, "direct_child_escalations": [],
                                "watchdog_errors": [], "process_cleanup": {"quiescent": True, "cleanup_state": "quiescent", "escalations": []},
                                "native_final": {"all_terminal": True}}}
        self.assertTrue(bench.evidence_ready(record))

    def test_rate_limit_errors_are_retryable_billing_is_not(self):
        limit = bench.parent_provider_error([{"type": "message_end", "data": {"message": {
            "stopReason": "error", "errorMessage": 'bedrock-runtime API error (429): {"type":"rate_limit_error"}'}}}])
        self.assertTrue(bench.retryable_provider_error(limit))
        billing = bench.parent_provider_error([{"type": "message_end", "data": {"message": {
            "stopReason": "error", "errorMessage": "You have no credits remaining. Add credits to continue using the API."}}}])
        self.assertFalse(bench.retryable_provider_error(billing))

    def test_scored_process_uses_tui_not_print_or_rpc(self):
        model = bench.load_config()["models"]["grok"]
        command = bench.pi_command(model, prompt="test prompt")
        for forbidden in ("--print", "--mode", "--no-session"):
            self.assertNotIn(forbidden, command)
        self.assertIn("--no-context-files", command)
        self.assertIn("--no-extensions", command)
        self.assertEqual(command[-2:], ["--", "test prompt"])

    def test_proxy_matches_js_utf16_length(self):
        self.assertEqual(bench.chars("a😀"), 3)
        self.assertEqual(bench.footprint({"system_prompt": "12345", "tools": []}), 2)
        self.assertEqual(bench.footprint({"system_prompt": "", "tools": [
            {"name": "x", "description": "y", "parameters": {}}]}), 2)

    def test_usage_counts_physical_messages_not_nested_rollups_or_reasoning_twice(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            usage = {"input": 10, "output": 5, "cacheRead": 20, "cacheWrite": 2,
                     "totalTokens": 37, "reasoning": 3}
            records = [
                {"type": "session", "id": "parent"},
                {"type": "message", "id": "one", "message": {
                    "role": "assistant", "provider": "test", "model": "model", "usage": usage}},
                {"type": "message", "id": "two", "message": {
                    "role": "toolResult", "usage": {**usage, "totalTokens": 999}}},
                {"type": "usage", "id": "warm", "usage": usage},
            ]
            text = "\n".join(json.dumps(record) for record in records)
            (root / "session.jsonl").write_text(text)
            (root / "duplicate.jsonl").write_text(text)
            child = root / "workspace" / ".pi"
            child.mkdir(parents=True)
            (child / "child.jsonl").write_text("\n".join(json.dumps(record) for record in [
                {"type": "session", "id": "child"},
                {"type": "message", "id": "one", "message": {
                    "role": "assistant", "provider": "test", "model": "model", "usage": usage}}]))
            (root / "observer.jsonl").write_text(json.dumps({"type": "startup", "data": {}}))
            result = bench.collect_usage(root)
            self.assertEqual(result["reported_usage_lower_bound"]["totalTokens"], 111)
            self.assertEqual(result["reported_usage_lower_bound"]["output"], 15)
            self.assertEqual(result["reported_usage_lower_bound"]["cacheRead"], 60)
            self.assertEqual(result["parse_errors"], [])

    def test_missing_usage_and_partial_jsonl_are_not_silently_zero(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            (root / "partial.jsonl").write_text('{"type":"session"')
            (root / "missing.jsonl").write_text("\n".join(json.dumps(record) for record in [
                {"type": "session", "id": "session"},
                {"type": "message", "id": "a", "message": {"role": "assistant", "usage": {}}}]))
            errors = bench.collect_usage(root)["parse_errors"]
            self.assertEqual(len(errors), 6)

    @unittest.skipUnless(shutil.which("pi"), "Pi is required for the local mock-provider integration")
    def test_real_tui_recorder_finishes_and_counts_local_mock_provider_usage(self):
        # This test never contacts a foundation-model provider. A loopback SSE
        # server deterministically emits a write call, then a final response.
        requests = []

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *_args):
                pass

            def do_POST(self):
                requests.append(json.loads(self.rfile.read(int(self.headers["Content-Length"]))))
                self.send_response(200)
                self.send_header("Content-Type", "text/event-stream")
                self.end_headers()
                if len(requests) == 1:
                    delta = {"role": "assistant", "tool_calls": [{"index": 0, "id": "fixture-call",
                        "type": "function", "function": {"name": "write", "arguments": json.dumps({
                            "path": "result.json", "content": json.dumps({"outcome": "completed"}) + "\n"})}}]}
                    reason = "tool_calls"
                else:
                    delta, reason = {"role": "assistant", "content": "Fixture finished."}, "stop"
                def send(value):
                    self.wfile.write(("data: " + json.dumps(value) + "\n\n").encode())
                    self.wfile.flush()
                base = {"id": "fixture-response", "object": "chat.completion.chunk", "created": 1, "model": "fixture"}
                send({**base, "choices": [{"index": 0, "delta": delta, "finish_reason": None}]})
                send({**base, "choices": [{"index": 0, "delta": {}, "finish_reason": reason}]})
                send({**base, "choices": [], "usage": {"prompt_tokens": 20, "completion_tokens": 5, "total_tokens": 25}})
                self.wfile.write(b"data: [DONE]\n\n")
                self.wfile.flush()

        server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            with tempfile.TemporaryDirectory() as temp:
                root = Path(temp)
                source = root / "source"
                source.mkdir()
                workspace = root / "workspace"
                workspace.mkdir()
                model = {"provider": "benchmark-fixture", "id": "fixture", "thinking": "off"}
                config = {"episode_timeout_seconds": 20}
                events_path = root / "events.jsonl"
                agent = root / "agent"
                env = bench.isolated_environment(agent, {"source_agent_dir": str(source)}, model, events_path, config)
                bench.save_json(agent / "models.json", {"providers": {model["provider"]: {
                    "baseUrl": f"http://127.0.0.1:{server.server_port}/v1", "api": "openai-completions",
                    "apiKey": "fixture-only-not-a-secret", "models": [{
                        "id": "fixture", "name": "Local fixture", "reasoning": False, "input": ["text"],
                        "cost": {"input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0},
                        "contextWindow": 32768, "maxTokens": 1024}]}}})
                # Keep forkpty in a fresh single-threaded process; the loopback
                # server's thread belongs only to this unittest process.
                code = ("import json, os; from pathlib import Path; import run as bench; "
                        f"model=json.loads({json.dumps(model)!r}); "
                        f"result=bench.run_tui(bench.pi_command(model, prompt='Run the local test fixture.'), "
                        f"Path({str(workspace)!r}), dict(os.environ), Path({str(root / 'terminal.log')!r}), 25); "
                        "print(json.dumps(result))")
                execution = bench.subprocess.run([sys.executable, "-c", code], cwd=bench.ROOT,
                                                 env=env, capture_output=True, text=True, timeout=30)
                self.assertEqual(execution.returncode, 0, execution.stderr)
                result = json.loads(execution.stdout)
                self.assertEqual(result["exit_code"], 0, (root / "terminal.log").read_text(errors="replace"))
                self.assertFalse(result["external_timeout"])
                self.assertFalse(result["premature_finish"])
                self.assertTrue(result["process_cleanup"]["quiescent"])
                self.assertEqual(result["process_cleanup"]["escalations"], [])
                self.assertEqual(bench.read_json(workspace / "result.json"), {"outcome": "completed"})
                events = bench.events_from(events_path)
                self.assertFalse(any(row["type"] == "episode_timeout" for row in events))
                self.assertEqual(sum(row["type"] == "request_context" for row in events), 2)
                startup = next(row["data"] for row in events if row["type"] == "startup")
                request = next(row["data"] for row in events if row["type"] == "request_context")
                self.assertEqual(bench.footprint(startup), bench.footprint(request))
                self.assertTrue(any(row["type"] == "result_claim" for row in events))
                self.assertTrue(any(row["type"] == "shutdown" for row in events))
                self.assertEqual(bench.collect_usage(root)["reported_usage_lower_bound"]["totalTokens"], 50)
        finally:
            server.shutdown()
            server.server_close()
            thread.join()

    def test_pty_really_has_terminal_stdin_and_stdout(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            code = "import os; print('TTY', os.isatty(0), os.isatty(1), flush=True)"
            result = bench.run_tui([sys.executable, "-c", code], root, dict(bench.os.environ), root / "log", 5)
            self.assertEqual(result["exit_code"], 0)
            self.assertFalse(result["external_timeout"])
            self.assertIn(b"TTY True True", (root / "log").read_bytes())

    def test_pty_timeout_is_explicit(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            result = bench.run_tui([sys.executable, "-c", "import time; time.sleep(60)"], root, {}, root / "log", 2)
            self.assertTrue(result["external_timeout"])
            self.assertNotEqual(result["exit_code"], 0)


if __name__ == "__main__":
    unittest.main()
