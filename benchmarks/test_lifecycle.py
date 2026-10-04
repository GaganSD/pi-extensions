import json
import os
from pathlib import Path
import signal
import subprocess
import sys
import tempfile
import time
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parent))
import run as bench
from lifecycle import ProcessOwner, credentials_cleanup, generation, native_ledger


class LifecycleTests(unittest.TestCase):
    def test_zero_aborted_usage_is_unknown_not_free(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            usage = {key: 0 for key in ("input", "output", "cacheRead", "cacheWrite", "totalTokens")}
            rows = [{"type": "session", "id": "fixture"}]
            for index, reason in enumerate(("error", "aborted")):
                rows.append({"type": "message", "id": str(index), "message": {"role": "assistant", "stopReason": reason, "usage": usage}})
            (root / "session.jsonl").write_text("\n".join(json.dumps(row) for row in rows))
            result = bench.collect_usage(root)
            self.assertEqual(result["unknown_requests"], 2)
            self.assertEqual(result["reported_usage_lower_bound"]["totalTokens"], 0)
            self.assertEqual(result["parse_errors"], [])

    def test_partial_positive_error_usage_remains_lower_bound(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            rows = [{"type": "session", "id": "fixture"}, {"type": "message", "id": "a", "message": {
                "role": "assistant", "stopReason": "error", "usage": {"input": 10, "output": 2, "cacheRead": 0, "cacheWrite": 0, "totalTokens": 12}}}]
            (root / "session.jsonl").write_text("\n".join(json.dumps(row) for row in rows))
            result = bench.collect_usage(root)
            self.assertEqual(result["unknown_requests"], 1)
            self.assertEqual(result["reported_usage_lower_bound"]["totalTokens"], 12)

    def test_precise_process_generation_is_available(self):
        self.assertIsNotNone(generation(os.getpid()))

    def test_reused_pid_never_receives_signal(self):
        with tempfile.TemporaryDirectory() as temporary:
            owner = ProcessOwner("fixture", Path(temporary))
            identity = {"pid": 12345, "generation": "old", "state": "S"}
            with patch.object(owner, "sample", return_value={12345: identity}), patch("lifecycle.generation", return_value="new"), patch("lifecycle.os.kill") as kill:
                owner.signal_owned(signal.SIGKILL)
                kill.assert_not_called()

    def test_environment_setup_failure_removes_private_copies(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            source = root / "source"; source.mkdir()
            (source / "auth.json").write_text('{"fixture":"dummy"}')
            (source / "models.json").write_text('{}')
            runtime = root / "runtime"
            original = bench.shutil.copyfile
            def failing_copy(src, dest):
                if Path(src).name == "models.json":
                    raise OSError("injected setup failure")
                return original(src, dest)
            with patch.object(bench.shutil, "copyfile", side_effect=failing_copy):
                with self.assertRaises(OSError):
                    bench.isolated_environment(runtime / "agent", {"source_agent_dir": str(source)},
                        {"provider": "fixture", "id": "fixture", "thinking": "off"}, runtime / "events", {"episode_timeout_seconds": 1}, credential_environment=False)
            self.assertFalse((runtime / "agent/auth.json").exists())
            self.assertTrue(credentials_cleanup(runtime)["complete"])

    def test_private_home_and_cloud_auth_environment_are_separate(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            source = root / "source"; source.mkdir()
            poisoned = root / "original-home/.agents"; poisoned.mkdir(parents=True)
            (poisoned / "worker.md").write_text("UNEXPECTED_USER_ROLE")
            env = bench.isolated_environment(root / "runtime/agent", {"source_agent_dir": str(source), "source_home": str(poisoned.parent)},
                {"provider": "fixture", "id": "fixture", "thinking": "off"}, root / "events", {"episode_timeout_seconds": 1}, credential_environment=False)
            self.assertNotEqual(env["HOME"], str(poisoned.parent))
            self.assertFalse((Path(env["HOME"]) / ".agents").exists())
            self.assertNotIn("AWS_SHARED_CREDENTIALS_FILE", env)
            self.assertNotIn("OPENAI_API_KEY", env)
            self.assertTrue(Path(env["PI_SUBAGENTS_TEMP_ROOT"]).is_relative_to(root / "runtime"))

    def test_ancestor_instruction_files_block_child_isolation(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            workspace = root / "workspace"; workspace.mkdir()
            (root / "AGENTS.md").write_text("UNEXPECTED_ANCESTOR_INSTRUCTION")
            with self.assertRaises(RuntimeError):
                bench.context_ancestors(workspace)

    def test_live_foreground_snapshot_is_not_terminal(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            bench.save_json(root / "native-status.json", {"quiescent": False, "snapshot": {}})
            self.assertFalse(native_ledger(root)["all_terminal"])

    def test_detached_owned_process_is_contained_after_parent_exits(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            marker = "detached-" + bench.uuid.uuid4().hex
            code = ("import subprocess,sys,time; "
                    "p=subprocess.Popen([sys.executable,'-c','import time;time.sleep(30)'],start_new_session=True); "
                    "print(p.pid,flush=True);time.sleep(.4)")
            process = subprocess.Popen([sys.executable, "-c", code], env={**os.environ, "PI_BENCH_OWNER": marker}, stdout=subprocess.PIPE, text=True)
            owner = ProcessOwner(marker, root)
            try:
                detached = int(process.stdout.readline())
                owner.sample(); process.wait(timeout=3)
                self.assertIn(detached, owner.sample())
                cleanup = owner.contain(grace=1)
                self.assertTrue(cleanup["quiescent"], cleanup)
                self.assertTrue(cleanup["escalations"])
            finally:
                if process.poll() is None:
                    process.terminate(); process.wait()
                owner.contain(grace=1)
                process.stdout.close()

    def test_runtime_inventory_rejects_added_roles_and_changed_dependencies(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            (root / "node_modules").mkdir()
            (root / "node_modules/dependency.js").write_text("original")
            script = ("import {inventory} from './runtime.mjs'; import assert from 'node:assert/strict'; import {writeFileSync} from 'node:fs'; "
                      f"const root={json.dumps(str(root))}; const before=inventory(root); "
                      "writeFileSync(root+'/worker.md','added role'); assert.notDeepEqual(inventory(root),before); "
                      "writeFileSync(root+'/node_modules/dependency.js','changed'); assert.notDeepEqual(inventory(root),before); console.log('ok');")
            result = subprocess.run(["node", "--input-type=module", "-e", script], cwd=bench.ROOT, capture_output=True, text=True, check=True)
            self.assertIn("ok", result.stdout)


if __name__ == "__main__":
    unittest.main()
