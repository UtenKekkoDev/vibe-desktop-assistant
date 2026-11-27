"""Run one Steam store search through UFO's in-process Windows MCP services."""
import asyncio
import contextlib
import json
import os
from pathlib import Path
import subprocess
import sys
import time
from urllib.parse import parse_qs, urlsplit
import winreg

import psutil
import win32gui
import win32process
from comtypes import COMError
from pywinauto import Desktop
from pywinauto.uia_defines import IUIA
from pywinauto.uia_element_info import UIAElementInfo
from pywinauto.controls.uiawrapper import UIAWrapper

ROOT = Path(__file__).resolve().parent
OUTPUT = sys.stdout


def emit(**event):
    print(json.dumps(event, ensure_ascii=False), file=OUTPUT, flush=True)


def steam_executable():
    try:
        with winreg.OpenKey(winreg.HKEY_CURRENT_USER, r"Software\Valve\Steam") as key:
            path = Path(winreg.QueryValueEx(key, "SteamExe")[0])
        if path.is_absolute() and path.name.lower() == "steam.exe" and path.is_file():
            return path
    except OSError:
        pass
    raise ValueError("没有找到本机安装的 Steam 客户端。")


def steam_windows(exe):
    found = []
    def visit(hwnd, _):
        if not win32gui.IsWindowVisible(hwnd) or win32gui.GetWindowText(hwnd) != "Steam":
            return
        try:
            process = psutil.Process(win32process.GetWindowThreadProcessId(hwnd)[1])
            owner = Path(process.exe())
            if owner == exe or (owner.name.lower() == "steamwebhelper.exe"
                                and owner.is_relative_to(exe.parent)
                                and any(Path(p.exe()) == exe for p in process.parents())):
                found.append(hwnd)
        except (psutil.Error, OSError):
            pass
    win32gui.EnumWindows(visit, None)
    return found


def is_result(url, query):
    parsed = urlsplit(url or "")
    return (parsed.scheme == "https" and parsed.hostname == "store.steampowered.com"
            and parsed.path.rstrip("/") == "/search" and parse_qs(parsed.query).get("term") == [query])


def result_visible(window, query):
    # Steam's Chromium document exposes its URL through the legacy UIA value.
    try:
        return any(doc.is_visible() and is_result(doc.legacy_properties().get("Value"), query)
                   for doc in window.descendants(control_type="Document"))
    except (COMError, RuntimeError, OSError):
        return False


def literal_keys(text):
    # pywinauto's key syntax treats these characters as modifiers or commands.
    return "".join("{" + char + "}" if char in "{}+^%~()" else char for char in text)


async def search(query):
    from fastmcp import Client
    repo = ROOT / ".runtime/ufo"
    sys.path.insert(0, str(repo))
    os.chdir(repo)
    from ufo.client.mcp.local_servers.ui_mcp_server import (
        create_app_action_mcp_server, create_data_mcp_server, create_host_action_mcp_server,
    )
    exe = steam_executable()
    windows = steam_windows(exe)
    launched_store = False
    def show_store():
        subprocess.Popen([str(exe), "steam://store/"], stdin=subprocess.DEVNULL,
                         stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    if not windows:
        show_store()
        launched_store = True
        for _ in range(40):
            await asyncio.sleep(.25)
            windows = steam_windows(exe)
            if windows:
                break
    if len(windows) != 1:
        raise ValueError("无法唯一定位 Steam 主窗口，请先打开 Steam 商店。")
    hwnd, = windows
    window = Desktop(backend="uia").window(handle=hwnd).wrapper_object()
    def check_focus():
        if win32gui.GetForegroundWindow() != hwnd:
            raise ValueError("前台窗口已变化，已停止本次 Steam 搜索。")
    async with (Client(create_data_mcp_server()) as observer,
                Client(create_host_action_mcp_server()) as host,
                Client(create_app_action_mcp_server()) as app):
        apps = (await observer.call_tool("get_desktop_app_info", {})).data
        matches = [a for a in apps if a["name"] == "Steam"]
        if len(matches) != 1:
            raise ValueError("无法唯一定位 Steam 窗口。")
        was_active = win32gui.GetForegroundWindow() == hwnd
        selected = (await host.call_tool("select_application_window", {"id":matches[0]["id"], "name":"Steam"})).data
        if selected["window_info"]["handle"] != hwnd:
            raise ValueError("Steam 窗口已变化，请重新搜索。")
        check_focus()
        if not was_active or launched_store:
            emit(stage="action")
        deadline = time.monotonic() + 12
        while True:
            check_focus()
            fields = (await observer.call_tool("get_app_window_controls_info",
                                               {"field_list":["control_text","control_type"]})).data
            hits = [f for f in fields if f.get("control_type") in {"ComboBox","Edit"}
                    and f["control_text"].casefold() in {"搜索商店","search the store","search the steam store"}]
            if len(hits) == 1:
                break
            if len(hits) > 1 or time.monotonic() >= deadline:
                raise ValueError("Steam 商店搜索框未就绪，请检查商店页面。")
            if not launched_store:
                show_store()
                launched_store = True
            await asyncio.sleep(.35)
        field, = hits
        target = {"id":field["label"],"name":field["control_text"]}
        check_focus()
        await app.call_tool("click_input",target)
        emit(stage="action")
        check_focus()
        focused = UIAWrapper(UIAElementInfo(IUIA().iuia.GetFocusedElement()))
        if (focused.element_info.process_id != window.element_info.process_id
                or focused.element_info.name != target["name"] or focused.top_level_parent().handle != hwnd):
            raise ValueError("Steam 搜索框焦点已变化，已停止输入。")
        # Chromium search suggestions react to keyboard input. Escape the entire
        # user string and keep Return a separate action after the read-back.
        focused.type_keys("^a", set_foreground=False)
        check_focus()
        focused.type_keys(literal_keys(query), with_spaces=True, set_foreground=False, pause=.01)
        for _ in range(12):
            if focused.iface_value.CurrentValue == query or focused.legacy_properties().get("Value") == query:
                break
            await asyncio.sleep(.05)
        else:
            raise ValueError("Steam 搜索框中的文字与指令不一致。")
        check_focus()
        if not IUIA().iuia.CompareElements(focused.element_info.element, IUIA().iuia.GetFocusedElement()):
            raise ValueError("Steam 搜索框焦点已变化，已停止提交。")
        await app.call_tool("keyboard_input", {**target, "keys":"{ENTER}","control_focus":True})
        emit(stage="submitted")
        deadline = time.monotonic() + 8
        while time.monotonic() < deadline:
            if result_visible(window, query):
                return {"status":"searched","message":f"已在 Steam 商店搜索「{query}」。"}
            await asyncio.sleep(.25)
        return {"status":"unverified","message":f"已提交「{query}」，暂未核对到 Steam 搜索结果页。"}


if __name__ == "__main__":
    try:
        query = json.loads(sys.stdin.buffer.read())["decision"]["value"]
        if not isinstance(query,str) or not query.strip() or len(query)>256 or any(ord(c)<32 for c in query):
            raise ValueError("请说出要在 Steam 商店搜索的游戏名。")
        with contextlib.redirect_stdout(sys.stderr):
            result = asyncio.run(search(query.strip()))
        emit(**result)
    except ValueError as exc:
        emit(status="error",message=str(exc))
    except Exception as exc:
        print(type(exc).__name__,str(exc),file=sys.stderr)
        emit(status="error",message="Steam 桌面操作中断，请检查当前窗口。")
