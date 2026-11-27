"""One UTF-8 JSON request on stdin, one JSON response on stdout."""

import json
import sys

from desktop import DesktopActionError, apply_decision, capture


def dispatch(request):
    if request["op"] == "locate":
        from wechat_contacts import locate
        return locate(request["name"], request.get("choice"))
    if request["op"] == "capture":
        return capture(request.get("target"), request.get("field"), request.get("sendButton"))
    if request["op"] == "apply":
        return apply_decision(request["decision"], request.get("binding"))
    raise ValueError("未知的桌面请求。")


if __name__ == "__main__":
    try:
        request = json.loads(sys.stdin.buffer.read().decode("utf-8"))
        try:
            response = dispatch(request)
        except DesktopActionError as exc:
            blocked = request.get("decision", {}).get("intent") == "send_draft"
            response = {"status": "blocked" if blocked else "error", "message": str(exc)}
        sys.stdout.buffer.write(json.dumps(response, ensure_ascii=False).encode("utf-8") + b"\n")
    except Exception as exc:
        sys.stderr.buffer.write((str(exc) + "\n").encode("utf-8"))
        sys.exit(1)
