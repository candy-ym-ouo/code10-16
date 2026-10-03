import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Prisma } from "@prisma/client";

process.env.NODE_ENV = "test";
process.env.DATABASE_URL ??= "postgresql://practice:practice@localhost:5432/practice";
process.env.REDIS_URL ??= "redis://localhost:6379";
process.env.JWT_ACCESS_SECRET ??= "a".repeat(32);
process.env.REFRESH_TOKEN_PEPPER ??= "b".repeat(32);
process.env.S3_ENDPOINT ??= "http://localhost:9000";
process.env.S3_ACCESS_KEY ??= "test-access";
process.env.S3_SECRET_KEY ??= "test-secret";
process.env.PUBLIC_API_ORIGIN ??= "http://localhost:3000";
process.env.WEB_ORIGIN ??= "http://localhost:5173";

/* 内存版 Prisma 桩：只实现分享交接链路用到的方法，行为与真实模型一致。 */
const user = { id: randomUUID(), email: "teacher@example.com", displayName: "陈老师", status: "ACTIVE" };
const session = {
  id: randomUUID(),
  userId: user.id,
  title: "协奏曲第二乐章",
  instrument: "小提琴",
  focus: "换把音准",
  location: null,
  startedAt: new Date("2026-10-01T08:00:00.000Z"),
  actualDurationMs: BigInt(1_800_000),
  status: "COMPLETED",
  completedAt: new Date("2026-10-01T09:00:00.000Z"),
  review: {
    goodPoints: "长弓稳定",
    mainIssues: "17 小节换把偏高",
    nextFocus: "慢练换把",
    noIssues: false,
    suggestedNextPracticeAt: null,
    completedAt: new Date("2026-10-01T09:00:00.000Z"),
  },
  goals: [
    {
      id: randomUUID(),
      title: "换把音准练习",
      category: "FINGERING",
      targetValue: 90,
      unit: "BPM",
      dueDate: new Date("2026-10-10T00:00:00.000Z"),
      status: "OPEN",
      createdAt: new Date(),
    },
  ],
  annotations: [{ id: randomUUID(), type: "RHYTHM", severity: 3, startMs: BigInt(1000), endMs: BigInt(2600), title: "抢拍" }],
};

const shares: any[] = [];
const shareAnnotations: any[] = [];
const mergeBatches: any[] = [];
const auditLogs: any[] = [];

function withAnnotationCount(row: any) {
  return { ...row, _count: { annotations: shareAnnotations.filter((item) => item.shareId === row.id).length } };
}

/* 模拟 Prisma select：服务端 sharePublicSelect 不包含 tokenHash/snapshot。 */
const SHARE_PUBLIC_FIELDS = ["id", "sessionId", "note", "snapshotAt", "expiresAt", "revokedAt", "lastAccessedAt", "createdAt"];

function pickSharePublic(row: any) {
  const picked: any = {};
  for (const field of SHARE_PUBLIC_FIELDS) picked[field] = row[field];
  picked._count = { annotations: shareAnnotations.filter((item) => item.shareId === row.id).length };
  return picked;
}

const stub: any = {
  user: {
    findUnique: async ({ where }: any) => (where.id === user.id ? { ...user } : null),
  },
  practiceSession: {
    findFirst: async ({ where }: any) => (where.id === session.id && where.userId === user.id ? session : null),
  },
  reviewShare: {
    create: async ({ data }: any) => {
      const row = {
        id: randomUUID(),
        note: null,
        expiresAt: null,
        revokedAt: null,
        lastAccessedAt: null,
        createdAt: new Date(),
        updatedAt: new Date(),
        ...data,
      };
      shares.push(row);
      return pickSharePublic(row);
    },
    findMany: async ({ where }: any) =>
      shares
        .filter((row) => row.sessionId === where.sessionId && row.createdById === where.createdById)
        .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
        .map(pickSharePublic),
    findFirst: async ({ where }: any) => shares.find((row) => row.id === where.id && row.createdById === where.createdById) ?? null,
    findUnique: async ({ where }: any) => shares.find((row) => row.tokenHash === where.tokenHash) ?? null,
    update: async ({ where, data }: any) => {
      const row = shares.find((item) => item.id === where.id);
      Object.assign(row, data);
      return pickSharePublic(row);
    },
  },
  shareAnnotation: {
    create: async ({ data }: any) => {
      if (data.clientRequestId && shareAnnotations.some((row) => row.shareId === data.shareId && row.clientRequestId === data.clientRequestId)) {
        throw new Prisma.PrismaClientKnownRequestError("Unique constraint failed", { code: "P2002", clientVersion: "6.19.3" });
      }
      const row = { id: randomUUID(), status: "PENDING", mergeBatchId: null, clientRequestId: null, createdAt: new Date(), updatedAt: new Date(), ...data };
      shareAnnotations.push(row);
      return row;
    },
    findFirst: async ({ where }: any) =>
      shareAnnotations.find((row) => row.shareId === where.shareId && row.clientRequestId === where.clientRequestId) ?? null,
    findMany: async ({ where }: any) =>
      shareAnnotations.filter((row) => {
        if (row.shareId !== where.shareId) return false;
        if (where.id?.in && !where.id.in.includes(row.id)) return false;
        if (where.status && row.status !== where.status) return false;
        if (where.section && row.section !== where.section) return false;
        return true;
      }),
    updateMany: async ({ where, data }: any) => {
      let count = 0;
      for (const row of shareAnnotations) {
        if (where.id?.in?.includes(row.id)) {
          Object.assign(row, data);
          count += 1;
        }
      }
      return { count };
    },
  },
  annotationMergeBatch: {
    create: async ({ data }: any) => {
      const row = { id: randomUUID(), createdAt: new Date(), ...data };
      mergeBatches.push(row);
      return row;
    },
  },
  auditLog: {
    create: async ({ data }: any) => {
      const row = { id: randomUUID(), createdAt: new Date(), ...data };
      auditLogs.push(row);
      return row;
    },
    findMany: async ({ where, take }: any) =>
      auditLogs
        .filter((row) => row.resource === where.resource && row.resourceId === where.resourceId)
        .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
        .slice(0, take ?? 100),
  },
  $transaction: async (fn: (tx: any) => Promise<unknown>) => fn(stub),
  $disconnect: async () => undefined,
};

