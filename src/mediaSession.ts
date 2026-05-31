import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { Player } from "./player";
import type { Song } from "./types";

/** Wire OS media-button presses (forwarded from Rust/souvlaki) to the player. */
export async function initMediaControls(player: Player): Promise<void> {
  await listen<string>("media-control", (e) => {
    switch (e.payload) {
      case "play":
        player.play();
        break;
      case "pause":
        player.pause();
        break;
      case "toggle":
        player.togglePlay();
        break;
      case "next":
        player.next();
        break;
      case "prev":
        player.prev();
        break;
      case "stop":
        player.pause();
        break;
    }
  });
}

/** Push the current track's metadata to the OS "now playing" panel. */
export async function pushNowPlaying(song: Song): Promise<void> {
  try {
    await invoke("set_now_playing", {
      title: song.title,
      artist: song.artist,
      album: song.album,
      coverPath: song.cover_path,
      durationSecs: song.duration_secs,
    });
  } catch {
    /* media controls may be unavailable */
  }
}

export async function pushPlaybackState(
  playing: boolean,
  positionSecs: number,
): Promise<void> {
  try {
    await invoke("set_playback_state", { playing, positionSecs });
  } catch {
    /* media controls may be unavailable */
  }
}
