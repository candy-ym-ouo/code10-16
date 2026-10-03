import type { FastifyRequest } from "fastify";
import type { Prisma } from "@prisma/client";
import {
  HANDOVER_REVIEW_FIELDS,
  locateUnique,
  planHandoverMerge,
  type HandoverConflictVersion,
  type HandoverReviewField,
  type HandoverSuggestionInput,
} from "@practice/contracts";
import { audit } from "../lib/audit.js";
import { AppError, notFound } from "../lib/errors.js";
import { prisma } from "../lib/prisma.js";
import { createShareToken, hashShareToken } from "../lib/security.js";

const AUDIT_RESOURCE = "REVIEW_HANDOVER";

const shareSafeSelect = {
  id: true,
  label: true,
  expiresAt: true,
  revokedAt: true,
  revokedReason: true,
  lastAccessedAt: true,
  createdAt: true,
} as const;

const publicAnnotationSelect = {
  id: true,
  authorName: true,
  kind: true,
  fieldPath: true,
  startOffset: true,
  endOffset: true,
  quote: true,
  body: true,
  replacement: true,
  status: true,
  createdAt: true,
} as const;

export interface HandoverSnapshot {
  capturedAt: string;
  sessionVersion: number;
  session: {
    id: string;
    title: string;
    instrument: string;
    focus: string | null;
    location: string | null;
    startedAt: string;
  };
  review: Record<HandoverReviewField, string> & { noIssues: boolean; completedAt: string | null };
  markers: Array<{
    type: string;
    severity: number;
    startMs: number;
    endMs: number;
    title: string;
    description: string | null;
  }>;
}

export interface CreateHandoverInput {
  sessionId: string;
  title: string;
}

export interface CreateShareInput {
  label?: string | null;
  expiresInSeconds?: number | null;
}

export interface SharedAnnotationInput {
  authorName: string;
  kind: "COMMENT" | "SUGGESTION";
  fieldPath: HandoverReviewField;
  start: number;
  end: number;
  quote: string;
  body?: string | null;
  replacement?: string | null;
}

export type ResolveConflictInput =
  | { strategy: "pick"; annotationId: string }
  | { strategy: "custom"; text: string };

export async function createHandover(request: FastifyRequest, userId: string, input: CreateHandoverInput) {
  const session = await prisma.practiceSession.findFirst({
    where: { id: input.sessionId, userId },
    include: { review: true, annotations: { orderBy: [{ startMs: "asc" }, { createdAt: "asc" }] } },
  });
  if (!session) throw notFound();
  if (!session.review) throw new AppError(409, "HANDOVER_NO_REVIEW", "练习还没有复盘内容，无法交接");

  const snapshot: HandoverSnapshot = {
    capturedAt: new Date().toISOString(),
    sessionVersion: session.version,
    session: {
      id: session.id,
      title: session.title,
      instrument: session.instrument,
      focus: session.focus,
      location: session.location,
      startedAt: session.startedAt.toISOString(),
    },
    review: {
      goodPoints: session.review.goodPoints ?? "",
      mainIssues: session.review.mainIssues ?? "",
      nextFocus: session.review.nextFocus ?? "",
      noIssues: session.review.noIssues,
      completedAt: session.review.completedAt?.toISOString() ?? null,
    },
    markers: session.annotations.map((marker) => ({
      type: marker.type,
      severity: marker.severity,
      startMs: Number(marker.startMs),
      endMs: Number(marker.endMs),
      title: marker.title,
      description: marker.description,
    })),
  };
  const handover = await prisma.reviewHandover.create({
    data: {
      userId,
      sessionId: session.id,
      title: input.title,
      snapshot: snapshot as unknown as Prisma.InputJsonValue,
    },
  });
  await audit(request, "HANDOVER_CREATED", AUDIT_RESOURCE, handover.id, "SUCCESS", {
    sessionId: session.id,
    title: input.title,
    capturedAt: snapshot.capturedAt,
  });
  return handover;
}

export async function listHandovers(userId: string) {
  return prisma.reviewHandover.findMany({
    where: { userId },
    orderBy: { createdAt: "desc" },
    include: {
      shares: { select: shareSafeSelect, orderBy: { createdAt: "asc" } },
      _count: {
        select: {
          annotations: { where: { status: "PENDING" } },
          conflicts: { where: { status: "OPEN" } },
        },
      },
    },
  });
}

export async function getHandover(userId: string, handoverId: string) {
  const handover = await prisma.reviewHandover.findFirst({
    where: { id: handoverId, userId },
    include: {
      shares: { select: shareSafeSelect, orderBy: { createdAt: "asc" } },
      annotations: { orderBy: { createdAt: "asc" } },
      conflicts: { orderBy: { createdAt: "asc" } },
    },
  });
  if (!handover) throw notFound();
  return handover;
}

