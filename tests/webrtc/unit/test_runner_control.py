import json
import os
from pathlib import Path
import sys
import tempfile
import time
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from runner_control import run_controlled, runner_timeouts


class RunnerControlTests(unittest.TestCase):
    def run_child(self, code, *, idle=0.3, total=3):
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory)
            with (output / "run.log").open("w") as stream, patch("runner_control.subprocess.run"):
                started = time.monotonic()
                status = run_controlled([sys.executable, "-u", "-c", code], output=output,
                                        turn="owned-test-turn", stream=stream,
                                        idle_seconds=idle, max_seconds=total,
                                        terminate_grace_seconds=0.2)
            watchdog = output / "run.log.watchdog.json"
            return status, json.loads(watchdog.read_text()) if watchdog.exists() else None, time.monotonic() - started

    def test_preserves_child_exit_status(self):
        status, diagnostic, _ = self.run_child("raise SystemExit(7)")
        self.assertEqual(status, 7)
        self.assertIsNone(diagnostic)

    @unittest.skipUnless(os.name == "posix", "session termination requires POSIX")
    def test_silent_child_ignoring_term_is_killed(self):
        with tempfile.TemporaryDirectory() as directory:
            pid_file = Path(directory) / "child.pid"
            code = ("import signal,time,os; from pathlib import Path; "
                    "signal.signal(signal.SIGTERM,signal.SIG_IGN); "
                    f"Path({str(pid_file)!r}).write_text(str(os.getpid())); time.sleep(60)")
            status, diagnostic, elapsed = self.run_child(code)
            self.assertEqual(status, 124)
            self.assertEqual(diagnostic["reason"], "no-log-progress")
            self.assertLess(elapsed, 3)
            with self.assertRaises(ProcessLookupError):
                os.kill(int(pid_file.read_text()), 0)

    def test_progress_does_not_bypass_total_deadline(self):
        code = "import time\nwhile True:\n print('progress',flush=True); time.sleep(0.02)"
        status, diagnostic, _ = self.run_child(code, total=0.6)
        self.assertEqual(status, 124)
        self.assertEqual(diagnostic["reason"], "total-runtime")

    def test_progress_renews_idle_deadline(self):
        code = "import time\nfor i in range(8):\n print(i,flush=True); time.sleep(0.1)"
        status, diagnostic, elapsed = self.run_child(code)
        self.assertEqual(status, 0)
        self.assertIsNone(diagnostic)
        self.assertGreater(elapsed, 0.6)

    def test_soak_and_explicit_limits(self):
        self.assertEqual(runner_timeouts({"WEBRTC_SOAK_SECONDS": "3600"}), (3900, 9000))
        self.assertEqual(runner_timeouts({"WEBRTC_RUN_IDLE_TIMEOUT_SECONDS": "20",
                                         "WEBRTC_RUN_TIMEOUT_SECONDS": "60"}), (20, 60))
        for value in ("nan", "inf", "0", "-1"):
            with self.assertRaises(ValueError):
                runner_timeouts({"WEBRTC_RUN_TIMEOUT_SECONDS": value})


if __name__ == "__main__":
    unittest.main()
