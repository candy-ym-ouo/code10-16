import { describe, expect, it } from "vitest";
import {
  calculateSessionDuration,
  canTransitionSession,
  describeMissingReview,
  isGoalProgressValid,
  isShareActive,
  planAnnotationMerge,
  validateAnnotationRange,
} from "../src/index.js";

describe("session state machine", () => {
  it("allows the required completion transition", () => {
    expect(canTransitionSession("IN_REVIEW", "COMPLETED")).toBe(true);
    expect(canTransitionSession("DRAFT", "COMPLETED")).toBe(false);
  });
});

describe("annotation range", () => {
  it("rejects ranges under 100ms and outside media", () => {
    expect(validateAnnotationRange(100, 150, 1000)).toMatchObject({ ok: false });
    expect(validateAnnotationRange(900, 1100, 1000)).toMatchObject({ ok: false });
    expect(validateAnnotationRange(100, 250, 1000)).toEqual({ ok: true });
  });
});

describe("review completion", () => {
  it("returns every missing item instead of a generic failure", () => {
    expect(
      describeMissingReview({
        readyMediaCount: 0,
        annotationCount: 0,
        noIssues: false,
        nextFocus: "",
        openGoalCount: 0,
        newGoalCount: 0,
        progressUpdateCount: 0,
      }),
    ).toHaveLength(4);
  });
});

describe("goal values", () => {
  it("suggests achieved only when actual reaches target", () => {
    expect(isGoalProgressValid(90, 88)).toBe(true);
    expect(isGoalProgressValid(87, 88)).toBe(false);
  });

  it("sums only valid media durations", () => {
    expect(calculateSessionDuration([1000, null, 2500, -1])).toBe(3500);
  });
});

describe("share validity", () => {
  const now = new Date("2026-10-03T12:00:00.000Z");

  it("is active when neither revoked nor expired", () => {
    expect(isShareActive({ revokedAt: null, expiresAt: null }, now)).toBe(true);
    expect(isShareActive({ revokedAt: null, expiresAt: "2026-10-04T12:00:00.000Z" }, now)).toBe(true);
  });

  it("revocation takes effect immediately", () => {
    expect(isShareActive({ revokedAt: "2026-10-03T11:59:59.000Z", expiresAt: null }, now)).toBe(false);
    expect(isShareActive({ revokedAt: now.toISOString(), expiresAt: "2026-10-10T00:00:00.000Z" }, now)).toBe(false);
  });

  it("expires exactly at the deadline", () => {
    expect(isShareActive({ revokedAt: null, expiresAt: "2026-10-03T12:00:00.000Z" }, now)).toBe(false);
    expect(isShareActive({ revokedAt: null, expiresAt: "2026-10-03T11:59:59.999Z" }, now)).toBe(false);
  });
});

describe("annotation merge planning", () => {
  it("merges annotations whose content agrees, ignoring whitespace", () => {
    const plan = planAnnotationMerge([
      { id: "a", section: "MAIN_ISSUES", content: "  第 17 小节换把偏高 " },
      { id: "b", section: "MAIN_ISSUES", content: "第 17 小节换把偏高" },
      { id: "c", section: "NEXT_FOCUS", content: "慢练音准" },
    ]);
    expect(plan.mergedIds).toEqual(["a", "b", "c"]);
    expect(plan.conflicts).toEqual([]);
  });

  it("keeps every conflicting version within a section", () => {
    const plan = planAnnotationMerge([
      { id: "a", section: "MAIN_ISSUES", content: "节奏抢拍" },
      { id: "b", section: "MAIN_ISSUES", content: "节奏拖拍" },
      { id: "c", section: "GOALS", content: "目标合理" },
    ]);
    expect(plan.mergedIds).toEqual(["c"]);
    expect(plan.conflicts).toHaveLength(1);
    expect(plan.conflicts[0]).toMatchObject({ section: "MAIN_ISSUES", annotationIds: ["a", "b"] });
    expect(plan.conflicts[0]?.contents).toHaveLength(2);
  });

  it("treats the same content in different sections as independent merges", () => {
    const plan = planAnnotationMerge([
      { id: "a", section: "GOOD_POINTS", content: "音准稳定" },
      { id: "b", section: "MAIN_ISSUES", content: "音准稳定" },
    ]);
    expect(plan.mergedIds).toEqual(["a", "b"]);
    expect(plan.conflicts).toEqual([]);
  });
});
