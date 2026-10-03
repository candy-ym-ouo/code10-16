import { describe, expect, it } from "vitest";
import {
  applyTextSuggestions,
  handoverAnnotationCreateSchema,
  locateUnique,
  planHandoverMerge,
  type HandoverSuggestionInput,
} from "../src/index.js";

const FIELDS = {
  goodPoints: "节奏稳定，换把干净。",
  mainIssues: "第 17 小节抢拍，长弓发音发虚。",
  nextFocus: "节拍器 84 BPM 慢练。",
} as const;

function suggestion(partial: Partial<HandoverSuggestionInput> & Pick<HandoverSuggestionInput, "id">): HandoverSuggestionInput {
  return {
    authorName: "王老师",
    fieldPath: "mainIssues",
    start: 0,
    end: 2,
    quote: "第 1",
    replacement: "第 3",
    ...partial,
  };
}

describe("applyTextSuggestions", () => {
  it("applies edits back to front without corrupting offsets", () => {
    expect(
      applyTextSuggestions("abcdef", [
        { start: 0, end: 1, replacement: "XX" },
        { start: 4, end: 5, replacement: "Y" },
      ]),
    ).toBe("XXbcdYf");
  });
});

describe("locateUnique", () => {
  it("returns the index only when the needle occurs exactly once", () => {
    expect(locateUnique("abcabc", "bc")).toBeNull();
    expect(locateUnique("abcabc", "cabc")).toBe(2);
    expect(locateUnique("abc", "z")).toBeNull();
  });
});

describe("planHandoverMerge", () => {
  it("applies non-overlapping suggestions across fields", () => {
    const plan = planHandoverMerge({ ...FIELDS }, [
      suggestion({ id: "a1", start: 0, end: 5, quote: "第 17 ", replacement: "第 18 " }),
      suggestion({ id: "a2", fieldPath: "nextFocus", start: 0, end: 3, quote: "节拍器", replacement: "跟着节拍器" }),
    ]);
    expect(plan.conflicts).toHaveLength(0);
    expect(plan.applied.map((item) => item.annotationId).sort()).toEqual(["a1", "a2"]);
    expect(plan.newFields.mainIssues).toBe("第 18 小节抢拍，长弓发音发虚。");
    expect(plan.newFields.nextFocus).toBe("跟着节拍器 84 BPM 慢练。");
    expect(plan.newFields.goodPoints).toBe(FIELDS.goodPoints);
  });

  it("keeps both versions when suggestions overlap", () => {
    const plan = planHandoverMerge({ ...FIELDS }, [
      suggestion({ id: "b1", authorName: "王老师", start: 0, end: 6, quote: "第 17 小", replacement: "第 18 大" }),
      suggestion({ id: "b2", authorName: "李老师", start: 3, end: 8, quote: "7 小节抢", replacement: "7 小节拖" }),
    ]);
    expect(plan.applied).toHaveLength(0);
    expect(plan.newFields.mainIssues).toBe(FIELDS.mainIssues);
    expect(plan.conflicts).toHaveLength(1);
    const conflict = plan.conflicts[0]!;
    expect(conflict.reason).toBe("OVERLAP");
    expect(conflict.baseText).toBe("第 17 小节抢");
    expect(conflict.versions.map((version) => version.annotationId).sort()).toEqual(["b1", "b2"]);
    const b1 = conflict.versions.find((version) => version.annotationId === "b1")!;
    const b2 = conflict.versions.find((version) => version.annotationId === "b2")!;
    expect(b1.resultingText).toBe("第 18 大节抢拍，长弓发音发虚。");
    expect(b2.resultingText).toBe("第 17 小节拖拍，长弓发音发虚。");
  });

  it("groups chained overlaps into a single conflict", () => {
    const plan = planHandoverMerge({ ...FIELDS }, [
      suggestion({ id: "c1", start: 0, end: 4, quote: "第 17", replacement: "甲" }),
      suggestion({ id: "c2", start: 3, end: 6, quote: "7 小", replacement: "乙" }),
      suggestion({ id: "c3", start: 5, end: 8, quote: "小节抢", replacement: "丙" }),
    ]);
    expect(plan.conflicts).toHaveLength(1);
    expect(plan.conflicts[0]!.versions).toHaveLength(3);
  });

  it("flags anchor drift when the quote moved and keeps the proposed version", () => {
    const drifted = suggestion({ id: "d1", start: 0, end: 2, quote: "长弓", replacement: "短弓" });
    const plan = planHandoverMerge({ ...FIELDS }, [drifted]);
    expect(plan.applied).toHaveLength(0);
    expect(plan.newFields.mainIssues).toBe(FIELDS.mainIssues);
    const conflict = plan.conflicts[0]!;
    expect(conflict.reason).toBe("ANCHOR_DRIFT");
    expect(conflict.baseText).toBe("长弓");
    expect(conflict.versions[0]!.resultingText).toBe("第 17 小节抢拍，短弓发音发虚。");
  });

  it("flags anchor drift without applying when the quote is gone", () => {
    const plan = planHandoverMerge({ ...FIELDS }, [
      suggestion({ id: "e1", start: 0, end: 2, quote: "不存在", replacement: "任意" }),
    ]);
    const conflict = plan.conflicts[0]!;
    expect(conflict.reason).toBe("ANCHOR_DRIFT");
    expect(conflict.versions[0]!.resultingText).toBe(FIELDS.mainIssues);
    expect(conflict.versions[0]!.replacement).toBe("任意");
  });

  it("treats identical ranges from two reviewers as a conflict", () => {
    const plan = planHandoverMerge({ ...FIELDS }, [
      suggestion({ id: "f1", start: 0, end: 2, quote: "第 ", replacement: "甲" }),
      suggestion({ id: "f2", start: 0, end: 2, quote: "第 ", replacement: "乙" }),
    ]);
    expect(plan.conflicts).toHaveLength(1);
    expect(plan.conflicts[0]!.reason).toBe("OVERLAP");
  });
});

describe("handoverAnnotationCreateSchema", () => {
  const base = {
    authorName: "王老师",
    kind: "COMMENT",
    fieldPath: "mainIssues",
    start: 0,
    end: 2,
    quote: "第 1",
  };

  it("requires replacement text for suggestions", () => {
    expect(handoverAnnotationCreateSchema.safeParse({ ...base, kind: "SUGGESTION" }).success).toBe(false);
    expect(
      handoverAnnotationCreateSchema.safeParse({ ...base, kind: "SUGGESTION", replacement: "" }).success,
    ).toBe(true);
  });

  it("rejects empty or inverted ranges", () => {
    expect(handoverAnnotationCreateSchema.safeParse({ ...base, start: 2, end: 2 }).success).toBe(false);
    expect(handoverAnnotationCreateSchema.safeParse({ ...base, start: 3, end: 2 }).success).toBe(false);
  });
});
