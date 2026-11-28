import argparse
import asyncio
from dataclasses import dataclass
import json
import os
import re
from pathlib import Path
import subprocess
import sys
import time

import psutil
import ai_chat
import win32gui
import win32process
from windows_mcp import uia
from windows_mcp.desktop.utils import resolve_known_folder_guid_path

ROOT = Path(__file__).resolve().parent


class DesktopActionError(ValueError):
    """A short user-facing explanation of a desktop operation failure."""


def windows_named(title, *, ignore_case=False):
    matches = []
    expected = title.casefold() if ignore_case else title

    def visit(hwnd, _):
        if not win32gui.IsWindowVisible(hwnd):
            return
        actual = win32gui.GetWindowText(hwnd)
        if (actual.casefold() if ignore_case else actual) == expected:
            matches.append(hwnd)

    win32gui.EnumWindows(visit, None)
    return matches


def start_menu_id(name):
    query = ("[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false); "
             "ConvertTo-Json -Compress -InputObject @(Get-StartApps | Select-Object Name,AppID)")
    result = subprocess.run(["powershell.exe", "-NoProfile", "-Command", query],
                            capture_output=True, timeout=15, check=True, encoding="utf-8")
    matches = [app["AppID"] for app in json.loads(result.stdout)
               if app["Name"].casefold() == name.casefold()]
    return matches[0] if len(matches) == 1 else None


def controls(root, kind, names):
    for control, _ in uia.WalkControl(root, maxDepth=36):
        if control.ControlTypeName != kind or control.IsOffscreen or not control.IsEnabled:
            continue
        if names and control.Name not in names and control.AutomationId not in names:
            continue
        yield control


@dataclass
class Editor:
    hwnd: int
    title: str
    pid: int
    control: object
    pattern: object
    original: str
    chat_app: str | None = None
    document: object = None

    def check(self, expected):
        window_valid = (win32gui.IsWindowVisible(self.hwnd) and win32gui.GetWindowText(self.hwnd) == self.title
                        if self.chat_app else windows_named(self.title) == [self.hwnd])
        if (not window_valid
                or win32process.GetWindowThreadProcessId(self.hwnd)[1] != self.pid
                or self.control.IsOffscreen or not self.control.IsEnabled
                or self.control.IsPassword or self.read() != expected):
            raise DesktopActionError("目标窗口或草稿已变化，请重新指定。")

    def read(self):
        if self.chat_app:
            children = self.control.GetChildren()
            if len(children) == 1 and "is-editor-empty" in children[0].ClassName.split():
                return ""
        return self.pattern.Value or ""


def bind_editor(title, field, chat_hwnd=None):
    if chat_hwnd:
        hwnd = chat_hwnd
        if win32gui.GetForegroundWindow() != hwnd:
            return None
    elif title:
        found = windows_named(title)
        if len(found) != 1:
            return None
        hwnd = found[0]
    else:
        hwnd = win32gui.GetForegroundWindow()
        if not hwnd:
            return None
    pid = win32process.GetWindowThreadProcessId(hwnd)[1]
    if psutil.Process(pid).name().lower() in {"windowsterminal.exe", "conhost.exe", "openconsole.exe"}:
        return None
    title = win32gui.GetWindowText(hwnd)
    if not title:
        return None
    root = uia.ControlFromHandle(hwnd)
    app, doc = ai_chat.surface(root, Path(psutil.Process(pid).exe()))
    if app and doc is None:
        return None
    weixin = is_weixin_main(root)
    editors = []
    for c in controls(doc if app else root, "EditControl", {field} if field else None):
        if app and ("ProseMirror" not in c.ClassName.split()
                    or ai_chat.owning_document(c).GetRuntimeId() != doc.GetRuntimeId()):
            continue
        if weixin and c.ClassName != "mmui::ChatInputField":
            if c.HasKeyboardFocus:
                return None
            continue
        if c.IsPassword:
            continue
        pattern = c.GetValuePattern()
        if pattern and not pattern.IsReadOnly:
            editors.append((c, pattern))
    if len(editors) > 1:
        editors = [(c, p) for c, p in editors if c.HasKeyboardFocus]
    if len(editors) != 1:
        return None
    control, pattern = editors[0]
    editor = Editor(hwnd, title, pid, control, pattern, "", app, doc)
    editor.original = editor.read()
    return editor


