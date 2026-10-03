import { z } from "zod";

export const SESSION_STATUSES = [
  "DRAFT",
  "IN_REVIEW",
  "COMPLETED",
  "ARCHIVED",
  "DELETING",
  "DELETE_FAILED",
] as const;
export const MEDIA_STATUSES = [
  "PENDING_UPLOAD",
  "UPLOADING",
  "UPLOADED",
  "PROCESSING",
  "READY",
  "FAILED",
  "CANCELLED",
] as const;
export const ANNOTATION_TYPES = ["RHYTHM", "FINGERING", "EMOTION"] as const;
export const GOAL_CATEGORIES = [
  "RHYTHM",
  "FINGERING",
  "EMOTION",
  "CONTINUITY",
  "PITCH",
  "SPEED",
  "REPERTOIRE",
  "OTHER",
] as const;
export const METRIC_TYPES = [
  "DURATION",
  "COUNT",
  "SPEED",
  "ACCURACY",
  "SUBJECTIVE_SCORE",
  "CUSTOM",
] as const;
export const EVIDENCE_REQUIREMENTS = ["NONE", "AUDIO", "SELF_REVIEW", "AUDIO_AND_SELF_REVIEW"] as const;
export const GOAL_STATUSES = ["OPEN", "IN_PROGRESS", "ACHIEVED", "MISSED", "CANCELLED"] as const;

const requiredText = (label: string, max: number) =>
  z.string().trim().min(1, `${label}不能为空`).max(max, `${label}不能超过 ${max} 个字符`);
const optionalText = (max: number, label: string) =>
  z.string().trim().max(max, `${label}不能超过 ${max} 个字符`).optional().nullable();

export const emailSchema = z.string().trim().toLowerCase().email("邮箱格式不正确").max(254);
export const passwordSchema = z
  .string()
  .min(10, "密码至少 10 位")
  .max(128, "密码不能超过 128 位")
  .regex(/[A-Za-z]/, "密码必须包含字母")
  .regex(/[0-9]/, "密码必须包含数字");

export const registerSchema = z.object({
  email: emailSchema,
  password: passwordSchema,
  displayName: requiredText("展示名", 80),
});
export const loginSchema = z.object({
  email: emailSchema,
  password: z.string().min(1, "请输入密码").max(128),
});
export const updateProfileSchema = z.object({
  displayName: requiredText("展示名", 80).optional(),
  defaultInstrument: optionalText(60, "默认乐器"),
  timezone: z.string().trim().min(1).max(64).optional(),
  locale: z.string().trim().min(2).max(16).optional(),
});
export const changePasswordSchema = z.object({
  currentPassword: z.string().min(1).max(128),
  newPassword: passwordSchema,
});

export const sessionCreateSchema = z.object({
  title: requiredText("练习标题", 120),
  instrument: requiredText("乐器", 60),
  startedAt: z.coerce.date(),
  focus: optionalText(500, "本次重点"),
  location: optionalText(120, "练习地点"),
  notes: optionalText(5000, "总体备注"),
  actualDurationMs: z.coerce.number().int().positive().max(86_400_000).optional().nullable(),
});
export const sessionUpdateSchema = sessionCreateSchema
  .partial()
  .extend({ version: z.coerce.number().int().nonnegative() });
