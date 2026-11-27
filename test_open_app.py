import unittest
from pathlib import Path
from unittest.mock import AsyncMock, Mock, patch

import desktop


class OpenAppTests(unittest.IsolatedAsyncioTestCase):
    async def test_user_control_returns_an_actionable_receipt(self):
        from fastmcp.exceptions import ToolError
        tool = AsyncMock()
        tool.call_tool.side_effect = ToolError('{"code":"USER_CONTROL","status":{"state":"user"}}')
        with (patch.object(desktop, "start_menu_id", return_value=None),
              patch.object(desktop, "app_windows", return_value=[]),
              patch("fastmcp.Client") as client):
            client.return_value.__aenter__.return_value = tool
            with self.assertRaisesRegex(desktop.DesktopActionError, "^当前桌面由你控制"):
                await desktop.open_app("测试应用")

    def test_helper_window_must_belong_to_registered_app(self):
        exe = Path(r"D:\Steam\steam.exe")
        helper = Mock()
        helper.exe.return_value = r"D:\Steam\bin\steamwebhelper.exe"
        parent = Mock()
        parent.exe.return_value = str(exe)
        unrelated = Mock()
        unrelated.exe.return_value = r"D:\Other\steam.exe"
        helper.parents.side_effect = [[parent], [unrelated]]
        with (patch.object(desktop, "windows_named", return_value=[21, 22]) as named,
              patch.object(desktop.win32process, "GetWindowThreadProcessId", return_value=(1, 2)),
              patch.object(desktop.psutil, "Process", return_value=helper)):
            self.assertEqual(desktop.app_windows("steam", exe), [21])
            named.assert_called_once_with("steam", ignore_case=True)

    async def test_launched_window_can_be_visible_in_background(self):
        exe = Path(r"D:\Steam\steam.exe")
        tool = AsyncMock()
        tool.call_tool.return_value = Mock(content=[])
        with (patch.object(desktop, "start_menu_id", return_value=str(exe)),
              patch.object(desktop, "registered_executable", return_value=exe),
              patch.object(desktop, "app_windows", side_effect=[[], [], [21]]),
              patch.object(desktop.win32gui, "GetForegroundWindow", return_value=35),
              patch.object(desktop, "belongs_to_app", return_value=False),
              patch.object(desktop.asyncio, "sleep", new_callable=AsyncMock),
              patch("fastmcp.Client") as client):
            client.return_value.__aenter__.return_value = tool
            self.assertIn("后台", await desktop.open_app("Steam"))
            tool.call_tool.assert_awaited_once()

    async def test_no_visible_window_after_launch_is_not_success(self):
        with (patch.object(desktop, "start_menu_id", return_value="registered"),
              patch.object(desktop, "registered_executable", return_value=None),
              patch.object(desktop, "app_windows", return_value=[]),
              patch.object(desktop.win32gui, "GetForegroundWindow", return_value=35),
              patch.object(desktop.asyncio, "sleep", new_callable=AsyncMock),
              patch("fastmcp.Client")):
            with self.assertRaisesRegex(ValueError, "未检测到"):
                await desktop.open_app("Steam")

    async def test_switch_uses_the_already_resolved_handle(self):
        with (patch.object(desktop, "start_menu_id", return_value=None),
              patch.object(desktop, "windows_named", return_value=[125]),
              patch.object(desktop.win32gui, "GetForegroundWindow", side_effect=[9, 125]),
              patch("windows_mcp.desktop.service.Desktop") as driver,
              patch("fastmcp.Client") as client):
            self.assertIn("已切换", await desktop.open_app("微信"))
            driver.return_value.bring_window_to_top.assert_called_once_with(125)
            client.assert_not_called()

    async def test_launch_uses_registered_exe_and_checks_owner(self):
        exe = Path(r"C:\Program Files\Tencent\Weixin\Weixin.exe")
        tool = AsyncMock()
        tool.call_tool.return_value = Mock(content=[])
        with (patch.object(desktop, "start_menu_id", return_value="registered"),
              patch.object(desktop, "registered_executable", return_value=exe),
              patch.object(desktop, "windows_named", return_value=[]),
              patch.object(desktop.win32gui, "GetForegroundWindow", return_value=66),
              patch.object(desktop.win32gui, "IsWindowVisible", return_value=True),
              patch.object(desktop, "belongs_to_app", return_value=True) as owner,
              patch("fastmcp.Client") as client):
            client.return_value.__aenter__.return_value = tool
            await desktop.open_app("微信")
            tool.call_tool.assert_awaited_once_with("App", {"mode": "launch_executable", "executable": str(exe)})
            owner.assert_called_once_with(66, exe)
