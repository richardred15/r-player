use std::path::{Path, PathBuf};

use lofty::file::TaggedFileExt;
use lofty::prelude::*;
use rayon::prelude::*;
use serde::Serialize;
use sha2::{Digest, Sha256};
use walkdir::WalkDir;

/// Audio extensions we scan for. Mirrors the formats the webview can decode
/// (WebKitGTK/GStreamer on Linux): MP3, FLAC, OGG/Opus, WAV, M4A/AAC.
const AUDIO_EXTS: &[&str] = &[
    "mp3", "flac", "ogg", "oga", "opus", "wav", "m4a", "aac", "mp4",
];

const COVER_FILENAMES: &[&str] = &["cover", "folder", "front", "album"];
const COVER_EXTS: &[&str] = &["jpg", "jpeg", "png", "webp"];

#[derive(Serialize)]
pub struct SongMeta {
    pub path: String,
    pub title: String,
    pub artist: String,
    pub album: String,
    pub album_artist: String,
    pub track_no: u32,
    pub duration_secs: f64,
    pub cover_path: Option<String>,
}

fn is_audio(path: &Path) -> bool {
    path.extension()
        .and_then(|e| e.to_str())
        .map(|e| AUDIO_EXTS.contains(&e.to_ascii_lowercase().as_str()))
        .unwrap_or(false)
}

fn file_stem(path: &Path) -> String {
    path.file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("Unknown")
        .to_string()
}

/// Look for a sibling cover image (cover.jpg, folder.png, …) next to the track.
fn sibling_cover(path: &Path) -> Option<String> {
    let dir = path.parent()?;
    for name in COVER_FILENAMES {
        for ext in COVER_EXTS {
            let candidate = dir.join(format!("{name}.{ext}"));
            if candidate.is_file() {
                return Some(candidate.to_string_lossy().to_string());
            }
        }
    }
    None
}

/// Extract embedded artwork to the cache directory keyed by content hash so
/// the webview can load it through the asset protocol. Returns the file path.
fn extract_embedded_cover(data: &[u8], mime: Option<&str>, covers_dir: &Path) -> Option<String> {
    let ext = match mime {
        Some(m) if m.contains("png") => "png",
        Some(m) if m.contains("webp") => "webp",
        Some(m) if m.contains("gif") => "gif",
        _ => "jpg",
    };
    let mut hasher = Sha256::new();
    hasher.update(data);
    let hash = hasher.finalize();
    let name = format!("{:x}.{}", hash, ext);
    let out = covers_dir.join(&name);
    if !out.exists() {
        if std::fs::create_dir_all(covers_dir).is_err() {
            return None;
        }
        if std::fs::write(&out, data).is_err() {
            return None;
        }
    }
    Some(out.to_string_lossy().to_string())
}

fn read_one(path: &Path, covers_dir: &Path) -> SongMeta {
    let mut meta = SongMeta {
        path: path.to_string_lossy().to_string(),
        title: file_stem(path),
        artist: String::new(),
        album: String::new(),
        album_artist: String::new(),
        track_no: 0,
        duration_secs: 0.0,
        cover_path: None,
    };

    let tagged = match lofty::read_from_path(path) {
        Ok(t) => t,
        Err(_) => {
            meta.cover_path = sibling_cover(path);
            return meta;
        }
    };

    meta.duration_secs = tagged.properties().duration().as_secs_f64();

    let tag = tagged.primary_tag().or_else(|| tagged.first_tag());
    if let Some(tag) = tag {
        if let Some(t) = tag.title() {
            if !t.trim().is_empty() {
                meta.title = t.to_string();
            }
        }
        if let Some(a) = tag.artist() {
            meta.artist = a.to_string();
        }
        if let Some(al) = tag.album() {
            meta.album = al.to_string();
        }
        if let Some(aa) = tag.get_string(ItemKey::AlbumArtist) {
            meta.album_artist = aa.to_string();
        }
        if let Some(n) = tag.track() {
            meta.track_no = n;
        }

        if let Some(pic) = tag.pictures().first() {
            let mime = pic.mime_type().map(|m| m.as_str());
            meta.cover_path = extract_embedded_cover(pic.data(), mime, covers_dir);
        }
    }

    if meta.cover_path.is_none() {
        meta.cover_path = sibling_cover(path);
    }

    meta
}

/// Fast pre-pass: enumerate every audio file under `root` without reading tags,
/// so the caller knows the total up front for progress reporting.
pub fn collect_audio_paths(root: &str) -> Vec<PathBuf> {
    WalkDir::new(root)
        .follow_links(true)
        .into_iter()
        .filter_map(|e| e.ok())
        .filter(|e| e.file_type().is_file() && is_audio(e.path()))
        .map(|e| e.path().to_path_buf())
        .collect()
}

/// Read tags/album art for every path in parallel (rayon) and deliver results in
/// batches via `on_batch`. `should_continue` is polled so a superseded scan can
/// abort early. Returns the number of files processed.
pub fn scan_streaming(
    paths: &[PathBuf],
    covers_dir: PathBuf,
    batch_size: usize,
    should_continue: impl Fn() -> bool + Sync,
    mut on_batch: impl FnMut(Vec<SongMeta>),
) -> usize {
    use std::sync::mpsc;

    let (tx, rx) = mpsc::channel::<SongMeta>();

    // Producer: parallel tag reads feeding the channel. Runs in its own scope so
    // `tx` is dropped (closing the channel) once all files are processed.
    let covers = &covers_dir;
    let cont = &should_continue;
    std::thread::scope(|scope| {
        scope.spawn(move || {
            paths.par_iter().for_each_with(tx, |tx, path| {
                if !cont() {
                    return;
                }
                let _ = tx.send(read_one(path, covers));
            });
        });

        // Consumer: drain the channel, emitting fixed-size batches.
        let mut processed = 0usize;
        let mut buffer: Vec<SongMeta> = Vec::with_capacity(batch_size);
        for meta in rx {
            buffer.push(meta);
            processed += 1;
            if buffer.len() >= batch_size {
                on_batch(std::mem::take(&mut buffer));
            }
        }
        if !buffer.is_empty() {
            on_batch(buffer);
        }
        processed
    })
}
