"""Unscored fault injection. Mock metadata is never benchmark evidence."""
import json
import os
from pathlib import Path
import signal
import sys
import tempfile
import time
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parent))
import run as bench
from lifecycle import ProcessOwner


class FaultTests(unittest.TestCase):
    def test_stale_discovery_marker_does_not_own_replacement(self):
        owner = ProcessOwner("fixture", "/tmp")
        stale = "12345 1 Sun Oct 4 00:00:00 2026 S node PI_BENCH_OWNER=fixture\n"
        fresh = "12345 1 Sun Oct 4 00:00:01 2026 S unrelated\n"
        with patch.object(owner, "_ps", side_effect=[stale, fresh]), patch("lifecycle.generation", return_value="replacement"):
            self.assertEqual(owner.sample(), {})
        self.assertEqual(owner.observed, {})
        with patch.object(owner, "_ps", return_value=fresh), patch("lifecycle.os.kill") as kill:
            owner.signal_owned(signal.SIGKILL)
            kill.assert_not_called()

    def test_reuse_during_ownership_binding_is_rejected(self):
        owner = ProcessOwner("fixture", "/tmp")
        row = "12345 1 Sun Oct 4 00:00:00 2026 S node PI_BENCH_OWNER=fixture\n"
        with patch.object(owner, "_ps", return_value=row), patch("lifecycle.generation", side_effect=["old", "replacement"]):
            self.assertEqual(owner.sample(), {})
        self.assertEqual(owner.observed, {})
        with patch.object(owner, "_ps", return_value=row), patch("lifecycle.generation", side_effect=["old", "replacement"]), patch("lifecycle.os.kill") as kill:
            owner.signal_owned(signal.SIGKILL)
            kill.assert_not_called()

    def test_parent_reuse_during_ancestry_binding_is_rejected(self):
        owner = ProcessOwner("fixture", "/tmp")
        parent = "12345 1 Sun Oct 4 00:00:00 2026 S node PI_BENCH_OWNER=fixture\n"
        child = "12346 12345 Sun Oct 4 00:00:00 2026 S protected-child\n"
        with patch.object(owner, "_ps", side_effect=[parent + child, parent, child]), patch("lifecycle.generation", side_effect=["parent", "parent", "parent", "child", "child", "replaced-parent"]):
            self.assertNotIn(12346, owner.sample())
        self.assertNotIn((12346, "child"), owner.observed)

    def episode_fault(self, root, fault=None, unreapable=False, inspection_failure=False):
        # Successful transport metadata is deliberately mocked; only exceptional
        # collector control flow and actual direct-child fallback are under test.
        results = root / "results"
        (root / ".cache").mkdir()
        bench.save_json(root / ".cache/manifest.json", {"fixture": True})
        model = {"provider": "fixture", "id": "fixture", "thinking": "off"}
        manifest = {"protocol_sha256": "fixture", "packages": {"ours": {}}}
        startup = {"system_prompt": "fixture", "tools": [{"name": "subagent", "description": "fixture", "parameters": {}}],
                   "pid": 1, "session_id": "fixture", "model": "fixture", "thinking": "off", "pi_version": "fixture",
                   "node_version": "fixture", "node_executable": "fixture", "pi_entrypoint": "fixture", "route": {}}
        complete = {"exit_code": 0, "external_timeout": False, "interrupted": None, "premature_finish": False,
                    "direct_child_escalations": [], "watchdog_errors": [], "process_cleanup": {"quiescent": True, "escalations": []},
                    "native_final": {"all_terminal": True, "runs": []}}
        def environment(agent, *args, **kwargs):
            agent.mkdir()
            (agent / "auth.json").write_text('{"fixture":"dummy-not-a-credential"}')
            return {**os.environ, "PI_CODING_AGENT_DIR": str(agent), "PI_BENCH_OWNER": "fixture"}
        count = 0
        original_tui = bench.run_tui
        def transport(args, workspace, env, log, timeout):
            nonlocal count
            count += 1
            events = log.parent / ("baseline-events.jsonl" if count == 1 else "events.jsonl")
            if count == 1 or fault != "no_startup":
                events.write_text(("not-json\n" if count == 2 and fault == "events" else "") + json.dumps({"type": "startup", "data": startup}) + "\n")
            if count == 1 and fault == "baseline":
                return {**complete, "process_cleanup": {"quiescent": False, "cleanup_state": "unknown", "observed": [{"pid": 2147483646, "generation": "fixture"}]}}
            if count == 2:
                if fault == "claim":
                    (workspace / "result.json").write_text("not-json")
                else:
                    bench.save_json(workspace / "result.json", {"unscored_fault_fixture": True})
                if unreapable or inspection_failure:
                    return original_tui([sys.executable, "-c", "import time;time.sleep(60)"], workspace, env, log, 0.01)
            return complete
        usage = {"parse_errors": [], "unknown_requests": 1, "reported_usage_lower_bound": {"totalTokens": 0}}
        attestation = {"children": [], "errors": [] if fault != "attestation" else [{"wrong_model": True}]}
        with patch.object(bench, "ROOT", root), patch.object(bench, "make_fixture", side_effect=lambda workspace, _trial: workspace.mkdir()), \
             patch.object(bench, "render_prompt", return_value="unscored fault fixture"), \
             patch.object(bench, "pi_command", return_value=[]), patch.object(bench, "isolated_environment", side_effect=environment), \
             patch.object(bench, "run_tui", side_effect=transport), patch.object(bench, "TEARDOWN_SECONDS", 0.7), \
             patch.object(bench, "collect_usage", side_effect=RuntimeError("injected usage failure") if fault == "usage" else None, return_value=usage), \
             patch.object(bench, "session_attestation", return_value=attestation):
            with self.assertRaises(RuntimeError):
                bench.run_episode("fixture", model, 1, "parallel_join", "ours", {"episode_timeout_seconds": 1}, manifest, results, preflight=True)
            directory = results / "episodes/fixture-t1-parallel_join-ours"
            record = bench.read_json(directory / "collection.json")
            self.assertEqual(record["collector_status"], "incomplete")
            self.assertTrue(record["credential_cleanup"]["complete"])
            self.assertFalse(list((directory / "runtime").rglob("auth.json")))
            # Even an old collector's premature 'collected' flag cannot authorize resume.
            record["collector_status"] = "collected"
            bench.save_json(directory / "collection.json", record)
            with self.assertRaisesRegex(AssertionError, "invalid evidence"):
                bench.run_episode("fixture", model, 1, "parallel_join", "ours", {"episode_timeout_seconds": 1}, manifest, results, preflight=True)
            # The documented later-trial path must not admit ANY new PTY/model
            # after earlier invalid/unknown evidence, even with a different run_id.
            with patch.object(bench.pty, "fork") as fork, patch.object(bench, "isolated_environment") as setup:
                with self.assertRaisesRegex(AssertionError, "blocks admission"):
                    bench.run_episode("fixture", model, 2, "parallel_join", "ours", {"episode_timeout_seconds": 1}, manifest, results, preflight=True)
                fork.assert_not_called(); setup.assert_not_called()
            self.assertFalse((results / "episodes/fixture-t2-parallel_join-ours").exists())
            self.assertEqual(count, 1 if fault == "baseline" else 2)
            return record

    def test_usage_exception_stops_collection_and_resume(self):
        with tempfile.TemporaryDirectory() as temporary:
            self.episode_fault(Path(temporary), fault="usage")

    def test_attestation_mismatch_stops_collection_and_resume(self):
        with tempfile.TemporaryDirectory() as temporary:
            self.episode_fault(Path(temporary), fault="attestation")

    def test_persistent_inspection_failure_keeps_direct_fallback_and_evidence(self):
        with tempfile.TemporaryDirectory() as temporary, patch("lifecycle.ProcessOwner._ps", side_effect=RuntimeError("injected persistent ps failure")):
            started = time.monotonic()
            record = self.episode_fault(Path(temporary), inspection_failure=True)
            self.assertLess(time.monotonic() - started, 4)
            execution = record["execution"]
            self.assertIsNotNone(execution["exit_code"])  # Real child was terminated and reaped.
            self.assertTrue(execution["direct_child_escalations"])
            self.assertFalse(execution["process_cleanup"]["quiescent"])
            self.assertTrue(execution["watchdog_errors"])
            # Unknown cleanup is retained privately, never automatically discarded.
            bench.shutil.rmtree(record["retained_private_runtime"])

    def test_parsing_errors_preserve_execution_and_block_later_trials(self):
        for fault in ("events", "claim"):
            with self.subTest(fault=fault), tempfile.TemporaryDirectory() as temporary:
                record = self.episode_fault(Path(temporary), fault=fault)
                self.assertEqual(record["execution"]["exit_code"], 0)
                self.assertIn("process_cleanup", record["execution"])

    def test_prior_partial_evidence_blocks_different_trial_without_launch(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            (root / "episodes/trial-one-partial").mkdir(parents=True)
            with self.assertRaisesRegex(AssertionError, "partial evidence"):
                bench.admission_gate(root, "campaign", "protocol")

    def test_baseline_unknown_cannot_be_cleared_by_fresh_empty_owner(self):
        with tempfile.TemporaryDirectory() as temporary:
            record = self.episode_fault(Path(temporary), fault="baseline")
            self.assertFalse(record["baseline_execution"]["process_cleanup"]["quiescent"])
            self.assertTrue(Path(record["retained_private_runtime"]).exists())
            bench.shutil.rmtree(record["retained_private_runtime"])

    def test_cli_trial_two_gate_runs_under_lock_and_launches_nothing(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            (root / ".cache").mkdir()
            bench.save_json(root / ".cache/manifest.json", {"protocol_sha256": "fixture"})
            bench.save_json(root / "config.json", bench.read_json(bench.ROOT / "config.json"))
            previous = root / "luna/results/episodes/luna-t1-existing"
            previous.mkdir(parents=True)
            bench.save_json(previous / "collection.json", {"collector_status": "incomplete", "execution": {"process_cleanup": {"cleanup_state": "unknown"}}})
            original = bench.admission_gate
            def locked_gate(results, *args):
                self.assertTrue((results / ".running").exists())
                return original(results, *args)
            with patch.object(bench, "ROOT", root), patch.object(sys, "argv", ["run.py", "luna", "--trial", "2"]), \
                 patch.object(bench.subprocess, "run"), patch.object(bench, "admission_gate", side_effect=locked_gate), \
                 patch.object(bench.pty, "fork") as fork, patch.object(bench, "run_tui") as transport:
                with self.assertRaisesRegex(AssertionError, "blocks admission"):
                    bench.main()
                fork.assert_not_called(); transport.assert_not_called()
            self.assertEqual(list((root / "luna/results/episodes").iterdir()), [previous])
            self.assertEqual(bench.read_json(previous / "collection.json")["collector_status"], "incomplete")

    def test_no_startup_still_retains_unknown_pid_and_blocks_trial_two(self):
        self.unreapable_fixture(fault="no_startup")

    def test_unreapable_child_has_bounded_incomplete_outcome(self):
        self.unreapable_fixture()

    def unreapable_fixture(self, fault=None):
        with tempfile.TemporaryDirectory() as temporary:
            descriptor = os.open("/dev/null", os.O_RDONLY)
            with patch.object(bench.pty, "fork", return_value=(2147483646, descriptor)), \
                 patch.object(bench.fcntl, "ioctl"), patch.object(bench.select, "select", return_value=([], [], [])), \
                 patch.object(bench.os, "waitpid", return_value=(0, 0)), patch.object(bench.os, "kill") as kill, \
                 patch.object(ProcessOwner, "sample", return_value={}), \
                 patch.object(ProcessOwner, "contain", return_value={"quiescent": False, "escalations": [], "observed": []}):
                started = time.monotonic()
                record = self.episode_fault(Path(temporary), unreapable=True, fault=fault)
                self.assertLess(time.monotonic() - started, 2)
                self.assertIsNone(record["execution"]["exit_code"])
                self.assertEqual(record["execution"]["process_cleanup"]["unresolved_direct_pid"], 2147483646)
                self.assertTrue(kill.called)
                bench.shutil.rmtree(record["retained_private_runtime"])
            with self.assertRaises(OSError):
                os.fstat(descriptor)  # PTY finalizer ran despite failed reap/inspection.


if __name__ == "__main__":
    unittest.main()
