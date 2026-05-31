/** FFT bar-graph visualizer driven by an AnalyserNode, rendered to a canvas. */
export class Visualizer {
  private raf = 0;
  private enabled = false;

  constructor(
    private canvas: HTMLCanvasElement,
    private getAnalyser: () => AnalyserNode | undefined,
  ) {}

  toggle(): boolean {
    this.enabled ? this.stop() : this.start();
    return this.enabled;
  }

  isEnabled() {
    return this.enabled;
  }

  start() {
    this.enabled = true;
    this.canvas.hidden = false;
    this.loop();
  }

  stop() {
    this.enabled = false;
    this.canvas.hidden = true;
    cancelAnimationFrame(this.raf);
    const ctx = this.canvas.getContext("2d");
    ctx?.clearRect(0, 0, this.canvas.width, this.canvas.height);
  }

  private loop = () => {
    if (!this.enabled) return;
    this.raf = requestAnimationFrame(this.loop);

    const analyser = this.getAnalyser();
    const ctx = this.canvas.getContext("2d");
    if (!analyser || !ctx) return;

    // Match the backing store to the displayed size for crisp bars.
    const w = (this.canvas.width = this.canvas.clientWidth);
    const h = (this.canvas.height = this.canvas.clientHeight);

    const bins = analyser.frequencyBinCount;
    const data = new Uint8Array(bins);
    analyser.getByteFrequencyData(data);

    ctx.clearRect(0, 0, w, h);
    const bars = Math.min(bins, 64);
    const gap = 2;
    const barWidth = (w - gap * (bars - 1)) / bars;
    const accent =
      getComputedStyle(this.canvas).getPropertyValue("--accent").trim() ||
      "#6c8cff";

    for (let i = 0; i < bars; i++) {
      const v = data[i] / 255;
      const barHeight = Math.max(1, v * h);
      ctx.fillStyle = accent;
      ctx.globalAlpha = 0.35 + v * 0.65;
      ctx.fillRect(i * (barWidth + gap), h - barHeight, barWidth, barHeight);
    }
    ctx.globalAlpha = 1;
  };
}