globalThis.__practicePrisma = stub;

const { buildApp } = await import("../src/app.js");
const { signAccessToken } = await import("../src/lib/security.js");

let app: Awaited<ReturnType<typeof buildApp>>;
let authHeader: string;

beforeAll(async () => {
  app = await buildApp();
  authHeader = `Bearer ${signAccessToken({ id: user.id, email: user.email })}`;
});

afterAll(async () => {
  await app.close();
});

function auth() {
  return { authorization: authHeader, "content-type": "application/json" };
}

describe("teacher review handover flow", () => {
  let shareId = "";
  let shareToken = "";
  let snapshotAt = "";
  const annotationIds: string[] = [];

  it("rejects owner endpoints without a token", async () => {
    const response = await app.inject({ method: "GET", url: `/api/v1/sessions/${session.id}/shares` });
    expect(response.statusCode).toBe(401);
  });

  it("creates a timestamped read-only share and returns the raw token once", async () => {
    const response = await app.inject({
      method: "POST",
      url: `/api/v1/sessions/${session.id}/shares`,
      headers: auth(),
      payload: { note: "交接给王老师", expiresInHours: 72 },
    });
    expect(response.statusCode).toBe(201);
    const body = response.json();
    shareId = body.share.id;
    shareToken = body.token;
    snapshotAt = body.share.snapshotAt;
    expect(shareToken).toMatch(/^[A-Za-z0-9_-]{40,}$/);
    expect(body.share.note).toBe("交接给王老师");
    expect(body.share.expiresAt).toBeTruthy();
    expect(body.share.tokenHash).toBeUndefined();
    // 列表中不泄露令牌摘要
    const list = await app.inject({ method: "GET", url: `/api/v1/sessions/${session.id}/shares`, headers: auth() });
    const listed = list.json().shares[0];
    expect(listed.active).toBe(true);
    expect(listed.tokenHash).toBeUndefined();
  });

  it("serves the frozen snapshot publicly with timestamps", async () => {
    // 分享后修改复盘，快照应保持不变
    session.review.mainIssues = "已被后续编辑覆盖";
    const response = await app.inject({ method: "GET", url: `/api/v1/shared/${shareToken}` });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.share.snapshotAt).toBe(snapshotAt);
    expect(body.serverTime).toBeTruthy();
    expect(body.snapshot.session.title).toBe("协奏曲第二乐章");
    expect(body.snapshot.review.mainIssues).toBe("17 小节换把偏高");
    expect(body.snapshot.goals[0].title).toBe("换把音准练习");
    expect(body.snapshot.markers[0].startMs).toBe(1000);
    session.review.mainIssues = "17 小节换把偏高";
  });

  it("rejects unknown tokens with 404", async () => {
    const response = await app.inject({ method: "GET", url: "/api/v1/shared/not-a-real-token" });
    expect(response.statusCode).toBe(404);
  });

  it("collects annotations idempotently", async () => {
    const first = await app.inject({
      method: "POST",
      url: `/api/v1/shared/${shareToken}/annotations`,
      headers: { "content-type": "application/json" },
      payload: { authorName: "王老师", section: "MAIN_ISSUES", content: "节奏抢拍，建议节拍器 60 慢练", clientRequestId: "req-0001-handover" },
    });
    expect(first.statusCode).toBe(201);
    annotationIds.push(first.json().annotation.id);

    const replay = await app.inject({
      method: "POST",
      url: `/api/v1/shared/${shareToken}/annotations`,
      headers: { "content-type": "application/json" },
      payload: { authorName: "王老师", section: "MAIN_ISSUES", content: "节奏抢拍，建议节拍器 60 慢练", clientRequestId: "req-0001-handover" },
    });
    expect(replay.statusCode).toBe(200);
    expect(replay.json().annotation.id).toBe(annotationIds[0]);

    const second = await app.inject({
      method: "POST",
      url: `/api/v1/shared/${shareToken}/annotations`,
      headers: { "content-type": "application/json" },
      payload: { authorName: "李老师", section: "MAIN_ISSUES", content: "其实是拖拍，建议分手练习", clientRequestId: "req-0002-handover" },
    });
    const third = await app.inject({
      method: "POST",
      url: `/api/v1/shared/${shareToken}/annotations`,
      headers: { "content-type": "application/json" },
      payload: { authorName: "王老师", section: "GOALS", content: "目标合理，建议保持", clientRequestId: "req-0003-handover" },
    });
    annotationIds.push(second.json().annotation.id, third.json().annotation.id);
    expect(new Set(annotationIds).size).toBe(3);
  });

  it("merges agreeing annotations and keeps every conflicting version", async () => {
    const merge = await app.inject({
      method: "POST",
      url: `/api/v1/shares/${shareId}/annotations/merge`,
      headers: auth(),
      payload: { annotationIds },
    });
    expect(merge.statusCode).toBe(200);
    const { batch, plan } = merge.json();
    expect(batch.mergedCount).toBe(1);
    expect(batch.conflictCount).toBe(2);
    expect(plan.conflicts).toHaveLength(1);
    expect(plan.conflicts[0].section).toBe("MAIN_ISSUES");
    expect(plan.conflicts[0].contents).toHaveLength(2);

    const list = await app.inject({ method: "GET", url: `/api/v1/shares/${shareId}/annotations`, headers: auth() });
    const byStatus = new Map(list.json().annotations.map((item: any) => [item.id, item.status]));
    expect(byStatus.get(annotationIds[0])).toBe("CONFLICT");
    expect(byStatus.get(annotationIds[1])).toBe("CONFLICT");
    expect(byStatus.get(annotationIds[2])).toBe("MERGED");
    // 冲突版本全部保留，没有一条被删除
    expect(list.json().annotations).toHaveLength(3);
  });

  it("refuses to re-merge resolved annotations", async () => {
    const response = await app.inject({
      method: "POST",
      url: `/api/v1/shares/${shareId}/annotations/merge`,
      headers: auth(),
      payload: { annotationIds: [annotationIds[0]] },
    });
    expect(response.statusCode).toBe(409);
    expect(response.json().error.code).toBe("ANNOTATION_ALREADY_MERGED");
  });

  it("revokes access immediately", async () => {
    const before = await app.inject({ method: "GET", url: `/api/v1/shared/${shareToken}` });
    expect(before.statusCode).toBe(200);

    const revoke = await app.inject({ method: "POST", url: `/api/v1/shares/${shareId}/revoke`, headers: auth(), payload: {} });
    expect(revoke.statusCode).toBe(200);
    expect(revoke.json().share.revokedAt).toBeTruthy();

    const after = await app.inject({ method: "GET", url: `/api/v1/shared/${shareToken}` });
    expect(after.statusCode).toBe(410);
    expect(after.json().error.code).toBe("SHARE_REVOKED");

    const annotate = await app.inject({
      method: "POST",
      url: `/api/v1/shared/${shareToken}/annotations`,
      headers: { "content-type": "application/json" },
      payload: { authorName: "王老师", section: "GENERAL", content: "撤销后不应再能提交", clientRequestId: "req-0004-handover" },
    });
    expect(annotate.statusCode).toBe(410);
  });

  it("keeps a traceable audit trail for the share", async () => {
    const response = await app.inject({ method: "GET", url: `/api/v1/shares/${shareId}/audit`, headers: auth() });
    expect(response.statusCode).toBe(200);
    const actions = response.json().entries.map((entry: any) => entry.action);
    expect(actions).toContain("SHARE_CREATED");
    expect(actions).toContain("SHARE_ANNOTATION_ADDED");
    expect(actions).toContain("SHARE_ANNOTATIONS_MERGED");
    expect(actions).toContain("SHARE_REVOKED");
    expect(actions).toContain("SHARE_ACCESS_DENIED");
    for (const entry of response.json().entries) {
      expect(entry.createdAt).toBeTruthy();
      expect(entry.traceId).toBeTruthy();
    }
  });
});