def is_weixin_main(root):
    return (root.ClassName == "mmui::MainWindow"
            and psutil.Process(root.ProcessId).name().lower() == "weixin.exe")


def weixin_conversation_key(root):
    bars = []
    rows = []
    for control, _ in uia.WalkControl(root, maxDepth=36):
        cls = control.ClassName
        if cls not in {"mmui::ChatTitleBarMasterView", "mmui::ChatSessionCell"} or control.IsOffscreen:
            continue
        if cls == "mmui::ChatSessionCell":
            rows.append(control)
        else:
            bars.append(control)
    if len(bars) != 1:
        return None
    selected = []
    for row in rows:
        pattern = row.GetSelectionItemPattern()
        if pattern and pattern.IsSelected:
            selected.append(row)
    if len(selected) != 1:
        return None
    row, = selected
    title = row.Name.partition("\n")[0].strip()
    if not title:
        return None
    titles = [c.Name.strip() for c in controls(bars[0], "TextControl", None)
              if c.ClassName == "mmui::XTextView"]
    row_id = row.GetRuntimeId()
    if titles != [title] or not row_id:
        return None
    return ["weixin", title, row.AutomationId, list(row_id)]


def conversation_key(root):
    """Read an explicit active-conversation key. A window title alone is ambiguous."""
    if is_weixin_main(root):
        return weixin_conversation_key(root)
    markers = list(controls(root, "TextControl", {"VibeActiveConversationId"}))
    markers = [marker for marker in markers if marker.AutomationId == "VibeActiveConversationId"]
    if len(markers) == 1 and markers[0].Name.strip():
        return markers[0].Name
    return None


def editor_state(editor):
    runtime_id = editor.control.GetRuntimeId()
    if not runtime_id:
        raise DesktopActionError("输入框没有稳定标识，请重新指定目标。")
    process_start = psutil.Process(editor.pid).create_time()
    key = (ai_chat.conversation(editor.chat_app, editor.document) if editor.chat_app
           else conversation_key(uia.ControlFromHandle(editor.hwnd)))
    identity = json.dumps([editor.pid, process_start, editor.hwnd, list(runtime_id), key],
                          ensure_ascii=False, separators=(",", ":"))
    return identity, key


def capture(target=None, field=None, send_button=None):
    editor = bind_editor(target, field)
    if editor is None:
        return None
    identity, key = editor_state(editor)
    editor.check(editor.original)
    return {"identity": identity, "target": editor.title, "draft": editor.original, "hwnd": editor.hwnd,
            "recipient": key[1] if isinstance(key, list) and key[0] == "weixin" else None,
            "chatApp": editor.chat_app, "isWeChat": is_weixin_main(uia.ControlFromHandle(editor.hwnd)),
            "isForeground": win32gui.GetForegroundWindow() == editor.hwnd,
            "field": field, "sendButton": send_button, "foreground": not bool(target),
            "sendAvailable": key is not None}


def validate_binding(editor, binding, expected, require_conversation=False):
    if editor is None:
        raise DesktopActionError("指定的输入框已变化，请重新选择。")
    if binding.get("foreground") and win32gui.GetForegroundWindow() != editor.hwnd:
        raise DesktopActionError("前台窗口发生变化，请重新指定目标。")
    identity, key = editor_state(editor)
    if editor.chat_app and not key:
        raise DesktopActionError("未能核对当前 AI 对话。请打开目标聊天，Codex 请展开侧栏。")
    if binding.get("requiredRecipient") and (
            not isinstance(key, list) or binding["requiredRecipient"] != key[1]):
        raise DesktopActionError("当前微信聊天与指定收件人不符，请切换到对应聊天后重试。")
    if identity != binding["identity"]:
        raise DesktopActionError("输入框或目标对话已变化，此操作已停止。")
    if require_conversation and not key:
        raise DesktopActionError("当前应用未提供可核对的会话标识，已保留草稿。")
    editor.check(expected)


