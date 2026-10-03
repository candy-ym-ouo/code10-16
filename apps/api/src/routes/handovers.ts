import type { FastifyPluginAsync } from "fastify";
import {
  handoverAnnotationCreateSchema,
  handoverConflictResolveSchema,
  handoverCreateSchema,
  handoverMergeSchema,
  handoverShareCreateSchema,
  handoverShareRevokeSchema,
} from "@practice/contracts";
import { parseOrThrow } from "../lib/validation.js";
import {
  addSharedAnnotation,
  createHandover,
  createShare,
  getHandover,
  getSharedSnapshot,
  listHandoverAudit,
  listHandovers,
  listSharedAnnotations,
  mergeAnnotations,
  rejectAnnotation,
  resolveConflict,
  revokeShare,
} from "../services/handover-service.js";

const handoverRoutes: FastifyPluginAsync = async (app) => {
  // 公开只读分享：令牌即授权，撤销/过期在每个请求上即时校验，快照内容不随主文档变化
  app.get("/shared/handovers/:token", async (request) => {
    const { token } = request.params as { token: string };
    return getSharedSnapshot(request, token);
  });

  app.get("/shared/handovers/:token/annotations", async (request) => {
    const { token } = request.params as { token: string };
    return listSharedAnnotations(request, token);
  });

  app.post("/shared/handovers/:token/annotations", async (request, reply) => {
    const { token } = request.params as { token: string };
    const input = parseOrThrow(handoverAnnotationCreateSchema, request.body);
    const annotation = await addSharedAnnotation(request, token, input);
    return reply.status(201).send({ annotation });
  });

  await app.register(async (authed) => {
    authed.addHook("preHandler", authed.authenticate);

    authed.post("/handovers", async (request, reply) => {
      const input = parseOrThrow(handoverCreateSchema, request.body);
      const handover = await createHandover(request, request.authUser!.id, input);
      return reply.status(201).send({ handover });
    });

    authed.get("/handovers", async (request) => {
      return { handovers: await listHandovers(request.authUser!.id) };
    });

    authed.get("/handovers/:id", async (request) => {
      const { id } = request.params as { id: string };
      return { handover: await getHandover(request.authUser!.id, id) };
    });

    authed.post("/handovers/:id/shares", async (request, reply) => {
      const { id } = request.params as { id: string };
      const input = parseOrThrow(handoverShareCreateSchema, request.body ?? {});
      const result = await createShare(request, request.authUser!.id, id, input);
      return reply.status(201).send(result);
    });

    authed.post("/handovers/:id/shares/:shareId/revoke", async (request) => {
      const { id, shareId } = request.params as { id: string; shareId: string };
      const input = parseOrThrow(handoverShareRevokeSchema, request.body ?? {});
      const share = await revokeShare(request, request.authUser!.id, id, shareId, input.reason ?? null);
      return { share };
    });

    authed.post("/handovers/:id/annotations/:annotationId/reject", async (request) => {
      const { id, annotationId } = request.params as { id: string; annotationId: string };
      const annotation = await rejectAnnotation(request, request.authUser!.id, id, annotationId);
      return { annotation };
    });

    authed.post("/handovers/:id/merge", async (request) => {
      const { id } = request.params as { id: string };
      const input = parseOrThrow(handoverMergeSchema, request.body);
      return mergeAnnotations(request, request.authUser!.id, id, input.annotationIds);
    });

    authed.post("/handovers/:id/conflicts/:conflictId/resolve", async (request) => {
      const { id, conflictId } = request.params as { id: string; conflictId: string };
      const input = parseOrThrow(handoverConflictResolveSchema, request.body);
      return resolveConflict(request, request.authUser!.id, id, conflictId, input);
    });

    authed.get("/handovers/:id/audit", async (request) => {
      const { id } = request.params as { id: string };
      return listHandoverAudit(request.authUser!.id, id);
    });
  });
};

export default handoverRoutes;
