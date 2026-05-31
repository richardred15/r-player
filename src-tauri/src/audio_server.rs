use std::fs::File;
use std::io::{Read, Seek, SeekFrom};
use std::path::Path;
use std::time::{SystemTime, UNIX_EPOCH};

use percent_encoding::percent_decode_str;
use sha2::{Digest, Sha256};
use tiny_http::{Header, Request, Response, Server, StatusCode};

/// Endpoint info handed to the frontend so it can build playable URLs.
pub struct AudioServer {
    pub port: u16,
    pub token: String,
}

fn make_token() -> String {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let mut hasher = Sha256::new();
    hasher.update(nanos.to_le_bytes());
    hasher.update(std::process::id().to_le_bytes());
    format!("{:x}", hasher.finalize())[..32].to_string()
}

/// Start a loopback HTTP server that streams local audio files with Range support.
/// WebKitGTK's media pipeline (GStreamer) can stream `http://127.0.0.1` natively but
/// not Tauri's `asset://` scheme, so audio playback goes through here.
pub fn start() -> Result<AudioServer, String> {
    let server = Server::http("127.0.0.1:0").map_err(|e| e.to_string())?;
    let port = server
        .server_addr()
        .to_ip()
        .map(|a| a.port())
        .ok_or_else(|| "no bound port".to_string())?;
    let token = make_token();

    let token_thread = token.clone();
    std::thread::spawn(move || {
        for request in server.incoming_requests() {
            let token = token_thread.clone();
            // Each request on its own thread so range reads can overlap.
            std::thread::spawn(move || {
                let _ = handle(request, &token);
            });
        }
    });

    Ok(AudioServer { port, token })
}

fn header(key: &str, value: &str) -> Header {
    Header::from_bytes(key.as_bytes(), value.as_bytes()).expect("valid header")
}

fn content_type(path: &Path) -> &'static str {
    match path
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_ascii_lowercase())
        .as_deref()
    {
        Some("mp3") => "audio/mpeg",
        Some("flac") => "audio/flac",
        Some("ogg") | Some("oga") => "audio/ogg",
        Some("opus") => "audio/opus",
        Some("wav") => "audio/wav",
        Some("m4a") | Some("mp4") | Some("aac") => "audio/mp4",
        _ => "application/octet-stream",
    }
}

/// Parse a `Range: bytes=...` value into an inclusive (start, end) within `len`.
/// Returns None for a full-content request.
fn parse_range(value: &str, len: u64) -> Option<(u64, u64)> {
    let spec = value.strip_prefix("bytes=")?.trim();
    let (a, b) = spec.split_once('-')?;
    let last = len.saturating_sub(1);
    if a.is_empty() {
        // suffix: last N bytes
        let n: u64 = b.parse().ok()?;
        Some((len.saturating_sub(n), last))
    } else {
        let start: u64 = a.parse().ok()?;
        let end = if b.is_empty() {
            last
        } else {
            b.parse::<u64>().ok()?.min(last)
        };
        if start > end {
            None
        } else {
            Some((start, end))
        }
    }
}

fn handle(request: Request, token: &str) -> std::io::Result<()> {
    let url = request.url().to_string();
    let trimmed = url.trim_start_matches('/');
    let Some((tok, enc)) = trimmed.split_once('/') else {
        return request.respond(Response::empty(StatusCode(400)));
    };
    if tok != token {
        return request.respond(Response::empty(StatusCode(403)));
    }

    let path = percent_decode_str(enc).decode_utf8_lossy().to_string();
    let path = Path::new(&path);
    let ctype = content_type(path);

    let mut file = match File::open(path) {
        Ok(f) => f,
        Err(_) => return request.respond(Response::empty(StatusCode(404))),
    };
    let len = file.metadata()?.len();

    let range = request
        .headers()
        .iter()
        .find(|h| h.field.equiv("Range"))
        .and_then(|h| parse_range(h.value.as_str(), len));

    let cors = header("Access-Control-Allow-Origin", "*");
    let ranges = header("Accept-Ranges", "bytes");
    let ctype = header("Content-Type", ctype);

    match range {
        Some((start, end)) => {
            let chunk = end - start + 1;
            file.seek(SeekFrom::Start(start))?;
            let reader = file.take(chunk);
            let headers = vec![
                ctype,
                ranges,
                cors,
                header("Content-Range", &format!("bytes {start}-{end}/{len}")),
            ];
            let resp = Response::new(StatusCode(206), headers, reader, Some(chunk as usize), None);
            request.respond(resp)
        }
        None => {
            let headers = vec![ctype, ranges, cors];
            let resp = Response::new(StatusCode(200), headers, file, Some(len as usize), None);
            request.respond(resp)
        }
    }
}