def submit_with_enter(editor, binding, expected):
    if win32gui.GetForegroundWindow() != editor.hwnd:
        raise DesktopActionError("请回到要发送的聊天窗口后重试。")
    editor.control.SetFocus()
    validate_binding(editor, binding, expected, require_conversation=True)
    if win32gui.GetForegroundWindow() != editor.hwnd or not editor.control.HasKeyboardFocus:
        raise DesktopActionError("未能确认聊天输入框焦点，已保留草稿。")
    try:
        uia.SendKeys("{Enter}", waitTime=0)
    except Exception:
        return {"status": "unknown", "level": "error", "message": "发送过程出错，结果未知，请先查看对话。"}
    try:
        deadline = time.monotonic() + 2
        while True:
            remaining = editor.pattern.Value
            if remaining == "" or time.monotonic() >= deadline:
                validate_binding(editor, binding, remaining, require_conversation=True)
                if remaining == "":
                    return {"status": "submitted", "level": "success", "message": "已发送。"}
                if not isinstance(remaining, str):
                    raise ValueError("Missing editor value")
                return {"status": "unknown", "level": "error", "message": "没发出去，文字还在输入框里，请检查微信发送快捷键。"}
            time.sleep(0.08)
    except Exception:
        return {"status": "unknown", "level": "warning", "message": "已按回车，无法确认是否发出，请查看聊天记录。"}


def submit(editor, binding, expected):
    root = uia.ControlFromHandle(editor.hwnd)
    if is_weixin_main(root):
        return submit_with_enter(editor, binding, expected)
    name = binding.get("sendButton")
    names = {name} if name else {"发送", "Send", "Send message", "发送消息"}
    if editor.chat_app:
        names = {"发送", "发送消息", "发送提示", "发送提示词", "发送提示语", "发送后续消息", "提交",
                 "Send", "Send message", "Send prompt", "Send follow-up", "Submit", "提交提示"}
        root = editor.document
    buttons = list(controls(root, "ButtonControl", names))
    if editor.chat_app:
        buttons = [b for b in buttons if b.Name in names and
                   ai_chat.owning_document(b).GetRuntimeId() == root.GetRuntimeId()]
    if len(buttons) != 1:
        raise DesktopActionError("发送按钮不唯一或不可用，已保留草稿。")
    invoke = buttons[0].GetInvokePattern()
    if not invoke:
        raise DesktopActionError("发送按钮不支持调用，已保留草稿。")
    if editor.chat_app:
        before = ai_chat.matching_messages(editor.chat_app, root, expected)
        key = ai_chat.conversation(editor.chat_app, root)
    validate_binding(editor, binding, expected, require_conversation=True)
    try:
        # A successful COM call acknowledges the button invocation, not delivery.
        invoke.pattern.Invoke()
        if editor.chat_app:
            deadline = time.monotonic() + 5
            while time.monotonic() < deadline and win32gui.GetForegroundWindow() == editor.hwnd:
                current = ai_chat.conversation(editor.chat_app, root)
                same = current and (key == current or (editor.chat_app == "ChatGPT" and key[-1] == "/"
                                    and current[:2] == key[:2] and current[-1].startswith("/c/")))
                if not same:
                    break
                if ai_chat.matching_messages(editor.chat_app, root, expected) > before:
                    return {"status": "confirmed", "level": "success", "message": "已发送。"}
                time.sleep(.2)
            return {"status": "unknown", "level": "warning", "message": "已触发发送，对话里还没看到新消息，请确认。"}
    except Exception:
        return {"status": "unknown", "level": "error", "message": "发送过程出错，结果未知，请先查看对话。"}
    return {"status": "submitted", "level": "warning", "message": "已点击发送，无法确认是否发出，请查看窗口。"}


