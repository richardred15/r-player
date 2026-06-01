import * as db from "./db";
import {
  authorizeLibrary,
  chooseLibraryFolder,
  getLibraryPath,
  initAudioEndpoint,
} from "./library";
import { startScan } from "./scan";
import { icon } from "./icons";
import { initMediaControls, pushNowPlaying, pushPlaybackState } from "./mediaSession";
import { Player } from "./player";
import { likeDelta } from "./scoring";
import { registerShortcuts } from "./shortcuts";
import type { Playlist, Song, ViewId } from "./types";
import {
  closeModal,
  coverSrc,
  el,
  formatTime,
  isModalOpen,
  type ModalButton,
  initTrackList,
  openModal,
  renderSidebar,
  renderTrackList,
  hideScanStatus,
  scrollListToTop,
  setScanStatus,
  setToggleState,
  setViewHeader,
  updateNowPlaying,
} from "./ui";

// --------------------------------------------------------------- app state ---

let currentView: ViewId = { kind: "all" };
let currentSongs: Song[] = [];
let playlists: Playlist[] = [];
let nowPlayingId: number | null = null;
let lastMediaPush = 0;

const audio = el<HTMLAudioElement>("audio");
const player = new Player(audio, {
  onTrack: (song) => {
    nowPlayingId = song?.id ?? null;
    if (song) void pushNowPlaying(song);
    renderCurrentList();
    void refreshNowPlaying();
  },
  onState: (playing) => {
    renderCurrentList();
    void refreshNowPlaying();
    void pushPlaybackState(playing, audio.currentTime);
  },
  onTick: (cur, dur) => {
    const seek = el<HTMLInputElement>("seek");
    if (document.activeElement !== seek) {
      seek.value = dur ? String((cur / dur) * 1000) : "0";
    }
    el("np-elapsed").textContent = formatTime(cur);
    el("np-duration").textContent = formatTime(dur);
    const now = performance.now();
    if (now - lastMediaPush > 1000) {
      lastMediaPush = now;
      void pushPlaybackState(player.playing, cur);
    }
  },
  onScored: () => void refreshScores(),
});

// ------------------------------------------------------------------- views ---

function titleFor(view: ViewId): string {
  switch (view.kind) {
    case "all":
      return "All Songs";
    case "liked":
      return "Liked";
    case "ranked":
      return "Ranked";
    case "unranked":
      return "Random Unranked";
    case "custom":
      return view.name;
    case "artist":
      return view.name;
    case "album":
      return view.artist ? `${view.album} — ${view.artist}` : view.album;
  }
}

let lastViewKey = "";
let prevView: ViewId | null = null;

async function loadView(view: ViewId, fromBack = false): Promise<void> {
  const key = JSON.stringify(view);
  // Remember where we came from so artist/album views get a Back button. Don't
  // record history when navigating via Back itself, or re-loading the same view.
  if (!fromBack && key !== lastViewKey) prevView = currentView;
  currentView = view;
  currentSongs = await db.songsForView(view);
  setViewHeader(titleFor(view), currentSongs.length);
  renderSidebar(currentView, playlists);
  setBackVisible(view.kind === "artist" || view.kind === "album");
  renderCurrentList();
  // Only jump back to the top when the user actually switches views — not on the
  // periodic re-render during a live scan.
  if (key !== lastViewKey) {
    lastViewKey = key;
    scrollListToTop();
  }
}

function goBack(): void {
  void loadView(prevView ?? { kind: "all" }, true);
}

function renderCurrentList(): void {
  renderTrackList(currentSongs, player.current?.id ?? null, player.playing);
}

function setBackVisible(visible: boolean): void {
  el("back-btn").hidden = !visible;
}

/** Patch visible rows' score/liked in place (no reorder) after playback scoring. */
async function refreshScores(): Promise<void> {
  const snap = await db.scoreSnapshot();
  const map = new Map(snap.map((s) => [s.id, s]));
  for (const s of currentSongs) {
    const f = map.get(s.id);
    if (f) {
      s.score = f.score;
      s.liked = f.liked;
      s.play_count = f.play_count;
    }
  }
  renderCurrentList();
  await refreshNowPlaying();
}

/** Now-playing bar always reflects DB truth for the current track. */
async function refreshNowPlaying(): Promise<void> {
  if (nowPlayingId == null) {
    updateNowPlaying(null, player.playing);
    return;
  }
  const song = await db.getSong(nowPlayingId);
  updateNowPlaying(song, player.playing);
}