export async function createShare(request: FastifyRequest, userId: string, handoverId: string, input: CreateShareInput) {
  const handover = await prisma.reviewHandover.findFirst({ where: { id: handoverId, userId }, select: { id: true } });
  if (!handover) throw notFound();
  const { raw, hash } = createShareToken();
  const share = await prisma.handoverShare.create({
    data: {
      handoverId,
      label: input.label ?? null,
      tokenHash: hash,
      expiresAt: input.expiresInSeconds ? new Date(Date.now() + input.expiresInSeconds * 1000) : null,
    },
    select: shareSafeSelect,
  });
  await audit(request, "HANDOVER_SHARE_CREATED", AUDIT_RESOURCE, handoverId, "SUCCESS", {
    shareId: share.id,
    label: share.label,
    expiresAt: share.expiresAt,
  });
  // 原始令牌只在创建响应中出现一次，服务端只保存哈希
  return { share, token: raw };
}

export async function revokeShare(
  request: FastifyRequest,
  userId: string,
  handoverId: string,
  shareId: string,
  reason: string | null,
) {
  const share = await prisma.handoverShare.findFirst({
    where: { id: shareId, handoverId, handover: { userId } },
    select: { id: true, revokedAt: true },
  });
  if (!share) throw notFound();
  if (share.revokedAt) {
    return prisma.handoverShare.findUniqueOrThrow({ where: { id: share.id }, select: shareSafeSelect });
  }
  const revoked = await prisma.handoverShare.update({
    where: { id: share.id },
    data: { revokedAt: new Date(), revokedReason: reason },
    select: shareSafeSelect,
  });
  await audit(request, "HANDOVER_SHARE_REVOKED", AUDIT_RESOURCE, handoverId, "SUCCESS", { shareId, reason });
  return revoked;
}

/**
 * 每个公开请求都重新读取数据库校验撤销与过期状态，
 * 因此 revoke 提交后下一个请求立即被拒绝，无需等待缓存失效。
 */
async function loadActiveShare(request: FastifyRequest, token: string) {
  const share = await prisma.handoverShare.findUnique({
    where: { tokenHash: hashShareToken(token) },
    include: { handover: true },
  });
  if (!share) throw notFound();
  if (share.revokedAt) {
    await audit(request, "HANDOVER_SHARE_ACCESS_DENIED", AUDIT_RESOURCE, share.handoverId, "FAILURE", {
      shareId: share.id,
      reason: "REVOKED",
      revokedAt: share.revokedAt,
    });
    throw new AppError(403, "SHARE_REVOKED", "分享已被撤销");
  }
  if (share.expiresAt && share.expiresAt.getTime() <= Date.now()) {
    await audit(request, "HANDOVER_SHARE_ACCESS_DENIED", AUDIT_RESOURCE, share.handoverId, "FAILURE", {
      shareId: share.id,
      reason: "EXPIRED",
      expiresAt: share.expiresAt,
    });
    throw new AppError(410, "SHARE_EXPIRED", "分享已过期");
  }
  return share;
}

export async function getSharedSnapshot(request: FastifyRequest, token: string) {
  const share = await loadActiveShare(request, token);
  await prisma.handoverShare.update({ where: { id: share.id }, data: { lastAccessedAt: new Date() } });
  await audit(request, "HANDOVER_SHARE_ACCESSED", AUDIT_RESOURCE, share.handoverId, "SUCCESS", { shareId: share.id });
  return {
    handover: { title: share.handover.title },
    share: { label: share.label, createdAt: share.createdAt, expiresAt: share.expiresAt },
    snapshot: share.handover.snapshot as unknown as HandoverSnapshot,
  };
}

export async function listSharedAnnotations(request: FastifyRequest, token: string) {
  const share = await loadActiveShare(request, token);
  const annotations = await prisma.handoverAnnotation.findMany({
    where: { handoverId: share.handoverId },
    orderBy: { createdAt: "asc" },
    select: publicAnnotationSelect,
  });
  return { annotations };
}