def operate_window(decision, hwnd):
    def check_window():
        if not hwnd or win32gui.GetForegroundWindow() != hwnd or not win32gui.IsWindowVisible(hwnd):
            raise DesktopActionError("前台窗口已变化，请回到目标软件后重试。")

    check_window()
    root = uia.ControlFromHandle(hwnd)
    types = {"ButtonControl": "按钮", "EditControl": "输入框", "ComboBoxControl": "组合框",
             "TabItemControl": "选项卡", "CheckBoxControl": "复选框"}
    intent = decision["intent"]
    name = decision.get("value", "").strip()
    labels = []
    matches = []
    deadline = time.monotonic() + 6
    partial = False
    for index, (c, _) in enumerate(uia.WalkControl(root, maxDepth=36)):
        if index >= 1800 or time.monotonic() > deadline:
            partial = True
            break
        kind = c.ControlTypeName
        if kind not in types or c.IsOffscreen or not c.IsEnabled or c.IsPassword:
            continue
        label = c.Name.strip()
        if not label or len(label) > 80 or "\n" in label:
            continue
        if intent == "list_controls":
            entry = f"{label}（{types[kind]}）"
            if entry not in labels:
                labels.append(entry)
            if len(labels) == 18:
                partial = True
                break
        elif intent != "press_button" or kind == "ButtonControl":
            # Explorer appends the folder name and keyboard shortcut to Refresh.
            short = re.sub(r"(?:“[^”]+”)?\s*[（(](?:F\d+|Ctrl\+[^)）]+)[)）]$", "", label)
            aliases = (label, short, label + types[kind], short + types[kind])
            if any(name.casefold() == alias.casefold() for alias in aliases):
                matches.append(c)
    check_window()
    if intent == "list_controls":
        if not labels:
            raise DesktopActionError("当前窗口没有读到可操作的具名控件。")
        prefix = "当前窗口的部分控件：" if partial else "当前窗口的控件："
        return {"status": "listed", "message": prefix + "、".join(labels)}
    if len(matches) != 1 or partial:
        raise DesktopActionError(f"未能在当前窗口唯一定位「{name}」。可以先说“列出当前窗口的控件”。")
    control, = matches
    if intent == "focus_control":
        control.SetFocus()
        check_window()
        if control.HasKeyboardFocus:
            return {"status": "focused", "message": f"焦点已移到「{name}」。"}
        raise DesktopActionError(f"未能核对「{name}」的键盘焦点。")
    if is_weixin_main(root) and name.casefold() in {"发送", "发送消息", "send", "send message"}:
        raise DesktopActionError("请说“发送当前草稿”，以核对微信收件人。")
    invoke = control.GetInvokePattern()
    if not invoke:
        raise DesktopActionError(f"「{name}」没有提供可调用的按钮动作。")
    check_window()
    try:
        invoke.Invoke()
    except Exception:
        return {"status": "unknown", "message": f"「{name}」的点击结果未能核对，请查看窗口。"}
    return {"status": "submitted", "message": f"已调用「{name}」按钮。"}


def apply_decision(decision, binding):
    intent = decision["intent"]
    if intent in {"list_controls", "focus_control", "press_button"}:
        return operate_window(decision, (binding or {}).get("hwnd"))
    if intent == "open_app":
        return {"status": "opened", "message": asyncio.run(open_app(decision["value"]))}
    if intent not in {"dictate", "fill_text", "fill_send", "send_draft", "set_draft"}:
        raise DesktopActionError("不支持的桌面动作。")
    if not binding or not binding.get("target"):
        raise DesktopActionError("未找到唯一可编辑的输入框，请指定窗口或输入框。")
    if decision.get("recipient"):
        binding = {**binding, "requiredRecipient": decision["recipient"]}
    editor = bind_editor(binding["target"], binding.get("field"), binding["hwnd"] if binding.get("chatApp") else None)
    expected = binding["draft"]
    validate_binding(editor, binding, expected)
    if intent == "send_draft":
        if not expected.strip():
            raise DesktopActionError("当前输入框没有可发送的草稿。")
        return submit(editor, binding, expected)
    value = decision.get("text") if intent == "dictate" else decision.get("value")
    if not isinstance(value, str):
        raise DesktopActionError("草稿需要文本内容。")
    updated = value if intent == "set_draft" else expected + value
    editor.pattern.SetValue(updated)
    validate_binding(editor, binding, updated)
    if intent == "fill_send":
        return submit(editor, binding, updated)
    return {"status": "written", "draft": updated, "message": "已核对输入框中的正文。"}


def registered_executable(app_id):
    if not app_id:
        return None
    path = Path(resolve_known_folder_guid_path(app_id))
    return path if path.is_absolute() and path.suffix.lower() == ".exe" and path.is_file() else None


def belongs_to_app(hwnd, executable, *, include_parents=False):
    try:
        pid = win32process.GetWindowThreadProcessId(hwnd)[1]
        process = psutil.Process(pid)
        if Path(process.exe()) == executable:
            return True
        return include_parents and any(Path(parent.exe()) == executable for parent in process.parents())
    except (psutil.Error, OSError):
        return False


def app_windows(name, executable):
    # Steam renders its main window in a child process. Only use ancestry
    # for windows whose title also identifies the requested application.
    return [hwnd for hwnd in windows_named(name, ignore_case=True)
            if executable is None or belongs_to_app(hwnd, executable, include_parents=True)]


