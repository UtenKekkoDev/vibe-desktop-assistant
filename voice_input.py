"""Local SenseVoice speech input. Emits UTF-8 JSON lines; audio stays in memory."""

import argparse
from collections import deque
import json
import os
from pathlib import Path
import queue
import re
import sys
import threading
import uuid
import wave

import numpy as np

RATE = 16000
FRAME_MS = 20
FRAME = RATE * FRAME_MS // 1000

if sys.platform == "win32":
    import ctypes
    from ctypes.wintypes import HWND

    get_foreground = ctypes.windll.user32.GetForegroundWindow
    get_foreground.restype = HWND


def foreground():
    return (get_foreground() or None) if sys.platform == "win32" else None


def emit(event):
    sys.stdout.buffer.write(json.dumps(event, ensure_ascii=False).encode("utf-8") + b"\n")
    sys.stdout.buffer.flush()


class Resampler:
    """Interpolate between adjacent samples, preserving fractional phase across blocks."""

    def __init__(self, source_rate):
        self.rate = source_rate
        self.input_count = 0
        self.next_tick = 0
        self.last = None

    def push(self, samples, final=False):
        if self.rate == RATE:
            return samples
        previous = self.last
        start = self.input_count
        self.input_count += len(samples)
        if len(samples):
            self.last = samples[-1]
        if self.last is None:
            return np.empty(0, np.float32)
        values = np.concatenate(([previous], samples)) if previous is not None else samples
        offset = start - (1 if previous is not None else 0)
        if final:
            values = np.append(values, self.last)
        end_tick = (offset + len(values) - 1) * RATE
        ticks = np.arange(self.next_tick, end_tick, self.rate, dtype=np.int64)
        self.next_tick += len(ticks) * self.rate
        relative = ticks - offset * RATE
        left = relative // RATE
        weight = (relative % RATE) / RATE
        return (values[left] + weight * (values[left + 1] - values[left])).astype(np.float32)


class Segmenter:
    """Twenty millisecond energy gate with pre-roll, endpointing and gap recovery."""

    def __init__(self, recognize, publish=emit, threshold=0.009, silence_ms=900, max_seconds=25):
        self.recognize = recognize
        self.publish = publish
        self.threshold = threshold
        self.end_frames = max(1, int(np.ceil(silence_ms / FRAME_MS)))
        self.max_frames = max(1, int(max_seconds * 1000 / FRAME_MS))
        self.history = deque(maxlen=10)
        self.reset()
        self.discarding = False

    def reset(self):
        self.history.clear()
        self.frames = []
        self.turn = None
        self.loud = 0
        self.quiet = 0
        self.voiced = 0
        self.onset_window = None

    def discard(self, reason):
        if not self.discarding:
            event = {"type": "error", "recoverable": True, "message": reason}
            if self.turn is not None:
                event["id"] = self.turn
            self.publish(event)
        self.reset()
        # Wait for a complete silence interval before accepting any new speech.
        self.discarding = True

    def frame(self, data, hwnd):
        energy = float(np.sqrt(np.mean(np.square(data))))
        if not np.isfinite(energy):
            self.discard("输入音频含有无效样本，已丢弃当前片段。")
            return
        if self.discarding:
            self.quiet = self.quiet + 1 if energy < self.threshold * 0.7 else 0
            if self.quiet >= self.end_frames:
                self.discarding = False
                self.reset()
            return
        if self.turn is None:
            self.history.append(data.copy())
            if energy < self.threshold:
                self.loud = 0
                return
            if self.loud == 0:
                self.onset_window = hwnd
            self.loud += 1
            if self.loud < 3:
                return
            self.frames = list(self.history)
            self.voiced = self.loud
            self.turn = uuid.uuid4().hex
            event = {"type": "start", "id": self.turn}
            if self.onset_window is not None:
                event["foregroundHwnd"] = self.onset_window
            self.publish(event)
            return
        self.frames.append(data.copy())
        if energy >= self.threshold * 0.7:
            self.voiced += 1
            self.quiet = 0
        else:
            self.quiet += 1
        if self.quiet >= self.end_frames:
            self.finish()
        elif len(self.frames) >= self.max_frames:
            self.discard("语音超过单句时长，已丢弃整句。请停顿后重新说。")

    def finish(self):
        if self.turn is None:
            return
        text = ""
        if self.voiced >= 8:
            trailing = max(0, self.quiet - 8)
            samples = np.concatenate(self.frames[:-trailing] if trailing else self.frames)
            text = self.recognize(samples)
        self.publish({"type": "text", "id": self.turn, "text": text})
        self.reset()


