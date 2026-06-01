import { invoke } from "@tauri-apps/api/core";
import Database from "@tauri-apps/plugin-sql";
import type { Playlist, Song, SongMeta, ViewId } from "./types";

let dbPromise: Promise<Database> | null = null;

function db(): Promise<Database> {
  // The Rust side resolves the absolute sqlite path (app data dir) and registers
  // migrations against the same string, so load exactly what it reports.
  if (!dbPromise) {
    dbPromise = invoke<string>("db_url").then((url) => Database.load(url));
  }
  return dbPromise;
}

const SONG_COLUMNS =
  "id, path, title, artist, album, album_artist, track_no, duration_secs, cover_path, score, liked, play_count, last_played_at, added_at";

// ---------------------------------------------------------------- settings ---

export async function getSetting(key: string): Promise<string | null> {
  const d = await db();
  const rows = await d.select<{ value: string }[]>(
    "SELECT value FROM settings WHERE key = $1",
    [key],
  );
  return rows.length ? rows[0].value : null;
}

export async function setSetting(key: string, value: string): Promise<void> {
  const d = await db();
  await d.execute(
    "INSERT INTO settings (key, value) VALUES ($1, $2) " +
      "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    [key, value],
  );
}

// ------------------------------------------------------------------ library ---

const UPSERT_COLS = 8; // columns bound per row below
const UPSERT_CHUNK = 200; // rows per statement (200 * 8 = 1600 < SQLite param limit)

/** Insert or update scanned songs, preserving existing score/liked/play_count.
 *  Uses chunked multi-row statements so each runs as a single transaction —
 *  the plugin's connection pool makes manual BEGIN/COMMIT unreliable. */
export async function upsertSongs(metas: SongMeta[]): Promise<void> {
  const d = await db();
  for (let i = 0; i < metas.length; i += UPSERT_CHUNK) {
    const chunk = metas.slice(i, i + UPSERT_CHUNK);
    const rows = chunk
      .map((_, r) => {
        const b = r * UPSERT_COLS;
        return `($${b + 1}, $${b + 2}, $${b + 3}, $${b + 4}, $${b + 5}, $${b + 6}, $${b + 7}, $${b + 8})`;
      })
      .join(", ");
    const params = chunk.flatMap((m) => [
      m.path,
      m.title,
      m.artist,
      m.album,
      m.album_artist,
      m.track_no,
      m.duration_secs,
      m.cover_path,
    ]);
    await d.execute(
      `INSERT INTO songs (path, title, artist, album, album_artist, track_no, duration_secs, cover_path)
       VALUES ${rows}
       ON CONFLICT(path) DO UPDATE SET
         title = excluded.title,
         artist = excluded.artist,
         album = excluded.album,
         album_artist = excluded.album_artist,
         track_no = excluded.track_no,
         duration_secs = excluded.duration_secs,
         cover_path = excluded.cover_path`,
      params,
    );
  }
}

/** Remove songs whose files are no longer present in the library. */
export async function pruneMissing(existingPaths: string[]): Promise<void> {
  const d = await db();
  const all = await d.select<{ id: number; path: string }[]>(
    "SELECT id, path FROM songs",
  );
  const keep = new Set(existingPaths);
  const stale = all.filter((s) => !keep.has(s.path)).map((s) => s.id);
  for (let i = 0; i < stale.length; i += 200) {
    const chunk = stale.slice(i, i + 200);
    const placeholders = chunk.map((_, j) => `$${j + 1}`).join(", ");
    await d.execute(`DELETE FROM songs WHERE id IN (${placeholders})`, chunk);
  }
}

// -------------------------------------------------------------------- views ---

/** Resolve a view (smart or custom playlist) into its ordered song list. */
export async function songsForView(view: ViewId): Promise<Song[]> {
  const d = await db();
  switch (view.kind) {
    case "all":
      return d.select<Song[]>(
        `SELECT ${SONG_COLUMNS} FROM songs ORDER BY artist, album, track_no, title`,
      );
    case "liked":
      return d.select<Song[]>(
        `SELECT ${SONG_COLUMNS} FROM songs WHERE liked = 1 ORDER BY score DESC, title`,
      );
    case "ranked":
      // Songs that have been played, highest score first.
      return d.select<Song[]>(
        `SELECT ${SONG_COLUMNS} FROM songs WHERE play_count > 0 ORDER BY score DESC, play_count DESC, title`,
      );
    case "unranked":
      // Never played, in random order.
      return d.select<Song[]>(
        `SELECT ${SONG_COLUMNS} FROM songs WHERE play_count = 0 ORDER BY RANDOM()`,
      );
    case "custom":
      return d.select<Song[]>(
        `SELECT ${SONG_COLUMNS} FROM songs s
         JOIN playlist_songs ps ON ps.song_id = s.id
         WHERE ps.playlist_id = $1
         ORDER BY ps.position, s.title`,
        [view.id],
      );
    case "artist":
      // A flat discography, grouped visually by the album column.
      return d.select<Song[]>(
        `SELECT ${SONG_COLUMNS} FROM songs WHERE artist = $1 ORDER BY album, track_no, title`,
        [view.name],
      );
    case "album":
      // Scope by artist too, so same-named albums by different artists don't merge.
      return view.artist
        ? d.select<Song[]>(
            `SELECT ${SONG_COLUMNS} FROM songs WHERE album = $1 AND artist = $2 ORDER BY track_no, title`,
            [view.album, view.artist],
          )
        : d.select<Song[]>(
            `SELECT ${SONG_COLUMNS} FROM songs WHERE album = $1 ORDER BY track_no, title`,
            [view.album],
          );
  }
}

