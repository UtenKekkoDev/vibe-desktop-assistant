//! Standby accepts a whole wake phrase locally. Only the subsequent recording
//! enters the application's ordinary input pipeline.
use anyhow::{Result, anyhow, bail};
use cpal::traits::{DeviceTrait, StreamTrait};
use std::path::PathBuf;
use std::sync::mpsc::{self, Receiver, SyncSender, TryRecvError};
use std::time::{Duration, Instant};

const RMS: f32 = 0.009;
const FRAME_MS: usize = 20;

// Keep microphone samples from the start. Gate only the silence detector while
// the speaker plays the cue so the cue alone cannot submit an empty command.
pub struct WakeCue {
    finished: Receiver<Instant>,
    guard_until: Instant,
}

impl WakeCue {
    pub fn play() -> Self {
        use windows_sys::Win32::Media::Audio::{PlaySoundA, SND_MEMORY, SND_NODEFAULT, SND_SYNC};
        let (done, finished) = mpsc::channel();
        std::thread::spawn(move || {
            let wave = include_bytes!("../assets/wake-cue.wav");
            // The embedded WAV is valid for the entire synchronous WinMM call.
            let played = unsafe { PlaySoundA(wave.as_ptr(), std::ptr::null_mut(), SND_MEMORY | SND_NODEFAULT | SND_SYNC) } != 0;
            let tail = if played { Duration::from_millis(80) } else { Duration::ZERO };
            let _ = done.send(Instant::now() + tail);
        });
        Self { finished, guard_until: Instant::now() + Duration::from_secs(1) }
    }

    pub fn guarding(&mut self, now: Instant) -> bool {
        if let Ok(end) = self.finished.try_recv() {
            self.guard_until = self.guard_until.min(end);
        }
        now < self.guard_until
    }
}

struct Segmenter {
    frame: Vec<f32>,
    frame_size: usize,
    buffer: Vec<f32>,
    previous: Vec<f32>,
    quiet: usize,
    discard: bool,
}

impl Segmenter {
    fn new(rate: u32) -> Self {
        Self {
            frame: Vec::new(),
            frame_size: (rate as usize * FRAME_MS / 1000).max(1),
            buffer: Vec::new(),
            previous: Vec::new(),
            quiet: 0,
            discard: false,
        }
    }

    fn push(&mut self, sample: f32, tx: &SyncSender<(Instant, Vec<f32>)>) {
        self.frame.push(sample);
        if self.frame.len() < self.frame_size {
            return;
        }
        let voiced =
            self.frame.iter().map(|x| x * x).sum::<f32>() >= RMS * RMS * self.frame_size as f32;
        self.quiet = if voiced {
            0
        } else {
            self.quiet.saturating_add(1)
        };
        if self.discard {
            if self.quiet >= 20 {
                self.discard = false;
            }
        } else if !self.buffer.is_empty() || voiced {
            if self.buffer.is_empty() {
                self.buffer.append(&mut self.previous);
            }
            self.buffer.extend_from_slice(&self.frame);
            if self.quiet == 20 {
                if self.buffer.len() >= self.frame_size * 29 {
                    let _ = tx.try_send((Instant::now(), std::mem::take(&mut self.buffer)));
                }
                self.buffer.clear();
            } else if self.buffer.len() >= self.frame_size * 200 {
                self.buffer.clear();
                self.discard = true;
            }
        } else {
            self.previous.clone_from(&self.frame);
        }
        self.frame.clear();
    }
}

pub fn valid_phrase(s: &str) -> bool {
    (2..=12).contains(&s.chars().count()) && s.chars().all(char::is_alphanumeric)
}

fn matches_phrase(text: &str, phrase: &str) -> bool {
    let clean = |s: &str| {
        s.chars()
            .filter(|c| c.is_alphanumeric())
            .collect::<String>()
            .to_lowercase()
    };
    let phrase = clean(phrase);
    !phrase.is_empty() && clean(text) == phrase
}

pub struct Listener {
    _stream: cpal::Stream,
    events: Receiver<Result<Instant>>,
}

