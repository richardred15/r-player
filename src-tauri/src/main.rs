// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    // WebKitGTK's DMABUF/accelerated-compositing path crashes on some Linux
    // compositors (Wayland "Protocol error" + WebKit loader errors), which
    // closes the window on launch. Disable it before the webview initialises.
    // Respect any value the user has already set.
    #[cfg(target_os = "linux")]
    {
        if std::env::var_os("WEBKIT_DISABLE_DMABUF_RENDERER").is_none() {
            std::env::set_var("WEBKIT_DISABLE_DMABUF_RENDERER", "1");
        }
        if std::env::var_os("WEBKIT_DISABLE_COMPOSITING_MODE").is_none() {
            std::env::set_var("WEBKIT_DISABLE_COMPOSITING_MODE", "1");
        }
        // WebKitGTK plays audio via GStreamer's pulsesink. With PipeWire's small
        // default quantum this underruns and produces glitchy/crackly playback even
        // though the media element itself is healthy. Request a larger sink buffer
        // (honored by pulsesink and PipeWire's pulse layer) to stop the xruns.
        if std::env::var_os("PULSE_LATENCY_MSEC").is_none() {
            std::env::set_var("PULSE_LATENCY_MSEC", "120");
        }
    }

    r_player_lib::run()
}