// ------------------------------------------------------------- library ops ---

async function ensureLibrary(): Promise<void> {
  const path = await getLibraryPath();
  if (!path) {
    setViewHeader("All Songs", 0);
    renderCurrentList();
    return;
  }
  await authorizeLibrary(path);
  await loadView(currentView);
  // Only auto-scan when the library is empty (first run). Otherwise show the
  // cached library instantly — a full re-scan saturates the CPU (rayon across all
  // cores) and can make playback glitchy. Use the Rescan button to pick up changes.
  if (currentSongs.length === 0) void rescan();
}

async function chooseLibrary(): Promise<void> {
  const path = await chooseLibraryFolder();
  if (!path) return;
  await rescan();
}

let lastListRefresh = 0;

/** Run a streaming scan of the saved library: songs are upserted and shown live,
 *  with a non-blocking progress indicator, all off the main thread. */
async function rescan(): Promise<void> {
  const path = await getLibraryPath();
  if (!path) return;

  setScanStatus(0, 0);
  lastListRefresh = 0;
  await startScan(path, {
    onProgress: (scanned, total) => {
      setScanStatus(scanned, total);
      const now = performance.now();
      if (now - lastListRefresh > 750) {
        lastListRefresh = now;
        void loadView(currentView);
      }
    },
    onDone: () => {
      hideScanStatus();
      void loadView(currentView);
    },
    onError: (msg) => {
      hideScanStatus();
      console.error("library scan failed:", msg);
    },
  });
}

// --------------------------------------------------------------- like flow ---

async function toggleLike(songId: number): Promise<void> {
  const song = await db.getSong(songId);
  if (!song) return;
  const nowLiked = !song.liked;
  await db.setLiked(songId, nowLiked);
  await db.applyScore(songId, likeDelta(nowLiked), nowLiked ? "like" : "unlike");
  // Membership of the Liked view changes, so reload it; otherwise patch in place.
  if (currentView.kind === "liked") {
    await loadView(currentView);
  } else {
    await refreshScores();
  }
  await refreshNowPlaying();
}

// ----------------------------------------------------------- playlist flow ---

async function refreshPlaylists(): Promise<void> {
  playlists = await db.listPlaylists();
  renderSidebar(currentView, playlists);
}

function promptNewPlaylist(): void {
  const body = document.createElement("div");
  body.className = "modal-form";
  const input = document.createElement("input");
  input.type = "text";
  input.placeholder = "Playlist name";
  body.appendChild(input);
  const create = async () => {
    const name = input.value.trim();
    if (!name) return;
    await db.createPlaylist(name);
    await refreshPlaylists();
    closeModal();
  };
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") void create();
  });
  openModal("New Playlist", body, [
    { label: "Cancel", kind: "ghost", onClick: closeModal },
    { label: "Create", kind: "primary", onClick: create },
  ]);
  setTimeout(() => input.focus(), 0);
}

async function openTrackMenu(songId: number): Promise<void> {
  const song = await db.getSong(songId);
  if (!song) return;
  const body = document.createElement("div");
  body.className = "modal-list";

  const heading = document.createElement("p");
  heading.className = "muted";
  heading.textContent = "Add to playlist";
  body.appendChild(heading);

  if (!playlists.length) {
    const none = document.createElement("p");
    none.className = "muted";
    none.textContent = "No playlists yet — create one first.";
    body.appendChild(none);
  }
  for (const p of playlists) {
    const btn = document.createElement("button");
    btn.className = "modal-row";
    btn.textContent = p.name;
    btn.addEventListener("click", async () => {
      await db.addToPlaylist(p.id, songId);
      closeModal();
    });
    body.appendChild(btn);
  }

  const buttons: ModalButton[] = [
    { label: "Close", kind: "ghost", onClick: closeModal },
  ];
  if (currentView.kind === "custom") {
    const view = currentView;
    buttons.unshift({
      label: "Remove from this playlist",
      kind: "danger",
      onClick: async () => {
        await db.removeFromPlaylist(view.id, songId);
        closeModal();
        await loadView(view);
      },
    });
  }
  openModal(song.title, body, buttons);
}

