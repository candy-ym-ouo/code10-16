# API 契约

基础路径：`/api/v1`。除注册、登录和刷新外，请求使用 `Authorization: Bearer <accessToken>`。

错误统一返回：

```json
{
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "请求字段不合法",
    "details": [],
    "traceId": "req-..."
  }
}
```

## 认证

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/auth/register` | 注册并返回 Access Token，同时设置 Refresh Cookie |
| POST | `/auth/login` | 登录并轮换 Refresh Cookie |
| POST | `/auth/refresh` | 使用 Cookie 轮换刷新令牌 |
| POST | `/auth/logout` | 撤销当前 Refresh Session 并清除 Cookie |

Refresh Cookie 路径为 `/api/v1/auth`，生产环境在 HTTPS 下自动使用 `Secure`。

## 用户与设置

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/users/me` | 当前用户 |
| PATCH | `/users/me` | 更新展示名、默认乐器、时区和语言 |
| POST | `/users/me/password` | 修改密码并撤销其他会话 |

## 练习

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/sessions` | 光标分页、搜索、筛选和排序 |
| POST | `/sessions` | 创建练习 |
| GET | `/sessions/:id` | 详情，包含音频、标记、目标和复盘 |
| PATCH | `/sessions/:id` | 乐观锁更新；请求必须带 `version` |
| POST | `/sessions/:id/start-review` | 存在已就绪音频时进入 `IN_REVIEW` |
| GET | `/sessions/:id/completion-check` | 返回结构化缺失项 |
| POST | `/sessions/:id/complete` | 原子完成复盘 |
| POST | `/sessions/:id/archive` | 归档已完成练习 |
| POST | `/sessions/:id/restore` | 恢复归档练习 |
| DELETE | `/sessions/:id` | 必须提交完整 `confirmationTitle` |

创建练习：

```json
{
  "title": "协奏曲第二乐章 17-24 小节",
  "instrument": "小提琴",
  "startedAt": "2026-09-29T12:00:00.000Z",
  "focus": "换把后的音准",
  "location": "琴房 A",
  "notes": "节拍器 84 BPM",
  "actualDurationMs": 1800000
}
```

## 音频上传

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/sessions/:sessionId/media/uploads` | 创建上传会话并返回预签名 PUT URL |
| POST | `/media/:mediaId/complete-upload` | 校验对象大小/SHA-256 并投递探测任务 |
| GET | `/media/:mediaId` | 状态、元数据与波形峰值 |
| GET | `/media/:mediaId/playback-url` | 获取短期私有播放地址 |
| POST | `/media/:mediaId/retry-probe` | 重试音频探测 |
| DELETE | `/media/:mediaId` | 删除对象和关联标记 |

创建上传会话：

```json
{
  "originalName": "practice.wav",
  "mimeType": "audio/wav",
  "sizeBytes": 2646000,
  "sha256": "64-hex-characters"
}
```

预签名请求的 `Content-Type` 和 `x-amz-meta-sha256` 已纳入签名，必须使用返回的 `requiredHeaders` 原样上传。

## 标记

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/sessions/:sessionId/annotations` | 标记列表 |
| POST | `/sessions/:sessionId/annotations` | 新增标记 |
| PATCH | `/annotations/:id` | 编辑标记 |
| DELETE | `/annotations/:id` | 删除标记 |

区间使用毫秒整数，最小时长 100 ms，且不能超过音频时长。问题类型为 `RHYTHM`、`FINGERING` 或 `EMOTION`。

## 复盘与目标

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/sessions/:sessionId/review` | 获取复盘 |
| PUT | `/sessions/:sessionId/review` | 保存复盘草稿 |
| POST | `/sessions/:sessionId/review/complete` | 完成复盘事务 |
| GET/POST | `/goals` | 目标列表/创建 |
| GET/PATCH | `/goals/:id` | 目标详情/更新 |
| POST | `/goals/:id/activate` | 重新激活取消或逾期目标 |
| POST | `/goals/:id/cancel` | 带原因取消 |
| POST | `/goals/:id/complete` | 用户确认完成 |
| GET/POST | `/goals/:id/progress` | 进度列表/新增 |

完成复盘请求会原子写入复盘、目标、进度并更新练习状态。任一步失败时全部回滚，返回 `REVIEW_INCOMPLETE` 且 `details` 为缺失项数组。

## 复盘交接

