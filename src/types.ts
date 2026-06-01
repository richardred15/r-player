/** A song row as stored in SQLite. `liked` is 0/1 (SQLite has no bool). */
export interface Song {
  id: number;
  path: string;
  title: string;
  artist: string;
  album: string;
  album_artist: string;
  track_no: number;
  duration_secs: number;
  cover_path: string | null;
  score: number;
  liked: number;
  play_count: number;
  last_played_at: number | null;
  added_at: number;
}

/** Metadata returned by the Rust `scan_library` command (pre-insert). */
export interface SongMeta {
  path: string;
  title: string;
  artist: string;
  album: string;
  album_artist: string;
  track_no: number;
  duration_secs: number;
  cover_path: string | null;
}

export interface Playlist {
  id: number;
  name: string;
  created_at: number;
}

/** Identifies which view is loaded: a built-in smart playlist, a custom playlist,
 *  or a transient artist/album view reached by clicking a track's artist/album. */
export type ViewId =
  | { kind: "all" }
  | { kind: "liked" }
  | { kind: "ranked" }
  | { kind: "unranked" }
  | { kind: "custom"; id: number; name: string }
  | { kind: "artist"; name: string }
  | { kind: "album"; album: string; artist: string };
