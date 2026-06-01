import {
  isPermissionGranted,
  requestPermission,
  sendNotification,
} from "@tauri-apps/plugin-notification";
import type { Song } from "./types";

let granted = false;

/** Ask the OS notification daemon for permission once at startup (on Linux desktop
 *  this is granted implicitly). Failure is non-fatal — we just skip notifications. */
export async function initNotifications(): Promise<void> {
  try {
    granted = await isPermissionGranted();
    if (!granted) granted = (await requestPermission()) === "granted";
  } catch {
    granted = false;
  }
}

/** Show a "now playing" desktop toast (KDE Plasma's freedesktop notifications). */
export function notifyNowPlaying(song: Song): void {
  if (!granted) return;
  try {
    sendNotification({
      title: song.title,
      body: [song.artist, song.album].filter(Boolean).join(" — "),
      // Album-art file path (the OS daemon reads it directly, not via asset://).
      icon: song.cover_path ?? undefined,
    });
  } catch {
    /* notifications are best-effort */
  }
}