function confirmDeletePlaylist(id: number): void {
  const target = playlists.find((p) => p.id === id);
  if (!target) return;
  const body = document.createElement("p");
  body.textContent = `Delete playlist “${target.name}”? Songs are not deleted.`;
  openModal("Delete Playlist", body, [
    { label: "Cancel", kind: "ghost", onClick: closeModal },
    {
      label: "Delete",
      kind: "danger",
      onClick: async () => {
        await db.deletePlaylist(id);
        closeModal();
        if (currentView.kind === "custom" && currentView.id === id) {
          await loadView({ kind: "all" });
        }
        await refreshPlaylists();
      },
    },
  ]);
}

// --------------------------------------------------------------- reset flow ---

function confirmResetRanks(): void {
  const body = document.createElement("p");
  body.textContent =
    "Reset all ranks? This clears every song's score, play count, and thumbs-up. " +
    "Your library and playlists are kept. This can't be undone.";
  openModal("Reset Ranks", body, [
    { label: "Cancel", kind: "ghost", onClick: closeModal },
    {
      label: "Reset ranks",
      kind: "danger",
      onClick: async () => {
        await db.resetAllRanks();
        closeModal();
        await loadView(currentView);
        await refreshNowPlaying();
      },
    },
  ]);
}

// ------------------------------------------------------------- search flow ---

let searchDebounce = 0;
async function runSearch(query: string): Promise<void> {
  if (!query.trim()) {
    await loadView(currentView);
    return;
  }
  currentSongs = await db.searchSongs(query);
  setViewHeader(`Search: “${query}”`, currentSongs.length);
  renderCurrentList();
  scrollListToTop();
}

// -------------------------------------------------------------- event wiring ---

function wireUi(): void {
  // Sidebar navigation (default + custom playlists, delete).
  for (const id of ["default-playlists", "custom-playlists"]) {
    el(id).addEventListener("click", (e) => {
      const target = e.target as HTMLElement;
      const del = target.closest<HTMLElement>("[data-del]");
      if (del) {
        e.stopPropagation();
        confirmDeletePlaylist(Number(del.dataset.del));
        return;
      }
      const item = target.closest<HTMLElement>("[data-view]");
      if (item?.dataset.view) {
        el<HTMLInputElement>("search-input").value = "";
        void loadView(JSON.parse(item.dataset.view) as ViewId);
      }
    });
  }

  // Track list: double-click to play; single-click on like / more / artist / album.
  el("track-list-body").addEventListener("click", (e) => {
    const target = e.target as HTMLElement;
    const like = target.closest<HTMLElement>("[data-like]");
    if (like) {
      void toggleLike(Number(like.dataset.like));
      return;
    }
    const more = target.closest<HTMLElement>("[data-more]");
    if (more) {
      void openTrackMenu(Number(more.dataset.more));
      return;
    }
    const artist = target.closest<HTMLElement>("[data-artist]");
    if (artist?.dataset.artist) {
      void loadView({ kind: "artist", name: artist.dataset.artist });
      return;
    }
    const album = target.closest<HTMLElement>("[data-album]");
    if (album?.dataset.album) {
      void loadView({
        kind: "album",
        album: album.dataset.album,
        artist: album.dataset.albumArtist ?? "",
      });
    }
  });
  el("track-list-body").addEventListener("dblclick", (e) => {
    const row = (e.target as HTMLElement).closest<HTMLElement>("[data-id]");
    if (row?.dataset.id) player.load(currentSongs, Number(row.dataset.id));
  });

  // Transport.
  el("play-btn").addEventListener("click", () => player.togglePlay());
  el("next-btn").addEventListener("click", () => player.next());
  el("prev-btn").addEventListener("click", () => player.prev());
  el<HTMLInputElement>("seek").addEventListener("input", (e) => {
    player.seekFraction(Number((e.target as HTMLInputElement).value) / 1000);
  });
  el<HTMLInputElement>("volume").addEventListener("input", (e) => {
    player.setVolume(Number((e.target as HTMLInputElement).value) / 100);
  });
  el("np-like").addEventListener("click", () => {
    if (nowPlayingId != null) void toggleLike(nowPlayingId);
  });
  // Now-playing artist → artist view.
  el("np-artist").addEventListener("click", (e) => {
    const link = (e.target as HTMLElement).closest<HTMLElement>("[data-artist]");
    if (link?.dataset.artist) void loadView({ kind: "artist", name: link.dataset.artist });
  });
  el("back-btn").addEventListener("click", goBack);

  // Toggles.
  el("shuffle-btn").addEventListener("click", () => {
    player.setShuffle(!player.isShuffle());
    setToggleState("shuffle-btn", player.isShuffle());
  });
  el("loop-btn").addEventListener("click", () => {
    const mode = player.cycleRepeat();
    setToggleState("loop-btn", mode !== "off");
    el("loop-btn").innerHTML = icon(mode === "one" ? "repeat1" : "repeat");
  });
  el("visualizer-btn").addEventListener("click", () => void toggleVisualizer());

  // Library + playlists.
  el("choose-library-btn").addEventListener("click", () => void chooseLibrary());
  el("rescan-btn").addEventListener("click", () => void rescan());
  el("reset-ranks-btn").addEventListener("click", confirmResetRanks);
  el("new-playlist-btn").addEventListener("click", promptNewPlaylist);

  // Search (debounced).
  el<HTMLInputElement>("search-input").addEventListener("input", (e) => {
    const q = (e.target as HTMLInputElement).value;
    clearTimeout(searchDebounce);
    searchDebounce = window.setTimeout(() => void runSearch(q), 180);
  });

  // Modal close affordances.
  el("modal-close").addEventListener("click", closeModal);
  el("modal-backdrop").addEventListener("click", closeModal);
}

