import { isModalOpen } from "./ui";

export interface ShortcutHandlers {
  togglePlay: () => void;
  next: () => void;
  prev: () => void;
  like: () => void;
  shuffle: () => void;
  repeat: () => void;
  visualizer: () => void;
  search: () => void;
  newPlaylist: () => void;
}

function isTyping(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName.toLowerCase();
  return tag === "input" || tag === "textarea" || target.isContentEditable;
}

/** Keyboard shortcuts for every action (see titles in index.html). */
export function registerShortcuts(h: ShortcutHandlers): void {
  window.addEventListener("keydown", (e) => {
    // Let the modal's own Esc handler and text inputs work normally.
    if (isModalOpen()) return;
    if (isTyping(e.target)) {
      if (e.key === "Escape") (e.target as HTMLElement).blur();
      return;
    }
    if (e.ctrlKey || e.metaKey || e.altKey) return;

    switch (e.key) {
      case " ":
        e.preventDefault();
        h.togglePlay();
        break;
      case "ArrowRight":
        h.next();
        break;
      case "ArrowLeft":
        h.prev();
        break;
      case "l":
      case "L":
        h.like();
        break;
      case "s":
      case "S":
        h.shuffle();
        break;
      case "r":
      case "R":
        h.repeat();
        break;
      case "v":
      case "V":
        h.visualizer();
        break;
      case "/":
        e.preventDefault();
        h.search();
        break;
      case "n":
      case "N":
        h.newPlaylist();
        break;
    }
  });
}
