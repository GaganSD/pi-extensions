"""Deterministic contract probes; no SDK, provider, cache, or credentials needed."""
import json
from pathlib import Path
import sys
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parent))
from preflight import Fixture, records


def tool(name, properties=None):
    return {"function": {"name": name, "parameters": {"properties": properties or {}}}}


def payload(value):
    return {"messages": [{"role": "tool", "content": json.dumps(value)}]}


class PreflightContractTests(unittest.TestCase):
    def waiting_fixture(self, scenario="supervisor_roundtrip", mode="normal"):
        fixture = Fixture("ours", scenario, mode)
        fixture.phase = "waiting"
        fixture.batch = ["run-uuid"]
        fixture.jobs = [{"task": "PREFLIGHT_CHILD:question"}]
        fixture.workspace = "/fixture"
        fixture.run_id, fixture.trial, fixture.selector = "episode", 1, "fixture/model"
        return fixture

    def test_child_selects_variant_tool_without_alias_or_ours_reason(self):
        # Advertise both names so a mistaken legacy fallback cannot go unnoticed.
        tools = [tool("contact_agent", {"reason": {}}), tool("contact_supervisor", {"reason": {}})]
        for variant, expected in (("ours", "contact_agent"), ("upstream", "contact_supervisor")):
            for label in ("question", "obsolete"):
                with self.subTest(variant=variant, label=label):
                    fixture = Fixture(variant, "supervisor_roundtrip")
                    calls, text = fixture.child({"messages": [], "tools": tools}, "PREFLIGHT_CHILD:" + label)
                    arguments = {"message": "Which token should I use?"}
                    if variant == "upstream":
                        arguments["reason"] = "need_decision"
                    self.assertEqual(calls, [{"name": expected, "arguments": arguments}])
                    self.assertIsNone(text)

    def test_child_works_with_only_its_variant_tool_and_optional_upstream_reason(self):
        for variant, name in (("ours", "contact_agent"), ("upstream", "contact_supervisor")):
            with self.subTest(variant=variant):
                calls, _ = Fixture(variant, "supervisor_roundtrip").child(
                    {"messages": [], "tools": [tool(name)]}, "PREFLIGHT_CHILD:question")
                self.assertEqual(calls, [{"name": name, "arguments": {"message": "Which token should I use?"}}])

    def test_records_accept_new_waiting_state_not_legacy_alias(self):
        rows = [{"id": "current", "state": "waiting_for_agent"},
                {"id": "legacy", "state": "waiting_for_parent"}]
        self.assertEqual(records(payload({"runs": rows})["messages"]), {"current": rows[0]})

    def test_ours_waiting_status_and_reply_correlate_exact_run_and_question(self):
        fixture = self.waiting_fixture()
        row = {"id": "run-uuid", "state": "waiting_for_agent", "question": {"id": "question-uuid"}}
        # A different run's question must not become the reply target.
        data = payload({"runs": [row, {"id": "other-run", "state": "waiting_for_agent", "question": {"id": "other-question"}}]})
        calls, _ = fixture.parent(data, "")
        self.assertEqual(calls, [{"name": "subagent", "arguments": {"action": "status", "id": "run-uuid"}}])
        calls, _ = fixture.parent(payload(row), "")
        self.assertEqual(calls, [{"name": "subagent", "arguments": {
            "action": "reply", "id": "run-uuid", "requestId": "question-uuid", "message": "BLUE"}}])
        self.assertEqual(fixture.handled_questions, {"run-uuid"})
        calls, _ = fixture.parent(data, "")
        self.assertEqual(calls, [])  # No duplicate reply while the notification is still pending.

    def test_ours_legacy_waiting_notification_is_not_an_alias(self):
        fixture = self.waiting_fixture()
        calls, _ = fixture.parent(payload({"id": "run-uuid", "state": "waiting_for_parent"}), "")
        self.assertEqual(calls, [])
        self.assertEqual(fixture.phase, "waiting")
        self.assertEqual(fixture.handled_questions, set())

    def test_ours_incomplete_modes_recognize_new_waiting_state(self):
        for mode in ("premature", "blocked", "question_timeout", "sigint", "sigterm"):
            with self.subTest(mode=mode):
                fixture = self.waiting_fixture(mode=mode)
                calls, _ = fixture.parent(payload({"id": "run-uuid", "state": "waiting_for_agent"}), "")
                if mode in {"premature", "blocked"}:
                    self.assertEqual(calls[0]["name"], "write")
                    claim = json.loads(calls[0]["arguments"]["content"])
                    self.assertEqual(claim["outcome"], "blocked" if mode == "blocked" else "completed")
                    self.assertEqual(claim["answer"], {"intentionally_invalid": True})
                else:
                    self.assertEqual(calls, [])
                    self.assertEqual(fixture.phase, "held")

    def test_ours_question_status_requires_correlation_and_cancel_uses_run_id(self):
        for question in ({}, {"id": "question-uuid"}):
            with self.subTest(question=question):
                fixture = self.waiting_fixture(scenario="cancel_replace")
                fixture.phase = "question_status"
                data = payload({"id": "run-uuid", "state": "waiting_for_agent", "question": question})
                if not question:
                    with self.assertRaises(AssertionError):
                        fixture.parent(data, "")
                else:
                    calls, _ = fixture.parent(data, "")
                    self.assertEqual(calls, [{"name": "subagent", "arguments": {"action": "stop", "id": "run-uuid"}}])

    def test_upstream_keeps_native_pending_and_reply_to_contract(self):
        fixture = Fixture("upstream", "supervisor_roundtrip")
        fixture.phase = "question_waited"
        fixture.upstream_id = "upstream-run"
        calls, _ = fixture.parent(payload(""), "")
        self.assertEqual(calls, [{"name": "subagent_supervisor", "arguments": {"action": "pending"}}])
        data = {"messages": [{"role": "tool", "content": 'replyTo: "upstream-question"'}]}
        calls, _ = fixture.parent(data, "")
        self.assertEqual(calls, [{"name": "subagent_supervisor", "arguments": {
            "action": "reply", "replyTo": "upstream-question", "message": "BLUE"}}])
        calls, _ = fixture.parent(data, "")
        self.assertEqual(calls, [{"name": "bg_wait", "arguments": {"id": "upstream-run", "timeoutMs": 60000}}])


if __name__ == "__main__":
    unittest.main()
