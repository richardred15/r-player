use std::sync::Mutex;
use std::time::Duration;

use souvlaki::{
    MediaControlEvent, MediaControls, MediaMetadata, MediaPlayback, MediaPosition, PlatformConfig,
};
use tauri::{AppHandle, Emitter, Manager};

/// Managed wrapper around the OS media controls (MPRIS on Linux, SMTC on
/// Windows, MediaRemote on macOS) provided by `souvlaki`.
pub struct MediaState {
    controls: Mutex<Option<MediaControls>>,
}

impl MediaState {
    pub fn new() -> Self {
        Self {
            controls: Mutex::new(None),
        }
    }
}

/// Map a souvlaki control event into the string label the frontend listens for.
fn event_label(event: &MediaControlEvent) -> Option<&'static str> {
    match event {
        MediaControlEvent::Play => Some("play"),
        MediaControlEvent::Pause => Some("pause"),
        MediaControlEvent::Toggle => Some("toggle"),
        MediaControlEvent::Next => Some("next"),
        MediaControlEvent::Previous => Some("prev"),
        MediaControlEvent::Stop => Some("stop"),
        _ => None,
    }
}

/// Initialise the OS media controls and forward button presses to the webview
/// as `media-control` events. Failures are non-fatal (the app still works).
pub fn init(app: &AppHandle) {
    let config = PlatformConfig {
        dbus_name: "r_player",
        display_name: "R-Player",
        hwnd: None,
    };

    let mut controls = match MediaControls::new(config) {
        Ok(c) => c,
        Err(e) => {
            eprintln!("media controls unavailable: {e:?}");
            return;
        }
    };

    let handle = app.clone();
    let attach = controls.attach(move |event: MediaControlEvent| {
        if let Some(label) = event_label(&event) {
            let _ = handle.emit("media-control", label);
        }
    });
    if let Err(e) = attach {
        eprintln!("failed to attach media controls: {e:?}");
        return;
    }

    let state = app.state::<MediaState>();
    *state.controls.lock().unwrap() = Some(controls);
}

#[tauri::command]
pub fn set_now_playing(
    app: AppHandle,
    title: String,
    artist: String,
    album: String,
    cover_path: Option<String>,
    duration_secs: f64,
) -> Result<(), String> {
    let state = app.state::<MediaState>();
    let mut guard = state.controls.lock().map_err(|e| e.to_string())?;
    let Some(controls) = guard.as_mut() else {
        return Ok(());
    };

    // MPRIS wants a URI for artwork.
    let cover_url = cover_path.map(|p| {
        if p.starts_with("file://") {
            p
        } else {
            format!("file://{p}")
        }
    });

    controls
        .set_metadata(MediaMetadata {
            title: Some(&title),
            album: Some(&album),
            artist: Some(&artist),
            cover_url: cover_url.as_deref(),
            duration: Some(Duration::from_secs_f64(duration_secs.max(0.0))),
        })
        .map_err(|e| format!("{e:?}"))
}

#[tauri::command]
pub fn set_playback_state(app: AppHandle, playing: bool, position_secs: f64) -> Result<(), String> {
    let state = app.state::<MediaState>();
    let mut guard = state.controls.lock().map_err(|e| e.to_string())?;
    let Some(controls) = guard.as_mut() else {
        return Ok(());
    };

    let progress = Some(MediaPosition(Duration::from_secs_f64(
        position_secs.max(0.0),
    )));
    let playback = if playing {
        MediaPlayback::Playing { progress }
    } else {
        MediaPlayback::Paused { progress }
    };

    controls
        .set_playback(playback)
        .map_err(|e| format!("{e:?}"))
}
