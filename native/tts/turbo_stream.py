"""Local V5 Turbo synthesis using the Vulkan server and its text frontend."""
import contextlib
import http.client
import json
import os
from pathlib import Path
import socket
import struct
import subprocess
import time

import numpy as np


def free_port():
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return sock.getsockname()[1]


class TurboStream:
    sample_rate = 48000

    def __init__(self, config, base):
        self.runtime = (base / config["turbo_runtime"]).resolve()
        self.base = base
        self.reference_dir = (base / config["reference_audio"]).resolve().parent
        self.voices = {p["id"]: p for p in config.get("voices", [])}
        self.default_voice = next(iter(self.voices.values()), config)
        self.children = []

    def start_service(self, command, env, port):
        child = subprocess.Popen(command, cwd=self.runtime, env=env,
                                 creationflags=subprocess.CREATE_NO_WINDOW,
                                 stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                                 stderr=subprocess.DEVNULL)
        self.children.append(child)
        deadline = time.monotonic() + 40
        while time.monotonic() < deadline:
            if child.poll() is not None:
                raise RuntimeError(f"{Path(command[0]).name} exited ({child.returncode})")
            try:
                with contextlib.closing(http.client.HTTPConnection("127.0.0.1", port, timeout=1)) as conn:
                    conn.request("GET", "/health")
                    response = conn.getresponse()
                    if response.status == 200:
                        health = json.load(response)
                        if health.get("ready") or health.get("ok"):
                            return
            except (OSError, ValueError, http.client.HTTPException):
                pass
            time.sleep(.15)
        raise TimeoutError("V5 Turbo startup")

    def warmup(self):
        frontend = self.runtime / "models/frontend"
        env = dict(os.environ, PYTHONUTF8="1", GSV_G2PW_MODEL=str(frontend/"g2pw"),
                   GSV_BERT_DIR=str(frontend/"bert_tokenizer"), NLTK_DATA=str(frontend/"nltk_data"),
                   GSV_FAST_LANGDETECT=str(frontend/"fast_langdetect"))
        side = free_port()
        try:
            self.start_service([self.runtime/"python/python.exe", self.runtime/"frontend/text_sidecar.py",
                                "--host", "127.0.0.1", "--port", str(side)], env, side)
            self.port = free_port()
            self.start_service([self.runtime/"gsv/gsv_server.exe", "--models", self.runtime/"models",
                                "--device", "vulkan", "--host", "127.0.0.1", "--port", str(self.port),
                                "--sidecar", f"127.0.0.1:{side}", "--allow-path", self.reference_dir],
                               env, self.port)
        except Exception:
            self.close()
            raise

    def close(self):
        for child in reversed(self.children):
            if child.poll() is None:
                child.kill()
            child.wait()
        self.children.clear()

    def stream(self, text, voice=""):
        profile = self.voices[voice] if voice else self.default_voice
        reference = (self.base / profile["reference_audio"]).resolve(strict=True)
        if not reference.is_relative_to(self.reference_dir):
            raise ValueError("Voice reference is outside the configured reference folder")
        prompt_lang = {"zh": "all_zh", "ja": "all_ja"}[profile.get("reference_language", "zh")]
        lang = "auto" if any(c.isascii() and c.isalpha() for c in text) else "zh"
        body = dict(text=text, text_lang=lang, prompt_lang=prompt_lang, prompt_text=profile["reference_text"],
                    ref_audio_path=str(reference), sample_steps=4, stream=True, seed=42, media_type="wav")
        with contextlib.closing(http.client.HTTPConnection("127.0.0.1", self.port, timeout=75)) as conn:
            conn.request("POST", "/tts", json.dumps(body).encode(), {"Content-Type": "application/json"})
            response = conn.getresponse()
            if response.status != 200:
                raise RuntimeError(f"V5 Turbo HTTP {response.status}")
            header = response.read(44)
            if (len(header) != 44 or header[:4] != b"RIFF" or header[36:40] != b"data"
                    or struct.unpack_from("<HHI", header, 20) != (1, 1, self.sample_rate)
                    or struct.unpack_from("<H", header, 34)[0] != 16):
                raise ValueError("Unexpected V5 Turbo WAV format")
            tail = b""
            samples = 0
            while chunk := response.read1(16384):
                data = tail + chunk
                end = len(data) - len(data) % 2
                tail = data[end:]
                if end:
                    pcm = np.frombuffer(data[:end], dtype="<i2").astype(np.float32) / 32768
                    samples += pcm.size
                    yield pcm, self.sample_rate, None
            if tail or not samples:
                raise ValueError("Incomplete V5 Turbo audio")
