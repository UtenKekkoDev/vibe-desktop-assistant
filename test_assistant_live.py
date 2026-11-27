"""Opt-in end-to-end test of the Node session with DeepSeek and a local test window."""
import os
from pathlib import Path
import subprocess
import tempfile
import time
import unittest
import uuid

from test_desktop_bridge_live import FORM

ROOT = Path(__file__).parent


@unittest.skipUnless(os.environ.get("VIBE_TEST_SESSION_LIVE") == "1", "requires desktop and DeepSeek")
class AssistantLiveTest(unittest.TestCase):
    def test_edit_hold_then_send_once(self):
        with tempfile.TemporaryDirectory() as directory:
            folder = Path(directory)
            title = "Vibe session " + uuid.uuid4().hex
            fixture = folder / "form.ps1"
            ready, receipt = folder / "ready", folder / "receipt"
            fixture.write_text(FORM, encoding="utf-8-sig")
            form = subprocess.Popen(
                ["powershell.exe", "-NoProfile", "-STA", "-ExecutionPolicy", "Bypass", "-File", str(fixture)],
                env={**os.environ, "VIBE_TEST_TITLE": title, "VIBE_TEST_RECEIPT": str(receipt),
                     "VIBE_TEST_READY": str(ready)}, creationflags=subprocess.CREATE_NO_WINDOW,
            )
            try:
                for _ in range(150):
                    if ready.exists() or form.poll() is not None:
                        break
                    time.sleep(0.1)
                self.assertTrue(ready.exists())
                process = subprocess.run(
                    ["node", "assistant.mjs", "--target", title, "--field", "Draft"],
                    input="在当前输入框写下：周五交付\n把周五改成周四\n先别发\n读一下草稿\n发出去\n再发出去\n",
                    cwd=ROOT, capture_output=True, encoding="utf-8", timeout=200, check=True,
                )
                self.assertIn("周四交付", process.stdout, process.stdout)
                self.assertIn("保留", process.stdout, process.stdout)
                self.assertLess(process.stdout.index("周四交付"), process.stdout.index("已点击发送"))
                self.assertIn("为防重复没有重发", process.stdout, process.stdout)
                self.assertEqual(receipt.read_text(encoding="utf-8").splitlines(), ["thread-a|周四交付"])
            finally:
                form.terminate()
                form.wait(timeout=10)


if __name__ == "__main__":
    unittest.main()
