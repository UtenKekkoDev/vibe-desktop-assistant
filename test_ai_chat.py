import unittest
from unittest.mock import Mock, patch

import desktop as d


class ComposerText(unittest.TestCase):
    def test_generated_codex_hint_is_empty_but_identical_typed_text_is_a_draft(self):
        hint = "和 Codex 一起工作"
        text = Mock(ControlTypeName="TextControl", Name=hint)
        decoration = Mock(ControlTypeName="GroupControl")
        decoration.GetChildren.return_value = [text]
        paragraph = Mock(ClassName="placeholder before:composer-placeholder")
        paragraph.GetChildren.return_value = [decoration, Mock(ClassName="ProseMirror-trailingBreak")]
        control = Mock()
        control.GetChildren.return_value = [paragraph]
        pattern = Mock(Value=hint + "\n")
        editor = d.Editor(1, "", 1, control, pattern, "", "Codex")
        self.assertEqual(editor.read(), "")
        pattern.Value = hint + "，继续"
        self.assertEqual(editor.read(), pattern.Value)
        paragraph.ClassName = ""
        paragraph.GetChildren.return_value = [text]
        pattern.Value = hint
        self.assertEqual(editor.read(), hint)


class ChatSubmit(unittest.TestCase):
    def simulate(self, after_key, counts):
        doc = Mock()
        doc.GetRuntimeId.return_value = [12]
        editor = Mock(chat_app="Codex", document=doc, hwnd=1)
        button = Mock()
        button.Name = "发送"
        current = ["Codex", [12], [20], "chat"]
        with (patch.object(d.uia, "ControlFromHandle"), patch.object(d, "is_weixin_main", return_value=False),
              patch.object(d, "controls", return_value=[button]),
              patch.object(d.ai_chat, "owning_document", return_value=doc),
              patch.object(d.ai_chat, "matching_messages", side_effect=counts),
              patch.object(d.ai_chat, "conversation", side_effect=[current, after_key]),
              patch.object(d, "validate_binding") as validate,
              patch.object(d.win32gui, "GetForegroundWindow", return_value=1)):
            result = d.submit(editor, {}, "检查这段代码")
        validate.assert_called_once_with(editor, {}, "检查这段代码", require_conversation=True)
        button.GetInvokePattern.return_value.pattern.Invoke.assert_called_once()
        return result

    def test_new_matching_user_turn_required(self):
        self.assertEqual(self.simulate(["Codex", [12], [20], "chat"], [1, 2]),
                         {"status": "confirmed", "level": "success", "message": "已发送。"})

    def test_switch_after_click_is_not_a_receipt(self):
        self.assertEqual(self.simulate(["Codex", [12], [21], "chat"], [1]),
                         {"status": "unknown", "level": "warning", "message": "已触发发送，对话里还没看到新消息，请确认。"})

    def test_wechat_enter_receipts(self):
        for remaining, key_error, level, message in [
            ("", None, "success", "已发送。"),
            ("正文\n", None, "error", "没发出去，文字还在输入框里，请检查微信发送快捷键。"),
            (None, None, "warning", "已按回车，无法确认是否发出，请查看聊天记录。"),
            ("正文", OSError(), "error", "发送过程出错，结果未知，请先查看对话。"),
        ]:
            with self.subTest(message=message):
                editor = Mock(hwnd=1)
                editor.pattern.Value = remaining
                with (patch.object(d.win32gui, "GetForegroundWindow", return_value=1),
                      patch.object(d, "validate_binding"),
                      patch.object(d.uia, "SendKeys", side_effect=key_error) as enter,
                      patch.object(d.time, "monotonic", side_effect=[0, 3])):
                    receipt = d.submit_with_enter(editor, {}, "正文")
                enter.assert_called_once()
                self.assertEqual((receipt["level"], receipt["message"]), (level, message))