export const sessionBatchSchema = z.object({
  ids: z.array(z.string().uuid()).min(1).max(100),
});
export const sessionListQuerySchema = z.object({
  q: z.string().trim().max(200).optional(),
  status: z.enum([...SESSION_STATUSES, "ALL"]).default("COMPLETED"),
  instrument: z.string().trim().max(60).optional(),
  annotationType: z.enum(ANNOTATION_TYPES).optional(),
  goalStatus: z.enum(GOAL_STATUSES).optional(),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
  sortBy: z.enum(["startedAt", "actualDurationMs", "annotationCount", "updatedAt"]).default("startedAt"),
  sortOrder: z.enum(["asc", "desc"]).default("desc"),
  cursor: z.string().uuid().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

const annotationCreateBaseSchema = z.object({
  mediaId: z.string().uuid(),
  type: z.enum(ANNOTATION_TYPES),
  severity: z.coerce.number().int().min(1).max(5),
  startMs: z.coerce.number().int().nonnegative(),
  endMs: z.coerce.number().int().positive(),
  title: requiredText("短标题", 80),
  description: optionalText(2000, "详细描述"),
  nextAction: optionalText(1000, "建议动作"),
});

export const annotationCreateSchema = annotationCreateBaseSchema
  .refine((value) => value.endMs > value.startMs, {
    path: ["endMs"],
    message: "结束时间必须晚于开始时间",
  })
  .refine((value) => value.endMs - value.startMs >= 100, {
    path: ["endMs"],
    message: "标记区间至少 100 毫秒",
  });
export const annotationUpdateSchema = annotationCreateBaseSchema.partial().omit({ mediaId: true });
export const annotationListQuerySchema = z.object({
  mediaId: z.string().uuid().optional(),
  type: z.enum(ANNOTATION_TYPES).optional(),
});

export const reviewDraftSchema = z.object({
  goodPoints: optionalText(3000, "做得好的地方"),
  mainIssues: optionalText(3000, "主要问题"),
  nextFocus: optionalText(500, "下次练习重点"),
  noIssues: z.boolean().default(false),
  suggestedNextPracticeAt: z.coerce.date().optional().nullable(),
});
export const reviewSaveSchema = reviewDraftSchema.extend({
  version: z.coerce.number().int().nonnegative(),
});

export const goalCreateSchema = z.object({
  sourceSessionId: z.string().uuid(),
  annotationId: z.string().uuid().optional().nullable(),
  title: requiredText("目标标题", 160),
  category: z.enum(GOAL_CATEGORIES),
  metricType: z.enum(METRIC_TYPES),
  baselineValue: z.coerce.number().finite().optional().nullable(),
  targetValue: z.coerce.number().finite(),
  unit: requiredText("单位", 24),
  dueDate: z.coerce.date(),
  method: optionalText(3000, "练习方法"),
  evidenceRequirement: z.enum(EVIDENCE_REQUIREMENTS),
});
export const goalUpdateSchema = goalCreateSchema
  .omit({ sourceSessionId: true })
  .partial()
  .extend({ version: z.coerce.number().int().nonnegative() });
export const goalListQuerySchema = z.object({
  status: z.enum(GOAL_STATUSES).optional(),
  category: z.enum(GOAL_CATEGORIES).optional(),
  instrument: z.string().trim().max(60).optional(),
  dueBefore: z.coerce.date().optional(),
  cursor: z.string().uuid().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(30),
});
export const goalProgressCreateSchema = z.object({
  sessionId: z.string().uuid(),
  actualValue: z.coerce.number().finite(),
  note: optionalText(1000, "进度备注"),
  evidenceMediaId: z.string().uuid().optional().nullable(),
  recordedAt: z.coerce.date().optional(),
});
export const goalCancelSchema = z.object({ reason: requiredText("取消原因", 1000) });
export const goalActivateSchema = z.object({
  dueDate: z.coerce.date().optional(),
  targetValue: z.coerce.number().finite().optional(),
});

export const completionGoalProgressSchema = goalProgressCreateSchema.omit({ sessionId: true }).extend({
  goalId: z.string().uuid(),
});

export const completionSchema = z.object({
  version: z.coerce.number().int().nonnegative(),
  review: reviewDraftSchema.extend({ nextFocus: requiredText("下次练习重点", 500) }),
  goalCreates: z.array(goalCreateSchema.omit({ sourceSessionId: true })).default([]),
  goalProgressUpdates: z.array(completionGoalProgressSchema).default([]),
  annotationVersion: z.coerce.number().int().nonnegative().optional(),
});

export const statisticsRangeSchema = z.object({
  from: z.coerce.date(),
  to: z.coerce.date(),
  timezone: z.string().trim().min(1).max(64).default("Asia/Shanghai"),
  instrument: z.string().trim().max(60).optional(),
});

export const createExportSchema = z.object({
  format: z.enum(["json", "csv"]).default("json"),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
});

export const idSchema = z.string().uuid();

// ---------------------------------------------------------------------------
// 教师复盘交接：带时间戳的只读分享、批注收集、撤销、合并与冲突版本
// ---------------------------------------------------------------------------

export const HANDOVER_REVIEW_FIELDS = ["goodPoints", "mainIssues", "nextFocus"] as const;
export type HandoverReviewField = (typeof HANDOVER_REVIEW_FIELDS)[number];

export const HANDOVER_ANNOTATION_KINDS = ["COMMENT", "SUGGESTION"] as const;
export type HandoverAnnotationKind = (typeof HANDOVER_ANNOTATION_KINDS)[number];

export const HANDOVER_ANNOTATION_STATUSES = ["PENDING", "REJECTED", "MERGED", "CONFLICTED", "RESOLVED"] as const;
export const HANDOVER_CONFLICT_REASONS = ["OVERLAP", "ANCHOR_DRIFT"] as const;
export type HandoverConflictReason = (typeof HANDOVER_CONFLICT_REASONS)[number];

export const handoverCreateSchema = z.object({
  sessionId: z.string().uuid(),
  title: requiredText("交接标题", 160),
});

export const handoverShareCreateSchema = z.object({
  label: optionalText(80, "分享备注"),
  expiresInSeconds: z.coerce.number().int().min(60).max(2_592_000).optional().nullable(),
});

export const handoverShareRevokeSchema = z.object({
  reason: optionalText(200, "撤销原因"),
});

export const handoverAnnotationCreateSchema = z
  .object({
    authorName: requiredText("批注人", 80),
    kind: z.enum(HANDOVER_ANNOTATION_KINDS),
    fieldPath: z.enum(HANDOVER_REVIEW_FIELDS),
    start: z.coerce.number().int().nonnegative(),
    end: z.coerce.number().int().positive(),
    quote: requiredText("引用原文", 2000),
    body: optionalText(2000, "批注说明"),
    replacement: z.string().max(2000, "替换文本不能超过 2000 个字符").optional().nullable(),
  })
  .refine((value) => value.end > value.start, {
    path: ["end"],
    message: "结束位置必须大于开始位置",
  })
  .refine((value) => value.kind !== "SUGGESTION" || value.replacement != null, {
    path: ["replacement"],
    message: "修改建议必须提供替换文本",
  });

export const handoverMergeSchema = z.object({
  annotationIds: z.array(z.string().uuid()).min(1).max(50),
});

export const handoverConflictResolveSchema = z.discriminatedUnion("strategy", [
  z.object({ strategy: z.literal("pick"), annotationId: z.string().uuid() }),
  z.object({ strategy: z.literal("custom"), text: z.string().max(2000, "替换文本不能超过 2000 个字符") }),
]);

export interface HandoverSuggestionInput {
  id: string;
  authorName: string;
  fieldPath: HandoverReviewField;
  start: number;
  end: number;
  quote: string;
  replacement: string;
}

export interface HandoverConflictVersion {
  annotationId: string;
  authorName: string;
  replacement: string;
  /** 仅应用该条建议后整个字段的文本，用于保留冲突版本 */
  resultingText: string;
}

export interface HandoverConflictPlan {
  reason: HandoverConflictReason;
  fieldPath: HandoverReviewField;
  /** 冲突发生时主文档中的原文片段 */
  baseText: string;
  start: number;
  end: number;
  versions: HandoverConflictVersion[];
}

export interface HandoverMergePlan {
  newFields: Record<HandoverReviewField, string>;
  applied: Array<{ annotationId: string; fieldPath: HandoverReviewField }>;
  conflicts: HandoverConflictPlan[];
}

/** 在文本中查找唯一定位；不存在或出现多次时返回 null */
export function locateUnique(text: string, needle: string): number | null {
  if (!needle) return null;
  const first = text.indexOf(needle);
  if (first === -1) return null;
  return text.indexOf(needle, first + 1) === -1 ? first : null;
}

/** 按起点倒序应用替换，避免偏移量互相污染；调用方需保证区间互不重叠 */
export function applyTextSuggestions(
  text: string,
  edits: Array<{ start: number; end: number; replacement: string }>,
): string {
  const ordered = [...edits].sort((a, b) => b.start - a.start || b.end - a.end);
  let result = text;
  for (const edit of ordered) {
    result = result.slice(0, edit.start) + edit.replacement + result.slice(edit.end);
  }
  return result;
}

/**
 * 规划批注合并：锚点精确命中的建议直接应用；
 * 区间重叠或锚点漂移的建议不改动主文档，完整保留各冲突版本等待人工裁决。
 */
export function planHandoverMerge(
  fields: Record<HandoverReviewField, string>,
  suggestions: HandoverSuggestionInput[],
): HandoverMergePlan {
  const newFields = { ...fields };
  const applied: HandoverMergePlan["applied"] = [];
  const conflicts: HandoverConflictPlan[] = [];

  for (const fieldPath of HANDOVER_REVIEW_FIELDS) {
    const text = fields[fieldPath];
    const located: Array<{ suggestion: HandoverSuggestionInput; start: number; end: number }> = [];

    for (const suggestion of suggestions.filter((item) => item.fieldPath === fieldPath)) {
      if (text.slice(suggestion.start, suggestion.end) === suggestion.quote) {
        located.push({ suggestion, start: suggestion.start, end: suggestion.end });
        continue;
      }
      // 锚点漂移：原文不在批注时的位置，保留“当前文本 / 建议文本”两个版本
      const relocated = locateUnique(text, suggestion.quote);
      conflicts.push({
        reason: "ANCHOR_DRIFT",
        fieldPath,
        baseText: suggestion.quote,
        start: relocated ?? suggestion.start,
        end: relocated == null ? suggestion.end : relocated + suggestion.quote.length,
        versions: [
          {
            annotationId: suggestion.id,
            authorName: suggestion.authorName,
            replacement: suggestion.replacement,
            resultingText:
              relocated == null
                ? text
                : applyTextSuggestions(text, [
                    { start: relocated, end: relocated + suggestion.quote.length, replacement: suggestion.replacement },
                  ]),
          },
        ],
      });
    }

    // 按起点排序后把链式重叠的区间归并到同一冲突组
    located.sort((a, b) => a.start - b.start || a.end - b.end);
    const groups: Array<typeof located> = [];
    for (const item of located) {
      const group = groups[groups.length - 1];
      const groupEnd = group ? Math.max(...group.map((member) => member.end)) : -1;
      if (group && item.start < groupEnd) group.push(item);
      else groups.push([item]);
    }

    const cleanEdits: Array<{ start: number; end: number; replacement: string }> = [];
    for (const group of groups) {
      if (group.length === 1) {
        const [only] = group;
        cleanEdits.push({ start: only!.start, end: only!.end, replacement: only!.suggestion.replacement });
        applied.push({ annotationId: only!.suggestion.id, fieldPath });
        continue;
      }
      const start = Math.min(...group.map((member) => member.start));
      const end = Math.max(...group.map((member) => member.end));
      conflicts.push({
        reason: "OVERLAP",
        fieldPath,
        baseText: text.slice(start, end),
        start,
        end,
        versions: group.map((member) => ({
          annotationId: member.suggestion.id,
          authorName: member.suggestion.authorName,
          replacement: member.suggestion.replacement,
          resultingText: applyTextSuggestions(text, [
            { start: member.start, end: member.end, replacement: member.suggestion.replacement },
          ]),
        })),
      });
    }

    newFields[fieldPath] = applyTextSuggestions(text, cleanEdits);
  }

  return { newFields, applied, conflicts };
}

export type SessionStatus = (typeof SESSION_STATUSES)[number];
export type MediaStatus = (typeof MEDIA_STATUSES)[number];
export type AnnotationType = (typeof ANNOTATION_TYPES)[number];
export type GoalCategory = (typeof GOAL_CATEGORIES)[number];
export type MetricType = (typeof METRIC_TYPES)[number];
export type GoalStatus = (typeof GOAL_STATUSES)[number];
export type EvidenceRequirement = (typeof EVIDENCE_REQUIREMENTS)[number];

export interface ApiErrorBody {
  error: {
    code: string;
    message: string;
    details?: unknown;
    traceId?: string;
  };
}

const allowedTransitions: Record<SessionStatus, SessionStatus[]> = {
  DRAFT: ["IN_REVIEW", "DELETING"],
  IN_REVIEW: ["DRAFT", "COMPLETED", "DELETING"],
  COMPLETED: ["ARCHIVED", "DELETING", "COMPLETED"],
  ARCHIVED: ["COMPLETED", "DELETING"],
  DELETING: ["DELETE_FAILED"],
  DELETE_FAILED: ["DELETING"],
};

export function canTransitionSession(from: SessionStatus, to: SessionStatus): boolean {
  return from === to || allowedTransitions[from].includes(to);
}

export function validateAnnotationRange(
  startMs: number,
  endMs: number,
  durationMs?: number | null,
): { ok: true } | { ok: false; code: string; message: string } {
  if (!Number.isInteger(startMs) || startMs < 0) {
    return { ok: false, code: "AUDIO_RANGE_INVALID", message: "开始时间必须是非负整数毫秒值" };
  }
  if (!Number.isInteger(endMs) || endMs <= startMs) {
    return { ok: false, code: "AUDIO_RANGE_INVALID", message: "结束时间必须晚于开始时间" };
  }
  if (endMs - startMs < 100) {
    return { ok: false, code: "AUDIO_RANGE_INVALID", message: "标记区间至少 100 毫秒" };
  }
  if (durationMs != null && endMs > durationMs) {
    return { ok: false, code: "AUDIO_RANGE_INVALID", message: "标记结束时间不能超出音频时长" };
  }
  return { ok: true };
}

export function isGoalProgressValid(actualValue: number, targetValue: number): boolean {
  return Number.isFinite(actualValue) && Number.isFinite(targetValue) && actualValue >= targetValue;
}

export function calculateSessionDuration(mediaDurationsMs: Array<number | null | undefined>): number {
  return mediaDurationsMs.reduce<number>((total, duration) => total + (duration && duration > 0 ? duration : 0), 0);
}

export function describeMissingReview(input: {
  readyMediaCount: number;
  annotationCount: number;
  noIssues: boolean;
  nextFocus?: string | null;
  openGoalCount: number;
  newGoalCount: number;
  progressUpdateCount: number;
}): string[] {
  const missing: string[] = [];
  if (input.readyMediaCount < 1) missing.push("至少需要一段已解析完成的音频");
  if (input.annotationCount < 1 && !input.noIssues) missing.push("请至少添加一个问题标记，或声明本次无异常");
  if (!input.nextFocus?.trim()) missing.push("请填写下次练习重点");
  if (input.openGoalCount < 1 && input.newGoalCount < 1) missing.push("请至少创建一个可执行目标");
  if (input.openGoalCount > 0 && input.progressUpdateCount < 1) {
    missing.push("已有未关闭目标时，本次至少记录一次目标进度");
  }
  return missing;
}
