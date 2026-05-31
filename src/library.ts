import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { getSetting, setSetting } from "./db";

const LIBRARY_KEY = "library_path";

/** Prompt the user to pick a library folder; persists and authorises it. */
export async function chooseLibraryFolder(): Promise<string | null> {
  const selected = await open({
    directory: true,
    multiple: false,
    title: "Choose your music library folder",
  });
  if (typeof selected !== "string") return null;
  await setSetting(LIBRARY_KEY, selected);
  await invoke("allow_path", { path: selected });
  return selected;
}

export async function getLibraryPath(): Promise<string | null> {
  return getSetting(LIBRARY_KEY);
}

/** Re-authorise a previously chosen folder on startup (asset protocol scope). */
export async function authorizeLibrary(path: string): Promise<void> {
  await invoke("allow_path", { path });
}

/** Convert an absolute file path into a URL the webview can load (used for images). */
export function srcFor(path: string): string {
  return convertFileSrc(path);
}

// Audio is streamed from a loopback HTTP server (see src-tauri/src/audio_server.rs)
// because WebKitGTK/GStreamer can't play Tauri's asset:// scheme. Fetched once at boot.
let audioEndpoint: { port: number; token: string } | null = null;

export async function initAudioEndpoint(): Promise<void> {
  audioEndpoint = await invoke<{ port: number; token: string }>("audio_endpoint");
}

/** Build a streamable URL for a local audio file path. */
export function audioUrl(path: string): string {
  if (!audioEndpoint || !audioEndpoint.port) {
    console.error("audio endpoint not initialised");
    return "";
  }
  const { port, token } = audioEndpoint;
  return `http://127.0.0.1:${port}/${token}/${encodeURIComponent(path)}`;
}