class Pipeline:
    def __init__(self, rate, segmenter):
        self.rate = rate
        self.segmenter = segmenter
        self.resampler = Resampler(rate)
        self.pending = np.empty(0, np.float32)
        self.pending_hwnd = None

    def push(self, samples, hwnd, final=False):
        data = self.resampler.push(samples, final=final)
        prior = len(self.pending)
        if prior:
            data = np.concatenate((self.pending, data))
        complete = len(data) // FRAME * FRAME
        for i in range(0, complete, FRAME):
            self.segmenter.frame(data[i:i + FRAME], self.pending_hwnd if i < prior else hwnd)
        if complete or not prior:
            self.pending_hwnd = hwnd
        self.pending = data[complete:].copy()
        if final:
            if len(self.pending):
                self.segmenter.frame(np.pad(self.pending, (0, FRAME - len(self.pending))), self.pending_hwnd)
            self.segmenter.finish()

    def gap(self):
        self.resampler = Resampler(self.rate)
        self.pending = np.empty(0, np.float32)
        self.pending_hwnd = None
        self.segmenter.discard("输入音频有缺口，已丢弃当前片段。请停顿后重新说。")


def pcm_mono(raw, width, channels):
    if width == 1:
        values = (np.frombuffer(raw, np.uint8).astype(np.float32) - 128) / 128
    elif width in (2, 4):
        values = np.frombuffer(raw, "<i" + str(width)).astype(np.float32) / (1 << (8 * width - 1))
    elif width == 3:
        bytes3 = np.frombuffer(raw, np.uint8).reshape(-1, 3).astype(np.int32)
        packed = bytes3[:, 0] + (bytes3[:, 1] << 8) + (bytes3[:, 2] << 16)
        values = ((packed ^ 0x800000) - 0x800000).astype(np.float32) / 8388608
    else:
        raise ValueError("WAV 需使用 8、16、24 或 32 位整数 PCM。")
    return values.reshape(-1, channels).mean(axis=1, dtype=np.float32)


