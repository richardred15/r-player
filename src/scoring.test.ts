import { describe, expect, it } from "vitest";
import { completeDelta, likeDelta, skipDelta, SCORE } from "./scoring";

describe("skipDelta (fraction of track heard)", () => {
  it("heavily penalises skipping in the first quarter (<25% → -2)", () => {
    expect(skipDelta(10, 200)).toBe(-2); // 5%
    expect(skipDelta(49, 200)).toBe(-2); // 24.5%
  });

  it("lightly penalises skipping in the second quarter (25–50% → -1)", () => {
    expect(skipDelta(50, 200)).toBe(-1); // 25%
    expect(skipDelta(60, 200)).toBe(-1); // 30%
    expect(skipDelta(99, 200)).toBe(-1); // 49.5%
  });

  it("does not penalise a fair listen (50–90% → 0)", () => {
    expect(skipDelta(100, 200)).toBe(0); // 50%
    expect(skipDelta(120, 200)).toBe(0); // 60%
    expect(skipDelta(179, 200)).toBe(0); // 89.5%
  });

  it("counts a near-complete skip (≥90%) as a full play (+1)", () => {
    expect(skipDelta(180, 200)).toBe(SCORE.COMPLETE); // 90%
    expect(skipDelta(190, 200)).toBe(1); // 95%
  });

  it("works for short songs by fraction, not absolute seconds", () => {
    // 20s track — the same fractions apply where the old 30/60s rules couldn't.
    expect(skipDelta(3, 20)).toBe(-2); // 15%
    expect(skipDelta(6, 20)).toBe(-1); // 30%
    expect(skipDelta(12, 20)).toBe(0); // 60%
    expect(skipDelta(19, 20)).toBe(1); // 95%
  });

  it("does not penalise when the duration is unknown", () => {
    expect(skipDelta(10, 0)).toBe(0);
    expect(skipDelta(10, NaN)).toBe(0);
    expect(skipDelta(10, -1)).toBe(0);
  });
});

describe("completeDelta", () => {
  it("rewards a completed play with +1", () => {
    expect(completeDelta()).toBe(SCORE.COMPLETE);
    expect(completeDelta()).toBe(1);
  });
});

describe("likeDelta", () => {
  it("adds 10 when liking and removes 10 when unliking", () => {
    expect(likeDelta(true)).toBe(10);
    expect(likeDelta(false)).toBe(-10);
  });
});