async def open_app(name):
    app_id = start_menu_id(name)
    executable = registered_executable(app_id)
    existing = app_windows(name, executable)
    if win32gui.GetForegroundWindow() in existing:
        return f"{name}已在前台。"
    if len(existing) > 1:
        raise DesktopActionError("有多个同名窗口，请指定更明确的应用。")
    if existing:
        # Retain the Win32 identity: MCP's second, name-based search can omit
        # visible windows (including Weixin) from its application inventory.
        from windows_mcp.desktop.service import Desktop
        hwnd = existing[0]
        Desktop().bring_window_to_top(hwnd)
        for _ in range(20):
            if win32gui.GetForegroundWindow() == hwnd:
                return f"已切换到{name}。"
            await asyncio.sleep(0.05)
        if hwnd in app_windows(name, executable):
            return f"{name}窗口已打开，当前在后台。"
        raise DesktopActionError(f"切换时{name}窗口已消失。")
    # The bridge starts a fresh interpreter for each request. Load the MCP
    # client only when an application actually needs a launch request.
    from fastmcp import Client
    from fastmcp.client.transports import StdioTransport
    from fastmcp.exceptions import ToolError

    transport = StdioTransport(
        command=str(Path(sys.executable).with_name("windows-mcp.exe")),
        args=["serve", "--tools", "App"],
        env={"ANONYMIZED_TELEMETRY": "false", "PYTHONUTF8": "1"},
        keep_alive=False,
    )
    async with Client(transport, timeout=60) as client:
        request = {"mode": "launch", "name": name}
        if executable:
            request = {"mode": "launch_executable", "executable": str(executable)}
        elif app_id:
            request = {"mode": "launch_executable",
                       "executable": str(Path(os.environ["WINDIR"]) / "explorer.exe"),
                       "args": ["shell:AppsFolder\\" + app_id]}
        try:
            result = await client.call_tool("App", request)
        except ToolError as exc:
            try:
                payload = json.loads(str(exc))
            except ValueError:
                payload = None
            code = payload.get("code") if isinstance(payload, dict) else None
            if code in ("USER_CONTROL", "TAKEOVER_PENDING"):
                raise DesktopActionError("当前桌面由你控制，本次打开应用的操作被暂停。请在操作结束后重试。") from exc
            if code == "CONTROL_DENIED":
                raise DesktopActionError("本次桌面控制请求被拒绝，未启动应用。") from exc
            raise DesktopActionError("桌面工具未能执行打开应用的指令。") from exc
        message = " ".join(item.text for item in result.content if item.type == "text")
        if app_id:
            for _ in range(40):
                foreground = win32gui.GetForegroundWindow()
                if (executable and foreground and belongs_to_app(foreground, executable)
                        and win32gui.IsWindowVisible(foreground)):
                    return f"已打开{name}。"
                visible = app_windows(name, executable)
                if foreground in visible:
                    return f"已打开{name}。"
                if visible:
                    return f"{name}窗口已打开，当前在后台。"
                await asyncio.sleep(0.25)
            raise DesktopActionError("已调用开始菜单启动程序，未检测到同名窗口。")
        if not message.endswith(" launched."):
            raise DesktopActionError("未能确认应用窗口已打开，请核对应用名称。")
        return f"已打开{name}。"


def main():
    parser = argparse.ArgumentParser(description="从一句中文操作 Windows 桌面")
    parser.add_argument("utterance")
    parser.add_argument("--target", help="完整窗口标题")
    parser.add_argument("--field", help="输入框的辅助功能名称或 AutomationId")
    parser.add_argument("--send-button", help="发送按钮的辅助功能名称或 AutomationId")
    args = parser.parse_args()
    binding = capture(args.target, args.field, args.send_button)
    command = ["node", str(ROOT / "intent.mjs")]
    if binding:
        command += ["--target", binding["target"]]
        if binding["draft"].strip():
            command += ["--draft", "当前输入框有草稿"]
    command += ["--", args.utterance]
    proc = subprocess.run(command, capture_output=True, encoding="utf-8", timeout=40)
    if proc.returncode:
        raise ValueError(proc.stderr.strip())
    decision = json.loads(proc.stdout)
    intent = decision["intent"]
    if intent == "clarify":
        return decision["value"]
    return apply_decision(decision, binding)["message"]


if __name__ == "__main__":
    try:
        print(main())
    except Exception as exc:
        print(str(exc), file=sys.stderr)
        sys.exit(1)
