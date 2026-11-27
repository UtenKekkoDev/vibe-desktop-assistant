//! Hold-to-talk trigger key.
//!
//! The Windows global-hotkey API only reports key presses, so a hold gesture is
//! detected by polling the physical key state instead of hooking the keyboard.

use serde::Deserialize;
use std::{fs::File, io::BufReader, path::PathBuf};
use windows_sys::Win32::{
    Foundation::{CloseHandle, ERROR_ACCESS_DENIED, GetLastError},
    System::Threading::{MUTEX_MODIFY_STATE, OpenMutexW},
    UI::Input::KeyboardAndMouse::GetAsyncKeyState,
};

pub const DEFAULT: &str = "F9";

/// Trigger keys offered in settings. Right-hand modifiers are preferred because
/// they are rarely bound to editor or IME commands.
pub const OPTIONS: [&str; 5] = ["RightCtrl", "RightAlt", "RightShift", "F9", "F10"];

pub fn virtual_key(name: &str) -> i32 {
    match name {
        "RightAlt" => 0xA5,
        "RightShift" => 0xA1,
        "RightCtrl" => 0xA3,
        "F10" => 0x79,
        _ => 0x78, // F9 and unknown saved keys
    }
}

pub fn label(name: &str) -> &'static str {
    match name {
        "RightAlt" => "右 Alt",
        "RightShift" => "右 Shift",
        "RightCtrl" => "右 Ctrl",
        "F10" => "F10",
        _ => "F9",
    }
}

pub fn is_down(name: &str) -> bool {
    // GetAsyncKeyState reads the async key table; no message pump is required.
    unsafe { (GetAsyncKeyState(virtual_key(name)) as u16 & 0x8000) != 0 }
}

/// Read only the other application's shortcut. Unknown JSON fields are skipped
/// by serde; its credentials and transcripts never enter the assistant state.
#[derive(Deserialize)]
struct LegacyShortcut {
    hold_key: Option<String>,
}

fn legacy_shortcut(path: PathBuf) -> Result<i32, ()> {
    let file = match File::open(path) {
        Ok(file) => file,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(0xA3),
        Err(_) => return Err(()),
    };
    let config: LegacyShortcut = serde_json::from_reader(BufReader::new(file)).map_err(|_| ())?;
    // The original Voice Lite uses RightCtrl for unknown and absent settings.
    let name = config.hold_key.as_deref().unwrap_or("RightCtrl");
    Ok(if OPTIONS.contains(&name) {
        virtual_key(name)
    } else {
        0xA3
    })
}

pub fn conflict_notice(key: &str) -> Option<&'static str> {
    let mutex: Vec<u16> = "Local\\VibeVoiceLite.SingleInstance\0"
        .encode_utf16()
        .collect();
    let handle = unsafe { OpenMutexW(MUTEX_MODIFY_STATE, 0, mutex.as_ptr()) };
    if handle.is_null() {
        if unsafe { GetLastError() } == ERROR_ACCESS_DENIED {
            return Some(
                "Vibe Voice Lite 已占用会话，但无法核对其快捷键。请在相同用户权限下运行两个程序。",
            );
        }
        return None;
    }
    unsafe { CloseHandle(handle) };
    let dir = std::env::var_os("VIBE_CONFIG_DIR")
        .map(PathBuf::from)
        .or_else(|| {
            std::env::var_os("LOCALAPPDATA").map(|p| PathBuf::from(p).join("VibeVoiceLite"))
        })
        .unwrap_or_else(|| std::env::temp_dir().join("VibeVoiceLite"));
    match legacy_shortcut(dir.join("settings.json")) {
        Ok(original) if original == virtual_key(key) => {
            Some("该快捷键正由 Vibe Voice Lite 使用。请在桌面助手设置中另选按键。")
        }
        Err(()) => {
            Some("无法核对 Vibe Voice Lite 的快捷键。请检查原版设置，或关闭原版后使用桌面助手。")
        }
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn options_map_to_distinct_keys_and_fall_back_safely() {
        let mut seen = std::collections::HashSet::new();
        for name in OPTIONS {
            assert!(seen.insert(virtual_key(name)), "duplicate key for {name}");
            assert!(!label(name).is_empty());
        }
        assert_eq!(virtual_key("RightCtrl"), 0xA3);
        assert_eq!(virtual_key("something-else"), virtual_key(DEFAULT));
        assert_ne!(virtual_key(DEFAULT), virtual_key("RightCtrl"));
    }

    #[test]
    fn original_shortcut_projection_uses_legacy_defaults_and_requires_valid_json() {
        let path = std::env::temp_dir().join(format!("vda-shortcut-{}.json", std::process::id()));
        assert_eq!(legacy_shortcut(path.clone()), Ok(0xA3));
        for (doc, expected) in [
            (r#"{"hold_key":"F9","extra":{"deep":[1,2]}}"#, Ok(0x78)),
            (r#"{"hold_key":"RightShift"}"#, Ok(0xA1)),
            (r#"{"hold_key":"unknown"}"#, Ok(0xA3)),
            ("{}", Ok(0xA3)),
            ("invalid", Err(())),
        ] {
            std::fs::write(&path, doc).unwrap();
            assert_eq!(legacy_shortcut(path.clone()), expected);
        }
        std::fs::remove_file(path).unwrap();
    }
}
