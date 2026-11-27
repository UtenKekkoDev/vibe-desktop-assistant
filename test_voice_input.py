import tempfile
from pathlib import Path
import sys
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch
import wave

import numpy as np

from voice_input import FRAME, RATE, Pipeline, Resampler, Segmenter, check_microphone, pcm_mono, replay

LOUD = np.full(FRAME, 0.1, dtype=np.float32)
QUIET = np.zeros(FRAME, dtype=np.float32)


class AudioTests(unittest.TestCase):
    def setUp(self):
        self.events = []
        self.recognize = Mock(return_value="示例")
        self.segmenter = Segmenter(self.recognize, self.events.append, silence_ms=200, max_seconds=1)
        self.pipe = Pipeline(RATE, self.segmenter)

    def feed(self, frame, count, hwnd=17):
        for _ in range(count):
            self.pipe.push(frame, hwnd)

    def texts(self):
        return [event for event in self.events if event["type"] == "text"]

    def test_silence_and_single_click_are_not_speech(self):
        self.feed(QUIET, 100)
        self.feed(LOUD, 1)
        self.feed(QUIET, 30)
        self.assertEqual(self.events, [])
        self.recognize.assert_not_called()

    def test_short_pause_kept_and_start_context_captured(self):
        self.feed(LOUD, 1, 5)
        self.feed(LOUD, 9, 6)
        self.feed(QUIET, 4)
        self.feed(LOUD, 9)
        self.feed(QUIET, 10)
        self.feed(LOUD, 10)
        self.pipe.push(np.empty(0, np.float32), 17, final=True)
        self.assertEqual([e["type"] for e in self.events], ["start", "text", "start", "text"])
        self.assertEqual(self.events[0]["foregroundHwnd"], 5)
        self.assertEqual(self.events[0]["id"], self.events[1]["id"])
        self.assertNotEqual(self.events[0]["id"], self.events[2]["id"])

    def test_overflow_discards_prefix_and_suffix_until_a_full_pause(self):
        self.feed(LOUD, 11)
        self.pipe.gap()
        self.feed(QUIET, 4)
        self.feed(LOUD, 15)
        self.feed(QUIET, 10)
        self.assertEqual(self.texts(), [])
        self.assertEqual(self.events[1]["type"], "error")
        self.assertEqual(self.events[0]["id"], self.events[1]["id"])
        self.feed(LOUD, 10)
        self.feed(QUIET, 10)
        self.assertEqual([e["text"] for e in self.texts()], ["示例"])

    def test_long_turn_is_never_split_into_commands(self):
        self.feed(LOUD, 160)
        self.feed(QUIET, 15)
        self.assertEqual([e["type"] for e in self.events], ["start", "error"])
        self.recognize.assert_not_called()
        self.feed(LOUD, 12)
        self.feed(QUIET, 10)
        self.assertEqual(self.recognize.call_count, 1)

    def test_stereo_wave_endpoints_and_eof_without_trailing_silence(self):
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / "fixture.wav"
            rate = 44100
            first = np.full(rate // 4, 5000, "<i2")
            samples = np.concatenate((first, np.zeros(rate // 2, "<i2"), first))
            with wave.open(str(path), "wb") as out:
                out.setparams((2, 2, rate, 0, "NONE", "not compressed"))
                out.writeframes(np.column_stack((samples, samples)).astype("<i2").tobytes())
            replay(path, self.segmenter, self.events.append)
            self.assertEqual([e["type"] for e in self.events], ["ready", "start", "text", "start", "text"])
            self.assertEqual(self.recognize.call_count, 2)

    def test_resampling_independent_of_source_packet_sizes(self):
        for rate in (8000, 22050, 44100, 48000):
            with self.subTest(rate=rate):
                src = np.linspace(-0.5, 0.5, rate, dtype=np.float32)
                expected = Resampler(rate).push(src, final=True)
                resampler = Resampler(rate)
                packets = [resampler.push(block) for block in np.array_split(src, 73)]
                packets.append(resampler.push(np.empty(0, np.float32), final=True))
                merged = np.concatenate(packets)
                self.assertEqual(len(merged), RATE)
                np.testing.assert_allclose(merged, expected, atol=1e-6)

    def test_pcm_normalization(self):
        expectations = (
            (1, bytes((0, 128)), [-1.0, 0.0]),
            (2, bytes.fromhex("0080 0000"), [-1.0, 0.0]),
            (3, bytes.fromhex("000080 000000"), [-1.0, 0.0]),
            (4, bytes.fromhex("00000080 00000000"), [-1.0, 0.0]),
        )
        for width, raw, expected in expectations:
            with self.subTest(width=width):
                np.testing.assert_allclose(pcm_mono(raw, width, 1), expected)

    def test_truncated_active_wave_does_not_emit_its_tail(self):
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / "truncated.wav"
            with wave.open(str(path), "wb") as out:
                out.setparams((1, 2, RATE, 0, "NONE", "not compressed"))
                out.writeframes(np.full(RATE // 4, 4000, "<i2").tobytes())
            path.write_bytes(path.read_bytes()[:-512])
            with self.assertRaisesRegex(ValueError, "不完整"):
                replay(path, self.segmenter, self.events.append)
            self.assertEqual(self.texts(), [])

    def test_mic_check_counts_without_accessing_audio_or_loading_model(self):
        class Stop(Exception):
            pass

        class InputStream:
            def __init__(self, *, callback, **settings):
                self.callback = callback
                self.frames = settings["blocksize"]

            def __enter__(self):
                for _ in range(100):
                    try:
                        self.callback(None, self.frames, None, False)
                    except Stop:
                        return self
                raise AssertionError("short check never stopped")

            def __exit__(self, *args):
                pass

        sd = SimpleNamespace(
            query_devices=lambda device, kind: {"name": "test", "default_samplerate": RATE},
            check_input_settings=lambda **settings: None, InputStream=InputStream, CallbackStop=Stop)
        with patch.dict(sys.modules, {"sounddevice": sd}), patch("voice_input.emit") as events:
            check_microphone(42)
        events.assert_called_once_with({"type": "mic-check", "frames": RATE // 2,
                                        "sampleRate": RATE, "device": "test"})


if __name__ == "__main__":
    unittest.main()