教师把一次练习的复盘冻结成带时间戳的快照（交接单），生成只读分享链接收集批注，再把批注合并回复盘。快照在创建交接单时固定，之后修改复盘不影响已发出的分享。

管理接口（需登录，仅交接单所有者）：

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/handovers` | 用 `sessionId` + `title` 创建交接单，要求练习已有复盘内容 |
| GET | `/handovers` | 交接单列表，含各分享状态、待处理批注数和未决冲突数 |
| GET | `/handovers/:id` | 交接单详情：快照、分享、批注、冲突 |
| POST | `/handovers/:id/shares` | 创建分享，可选 `label` 和 `expiresInSeconds`（60～2592000） |
| POST | `/handovers/:id/shares/:shareId/revoke` | 撤销分享，可选 `reason`；撤销立即生效且幂等 |
| POST | `/handovers/:id/annotations/:annotationId/reject` | 驳回待处理批注 |
| POST | `/handovers/:id/merge` | 合并批注：`{ "annotationIds": [...] }` |
| POST | `/handovers/:id/conflicts/:conflictId/resolve` | 裁决冲突：`{ "strategy": "pick", "annotationId" }` 或 `{ "strategy": "custom", "text" }` |
| GET | `/handovers/:id/audit` | 该交接单的审计流水（最近 200 条） |

公开接口（无需登录，分享令牌即授权）：

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/shared/handovers/:token` | 只读快照：练习信息、复盘字段、标记列表和快照时间 `capturedAt` |
| GET | `/shared/handovers/:token/annotations` | 已有批注列表 |
| POST | `/shared/handovers/:token/annotations` | 提交批注 |

行为约定：

- 分享令牌为 32 字节随机值，只在创建响应中出现一次，服务端只存 SHA-256 哈希。
- 每个公开请求都实时校验撤销（`revokedAt`）与过期（`expiresAt`）状态：撤销后下一个请求即返回 `403 SHARE_REVOKED`，过期返回 `410 SHARE_EXPIRED`，拒绝事件写入审计。
- 批注锚定到复盘字段（`goodPoints` / `mainIssues` / `nextFocus`）的字符区间，`quote` 必须与快照中该区间的原文一致，否则返回 `400 ANCHOR_MISMATCH`。`kind` 为 `COMMENT`（纯批注）或 `SUGGESTION`（必须带 `replacement`，空串表示建议删除）。
- 合并只处理 `PENDING` 状态的批注。锚点精确命中的建议直接应用到复盘字段；区间重叠（`OVERLAP`）或锚点漂移（`ANCHOR_DRIFT`）的建议不改动主文档，生成冲突记录并完整保留各候选版本（`baseText` + 每个版本的 `replacement` 与 `resultingText`），等待人工裁决。
- 裁决时 `pick` 选择某个候选版本、`custom` 使用自定义文本；冲突原文在当前复盘中无法唯一定位时返回 `409 ANCHOR_DRIFT`。合并与裁决都在单事务内更新复盘并递增练习 `version`，冲突版本和裁决结果永久留痕。
- 创建交接单、创建/撤销分享、每次快照访问（含被拒绝的访问）、批注提交、合并与裁决都写入 `AuditLog`（含 `traceId`、IP 哈希和操作元数据），可通过 `/handovers/:id/audit` 追溯。

提交批注示例：

```json
{
  "authorName": "王老师",
  "kind": "SUGGESTION",
  "fieldPath": "mainIssues",
  "start": 0,
  "end": 5,
  "quote": "第 17 ",
  "body": "小节号记错了",
  "replacement": "第 18 "
}
```

## 统计与导出

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/statistics/overview` | 总览指标 |
| GET | `/statistics/trends` | 按用户时区分日趋势 |
| GET | `/statistics/issues` | 问题类型、严重度和困难片段 |
| GET | `/statistics/goals` | 目标完成率和逾期 |
| GET | `/statistics/instruments` | 各乐器聚合 |
| GET | `/statistics/dashboard` | 首页聚合 |
| POST | `/exports` | 创建 JSON/CSV 用户数据导出 |
| GET | `/exports/:id` | 查询导出状态和短时下载地址 |

统计接口必须传 `from`、`to` 和 IANA `timezone`。

## 健康检查

| 路径 | 说明 |
|---|---|
| `/health/live` | 仅检查进程存活 |
| `/health/ready` | 检查 PostgreSQL、Redis 和对象存储 |
| `/metrics` | Prometheus 文本指标 |