export async function addSharedAnnotation(request: FastifyRequest, token: string, input: SharedAnnotationInput) {
  const share = await loadActiveShare(request, token);
  const snapshot = share.handover.snapshot as unknown as HandoverSnapshot;
  const fieldText = snapshot.review[input.fieldPath] ?? "";
  if (input.end > fieldText.length || fieldText.slice(input.start, input.end) !== input.quote) {
    await audit(request, "HANDOVER_ANNOTATION_CREATED", AUDIT_RESOURCE, share.handoverId, "FAILURE", {
      shareId: share.id,
      reason: "ANCHOR_MISMATCH",
      fieldPath: input.fieldPath,
    });
    throw new AppError(400, "ANCHOR_MISMATCH", "引用原文与快照内容不一致，请刷新后重新选择");
  }
  const annotation = await prisma.handoverAnnotation.create({
    data: {
      handoverId: share.handoverId,
      shareId: share.id,
      authorName: input.authorName,
      kind: input.kind,
      fieldPath: input.fieldPath,
      startOffset: input.start,
      endOffset: input.end,
      quote: input.quote,
      body: input.body ?? null,
      replacement: input.kind === "SUGGESTION" ? (input.replacement ?? "") : null,
    },
  });
  await audit(request, "HANDOVER_ANNOTATION_CREATED", AUDIT_RESOURCE, share.handoverId, "SUCCESS", {
    shareId: share.id,
    annotationId: annotation.id,
    kind: annotation.kind,
    fieldPath: annotation.fieldPath,
    authorName: annotation.authorName,
  });
  return annotation;
}

export async function rejectAnnotation(request: FastifyRequest, userId: string, handoverId: string, annotationId: string) {
  const annotation = await prisma.handoverAnnotation.findFirst({
    where: { id: annotationId, handoverId, handover: { userId } },
    select: { id: true, status: true },
  });
  if (!annotation) throw notFound();
  if (annotation.status !== "PENDING") {
    throw new AppError(409, "ANNOTATION_NOT_PENDING", "只有待处理的批注可以驳回");
  }
  const updated = await prisma.handoverAnnotation.update({ where: { id: annotation.id }, data: { status: "REJECTED" } });
  await audit(request, "HANDOVER_ANNOTATION_REJECTED", AUDIT_RESOURCE, handoverId, "SUCCESS", { annotationId });
  return updated;
}

export async function mergeAnnotations(
  request: FastifyRequest,
  userId: string,
  handoverId: string,
  annotationIds: string[],
) {
  const handover = await prisma.reviewHandover.findFirst({
    where: { id: handoverId, userId },
    include: { session: { include: { review: true } } },
  });
  if (!handover) throw notFound();
  const review = handover.session.review;
  if (!review) throw new AppError(409, "HANDOVER_NO_REVIEW", "练习还没有复盘内容，无法合并");

  const uniqueIds = [...new Set(annotationIds)];
  const annotations = await prisma.handoverAnnotation.findMany({
    where: { id: { in: uniqueIds }, handoverId },
  });
  if (annotations.length !== uniqueIds.length) throw notFound();
  const notPending = annotations.filter((annotation) => annotation.status !== "PENDING");
  if (notPending.length > 0) {
    throw new AppError(409, "ANNOTATION_NOT_PENDING", "存在已处理的批注，请刷新后重试", {
      annotationIds: notPending.map((annotation) => annotation.id),
    });
  }

  const fields: Record<HandoverReviewField, string> = {
    goodPoints: review.goodPoints ?? "",
    mainIssues: review.mainIssues ?? "",
    nextFocus: review.nextFocus ?? "",
  };
  const suggestions: HandoverSuggestionInput[] = annotations
    .filter((annotation) => annotation.kind === "SUGGESTION")
    .map((annotation) => ({
      id: annotation.id,
      authorName: annotation.authorName,
      fieldPath: annotation.fieldPath as HandoverReviewField,
      start: annotation.startOffset,
      end: annotation.endOffset,
      quote: annotation.quote,
      replacement: annotation.replacement ?? "",
    }));
  const plan = planHandoverMerge(fields, suggestions);
  const appliedIds = plan.applied.map((item) => item.annotationId);
  const commentIds = annotations.filter((annotation) => annotation.kind === "COMMENT").map((annotation) => annotation.id);
  const conflictedIds = plan.conflicts.flatMap((conflict) => conflict.versions.map((version) => version.annotationId));

  const result = await prisma.$transaction(async (tx) => {
    const changedFields = HANDOVER_REVIEW_FIELDS.filter((field) => plan.newFields[field] !== fields[field]);
    const updatedReview =
      changedFields.length > 0
        ? await tx.sessionReview.update({
            where: { sessionId: handover.sessionId },
            data: Object.fromEntries(changedFields.map((field) => [field, plan.newFields[field]])),
          })
        : review;
    const bumped = await tx.practiceSession.updateMany({
      where: { id: handover.sessionId, version: handover.session.version },
      data: { version: { increment: 1 } },
    });
    if (bumped.count !== 1) throw new AppError(409, "VERSION_CONFLICT", "练习已在其他窗口被修改");
    const mergedIds = [...appliedIds, ...commentIds];
    if (mergedIds.length > 0) {
      await tx.handoverAnnotation.updateMany({ where: { id: { in: mergedIds } }, data: { status: "MERGED" } });
    }
    if (conflictedIds.length > 0) {
      await tx.handoverAnnotation.updateMany({ where: { id: { in: conflictedIds } }, data: { status: "CONFLICTED" } });
    }
    const conflicts = [];
    for (const conflict of plan.conflicts) {
      conflicts.push(
        await tx.handoverConflict.create({
          data: {
            handoverId,
            fieldPath: conflict.fieldPath,
            reason: conflict.reason,
            baseText: conflict.baseText,
            versions: conflict.versions as unknown as Prisma.InputJsonValue,
          },
        }),
      );
    }
    return { review: updatedReview, conflicts };
  });

  await audit(request, "HANDOVER_MERGED", AUDIT_RESOURCE, handoverId, "SUCCESS", {
    appliedAnnotationIds: appliedIds,
    commentAnnotationIds: commentIds,
    conflictedAnnotationIds: conflictedIds,
    conflictIds: result.conflicts.map((conflict) => conflict.id),
  });
  return { applied: appliedIds, comments: commentIds, conflicts: result.conflicts, review: result.review };
}

