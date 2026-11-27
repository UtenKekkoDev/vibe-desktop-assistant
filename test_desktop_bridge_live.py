"""Integration test using an explicitly created, local-only Windows Forms window."""

import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import time
import unittest
import uuid

from desktop import bind_editor, controls, submit_with_enter, uia, windows_named
from desktop_bridge import dispatch


FORM = """
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
$f = New-Object Windows.Forms.Form
$f.Text = $env:VIBE_TEST_TITLE
$f.Width = 360
$f.Height = 260
$box = New-Object Windows.Forms.TextBox
$box.AccessibleName = 'Draft'
$box.Dock = 'Top'
$box.Add_KeyDown({
    if ($_.KeyCode -eq 'Enter') {
        $_.SuppressKeyPress = $true
        [IO.File]::AppendAllText($env:VIBE_TEST_RECEIPT, 'enter|' + $box.Text + [Environment]::NewLine)
        $box.Clear()
    }
})
$key = New-Object Windows.Forms.Label
$key.Name = 'VibeActiveConversationId'
$key.AccessibleName = 'thread-a'
$key.Text = 'thread-a'
$key.Dock = 'Top'
$send = New-Object Windows.Forms.Button
$send.Text = 'Send'
$send.Dock = 'Bottom'
$send.Add_Click({ [IO.File]::AppendAllText($env:VIBE_TEST_RECEIPT, $key.Text + '|' + $box.Text + [Environment]::NewLine) })
$switch = New-Object Windows.Forms.Button
$switch.Text = 'Switch'
$switch.Dock = 'Bottom'
$switch.Add_Click({ $key.AccessibleName = 'thread-b'; $key.Text = 'thread-b' })
$hide = New-Object Windows.Forms.Button
$hide.Text = 'HideIdentity'
$hide.Dock = 'Bottom'
$hide.Add_Click({ $key.Visible = $false })
$f.Controls.AddRange(@($box,$key,$send,$switch,$hide))
Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public class BridgeDemo { [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hwnd, int n); }'
$f.Add_Shown({ [void][BridgeDemo]::ShowWindow($f.Handle,5); $f.Activate(); [IO.File]::WriteAllText($env:VIBE_TEST_READY, 'ready') })
[void]$f.ShowDialog()
"""


def read_binding(title):
    return dispatch({"op": "capture", "target": title, "field": "Draft"})


@unittest.skipUnless(os.environ.get("VIBE_TEST_DESKTOP") == "1", "requires an interactive Windows desktop")
class BridgeTests(unittest.TestCase):
    def test_target_draft_guard_and_single_receipt(self):
        with tempfile.TemporaryDirectory() as directory:
            folder = Path(directory)
            title = "Vibe desktop test " + uuid.uuid4().hex
            receipt = folder / "receipt.txt"
            ready = folder / "ready"
            program = folder / "fixture.ps1"
            program.write_text(FORM, encoding="utf-8-sig")
            process = subprocess.Popen(
                ["powershell.exe", "-NoProfile", "-STA", "-ExecutionPolicy", "Bypass", "-File", str(program)],
                env={**os.environ, "VIBE_TEST_TITLE": title, "VIBE_TEST_RECEIPT": str(receipt),
                     "VIBE_TEST_READY": str(ready)}, creationflags=subprocess.CREATE_NO_WINDOW,
            )
            try:
                for _ in range(150):
                    if ready.is_file() or process.poll() is not None:
                        break
                    time.sleep(0.1)
                self.assertTrue(ready.is_file(), "local fixture did not open")

                def invoke_test_action(name):
                    hwnd, = windows_named(title)
                    button, = controls(uia.ControlFromHandle(hwnd), "ButtonControl", {name})
                    button.GetInvokePattern().Invoke()

                captured = subprocess.run(
                    [sys.executable, "-X", "utf8", str(Path(__file__).with_name("desktop_bridge.py"))],
                    input=json.dumps({"op": "capture", "target": title, "field": "Draft"}),
                    encoding="utf-8", capture_output=True, timeout=30, check=True,
                )
                a = json.loads(captured.stdout)
                self.assertTrue(a["sendAvailable"])
                self.assertEqual(a["draft"], "")
                if os.environ.get("VIBE_TEST_DEEPSEEK") == "1":
                    terminal = subprocess.run(
                        ["node", str(Path(__file__).with_name("assistant.mjs")), "--target", title,
                         "--field", "Draft"],
                        input="在当前输入框写下：周五交付\n把周五改成周四\n先别发\n",
                        encoding="utf-8", capture_output=True, timeout=160, check=True,
                    )
                    after = read_binding(title)
                    self.assertEqual(after["draft"], "周四交付", terminal.stdout + terminal.stderr)
                    self.assertFalse(receipt.exists())
                    dispatch({"op": "apply", "binding": after,
                              "decision": {"intent": "set_draft", "value": ""}})
                updated = dispatch({"op": "apply", "binding": a,
                                    "decision": {"intent": "set_draft", "value": "周五交付"}})
                self.assertEqual(updated["draft"], "周五交付")
                with self.assertRaisesRegex(ValueError, "变化"):
                    dispatch({"op": "apply", "binding": a, "decision": {"intent": "set_draft", "value": "覆盖"}})
                a = read_binding(title)
                invoke_test_action("Switch")
                b = read_binding(title)
                self.assertNotEqual(a["identity"], b["identity"])
                self.assertEqual(a["draft"], b["draft"])
                with self.assertRaisesRegex(ValueError, "变化"):
                    dispatch({"op": "apply", "binding": a, "decision": {"intent": "send_draft"}})
                self.assertFalse(receipt.exists())
                updated = dispatch({"op": "apply", "binding": b,
                                    "decision": {"intent": "set_draft", "value": "周四交付"}})
                self.assertEqual(updated["draft"], "周四交付")
                b = read_binding(title)
                sent = dispatch({"op": "apply", "binding": b, "decision": {"intent": "fill_send", "value": "，下午见"}})
                self.assertEqual(sent, {"status": "submitted", "level": "warning",
                                        "message": "已点击发送，无法确认是否发出，请查看窗口。"})
                for _ in range(50):
                    if receipt.exists() and receipt.stat().st_size:
                        break
                    time.sleep(0.05)
                self.assertEqual(receipt.read_text(encoding="utf-8").splitlines(), ["thread-b|周四交付，下午见"])
                b = read_binding(title)
                editor = bind_editor(title, "Draft")
                entered = submit_with_enter(editor, b, b["draft"])
                self.assertEqual(entered, {"status": "submitted", "level": "success", "message": "已发送。"})
                self.assertEqual(receipt.read_text(encoding="utf-8").splitlines(),
                                 ["thread-b|周四交付，下午见", "enter|周四交付，下午见"])
                invoke_test_action("HideIdentity")
                missing = read_binding(title)
                self.assertFalse(missing["sendAvailable"])
                dispatch({"op": "apply", "binding": missing,
                          "decision": {"intent": "set_draft", "value": "待核对"}})
                missing = read_binding(title)
                with self.assertRaisesRegex(ValueError, "会话标识"):
                    dispatch({"op": "apply", "binding": missing, "decision": {"intent": "send_draft"}})
                self.assertEqual(receipt.read_text(encoding="utf-8").splitlines(),
                                 ["thread-b|周四交付，下午见", "enter|周四交付，下午见"])
            finally:
                process.terminate()
                process.wait(timeout=10)


if __name__ == "__main__":
    unittest.main()