export async function searchSongs(query: string): Promise<Song[]> {
  const d = await db();
  const like = `%${query}%`;
  return d.select<Song[]>(
    `SELECT ${SONG_COLUMNS} FROM songs
     WHERE title LIKE $1 OR artist LIKE $1 OR album LIKE $1
     ORDER BY artist, album, track_no, title`,
    [like],
  );
}

/** Lightweight score/liked/play_count snapshot for refreshing list rows in place. */
export async function scoreSnapshot(): Promise<
  { id: number; score: number; liked: number; play_count: number }[]
> {
  const d = await db();
  return d.select("SELECT id, score, liked, play_count FROM songs");
}

export async function getSong(id: number): Promise<Song | null> {
  const d = await db();
  const rows = await d.select<Song[]>(
    `SELECT ${SONG_COLUMNS} FROM songs WHERE id = $1`,
    [id],
  );
  return rows.length ? rows[0] : null;
}

// ----------------------------------------------------------------- mutations ---

export async function applyScore(
  songId: number,
  delta: number,
  reason: string,
): Promise<void> {
  const d = await db();
  await d.execute("UPDATE songs SET score = score + $1 WHERE id = $2", [
    delta,
    songId,
  ]);
  await d.execute(
    "INSERT INTO play_events (song_id, event, delta) VALUES ($1, $2, $3)",
    [songId, reason, delta],
  );
}

/** Reset all ranking data: scores, play counts, liked flags, and the event log.
 *  Songs themselves (the library) are kept. */
export async function resetAllRanks(): Promise<void> {
  const d = await db();
  await d.execute(
    "UPDATE songs SET score = 0, play_count = 0, liked = 0, last_played_at = NULL",
  );
  await d.execute("DELETE FROM play_events");
}

export async function markPlayed(songId: number): Promise<void> {
  const d = await db();
  await d.execute(
    "UPDATE songs SET play_count = play_count + 1, last_played_at = strftime('%s','now') WHERE id = $1",
    [songId],
  );
}

/** Toggle liked flag; returns the new liked state. */
export async function setLiked(songId: number, liked: boolean): Promise<void> {
  const d = await db();
  await d.execute("UPDATE songs SET liked = $1 WHERE id = $2", [
    liked ? 1 : 0,
    songId,
  ]);
}

// ----------------------------------------------------------------- playlists ---

export async function listPlaylists(): Promise<Playlist[]> {
  const d = await db();
  return d.select<Playlist[]>("SELECT id, name, created_at FROM playlists ORDER BY name");
}

export async function createPlaylist(name: string): Promise<number> {
  const d = await db();
  const res = await d.execute("INSERT INTO playlists (name) VALUES ($1)", [name]);
  return res.lastInsertId as number;
}

export async function renamePlaylist(id: number, name: string): Promise<void> {
  const d = await db();
  await d.execute("UPDATE playlists SET name = $1 WHERE id = $2", [name, id]);
}

export async function deletePlaylist(id: number): Promise<void> {
  const d = await db();
  await d.execute("DELETE FROM playlists WHERE id = $1", [id]);
}

export async function addToPlaylist(playlistId: number, songId: number): Promise<void> {
  const d = await db();
  const rows = await d.select<{ next: number }[]>(
    "SELECT COALESCE(MAX(position), -1) + 1 AS next FROM playlist_songs WHERE playlist_id = $1",
    [playlistId],
  );
  const position = rows[0]?.next ?? 0;
  await d.execute(
    "INSERT INTO playlist_songs (playlist_id, song_id, position) VALUES ($1, $2, $3) " +
      "ON CONFLICT(playlist_id, song_id) DO NOTHING",
    [playlistId, songId, position],
  );
}

export async function removeFromPlaylist(playlistId: number, songId: number): Promise<void> {
  const d = await db();
  await d.execute(
    "DELETE FROM playlist_songs WHERE playlist_id = $1 AND song_id = $2",
    [playlistId, songId],
  );
}
