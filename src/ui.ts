import { icon, type IconName } from "./icons";
import { srcFor } from "./library";
import type { Playlist, Song, ViewId } from "./types";

export function el<T extends HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!node) throw new Error(`Missing element #${id}`);
  return node as T;
}

const PLACEHOLDER_COVER =
  "data:image/svg+xml;utf8," +
  encodeURIComponent(
    `<svg xmlns='http://www.w3.org/2000/svg' width='64' height='64'>
       <rect width='64' height='64' rx='8' fill='#2a2d3a'/>
       <text x='32' y='42' font-size='30' text-anchor='middle' fill='#5b5f72'>♪</text>
     </svg>`,
  );

export function coverSrc(path: string | null): string {
  return path ? srcFor(path) : PLACEHOLDER_COVER;
}

export function formatTime(secs: number): string {
  if (!isFinite(secs) || secs < 0) return "0:00";
  const m = Math.floor(secs / 60);
  const s = Math.floor(secs % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

const DEFAULT_VIEWS: { id: ViewId; label: string; icon: IconName }[] = [
  { id: { kind: "all" }, label: "All Songs", icon: "list" },
  { id: { kind: "liked" }, label: "Liked", icon: "liked" },
  { id: { kind: "ranked" }, label: "Ranked", icon: "ranked" },
  { id: { kind: "unranked" }, label: "Random Unranked", icon: "unranked" },
];

function viewKey(v: ViewId): string {
  return v.kind === "custom" ? `custom:${v.id}` : v.kind;
}

export function renderSidebar(active: ViewId, playlists: Playlist[]): void {
  const defaults = el("default-playlists");
  defaults.innerHTML = DEFAULT_VIEWS.map(
    (v) =>
      `<button class="pl-item ${viewKey(active) === viewKey(v.id) ? "active" : ""}"
        data-view='${JSON.stringify(v.id)}'>
        <span class="pl-icon">${icon(v.icon)}</span><span>${escapeHtml(v.label)}</span>
      </button>`,
  ).join("");

  const custom = el("custom-playlists");
  if (!playlists.length) {
    custom.innerHTML = `<p class="sidebar-empty muted">No playlists yet</p>`;
    return;
  }
  custom.innerHTML = playlists
    .map((p) => {
      const v: ViewId = { kind: "custom", id: p.id, name: p.name };
      return `<button class="pl-item ${viewKey(active) === viewKey(v) ? "active" : ""}"
        data-view='${escapeAttr(JSON.stringify(v))}'>
        <span class="pl-icon">${icon("list")}</span><span>${escapeHtml(p.name)}</span>
        <span class="pl-del" data-del="${p.id}" title="Delete playlist">${icon("close", { size: 14 })}</span>
      </button>`;
    })
    .join("");
}

function rankClass(score: number): string {
  if (score > 0) return "pos";
  if (score < 0) return "neg";
  return "zero";
}

// Virtualized track list: only the rows in (and near) the viewport are in the DOM,
// so a 40k-song library renders and scrolls smoothly. Must match `.track-row`
// height in styles.css.
const ROW_H = 40;
const OVERSCAN = 8;

interface ListState {
  songs: Song[];
  currentId: number | null;
  playing: boolean;
}
let list: ListState = { songs: [], currentId: null, playing: false };
let rafPending = false;

function rowHtml(s: Song, index: number, currentId: number | null, playing: boolean): string {
  const isCurrent = s.id === currentId;
  const indexCell = isCurrent
    ? `<span class="now-dot ${playing ? "pulsing" : ""}">●</span>`
    : `${index + 1}`;
  return `<tr class="track-row ${isCurrent ? "current" : ""}" data-id="${s.id}">
    <td class="col-index">${indexCell}</td>
    <td class="col-title">${escapeHtml(s.title)}</td>
    <td class="col-artist muted">${
      s.artist
        ? `<span class="cell-link" data-artist="${escapeAttr(s.artist)}">${escapeHtml(s.artist)}</span>`
        : ""
    }</td>
    <td class="col-album muted">${
      s.album
        ? `<span class="cell-link" data-album="${escapeAttr(s.album)}" data-album-artist="${escapeAttr(s.artist)}">${escapeHtml(s.album)}</span>`
        : ""
    }</td>
    <td class="col-rank"><span class="rank-badge ${rankClass(s.score)}">${s.score}</span></td>
    <td class="col-like">
      <button class="like-btn ${s.liked ? "liked" : ""}" data-like="${s.id}" title="Thumbs up">
        ${icon("heart", { size: 16, fill: !!s.liked })}
      </button>
    </td>
    <td class="col-dur muted">${formatTime(s.duration_secs)}</td>
    <td class="col-more">
      <button class="icon-btn" data-more="${s.id}" title="More…">${icon("more", { size: 16 })}</button>
    </td>
  </tr>`;
}

function renderWindow(): void {
  const body = el("track-list-body");
  const wrap = el("track-list-wrap");
  const { songs, currentId, playing } = list;
  const total = songs.length;

  const scrollTop = wrap.scrollTop;
  const viewH = wrap.clientHeight || 600;
  const start = Math.max(0, Math.floor(scrollTop / ROW_H) - OVERSCAN);
  const end = Math.min(total, Math.ceil((scrollTop + viewH) / ROW_H) + OVERSCAN);

  const topPad = start * ROW_H;
  const botPad = Math.max(0, (total - end) * ROW_H);

  let html = "";
  if (topPad > 0) html += `<tr class="vspacer" style="height:${topPad}px"><td colspan="8"></td></tr>`;
  for (let i = start; i < end; i++) {
    html += rowHtml(songs[i], i, currentId, playing);
  }
  if (botPad > 0) html += `<tr class="vspacer" style="height:${botPad}px"><td colspan="8"></td></tr>`;
  body.innerHTML = html;
}

/** Attach the scroll listener once (called from boot). */
export function initTrackList(): void {
  el("track-list-wrap").addEventListener("scroll", () => {
    if (rafPending) return;
    rafPending = true;
    requestAnimationFrame(() => {
      rafPending = false;
      renderWindow();
    });
  });
}

export function renderTrackList(
  songs: Song[],
  currentId: number | null,
  playing: boolean,
): void {
  const empty = el("empty-state");
  const table = el("track-list");

  list = { songs, currentId, playing };

  if (!songs.length) {
    el("track-list-body").innerHTML = "";
    table.style.display = "none";
    empty.hidden = false;
    empty.textContent =
      "Nothing here yet. Choose a music library folder to get started.";
    return;
  }
  table.style.display = "";
  empty.hidden = true;
  renderWindow();
}

/** Reset the list scroll position to the top (on view changes). */
export function scrollListToTop(): void {
  el("track-list-wrap").scrollTop = 0;
}

export function updateNowPlaying(song: Song | null, playing: boolean): void {
  const cover = el<HTMLImageElement>("np-cover");
  const title = el("np-title");
  const artist = el("np-artist");
  const rank = el("np-rank");
  const like = el<HTMLButtonElement>("np-like");
  const playBtn = el("play-btn");

  playBtn.innerHTML = icon(playing ? "pause" : "play", { size: 20, fill: true });

  if (!song) {
    cover.src = coverSrc(null);
    title.innerHTML = `<span class="marquee-inner">—</span>`;
    artist.textContent = "";
    rank.textContent = "";
    rank.className = "rank-badge";
    like.innerHTML = icon("heart", { size: 18 });
    like.classList.remove("liked");
    refreshNowPlayingMarquee();
    return;
  }

  cover.src = coverSrc(song.cover_path);
  title.innerHTML = `<span class="marquee-inner">${escapeHtml(song.title)}</span>`;
  artist.innerHTML = song.artist
    ? `<span class="marquee-inner"><span class="cell-link" data-artist="${escapeAttr(song.artist)}">${escapeHtml(song.artist)}</span></span>`
    : "";
  rank.textContent = `${song.score}`;
  rank.className = `rank-badge ${rankClass(song.score)}`;
  like.innerHTML = icon("heart", { size: 18, fill: !!song.liked });
  like.classList.toggle("liked", !!song.liked);
  refreshNowPlayingMarquee();
}

/** Toggle marquee scrolling on the now-playing title/artist when their text
 *  overflows the available width. Measured after layout via rAF. */
export function refreshNowPlayingMarquee(): void {
  requestAnimationFrame(() => {
    for (const id of ["np-title", "np-artist"]) {
      const outer = el(id);
      const inner = outer.querySelector<HTMLElement>(".marquee-inner");
      outer.classList.remove("marquee");
      if (!inner) continue;
      inner.style.removeProperty("--marquee-shift");
      inner.style.removeProperty("--marquee-dur");
      const overflow = inner.scrollWidth - outer.clientWidth;
      if (overflow > 2) {
        // ~36px/s, doubled for the round trip; floor so short overflows still ease.
        const dur = Math.max(8, (overflow / 36) * 2);
        inner.style.setProperty("--marquee-shift", `-${overflow}px`);
        inner.style.setProperty("--marquee-dur", `${dur}s`);
        outer.classList.add("marquee");
      }
    }
  });
}

export function setViewHeader(title: string, count: number): void {
  el("view-title").textContent = title;
  el("view-count").textContent = `${count} song${count === 1 ? "" : "s"}`;
}

export function setToggleState(id: string, on: boolean): void {
  el(id).classList.toggle("on", on);
}

/** Show/update the non-blocking scan progress indicator. total=0 ⇒ indeterminate. */
export function setScanStatus(scanned: number, total: number): void {
  el("scan-status").hidden = false;
  const fill = el("scan-bar-fill");
  const text = el("scan-text");
  if (total > 0) {
    fill.style.width = `${Math.min(100, (scanned / total) * 100)}%`;
    text.textContent = `Scanning… ${scanned.toLocaleString()} / ${total.toLocaleString()}`;
  } else {
    fill.style.width = "0%";
    text.textContent = "Scanning…";
  }
}

export function hideScanStatus(): void {
  el("scan-status").hidden = true;
}

// ------------------------------------------------------------------- modal ---

export interface ModalButton {
  label: string;
  kind?: "primary" | "ghost" | "danger";
  onClick: () => void | Promise<void>;
}

let modalEscHandler: ((e: KeyboardEvent) => void) | null = null;

export function openModal(
  title: string,
  body: HTMLElement,
  buttons: ModalButton[],
): void {
  el("modal-title").textContent = title;
  const bodyEl = el("modal-body");
  bodyEl.innerHTML = "";
  bodyEl.appendChild(body);

  const footer = el("modal-footer");
  footer.innerHTML = "";
  for (const b of buttons) {
    const btn = document.createElement("button");
    btn.textContent = b.label;
    btn.className = `modal-btn ${b.kind ?? "ghost"}`;
    btn.addEventListener("click", () => void b.onClick());
    footer.appendChild(btn);
  }

  el("modal-root").hidden = false;
  modalEscHandler = (e) => {
    if (e.key === "Escape") closeModal();
  };
  window.addEventListener("keydown", modalEscHandler);
}

export function closeModal(): void {
  el("modal-root").hidden = true;
  if (modalEscHandler) {
    window.removeEventListener("keydown", modalEscHandler);
    modalEscHandler = null;
  }
}

export function isModalOpen(): boolean {
  return !el("modal-root").hidden;
}

// ----------------------------------------------------------------- escaping ---

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function escapeAttr(s: string): string {
  return escapeHtml(s).replace(/'/g, "&#39;");
}
