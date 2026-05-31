import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { pruneMissing, upsertSongs } from "./db";
import type { SongMeta } from "./types";

interface StartedEvent {
  scanId: number;
  total: number;
}
interface ProgressEvent {
  scanId: number;
  scanned: number;
  total: number;
  batch: SongMeta[];
}
interface DoneEvent {
  scanId: number;
  total: number;
}

export interface ScanCallbacks {
  onProgress?: (scanned: number, total: number) => void;
  onDone?: (total: number) => void;
  onError?: (message: string) => void;
}

// Streaming scan state. Events from a superseded scan (older scanId) are ignored,
// and batches are upserted on a serial promise chain so they never contend on SQLite.
let activeScanId = 0;
let seenPaths = new Set<string>();
let upsertChain: Promise<void> = Promise.resolve();
let unlisteners: UnlistenFn[] = [];
let cbs: ScanCallbacks = {};

async function ensureListeners(): Promise<void> {
  if (unlisteners.length) return;

  unlisteners.push(
    await listen<StartedEvent>("scan:started", (e) => {
      activeScanId = e.payload.scanId;
      seenPaths = new Set();
      upsertChain = Promise.resolve();
      cbs.onProgress?.(0, e.payload.total);
    }),
  );

  unlisteners.push(
    await listen<ProgressEvent>("scan:progress", (e) => {
      const p = e.payload;
      if (p.scanId !== activeScanId) return; // superseded scan
      for (const m of p.batch) seenPaths.add(m.path);
      const batch = p.batch;
      upsertChain = upsertChain.then(() => upsertSongs(batch)).catch((err) => {
        console.error("upsert batch failed:", err);
      });
      cbs.onProgress?.(p.scanned, p.total);
    }),
  );

  unlisteners.push(
    await listen<DoneEvent>("scan:done", async (e) => {
      if (e.payload.scanId !== activeScanId) return;
      const paths = [...seenPaths];
      await upsertChain;
      await pruneMissing(paths);
      cbs.onDone?.(e.payload.total);
    }),
  );
}

/** Kick off a background, streaming scan of `path`. Resolves when scanning finishes
 *  (UI updates arrive incrementally via the callbacks before then). */
export async function startScan(
  path: string,
  callbacks: ScanCallbacks = {},
): Promise<void> {
  cbs = callbacks;
  await ensureListeners();
  try {
    await invoke("scan_library", { path });
  } catch (err) {
    cbs.onError?.(String(err));
  }
}