// -------------------------------------------------------------- visualizer ---

let visualizer: import("./visualizer").Visualizer | null = null;

async function ensureVisualizer(): Promise<import("./visualizer").Visualizer> {
  if (!visualizer) {
    const { Visualizer } = await import("./visualizer");
    visualizer = new Visualizer(el<HTMLCanvasElement>("visualizer"), () =>
      player.getAnalyser(),
    );
  }
  return visualizer;
}

async function setVisualizer(on: boolean): Promise<void> {
  const v = await ensureVisualizer();
  if (on) v.start();
  else v.stop();
  setToggleState("visualizer-btn", on);
  await db.setSetting("visualizer_enabled", on ? "1" : "0");
}

async function toggleVisualizer(): Promise<void> {
  const v = await ensureVisualizer();
  await setVisualizer(!v.isEnabled());
}

// -------------------------------------------------------------------- boot ---

/** Populate the static (non-rendered) UI controls with their Lucide icons. */
function initStaticIcons(): void {
  const set = (sel: string, html: string) => {
    const e = document.querySelector(sel);
    if (e) e.innerHTML = html;
  };
  set(".brand-mark", icon("music", { size: 20 }));
  set("#back-btn", icon("back", { size: 20 }));
  set("#new-playlist-btn", icon("plus"));
  set("#shuffle-btn", icon("shuffle"));
  set("#loop-btn", icon("repeat"));
  set("#visualizer-btn", icon("visualizer"));
  set("#prev-btn", icon("prev", { size: 20 }));
  set("#play-btn", icon("play", { size: 20, fill: true }));
  set("#next-btn", icon("next", { size: 20 }));
  set("#np-like", icon("heart", { size: 18 }));
  set(".vol-icon", icon("volume", { size: 16 }));
  set("#modal-close", icon("close"));
  set("#choose-library-btn", `${icon("folder", { size: 15 })}<span>Music library…</span>`);
  set("#rescan-btn", `${icon("refresh", { size: 15 })}<span>Rescan</span>`);
  set("#reset-ranks-btn", `${icon("reset", { size: 15 })}<span>Reset ranks</span>`);
}

async function boot(): Promise<void> {
  initStaticIcons();
  wireUi();
  initTrackList();
  registerShortcuts({
    togglePlay: () => player.togglePlay(),
    next: () => player.next(),
    prev: () => player.prev(),
    like: () => {
      if (nowPlayingId != null) void toggleLike(nowPlayingId);
    },
    shuffle: () => el("shuffle-btn").click(),
    repeat: () => el("loop-btn").click(),
    visualizer: () => void toggleVisualizer(),
    search: () => el<HTMLInputElement>("search-input").focus(),
    newPlaylist: () => {
      if (!isModalOpen()) promptNewPlaylist();
    },
  });

  await initMediaControls(player);
  await initAudioEndpoint();

  // Build the Web Audio analyser graph up front (before any track plays) so the
  // visualizer never has to attach a MediaElementSource mid-playback — doing that
  // makes WebKitGTK reset the media buffer (an audible glitch). Negligible CPU.
  player.enableAnalyser();
  const visEnabled = (await db.getSetting("visualizer_enabled")) !== "0"; // default on
  await setVisualizer(visEnabled);

  await refreshPlaylists();
  await ensureLibrary();

  el<HTMLImageElement>("np-cover").src = coverSrc(null);
}

void boot();
