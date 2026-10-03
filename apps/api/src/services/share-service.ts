import {
  isShareActive,
  planAnnotationMerge,
  type AnnotationMergePlan,
  type ShareAnnotationSection,
} from "@practice/contracts";
import { Prisma } from "@prisma/client";
import { AppError, notFound } from "../lib/errors.js";
import { prisma } from "../lib/prisma.js";
import { createShareToken, hashShareToken } from "../lib/security.js";

export interface ShareCreateInput {
  note?: string | null;
  expiresInHours?: number | null;
}

export interface ShareAnnotationInput {
  authorName: string;
  section: ShareAnnotationSection;
  content: string;
  clientRequestId?: string | null;
}

interface ReviewSnapshot {
  session: {
    id: string;
    title: string;
    instrument: string;
    focus: string | null;
    location: string | null;
    startedAt: string;
    actualDurationMs: number;
    completedAt: string | null;
  };
  review: {
    goodPoints: string | null;
    mainIssues: string | null;
    nextFocus: string | null;
    noIssues: boolean;
    suggestedNextPracticeAt: string | null;
    completedAt: string | null;
  };
  goals: Array<{
    id: string;
    title: string;
    category: string;
    targetValue: string;
    unit: string;
    dueDate: string;
    status: string;
  }>;
  markers: Array<{
    id: string;
    type: string;
    severity: number;
    startMs: number;
    endMs: number;
    title: string;
  }>;
}

const sharePublicSelect = {
  id: true,
  sessionId: true,
  note: true,
  snapshotAt: true,
  expiresAt: true,
  revokedAt: true,
  lastAccessedAt: true,
  createdAt: true,
  _count: { select: { annotations: true } },
} satisfies Prisma.ReviewShareSelect;

/** 公共访问被拒时携带分享 ID，便于审计轨迹归集到具体分享。 */
export class ShareAccessError extends AppError {
  constructor(
    statusCode: number,
    code: string,
    message: string,
    public readonly shareId: string | null,
  ) {
    super(statusCode, code, message);
    this.name = "ShareAccessError";
  }
}

export function shareNotActiveError(share: { id: string; revokedAt: Date | null; expiresAt: Date | null }): ShareAccessError {
  if (share.revokedAt != null) {
    return new ShareAccessError(410, "SHARE_REVOKED", "该分享已被撤销，内容不再可访问", share.id);
  }
  return new ShareAccessError(410, "SHARE_EXPIRED", "该分享已过期", share.id);
}

async function buildSnapshot(sessionId: string, userId: string): Promise<ReviewSnapshot> {
  const session = await prisma.practiceSession.findFirst({
    where: { id: sessionId, userId },
    include: {
      review: true,
      goals: { orderBy: { createdAt: "asc" } },
      annotations: { orderBy: { startMs: "asc" } },
    },
  });
  if (!session) throw notFound();
  if (session.status === "DELETING" || session.status === "DELETE_FAILED") {
    throw new AppError(409, "INVALID_SESSION_STATE", "正在删除的练习不能生成交接分享");
  }
  if (!session.review) {
    throw new AppError(409, "REVIEW_REQUIRED", "请先填写复盘，再生成教师交接分享");
  }
  return {
    session: {
      id: session.id,
      title: session.title,
      instrument: session.instrument,
      focus: session.focus,
      location: session.location,
      startedAt: session.startedAt.toISOString(),
      actualDurationMs: Number(session.actualDurationMs),
      completedAt: session.completedAt?.toISOString() ?? null,
    },
    review: {
      goodPoints: session.review.goodPoints,
      mainIssues: session.review.mainIssues,
      nextFocus: session.review.nextFocus,
      noIssues: session.review.noIssues,
      suggestedNextPracticeAt: session.review.suggestedNextPracticeAt?.toISOString() ?? null,
      completedAt: session.review.completedAt?.toISOString() ?? null,
    },
    goals: session.goals.map((goal) => ({
      id: goal.id,
      title: goal.title,
      category: goal.category,
      targetValue: goal.targetValue.toString(),
      unit: goal.unit,
      dueDate: goal.dueDate.toISOString().slice(0, 10),
      status: goal.status,
    })),
    markers: session.annotations.map((marker) => ({
      id: marker.id,
      type: marker.type,
      severity: marker.severity,
      startMs: Number(marker.startMs),
      endMs: Number(marker.endMs),
      title: marker.title,
    })),
  };
}

export async function createReviewShare(userId: string, sessionId: string, input: ShareCreateInput) {
  const snapshot = await buildSnapshot(sessionId, userId);
  const token = createShareToken();
  const snapshotAt = new Date();
  const share = await prisma.reviewShare.create({
    data: {
      sessionId,
      createdById: userId,
      tokenHash: token.hash,
      note: input.note ?? null,
      snapshot: snapshot as unknown as Prisma.InputJsonValue,
      snapshotAt,
      expiresAt: input.expiresInHours ? new Date(snapshotAt.getTime() + input.expiresInHours * 3_600_000) : null,
    },
    select: sharePublicSelect,
  });
  // 原始令牌只在创建响应中返回一次，数据库只保存加盐摘要。
  return { share, token: token.raw };
}

export async function listSessionShares(userId: string, sessionId: string) {
  const owned = await prisma.practiceSession.findFirst({ where: { id: sessionId, userId }, select: { id: true } });
  if (!owned) throw notFound();
  const shares = await prisma.reviewShare.findMany({
    where: { sessionId, createdById: userId },
    orderBy: { createdAt: "desc" },
    select: sharePublicSelect,
  });
  return shares.map((share) => ({ ...share, active: isShareActive(share) }));
}