export async function resolveConflict(
  request: FastifyRequest,
  userId: string,
  handoverId: string,
  conflictId: string,
  input: ResolveConflictInput,
) {
  const conflict = await prisma.handoverConflict.findFirst({
    where: { id: conflictId, handoverId, handover: { userId } },
    include: { handover: { include: { session: { include: { review: true } } } } },
  });
  if (!conflict) throw notFound();
  if (conflict.status !== "OPEN") throw new AppError(409, "CONFLICT_ALREADY_RESOLVED", "冲突已处理");
  const review = conflict.handover.session.review;
  if (!review) throw new AppError(409, "HANDOVER_NO_REVIEW", "练习还没有复盘内容");

  const versions = conflict.versions as unknown as HandoverConflictVersion[];
  let replacement: string;
  let pickedAnnotationId: string | null = null;
  if (input.strategy === "pick") {
    const version = versions.find((item) => item.annotationId === input.annotationId);
    if (!version) throw new AppError(400, "CONFLICT_VERSION_UNKNOWN", "所选版本不在冲突中");
    replacement = version.replacement;
    pickedAnnotationId = version.annotationId;
  } else {
    replacement = input.text;
  }

  const fieldPath = conflict.fieldPath as HandoverReviewField;
  const currentText = review[fieldPath] ?? "";
  const anchor = locateUnique(currentText, conflict.baseText);
  if (anchor == null) {
    throw new AppError(409, "ANCHOR_DRIFT", "冲突原文已不在当前复盘中，请直接编辑复盘字段");
  }
  const newText = currentText.slice(0, anchor) + replacement + currentText.slice(anchor + conflict.baseText.length);
  const involvedAnnotationIds = versions.map((version) => version.annotationId);

  const result = await prisma.$transaction(async (tx) => {
    const updatedReview = await tx.sessionReview.update({
      where: { sessionId: conflict.handover.sessionId },
      data: { [fieldPath]: newText },
    });
    const bumped = await tx.practiceSession.updateMany({
      where: { id: conflict.handover.sessionId, version: conflict.handover.session.version },
      data: { version: { increment: 1 } },
    });
    if (bumped.count !== 1) throw new AppError(409, "VERSION_CONFLICT", "练习已在其他窗口被修改");
    const resolved = await tx.handoverConflict.update({
      where: { id: conflict.id },
      data: {
        status: "RESOLVED",
        resolvedAt: new Date(),
        resolution: {
          strategy: input.strategy,
          annotationId: pickedAnnotationId,
          text: replacement,
          resolvedBy: userId,
        } as unknown as Prisma.InputJsonValue,
      },
    });
    if (involvedAnnotationIds.length > 0) {
      await tx.handoverAnnotation.updateMany({
        where: { id: { in: involvedAnnotationIds } },
        data: { status: "RESOLVED" },
      });
    }
    return { review: updatedReview, conflict: resolved };
  });

  await audit(request, "HANDOVER_CONFLICT_RESOLVED", AUDIT_RESOURCE, handoverId, "SUCCESS", {
    conflictId,
    strategy: input.strategy,
    annotationId: pickedAnnotationId,
  });
  return result;
}

export async function listHandoverAudit(userId: string, handoverId: string) {
  const handover = await prisma.reviewHandover.findFirst({
    where: { id: handoverId, userId },
    select: { id: true },
  });
  if (!handover) throw notFound();
  const entries = await prisma.auditLog.findMany({
    where: { resource: AUDIT_RESOURCE, resourceId: handoverId },
    orderBy: { createdAt: "desc" },
    take: 200,
  });
  return { entries };
}
