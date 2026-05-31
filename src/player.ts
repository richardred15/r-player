import * as db from "./db";
import { audioUrl } from "./library";
import { completeDelta, skipDelta } from "./scoring";
import type { Song } from "./types";

export type RepeatMode = "off" | "all" | "one";

export interface PlayerCallbacks {
  /** Current track changed (or cleared). */
  onTrack?: (song: Song | null) => void;
  /** Play/pause state changed. */
  onState?: (playing: boolean) => void;
  /** Playback position tick. */
  onTick?: (currentSecs: number, durationSecs: number) => void;
  /** A score/like/play-count write happened — refresh dependent UI. */
  onScored?: () => void;
}

function shuffle(indices: number[]): number[] {
  const a = indices.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/**
 * Owns the <audio> element and the Web Audio graph (source → analyser →
 * destination). Manages the loaded queue, shuffle/repeat, and applies the
 * ranking rules as playback events occur.
 *
 * `active` is the track currently loaded into the audio element. Scoring is
 * keyed off `active` (not the queue position) so that navigating the queue can
 * never misattribute a skip penalty to the wrong song.
 */
export class Player {
  private audio: HTMLAudioElement;
  private ctx?: AudioContext;
  private analyser?: AnalyserNode;

  private queue: Song[] = [];
  private order: number[] = []; // positions into `queue`
  private pos = -1; // index into `order`

  private active: Song | null = null;
  private endedNaturally = false;

  private shuffleOn = false;
  private repeat: RepeatMode = "off";

  constructor(
    audio: HTMLAudioElement,
    private cb: PlayerCallbacks = {},
  ) {
    this.audio = audio;
    this.audio.addEventListener("timeupdate", () =>
      this.cb.onTick?.(this.audio.currentTime, this.audio.duration || 0),
    );
    this.audio.addEventListener("durationchange", () =>
      this.cb.onTick?.(this.audio.currentTime, this.audio.duration || 0),
    );
    this.audio.addEventListener("play", () => this.cb.onState?.(true));
    this.audio.addEventListener("pause", () => this.cb.onState?.(false));
    this.audio.addEventListener("ended", () => void this.onEnded());
  }

  // -- Web Audio graph (only built when the visualizer is enabled) ----------
  //
  // Routing the <audio> element through a MediaElementAudioSourceNode makes
  // playback glitchy on WebKitGTK, so by default we let the element play
  // natively. The graph is created lazily (once) the first time the user turns
  // on the visualizer; from then on audio flows through the analyser.

  enableAnalyser() {
    if (this.ctx) {
      void this.ctx.resume();
      return;
    }
    this.ctx = new AudioContext();
    const source = this.ctx.createMediaElementSource(this.audio);
    this.analyser = this.ctx.createAnalyser();
    this.analyser.fftSize = 256;
    source.connect(this.analyser);
    this.analyser.connect(this.ctx.destination);
    void this.ctx.resume();
  }

  getAnalyser(): AnalyserNode | undefined {
    return this.analyser;
  }

  // -- Queue management -----------------------------------------------------

  private buildOrder(startIndex: number) {
    const all = this.queue.map((_, i) => i);
    if (this.shuffleOn && startIndex >= 0) {
      this.order = [startIndex, ...shuffle(all.filter((i) => i !== startIndex))];
    } else if (this.shuffleOn) {
      this.order = shuffle(all);
    } else {
      this.order = all;
    }
    this.pos = this.order.indexOf(Math.max(0, startIndex));
  }

  /** Load a song list and start playing at `startId` (or the first song). */
  load(songs: Song[], startId?: number) {
    this.queue = songs;
    const startIndex =
      startId != null ? songs.findIndex((s) => s.id === startId) : 0;
    this.buildOrder(Math.max(0, startIndex));
    if (this.order.length) void this.playAt(this.pos);
  }

  get current(): Song | null {
    return this.active;
  }

  get playing(): boolean {
    return !this.audio.paused && !this.audio.ended && !!this.active;
  }

  // -- Transport ------------------------------------------------------------

  private async playAt(orderPos: number) {
    await this.ctx?.resume(); // no-op unless the analyser graph is active

    // Leaving the previously active track early counts as a skip.
    this.commitPendingSkip();

    this.pos = orderPos;
    const song = this.queue[this.order[orderPos]];
    if (!song) return;

    this.active = song;
    this.endedNaturally = false;
    this.cb.onTrack?.(song);

    // Stream from the loopback HTTP server (see library.ts/audio_server.rs).
    // GStreamer can't play Tauri's asset:// scheme, and the previous in-memory
    // blob workaround bled audio between tracks; a real http:// src streams
    // cleanly with range/seek support.
    this.audio.src = audioUrl(song.path);

    try {
      await this.audio.play();
    } catch {
      /* autoplay may be blocked until a user gesture; user can press play */
    }
    await db.markPlayed(song.id);
    this.cb.onScored?.();
  }

  /** Apply the skip penalty to the active track if it was left before the end. */
  private commitPendingSkip() {
    const song = this.active;
    if (!song || this.endedNaturally) return;
    if (this.audio.readyState === 0) return; // never actually started
    const delta = skipDelta(this.audio.currentTime);
    if (delta !== 0) {
      void db.applyScore(song.id, delta, "skip").then(() => this.cb.onScored?.());
    }
  }

  private async onEnded() {
    const song = this.active;
    this.endedNaturally = true;
    if (song) {
      await db.applyScore(song.id, completeDelta(), "complete");
      this.cb.onScored?.();
    }
    if (this.repeat === "one") {
      this.endedNaturally = false;
      this.audio.currentTime = 0;
      void this.audio.play();
      return;
    }
    this.next(true);
  }

  togglePlay() {
    if (!this.active) return;
    if (this.audio.paused) {
      void this.ctx?.resume(); // no-op unless the analyser graph is active
      void this.audio.play();
    } else {
      this.audio.pause();
    }
  }

  play() {
    if (this.active && this.audio.paused) this.togglePlay();
  }

  pause() {
    if (this.playing) this.audio.pause();
  }

  next(auto = false) {
    if (!this.order.length) return;
    let nextPos = this.pos + 1;
    if (nextPos >= this.order.length) {
      if (this.repeat === "all") {
        nextPos = 0;
      } else {
        if (!auto) this.commitPendingSkip();
        return; // reached the end of the queue
      }
    }
    void this.playAt(nextPos);
  }

  prev() {
    if (!this.order.length) return;
    // Restart the current track if we're more than 3s in (common player UX).
    if (this.audio.currentTime > 3) {
      this.audio.currentTime = 0;
      return;
    }
    const prevPos = this.pos - 1 < 0 ? this.order.length - 1 : this.pos - 1;
    void this.playAt(prevPos);
  }

  seekFraction(fraction: number) {
    if (this.audio.duration) {
      this.audio.currentTime = fraction * this.audio.duration;
    }
  }

  setVolume(v: number) {
    this.audio.volume = Math.min(1, Math.max(0, v));
  }

  // -- Modes ----------------------------------------------------------------

  isShuffle() {
    return this.shuffleOn;
  }

  setShuffle(on: boolean) {
    this.shuffleOn = on;
    if (!this.queue.length) return;
    const activeIndex = this.active
      ? this.queue.findIndex((s) => s.id === this.active!.id)
      : 0;
    this.buildOrder(activeIndex);
  }

  getRepeat() {
    return this.repeat;
  }

  cycleRepeat(): RepeatMode {
    this.repeat =
      this.repeat === "off" ? "all" : this.repeat === "all" ? "one" : "off";
    return this.repeat;
  }
}
