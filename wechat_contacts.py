"""Resolve a spoken recipient through Weixin's local contact search."""
import asyncio
import time

from desktop import (DesktopActionError, capture, controls, is_weixin_main, open_app, weixin_conversation_key,
                     uia, win32gui)


def candidates(root, name):
    lists = [c for c in controls(root, "ListControl", {"search_list"})
             if c.AutomationId == "search_list"]
    if len(lists) != 1:
        return []
    group = ""
    matches = []
    for row in lists[0].GetChildren():
        label = row.Name.strip()
        cls = row.ClassName
        if cls == "mmui::XTableCell" and not row.AutomationId:
            group = label
        contact = group in {"联系人", "群聊"} and cls == "mmui::SearchContentCellView"
        helper = group == "功能" and name == "文件传输助手" and bool(row.AutomationId)
        if (contact or helper) and label.split("\n", 1)[0].strip() == name and not row.IsOffscreen:
            matches.append((row, {"id": list(row.GetRuntimeId()), "aid": row.AutomationId,
                                  "label": group + " · " + label}))
    return matches


def locate(name, choice=None):
    if not isinstance(name, str) or not name.strip():
        raise DesktopActionError("请说出微信联系人或群聊的完整名称。")
    if not choice:
        asyncio.run(open_app("微信"))
    hwnd = win32gui.GetForegroundWindow()
    root = uia.ControlFromHandle(hwnd)
    if not is_weixin_main(root):
        raise DesktopActionError("未能切换到微信主窗口。")
    fields = [c for c in controls(root, "EditControl", None) if c.ClassName == "mmui::XValidatorTextEdit"]
    if len(fields) != 1:
        raise DesktopActionError("未找到微信搜索框。")
    field, = fields
    value = field.GetValuePattern()

    def check():
        if win32gui.GetForegroundWindow() != hwnd or value.Value != name:
            raise DesktopActionError("微信窗口或搜索词已变化，请重新说出指令。")

    if not choice:
        if value.Value and value.Value != name:
            raise DesktopActionError("微信搜索框中已有其他查询，请清空后重试。")
        field.Click()
        if win32gui.GetForegroundWindow() != hwnd or not field.HasKeyboardFocus:
            raise DesktopActionError("微信搜索框未获得焦点。")
        value.SetValue(name)
    previous = None
    deadline = time.monotonic() + 3
    while True:
        time.sleep(.25)
        check()
        hits = candidates(root, name)
        options = [option for _, option in hits]
        if options and options == previous:
            break
        if time.monotonic() >= deadline:
            if not options and not choice:
                check()
                value.SetValue("")
            raise DesktopActionError("微信未返回稳定的同名联系人或群聊，请核对备注名。")
        previous = options
    if choice:
        if choice["options"] != options or choice["hwnd"] != hwnd:
            raise DesktopActionError("微信候选列表已变化，请重新说出指令。")
        index = choice["index"]
    elif len(hits) > 1:
        return {"status": "choices", "options": options, "hwnd": hwnd}
    else:
        index = 0
    before = weixin_conversation_key(root) if choice else None
    check()
    hits[index][0].Click()
    deadline = time.monotonic() + 4
    while time.monotonic() < deadline and win32gui.GetForegroundWindow() == hwnd:
        time.sleep(.15)
        binding = capture()
        if binding and binding["hwnd"] == hwnd and binding["recipient"] == name and not candidates(root, name):
            if before and before[1] == name and weixin_conversation_key(root) == before:
                continue
            return {"status": "located", "binding": binding}
    raise DesktopActionError("已选择搜索结果，但未能核对打开的聊天。")
