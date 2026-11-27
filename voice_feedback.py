"""Speak one UTF-8 message with the local Windows voice. No markup is executed."""

import sys

from win32com.client import Dispatch


def main():
    text = sys.stdin.buffer.read().decode("utf-8")
    if text:
        speaker = Dispatch("SAPI.SpVoice")
        voices = speaker.GetVoices("Language=804", "")
        if voices.Count:
            speaker.Voice = voices.Item(0)
        speaker.Speak(text, 16)  # SVSFIsNotXML


if __name__ == "__main__":
    main()
