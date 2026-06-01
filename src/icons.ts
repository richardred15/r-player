// Lucide icons rendered to SVG strings, so they work both in static markup and in
// the virtualized row templates (plain string interpolation, no DOM scanning).
import {
  AudioLines,
  ChevronLeft,
  Dice5,
  EllipsisVertical,
  FolderOpen,
  Heart,
  ListMusic,
  Music,
  RefreshCw,
  Pause,
  Play,
  Plus,
  Repeat,
  Repeat1,
  RotateCcw,
  Search,
  SkipBack,
  SkipForward,
  Shuffle,
  Trash2,
  Trophy,
  Volume2,
  X,
} from "lucide";

type IconNode = readonly (readonly [string, Record<string, string | number>])[];

const ICONS = {
  music: Music,
  list: ListMusic,
  liked: Heart,
  ranked: Trophy,
  unranked: Dice5,
  plus: Plus,
  shuffle: Shuffle,
  repeat: Repeat,
  repeat1: Repeat1,
  visualizer: AudioLines,
  search: Search,
  prev: SkipBack,
  play: Play,
  pause: Pause,
  next: SkipForward,
  volume: Volume2,
  heart: Heart,
  more: EllipsisVertical,
  close: X,
  trash: Trash2,
  reset: RotateCcw,
  folder: FolderOpen,
  refresh: RefreshCw,
  back: ChevronLeft,
} as const;

export type IconName = keyof typeof ICONS;

interface IconOpts {
  size?: number;
  cls?: string;
  /** Fill the shape with currentColor (e.g. a "liked" heart). */
  fill?: boolean;
  strokeWidth?: number;
}

/** Render a Lucide icon as an inline SVG string. */
export function icon(name: IconName, opts: IconOpts = {}): string {
  const { size = 18, cls = "", fill = false, strokeWidth = 2 } = opts;
  const body = (ICONS[name] as IconNode)
    .map(([tag, attrs]) => {
      const a = Object.entries(attrs)
        .map(([k, v]) => `${k}="${v}"`)
        .join(" ");
      return `<${tag} ${a} />`;
    })
    .join("");
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 24 24" fill="${
    fill ? "currentColor" : "none"
  }" stroke="currentColor" stroke-width="${strokeWidth}" stroke-linecap="round" stroke-linejoin="round" class="lucide ${cls}">${body}</svg>`;
}