export async function revokeReviewShare(userId: string, shareId: string) {
  const share = await prisma.reviewShare.findFirst({ where: { id: shareId, createdById: userId } });
  if (!share) throw notFound();
  if (share.revokedAt != null) {
    throw new AppError(409, "SHARE_ALREADY_REVOKED", "该分享已撤销");
  }
  // 只写 revokedAt；公共访问每次请求实时重查，撤销立即生效。
  return prisma.reviewShare.update({
    where: { id: share.id },
    data: { revokedAt: new Date() },
    select: sharePublicSelect,
  });
}

async function getActiveShareByToken(token: string) {
  const share = await prisma.reviewShare.findUnique({ where: { tokenHash: hashShareToken(token) } });
  if (!share) throw notFound();
  if (!isShareActive(share)) throw shareNotActiveError(share);
  return share;
}

export async function getSharedSnapshot(token: string) {
  const share = await getActiveShareByToken(token);
  await prisma.reviewShare.update({ where: { id: share.id }, data: { lastAccessedAt: new Date() } });
  return {
    share: {
      id: share.id,
      note: share.note,
      snapshotAt: share.snapshotAt,
      createdAt: share.createdAt,
      expiresAt: share.expiresAt,
    },
    snapshot: share.snapshot as unknown as ReviewSnapshot,
    serverTime: new Date(),
  };
}

export async function addShareAnnotation(token: string, input: ShareAnnotationInput) {
  const share = await getActiveShareByToken(token);
  if (input.clientRequestId) {
    const existing = await prisma.shareAnnotation.findFirst({
      where: { shareId: share.id, clientRequestId: input.clientRequestId },
    });
    if (existing) return { annotation: existing, deduplicated: true };
  }
  try {
    const annotation = await prisma.shareAnnotation.create({
      data: {
        shareId: share.id,
        authorName: input.authorName,
        section: input.section,
        content: input.content,
        clientRequestId: input.clientRequestId ?? null,
      },
    });
    return { annotation, deduplicated: false };
  } catch (error) {
    // 并发重复提交同一 clientRequestId 时返回首次创建的批注，保证幂等。
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002" && input.clientRequestId) {
      const existing = await prisma.shareAnnotation.findFirst({
        where: { shareId: share.id, clientRequestId: input.clientRequestId },
      });
      if (existing) return { annotation: existing, deduplicated: true };
    }
    throw error;
  }
}

async function getOwnedShare(userId: string, shareId: string) {
  const share = await prisma.reviewShare.findFirst({ where: { id: shareId, createdById: userId } });
  if (!share) throw notFound();
  return share;
}

export async function listShareAnnotations(
  userId: string,
  shareId: string,
  filter: { status?: "PENDING" | "MERGED" | "CONFLICT"; section?: ShareAnnotationSection },
) {
  await getOwnedShare(userId, shareId);
  return prisma.shareAnnotation.findMany({
    where: { shareId, ...(filter.status ? { status: filter.status } : {}), ...(filter.section ? { section: filter.section } : {}) },
    orderBy: [{ section: "asc" }, { createdAt: "asc" }],
  });
}

export async function mergeShareAnnotations(userId: string, shareId: string, annotationIds: string[]) {
  const uniqueIds = [...new Set(annotationIds)];
  return prisma.$transaction(async (tx) => {
    const share = await tx.reviewShare.findFirst({ where: { id: shareId, createdById: userId } });
    if (!share) throw notFound();
    const annotations = await tx.shareAnnotation.findMany({ where: { shareId, id: { in: uniqueIds } } });
    if (annotations.length !== uniqueIds.length) {
      throw new AppError(404, "RESOURCE_NOT_FOUND", "部分批注不存在或不属于该分享");
    }
    if (annotations.some((annotation) => annotation.status !== "PENDING")) {
      throw new AppError(409, "ANNOTATION_ALREADY_MERGED", "只能合并待处理的批注，冲突版本请人工取舍");
    }
    const plan: AnnotationMergePlan = planAnnotationMerge(annotations);
    const conflictIds = plan.conflicts.flatMap((group) => group.annotationIds);
    const batch = await tx.annotationMergeBatch.create({
      data: {
        shareId,
        createdById: userId,
        mergedCount: plan.mergedIds.length,
        conflictCount: conflictIds.length,
      },
    });
    if (plan.mergedIds.length > 0) {
      await tx.shareAnnotation.updateMany({
        where: { id: { in: plan.mergedIds } },
        data: { status: "MERGED", mergeBatchId: batch.id },
      });
    }
    if (conflictIds.length > 0) {
      // 冲突版本全部保留为 CONFLICT，不删除、不覆盖，等待人工处理。
      await tx.shareAnnotation.updateMany({
        where: { id: { in: conflictIds } },
        data: { status: "CONFLICT", mergeBatchId: batch.id },
      });
    }
    return { batch, plan };
  });
}

export async function getShareAuditTrail(userId: string, shareId: string) {
  await getOwnedShare(userId, shareId);
  return prisma.auditLog.findMany({
    where: { resource: "REVIEW_SHARE", resourceId: shareId },
    orderBy: { createdAt: "desc" },
    take: 200,
    select: {
      id: true,
      userId: true,
      action: true,
      result: true,
      traceId: true,
      metadata: true,
      createdAt: true,
    },
  });
}
