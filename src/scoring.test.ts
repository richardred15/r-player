import { describe, expect, it } from "vitest";
import { completeDelta, likeDelta, skipDelta, SCORE } from "./scoring";

describe("skipDelta", () => {
  it("penalises a fast skip (<=30s) by 2", () => {
    expect(skipDelta(0)).toBe(-2);
    expect(skipDelta(15)).toBe(-2);
    expect(skipDelta(30)).toBe(-2);
  });

  it("penalises a slow skip (>30s, <=60s) by 1", () => {
    expect(skipDelta(31)).toBe(-1);
    expect(skipDelta(45)).toBe(-1);
    expect(skipDelta(60)).toBe(-1);
  });

  it("does not penalise skips after the 1-minute window", () => {
    expect(skipDelta(61)).toBe(0);
    expect(skipDelta(240)).toBe(0);
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
