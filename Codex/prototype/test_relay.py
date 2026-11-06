import json
from pathlib import Path
import sqlite3
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

import relay


class RelayTests(unittest.TestCase):
    def test_completion_requires_terminal_event(self):
        self.assertIsNone(relay.classify(0, [{"type": "turn.completed"}]))
        self.assertEqual(relay.classify(0, []), "MISSING_TERMINAL_EVENT")
        self.assertEqual(relay.classify(0, [{"type": "turn.failed"}]), "TURN_FAILED")
        self.assertEqual(relay.classify(1, []), "PROCESS_FAILED")

    def test_artifact_rejects_execution_and_multiple_functions(self):
        with tempfile.TemporaryDirectory() as folder:
            for code in ["import os", "def clamp(a,b,c):\n return open('secret')",
                         "def clamp(a,b,c):\n return 1\ndef other():\n return 2"]:
                with self.assertRaises(relay.RunFailure):
                    relay.validate_code(Path(folder), code)
            self.assertFalse((Path(folder) / "clamp.py").exists())

    def test_artifact_accepts_bounded_function(self):
        with tempfile.TemporaryDirectory() as folder:
            code = "def clamp(value, low, high):\n if low > high:\n  raise ValueError('bounds')\n return max(low, min(value, high))\n"
            relay.validate_code(Path(folder), code)
            self.assertEqual((Path(folder) / "clamp.py").read_text(), code)

    def test_timeout_stops_process_and_persists_failure(self):
        # A fake CLI is used only in this unit test; real relay evidence is separate.
        spawn = subprocess.Popen
        processes = []
        def fake_cli(*args, **kwargs):
            proc = spawn([sys.executable, "-c", "import time;time.sleep(30)"], **kwargs)
            processes.append(proc)
            return proc
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            (root / "workspace").mkdir()
            db = sqlite3.connect(":memory:")
            db.execute("CREATE TABLE runs(id TEXT, role TEXT, state TEXT, session_id TEXT, error TEXT, started_at REAL, ended_at REAL)")
            with patch.object(relay.subprocess, "Popen", side_effect=fake_cli):
                with self.assertRaisesRegex(relay.RunFailure, "TIMEOUT"):
                    relay.run_codex(root, db, "test", "test", timeout=0.05)
            self.assertIsNotNone(processes[0].poll())
            self.assertEqual(db.execute("SELECT state,error FROM runs").fetchone(),
                             ("failed", "TIMEOUT"))


if __name__ == "__main__":
    unittest.main()