impl Listener {
    pub fn open(model: PathBuf, phrase: String) -> Result<Self> {
        let (device, config) = crate::audio::default_input()?;
        let rate = config.sample_rate().0;
        let channels = config.channels() as usize;
        let (samples, clips) = mpsc::sync_channel(1);
        let (events, rx) = mpsc::channel();
        let error_tx = events.clone();
        let mut gate = Segmenter::new(rate);
        macro_rules! stream {
            ($ty:ty, $convert:expr) => {
                device.build_input_stream(
                    &config.clone().into(),
                    move |data: &[$ty], _| {
                        for frame in data.chunks_exact(channels) {
                            gate.push(
                                frame.iter().copied().map($convert).sum::<f32>() / channels as f32,
                                &samples,
                            );
                        }
                    },
                    move |err| {
                        let _ = error_tx.send(Err(anyhow!("待机麦克风不可用：{err}")));
                    },
                    None,
                )?
            };
        }
        let stream = match config.sample_format() {
            cpal::SampleFormat::F32 => stream!(f32, |s| s),
            cpal::SampleFormat::I16 => stream!(i16, |s| s as f32 / 32768.0),
            cpal::SampleFormat::U16 => stream!(u16, |s| (s as f32 - 32768.0) / 32768.0),
            f => bail!("待机麦克风不支持 {f:?} 格式"),
        };
        stream.play()?;
        std::thread::spawn(move || {
            while let Ok((end, audio)) = clips.recv() {
                if end.elapsed() > Duration::from_secs(2) {
                    continue;
                }
                let audio = crate::audio::resample_to_target(audio, rate, 1);
                let task = crate::task::TaskControl::new(Duration::from_secs(8));
                match crate::sensevoice::transcribe_audio(&model, audio, &task) {
                    Ok(t) if matches_phrase(&t.text, &phrase) => {
                        if events.send(Ok(end)).is_err() {
                            break;
                        }
                    }
                    Ok(_) => {}
                    Err(err) => {
                        let _ = events.send(Err(err));
                        break;
                    }
                }
            }
        });
        Ok(Self {
            _stream: stream,
            events: rx,
        })
    }

    pub fn heard(&self) -> Result<bool> {
        match self.events.try_recv() {
            Ok(event) => Ok(event?.elapsed() < Duration::from_secs(3)),
            Err(TryRecvError::Empty) => Ok(false),
            Err(TryRecvError::Disconnected) => bail!("待机识别已退出"),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn cue_guard_ends_after_playback_and_is_bounded_if_output_stalls() {
        let start = Instant::now();
        let limit = start + Duration::from_secs(1);
        let (done, finished) = mpsc::channel();
        let mut cue = WakeCue { finished, guard_until: limit };
        assert!(cue.guarding(start));
        assert!(!cue.guarding(limit));
        let end = start + Duration::from_millis(238);
        done.send(end).unwrap();
        assert!(cue.guarding(end - Duration::from_millis(1)));
        assert!(!cue.guarding(end));
    }
    #[test]
    fn only_a_standalone_phrase_wakes() {
        assert!(matches_phrase("小助手。", "小助手"));
        assert!(!matches_phrase("他说小助手。", "小助手"));
        assert!(!matches_phrase("小助手打开微信。", "小助手"));
        assert!(!matches_phrase("。", "。"));
    }

    #[test]
    fn silence_and_long_speech_do_not_queue_commands() {
        let (tx, rx) = mpsc::sync_channel(1);
        let mut gate = Segmenter::new(1000);
        for sample in std::iter::repeat_n(0.0, 1000)
            .chain(std::iter::repeat_n(0.1, 5000))
            .chain(std::iter::repeat_n(0.0, 600))
        {
            gate.push(sample, &tx);
        }
        assert!(rx.try_recv().is_err());
        for sample in std::iter::repeat_n(0.1, 360).chain(std::iter::repeat_n(0.0, 500)) {
            gate.push(sample, &tx);
        }
        assert!(rx.try_recv().is_ok());
    }

    #[test]
    #[ignore = "requires local SenseVoice model and a mono replay containing one standalone wake word"]
    fn offline_wake_replay() {
        let model = PathBuf::from(std::env::var_os("VIBE_WAKE_TEST_MODEL").unwrap());
        let mut wav =
            hound::WavReader::open(std::env::var_os("VIBE_WAKE_TEST_WAV").unwrap()).unwrap();
        let rate = wav.spec().sample_rate;
        assert_eq!(wav.spec().channels, 1);
        let mut gate = Segmenter::new(rate);
        let (tx, rx) = mpsc::sync_channel(32);
        for sample in wav.samples::<i16>() {
            gate.push(sample.unwrap() as f32 / 32768.0, &tx);
        }
        drop(tx);
        let mut hits = 0;
        for (_, clip) in rx {
            let task = crate::task::TaskControl::new(Duration::from_secs(20));
            let transcript = crate::sensevoice::transcribe_audio(
                &model,
                crate::audio::resample_to_target(clip, rate, 1),
                &task,
            )
            .unwrap();
            println!("replay: {}", transcript.text);
            hits += usize::from(matches_phrase(&transcript.text, "小助手"));
        }
        assert_eq!(hits, 1);
    }
}
