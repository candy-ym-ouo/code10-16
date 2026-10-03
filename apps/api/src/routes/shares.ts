import type { FastifyPluginAsync, FastifyRequest } from "fastify";
import {
  shareAnnotationCreateSchema,
  shareAnnotationListQuerySchema,
  shareAnnotationMergeSchema,
  shareCreateSchema,
} from "@practice/contracts";
import { audit } from "../lib/audit.js";
import { parseOrThrow } from "../lib/validation.js";
import {
  addShareAnnotation,
  createReviewShare,
  getSharedSnapshot,
  getShareAuditTrail,
  listSessionShares,
  listShareAnnotations,
  mergeShareAnnotations,
  revokeReviewShare,
  ShareAccessError,
} from "../services/share-service.js";

/** 需要登录的管理端：创建/撤销分享、收集与合并批注、查看审计。 */
const shareRoutes: FastifyPluginAsync = async (app) => {
  app.addHook("preHandler", app.authenticate);

  app.post("/sessions/:sessionId/shares", async (request, reply) => {
    const { sessionId } = request.params as { sessionId: string };
    const input = parseOrThrow(shareCreateSchema, request.body ?? {});
    const { share, token } = await createReviewShare(request.authUser!.id, sessionId, input);
    await audit(request, "SHARE_CREATED", "REVIEW_SHARE", share.id, "SUCCESS", { sessionId, expiresAt: share.expiresAt });
    return reply.status(201).send({ share, token });
  });

  app.get("/sessions/:sessionId/shares", async (request) => {
    const { sessionId } = request.params as { sessionId: string };
    return { shares: await listSessionShares(request.authUser!.id, sessionId) };
  });

  app.post("/shares/:shareId/revoke", async (request) => {
    const { shareId } = request.params as { shareId: string };
    const share = await revokeReviewShare(request.authUser!.id, shareId);
    await audit(request, "SHARE_REVOKED", "REVIEW_SHARE", shareId, "SUCCESS");
    return { share };
  });

  app.get("/shares/:shareId/annotations", async (request) => {
    const { shareId } = request.params as { shareId: string };
    const filter = parseOrThrow(shareAnnotationListQuerySchema, request.query);
    return { annotations: await listShareAnnotations(request.authUser!.id, shareId, filter) };
  });

  app.post("/shares/:shareId/annotations/merge", async (request) => {
    const { shareId } = request.params as { shareId: string };
    const input = parseOrThrow(shareAnnotationMergeSchema, request.body);
    const { batch, plan } = await mergeShareAnnotations(request.authUser!.id, shareId, input.annotationIds);
    await audit(request, "SHARE_ANNOTATIONS_MERGED", "REVIEW_SHARE", shareId, "SUCCESS", {
      mergeBatchId: batch.id,
      mergedIds: plan.mergedIds,
      conflicts: plan.conflicts,
    });
    return { batch, plan };
  });

  app.get("/shares/:shareId/audit", async (request) => {
    const { shareId } = request.params as { shareId: string };
    return { entries: await getShareAuditTrail(request.authUser!.id, shareId) };
  });
};

async function auditDeniedAccess(request: FastifyRequest, error: unknown): Promise<void> {
  await audit(request, "SHARE_ACCESS_DENIED", "REVIEW_SHARE", error instanceof ShareAccessError ? error.shareId : null, "FAILURE", {
    reason: error instanceof Error ? error.message : "unknown",
  });
}

/** 公开端：凭令牌只读访问快照并提交批注。撤销/过期在每次请求时实时校验，立即生效。 */
export const publicShareRoutes: FastifyPluginAsync = async (app) => {
  app.get("/:token", { config: { rateLimit: { max: 60, timeWindow: "1 minute" } } }, async (request) => {
    const { token } = request.params as { token: string };
    try {
      return await getSharedSnapshot(token);
    } catch (error) {
      await auditDeniedAccess(request, error);
      throw error;
    }
  });

  app.post("/:token/annotations", { config: { rateLimit: { max: 20, timeWindow: "1 minute" } } }, async (request, reply) => {
    const { token } = request.params as { token: string };
    const input = parseOrThrow(shareAnnotationCreateSchema, request.body);
    try {
      const { annotation, deduplicated } = await addShareAnnotation(token, input);
      await audit(request, "SHARE_ANNOTATION_ADDED", "REVIEW_SHARE", annotation.shareId, "SUCCESS", {
        annotationId: annotation.id,
        section: annotation.section,
        deduplicated,
      });
      return reply.status(deduplicated ? 200 : 201).send({ annotation });
    } catch (error) {
      await auditDeniedAccess(request, error);
      throw error;
    }
  });
};

export default shareRoutes;
