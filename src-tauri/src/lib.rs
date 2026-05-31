mod audio_server;
mod library;
mod media;

use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;

use serde_json::json;
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_sql::{Migration, MigrationKind};

use audio_server::AudioServer;
use media::MediaState;
use serde::Serialize;

const INIT_SQL: &str = include_str!("../migrations/0001_init.sql");
const BATCH_SIZE: usize = 250;

/// Tracks the current scan generation so a newer scan supersedes an in-flight one.
struct ScanState {
    generation: Arc<AtomicU64>,
}

impl ScanState {
    fn new() -> Self {
        Self {
            generation: Arc::new(AtomicU64::new(0)),
        }
    }
}

/// The resolved `sqlite:` connection string, shared with the frontend so it loads
/// the exact same DB the migrations were registered against.
struct DbUrl(String);

/// Resolve the DB to an explicit path in the app **data** dir (not the config dir,
/// where a bare relative name lands). Best-effort: migrate an existing DB from the
/// old config-dir location so the user keeps their library/scores. Returns the
/// `sqlite:<abs path>` connection string.
fn resolve_db_url(identifier: &str) -> String {
    let data_dir = dirs::data_dir().expect("no data dir").join(identifier);
    let _ = std::fs::create_dir_all(&data_dir);
    let db_file = data_dir.join("r-player.db");

    // One-time move from the previous config-dir location (incl. WAL/SHM).
    if !db_file.exists() {
        if let Some(old_dir) = dirs::config_dir().map(|d| d.join(identifier)) {
            for suffix in ["", "-wal", "-shm"] {
                let from = old_dir.join(format!("r-player.db{suffix}"));
                let to = data_dir.join(format!("r-player.db{suffix}"));
                if from.exists() {
                    let _ = std::fs::copy(&from, &to);
                }
            }
        }
    }

    format!("sqlite:{}", db_file.to_string_lossy())
}

/// Background, parallel, streaming library scan. Reads tags/album art off the main
/// thread (spawn_blocking + rayon) and emits batched `scan:*` events to the webview
/// as songs are discovered. Returns the total number of audio files found.
#[tauri::command]
async fn scan_library(app: AppHandle, path: String) -> Result<u64, String> {
    let covers_dir = app
        .path()
        .app_cache_dir()
        .map_err(|e| e.to_string())?
        .join("covers");

    // Claim a new generation; any older scan will see the mismatch and stop.
    let generation = app.state::<ScanState>().generation.clone();
    let scan_id = generation.fetch_add(1, Ordering::SeqCst) + 1;

    let result = tauri::async_runtime::spawn_blocking(move || {
        run_scan(&app, &path, covers_dir, generation, scan_id)
    })
    .await
    .map_err(|e| e.to_string())?;

    Ok(result)
}

fn run_scan(
    app: &AppHandle,
    path: &str,
    covers_dir: PathBuf,
    generation: Arc<AtomicU64>,
    scan_id: u64,
) -> u64 {
    let paths = library::collect_audio_paths(path);
    let total = paths.len() as u64;
    let _ = app.emit("scan:started", json!({ "scanId": scan_id, "total": total }));

    let should_continue = {
        let generation = generation.clone();
        move || generation.load(Ordering::SeqCst) == scan_id
    };

    let mut scanned: u64 = 0;
    library::scan_streaming(&paths, covers_dir, BATCH_SIZE, should_continue, |batch| {
        scanned += batch.len() as u64;
        let _ = app.emit(
            "scan:progress",
            json!({
                "scanId": scan_id,
                "scanned": scanned,
                "total": total,
                "batch": batch,
            }),
        );
    });

    let _ = app.emit("scan:done", json!({ "scanId": scan_id, "total": total }));
    total
}

#[derive(Serialize)]
struct AudioEndpoint {
    port: u16,
    token: String,
}

/// The SQLite connection string the frontend should pass to `Database.load`.
#[tauri::command]
fn db_url(state: tauri::State<DbUrl>) -> String {
    state.0.clone()
}

/// Returns the loopback audio server's port + token so the frontend can build
/// streamable `http://127.0.0.1:<port>/<token>/<path>` URLs.
#[tauri::command]
fn audio_endpoint(server: tauri::State<AudioServer>) -> AudioEndpoint {
    AudioEndpoint {
        port: server.port,
        token: server.token.clone(),
    }
}

/// Allow the webview's asset protocol to read files under `path` at runtime.
/// Called when the user picks a library folder outside the static scope.
#[tauri::command]
fn allow_path(app: AppHandle, path: String) -> Result<(), String> {
    app.asset_protocol_scope()
        .allow_directory(&path, true)
        .map_err(|e| e.to_string())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let migrations = vec![Migration {
        version: 1,
        description: "initial schema",
        sql: INIT_SQL,
        kind: MigrationKind::Up,
    }];

    let ctx = tauri::generate_context!();
    let db_conn = resolve_db_url(&ctx.config().identifier);

    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .plugin(
            tauri_plugin_sql::Builder::default()
                .add_migrations(&db_conn, migrations)
                .build(),
        )
        .manage(MediaState::new())
        .manage(ScanState::new())
        .manage(DbUrl(db_conn))
        .on_window_event(|_window, event| {
            // On some Wayland/WebKitGTK setups closing the window leaves the
            // process (and its background threads: audio server, MPRIS) running,
            // or exit-time cleanup hangs. Hard-exit to guarantee a clean shutdown.
            if let tauri::WindowEvent::CloseRequested { .. } = event {
                std::process::exit(0);
            }
        })
        .setup(|app| {
            media::init(app.handle());
            let audio = audio_server::start().unwrap_or_else(|e| {
                eprintln!("audio server failed to start: {e}");
                AudioServer {
                    port: 0,
                    token: String::new(),
                }
            });
            app.manage(audio);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            scan_library,
            allow_path,
            db_url,
            audio_endpoint,
            media::set_now_playing,
            media::set_playback_state,
        ])
        .run(ctx)
        .expect("error while running tauri application");
}
