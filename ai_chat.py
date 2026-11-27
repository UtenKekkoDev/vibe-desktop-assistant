"""Local UI Automation evidence for the active Codex or ChatGPT composer."""
import re
from urllib.parse import urlsplit

from windows_mcp import uia


def owning_document(control):
    parent = control.GetParentControl()
    while parent and parent.ControlTypeName != "DocumentControl":
        parent = parent.GetParentControl()
    return parent


def surface(root, exe):
    codex = exe.name.lower() == "chatgpt.exe" and any(
        p.lower().startswith("openai.codex_") for p in exe.parts)
    browser = exe.name.lower() in {"chrome.exe", "msedge.exe"}
    if not (codex or browser):
        return None, None
    docs = []
    for node, _ in uia.WalkControl(root, maxDepth=16):
        if node.ControlTypeName != "DocumentControl" or node.IsOffscreen:
            continue
        url = urlsplit(getattr(node.GetValuePattern(), "Value", "") or "")
        if (codex and url.scheme == "app") or (
                browser and url.scheme == "https" and url.hostname == "chatgpt.com"):
            if owning_document(node) is None:
                docs.append(node)
    if codex or docs:
        return ("Codex" if codex else "ChatGPT"), docs[0] if len(docs) == 1 else None
    return None, None


def conversation(app, doc):
    if app == "Codex":
        sidebar = [c for c, _ in uia.WalkControl(doc, maxDepth=25)
                   if c.AutomationId == "app-shell-sidebar"]
        if len(sidebar) != 1:
            return None
        current = [c for c, _ in uia.WalkControl(sidebar[0], maxDepth=30)
                   if c.ControlTypeName == "GroupControl" and "cursor-interaction" in c.ClassName.split()
                   and "current=page" in str(c.GetPropertyValue(30102)).split(";")]
        if len(current) == 1 and current[0].GetRuntimeId():
            return [app, list(doc.GetRuntimeId()), list(current[0].GetRuntimeId()), current[0].Name]
        return None
    url = urlsplit(doc.GetValuePattern().Value)
    if url.scheme != "https" or url.hostname != "chatgpt.com":
        return None
    if url.path == "/" or re.fullmatch(r"/(?:g/[^/]+/)?c/[\w-]+/?", url.path):
        return [app, list(doc.GetRuntimeId()), url.path]
    return None


def matching_messages(app, doc, expected):
    matches = 0
    for node, _ in uia.WalkControl(doc, maxDepth=45):
        classes = node.ClassName.split()
        user = ("bg-user-message" in classes if app == "Codex" else "user-message-bubble-color" in classes)
        if not user or owning_document(node).GetRuntimeId() != doc.GetRuntimeId():
            continue
        parts = [c.Name for c, _ in uia.WalkControl(node, maxDepth=20) if c.ControlTypeName == "TextControl"]
        if " ".join(" ".join(parts).split()) == " ".join(expected.split()):
            matches += 1
    return matches