def replay(path, segmenter, publish=emit):
    with wave.open(str(path), "rb") as source:
        rate, channels, width = source.getframerate(), source.getnchannels(), source.getsampwidth()
        if source.getcomptype() != "NONE" or rate <= 0:
            raise ValueError("回放需要未压缩 PCM WAV。")
        pipeline = Pipeline(rate, segmenter)
        publish({"type": "ready", "source": "wav", "sampleRate": RATE})
        remaining = source.getnframes()
        while remaining:
            frames = min(remaining, max(1, rate // 50))
            raw = source.readframes(frames)
            if len(raw) != frames * channels * width:
                raise ValueError("WAV 文件不完整，已停止回放。")
            pipeline.push(pcm_mono(raw, width, channels), foreground())
            remaining -= frames
        pipeline.push(np.empty(0, np.float32), foreground(), final=True)


def list_devices(sd):
    try:
        default = sd.query_devices(kind="input")["index"]
    except sd.PortAudioError:
        default = -1
    return [{"index": i, "name": d["name"], "inputChannels": d["max_input_channels"],
             "sampleRate": d["default_samplerate"], "default": i == default}
            for i, d in enumerate(sd.query_devices()) if d["max_input_channels"]]


def microphone_settings(sd, device):
    info = sd.query_devices(device, kind="input")
    rate = RATE
    try:
        sd.check_input_settings(device=device, channels=1, samplerate=rate, dtype="float32")
    except sd.PortAudioError:
        rate = int(round(info["default_samplerate"]))
    return info, rate


def check_microphone(device):
    import sounddevice as sd

    info, rate = microphone_settings(sd, device)
    count = 0
    dropped = False
    done = threading.Event()

    def count_frames(_data, frames, _timing, status):
        nonlocal count, dropped
        count += frames
        dropped = dropped or bool(status)
        if count >= rate // 2:
            done.set()
            raise sd.CallbackStop

    with sd.InputStream(device=device, samplerate=rate, channels=1, dtype="float32",
                        blocksize=max(1, rate // 50), callback=count_frames):
        if not done.wait(timeout=3):
            raise ValueError("麦克风输入超时，未接收到足够的帧。")
    if dropped:
        raise ValueError("短时检查期间输入不连续，请重新选择麦克风。")
    emit({"type": "mic-check", "device": info["name"], "frames": count, "sampleRate": rate})


def listen(device, segmenter):
    import sounddevice as sd

    info, rate = microphone_settings(sd, device)
    audio = queue.Queue(maxsize=200)
    sequence = 0

    def receive(indata, _frames, _timing, status):
        nonlocal sequence
        sequence += 1
        try:
            audio.put_nowait((sequence, bool(status), indata[:, 0].copy(), foreground()))
        except queue.Full:
            # The next enqueued block's sequence will reveal the loss.
            pass

    pipeline = Pipeline(rate, segmenter)
    with sd.InputStream(device=device, samplerate=rate, channels=1, dtype="float32",
                        blocksize=max(1, rate // 50), callback=receive) as stream:
        emit({"type": "ready", "source": "microphone", "device": info["name"], "sampleRate": RATE})
        last = 0
        while True:
            try:
                seq, gap, samples, hwnd = audio.get(timeout=0.5)
            except queue.Empty:
                if not stream.active:
                    raise ValueError("麦克风输入已断开。")
                continue
            if gap or seq != last + 1:
                pipeline.gap()
            last = seq
            pipeline.push(samples, hwnd)


def make_recognizer(directory):
    import sherpa_onnx

    options = [directory / name for name in ("model.int8.onnx", "model.onnx")]
    model = next((path for path in options if path.is_file()), None)
    tokens = directory / "tokens.txt"
    if model is None or not tokens.is_file():
        raise ValueError("SenseVoice 模型目录缺少模型或 tokens.txt。")
    engine = sherpa_onnx.OfflineRecognizer.from_sense_voice(
        model=str(model), tokens=str(tokens), num_threads=min(os.cpu_count() or 1, 4),
        sample_rate=RATE, language="zh", use_itn=True, provider="cpu",
    )

    def recognize(samples):
        stream = engine.create_stream()
        stream.accept_waveform(RATE, samples)
        engine.decode_stream(stream)
        return re.sub(r"<\|[^|]*\|>", "", stream.result.text).strip()

    return recognize


def main():
    parser = argparse.ArgumentParser(description="本地 SenseVoice 输入引擎")
    parser.add_argument("--model", type=Path, help="SenseVoice 模型目录")
    parser.add_argument("--wav", type=Path, help="用连续 PCM WAV 回放替代麦克风")
    parser.add_argument("--device", type=int, help="输入设备索引")
    parser.add_argument("--list-devices", action="store_true")
    parser.add_argument("--check-mic", action="store_true", help="仅读取约半秒的帧数，不识别或保存")
    parser.add_argument("--threshold", type=float, default=0.009, help="归一化 RMS 起音门限")
    parser.add_argument("--silence-ms", type=int, default=900)
    parser.add_argument("--max-seconds", type=float, default=25)
    args = parser.parse_args()
    if args.list_devices:
        import sounddevice as sd
        emit({"type": "devices", "devices": list_devices(sd)})
        return
    if args.check_mic:
        check_microphone(args.device)
        return
    if not args.model:
        parser.error("请提供 --model DIR。")
    if not (0 < args.threshold < 1 and 100 <= args.silence_ms <= 5000
            and args.silence_ms / 1000 < args.max_seconds <= 120):
        parser.error("音量、静音或时长参数超出可用范围。")
    segmenter = Segmenter(make_recognizer(args.model), threshold=args.threshold,
                          silence_ms=args.silence_ms, max_seconds=args.max_seconds)
    if args.wav:
        replay(args.wav, segmenter)
    else:
        listen(args.device, segmenter)


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        pass
    except Exception as exc:
        emit({"type": "error", "recoverable": False, "message": str(exc)})
        sys.exit(1)
