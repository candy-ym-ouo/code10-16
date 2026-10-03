<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { useRoute } from "vue-router";
import { apiFetch, ApiError } from "../api/client.js";
import LoadingBlock from "../components/LoadingBlock.vue";
import { formatDateTime, shareAnnotationStatusLabels, shareAuditActionLabels, shareSectionLabels } from "../utils/format.js";

interface Share {
  id: string; sessionId: string; note: string | null; snapshotAt: string; expiresAt: string | null;
  revokedAt: string | null; lastAccessedAt: string | null; createdAt: string; active: boolean;
  _count: { annotations: number };
}
interface ShareAnnotation {
  id: string; authorName: string; section: keyof typeof shareSectionLabels; content: string;
  status: keyof typeof shareAnnotationStatusLabels; createdAt: string; mergeBatchId: string | null;
}
interface MergeConflict { section: keyof typeof shareSectionLabels; annotationIds: string[]; contents: string[] }
interface MergeResult { batch: { id: string; mergedCount: number; conflictCount: number; createdAt: string }; plan: { mergedIds: string[]; conflicts: MergeConflict[] } }
interface AuditEntry { id: string; userId: string | null; action: string; result: string; traceId: string | null; createdAt: string }

const route = useRoute();
const sessionId = String(route.params.id);
const sessionTitle = ref("");
const shares = ref<Share[]>([]);
const loading = ref(true);
const error = ref("");

const note = ref("");
const expiresInHours = ref<number | null>(168);
const creating = ref(false);
const createdToken = ref("");
const copied = ref(false);

const selectedShareId = ref<string | null>(null);
const annotations = ref<ShareAnnotation[]>([]);
const annotationsLoading = ref(false);
const selectedAnnotationIds = ref<Set<string>>(new Set());
const merging = ref(false);
const mergeResult = ref<MergeResult | null>(null);
const actionError = ref("");

const auditEntries = ref<AuditEntry[]>([]);
const auditLoading = ref(false);
const showAudit = ref(false);

const selectedShare = computed(() => shares.value.find((share) => share.id === selectedShareId.value) ?? null);
const pendingAnnotations = computed(() => annotations.value.filter((item) => item.status === "PENDING"));
const conflictAnnotations = computed(() => annotations.value.filter((item) => item.status === "CONFLICT"));
const allPendingSelected = computed(() => pendingAnnotations.value.length > 0 && pendingAnnotations.value.every((item) => selectedAnnotationIds.value.has(item.id)));

const expiryOptions = [
  { value: null, label: "长期有效" },
  { value: 24, label: "24 小时" },
  { value: 72, label: "3 天" },
  { value: 168, label: "7 天" },
  { value: 720, label: "30 天" },
];

function shareStatusLabel(share: Share): string {
  if (share.revokedAt) return "已撤销";
  if (!share.active) return "已过期";
  return "生效中";
}

async function loadShares(): Promise<void> {
  const result = await apiFetch<{ shares: Share[] }>(`/api/v1/sessions/${sessionId}/shares`);
  shares.value = result.shares;
}

async function load(): Promise<void> {
  loading.value = true;
  error.value = "";
  try {
    const detail = await apiFetch<{ session: { title: string } }>(`/api/v1/sessions/${sessionId}`);
    sessionTitle.value = detail.session.title;
    await loadShares();
  } catch (reason) {
    error.value = reason instanceof ApiError ? reason.message : "交接信息加载失败";
  } finally {
    loading.value = false;
  }
}

async function createShare(): Promise<void> {
  if (creating.value) return;
  creating.value = true;
  actionError.value = "";
  try {
    const result = await apiFetch<{ share: Share; token: string }>(`/api/v1/sessions/${sessionId}/shares`, {
      method: "POST",
      body: JSON.stringify({ note: note.value || null, expiresInHours: expiresInHours.value }),
    });
    createdToken.value = result.token;
    note.value = "";
    await loadShares();
  } catch (reason) {
    actionError.value = reason instanceof ApiError ? reason.message : "分享创建失败";
  } finally {
    creating.value = false;
  }
}

function createdShareUrl(): string {
  return `${window.location.origin}/shared/${createdToken.value}`;
}

async function copyCreatedUrl(): Promise<void> {
  await navigator.clipboard.writeText(createdShareUrl());
  copied.value = true;
  window.setTimeout(() => (copied.value = false), 2000);
}

async function revokeShare(share: Share): Promise<void> {
  if (!window.confirm("撤销后该链接立即无法访问，确认撤销？")) return;
  actionError.value = "";
  try {
    await apiFetch(`/api/v1/shares/${share.id}/revoke`, { method: "POST", body: "{}" });
    await loadShares();
  } catch (reason) {
    actionError.value = reason instanceof ApiError ? reason.message : "撤销失败";
  }
}

async function selectShare(share: Share): Promise<void> {
  selectedShareId.value = share.id;
  mergeResult.value = null;
  showAudit.value = false;
  selectedAnnotationIds.value = new Set();
  annotationsLoading.value = true;
  try {
    const result = await apiFetch<{ annotations: ShareAnnotation[] }>(`/api/v1/shares/${share.id}/annotations`);
    annotations.value = result.annotations;
  } catch (reason) {
    actionError.value = reason instanceof ApiError ? reason.message : "批注加载失败";
  } finally {
    annotationsLoading.value = false;
  }
}

function toggleAnnotation(id: string): void {
  const next = new Set(selectedAnnotationIds.value);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  selectedAnnotationIds.value = next;
}

function toggleAllPending(): void {
  selectedAnnotationIds.value = allPendingSelected.value ? new Set() : new Set(pendingAnnotations.value.map((item) => item.id));
}

async function mergeSelected(): Promise<void> {
  if (!selectedShareId.value || selectedAnnotationIds.value.size === 0 || merging.value) return;
  merging.value = true;
  actionError.value = "";
  mergeResult.value = null;
  try {
    const result = await apiFetch<MergeResult>(`/api/v1/shares/${selectedShareId.value}/annotations/merge`, {
      method: "POST",
      body: JSON.stringify({ annotationIds: [...selectedAnnotationIds.value] }),
    });
    mergeResult.value = result;
    selectedAnnotationIds.value = new Set();
    const refreshed = await apiFetch<{ annotations: ShareAnnotation[] }>(`/api/v1/shares/${selectedShareId.value}/annotations`);
    annotations.value = refreshed.annotations;
  } catch (reason) {
    actionError.value = reason instanceof ApiError ? reason.message : "合并失败";
  } finally {
    merging.value = false;
  }
}

async function loadAudit(): Promise<void> {
  if (!selectedShareId.value) return;
  showAudit.value = !showAudit.value;
  if (!showAudit.value) return;
  auditLoading.value = true;
  try {
    const result = await apiFetch<{ entries: AuditEntry[] }>(`/api/v1/shares/${selectedShareId.value}/audit`);
    auditEntries.value = result.entries;
  } catch (reason) {
    actionError.value = reason instanceof ApiError ? reason.message : "审计记录加载失败";
  } finally {
    auditLoading.value = false;
  }
}

function annotationById(id: string): ShareAnnotation | undefined {
  return annotations.value.find((item) => item.id === id);
}

onMounted(load);
</script>

<template>
  <section class="page">
    <LoadingBlock v-if="loading" />
    <div v-else-if="error" class="alert">{{ error }} <button class="button small ghost" @click="load">重试</button></div>
    <template v-else>
      <header class="page-header">
        <div>
          <h1>教师复盘交接</h1>
          <p>{{ sessionTitle }} · 生成带时间戳的只读分享，收集批注并合并</p>
        </div>
        <RouterLink class="button ghost" :to="`/sessions/${sessionId}`">返回练习</RouterLink>
      </header>

      <p v-if="actionError" class="alert">{{ actionError }}</p>

      <article class="card stack">
        <h2>生成只读分享</h2>
        <form class="form-grid" @submit.prevent="createShare">
          <label class="field"><span>交接备注（可选）</span><input v-model="note" maxlength="200" placeholder="例如：交接给王老师，重点关注音准" /></label>
          <label class="field"><span>有效期</span>
            <select v-model="expiresInHours">
              <option v-for="option in expiryOptions" :key="option.label" :value="option.value">{{ option.label }}</option>
            </select>
          </label>
          <div class="row end full"><button class="button" type="submit" :disabled="creating">{{ creating ? "生成中…" : "生成分享链接" }}</button></div>
        </form>
        <div v-if="createdToken" class="created-token">
          <strong>链接已生成（仅显示这一次，请立即复制）：</strong>
          <div class="row">
            <input readonly :value="createdShareUrl()" @focus="($event.target as HTMLInputElement).select()" />
            <button class="button secondary" type="button" @click="copyCreatedUrl">{{ copied ? "已复制" : "复制" }}</button>
          </div>
        </div>
      </article>

      <article class="card stack">
        <h2>分享列表（{{ shares.length }}）</h2>
        <p v-if="!shares.length" class="muted">还没有分享。生成后可将链接发给教师或家长。</p>
        <div v-for="share in shares" :key="share.id" class="share-row">
          <div class="share-info">
            <div class="row">
              <span class="status-chip" :class="{ revoked: share.revokedAt, active: share.active }">{{ shareStatusLabel(share) }}</span>
              <strong>{{ share.note || "未备注" }}</strong>
            </div>
            <small>
              快照 {{ formatDateTime(share.snapshotAt) }} · 创建 {{ formatDateTime(share.createdAt) }} ·
              {{ share.expiresAt ? `到期 ${formatDateTime(share.expiresAt)}` : "长期有效" }} ·
              {{ share.lastAccessedAt ? `最近访问 ${formatDateTime(share.lastAccessedAt)}` : "尚未访问" }} ·
              批注 {{ share._count.annotations }} 条
            </small>
          </div>
          <div class="row">
            <button class="button small secondary" @click="selectShare(share)">批注</button>
            <button v-if="!share.revokedAt && share.active" class="button small danger" @click="revokeShare(share)">撤销</button>
          </div>
        </div>
      </article>

      <template v-if="selectedShare">
        <article class="card stack">
          <div class="row space-between">
            <h2>批注收集（{{ formatDateTime(selectedShare.createdAt) }} 的分享）</h2>
            <button class="button small ghost" @click="loadAudit">{{ showAudit ? "隐藏审计" : "审计轨迹" }}</button>
          </div>

          <div v-if="showAudit" class="audit-panel">
            <LoadingBlock v-if="auditLoading" />
            <p v-else-if="!auditEntries.length" class="muted">暂无审计记录。</p>
            <table v-else class="audit-table">
              <thead><tr><th>时间</th><th>动作</th><th>结果</th><th>追踪 ID</th></tr></thead>
              <tbody>
                <tr v-for="entry in auditEntries" :key="entry.id">
                  <td>{{ formatDateTime(entry.createdAt) }}</td>
                  <td>{{ shareAuditActionLabels[entry.action] ?? entry.action }}</td>
                  <td>{{ entry.result === "SUCCESS" ? "成功" : "失败" }}</td>
                  <td><code>{{ entry.traceId ?? "—" }}</code></td>
                </tr>
              </tbody>
            </table>
          </div>

          <LoadingBlock v-if="annotationsLoading" />
          <template v-else>
            <p v-if="!annotations.length" class="muted">还没有收到批注。</p>
            <template v-else>
              <div v-if="pendingAnnotations.length" class="row space-between">
                <label class="row checkbox-row">
                  <input type="checkbox" :checked="allPendingSelected" @change="toggleAllPending" />
                  全选待处理（{{ pendingAnnotations.length }}）
                </label>
                <button class="button small" :disabled="!selectedAnnotationIds.size || merging" @click="mergeSelected">
                  {{ merging ? "合并中…" : `合并选中（${selectedAnnotationIds.size}）` }}
                </button>
              </div>

              <div v-if="mergeResult" class="merge-result">
                <p>已合并 {{ mergeResult.batch.mergedCount }} 条；冲突 {{ mergeResult.batch.conflictCount }} 条（冲突版本已全部保留）。</p>
                <div v-for="conflict in mergeResult.plan.conflicts" :key="conflict.section" class="conflict-group">
                  <strong>{{ shareSectionLabels[conflict.section] }} 的冲突版本：</strong>
                  <ol>
                    <li v-for="(text, index) in conflict.contents" :key="index">{{ text }}</li>
                  </ol>
                </div>
              </div>

              <ul class="annotation-list">
                <li v-for="item in annotations" :key="item.id" class="annotation-item" :class="item.status.toLowerCase()">
                  <label v-if="item.status === 'PENDING'" class="checkbox-row">
                    <input type="checkbox" :checked="selectedAnnotationIds.has(item.id)" @change="toggleAnnotation(item.id)" />
                  </label>
                  <div class="annotation-body">
                    <div class="row">
                      <strong>{{ item.authorName }}</strong>
                      <span class="tag">{{ shareSectionLabels[item.section] }}</span>
                      <span class="status-chip" :class="item.status.toLowerCase()">{{ shareAnnotationStatusLabels[item.status] }}</span>
                      <small>{{ formatDateTime(item.createdAt) }}</small>
                    </div>
                    <p class="pre-wrap">{{ item.content }}</p>
                  </div>
                </li>
              </ul>
              <p v-if="conflictAnnotations.length" class="muted">
                冲突版本共 {{ conflictAnnotations.length }} 条，全部保留在列表中，请人工取舍后归档。
              </p>
            </template>
          </template>
        </article>
      </template>
    </template>
  </section>
</template>

<style scoped>
.muted { color: #5c6b66; }
.full { grid-column: 1 / -1; }
.space-between { justify-content: space-between; align-items: center; }
.created-token { display: grid; gap: 8px; background: #eef4f1; border-radius: 10px; padding: 12px; }
.share-row { display: flex; justify-content: space-between; align-items: center; gap: 12px; border-top: 1px solid #e2eae6; padding: 12px 0; flex-wrap: wrap; }
.share-info { display: grid; gap: 4px; }
.share-info small { color: #5c6b66; }
.status-chip { border-radius: 999px; padding: 2px 10px; font-size: 0.8rem; font-weight: 700; background: #eef4f1; color: #2f6b4f; }
.status-chip.revoked { background: #f7e4e0; color: #a33b2e; }
.status-chip.conflict { background: #fbf0d9; color: #8a6d1a; }
.status-chip.merged { background: #e4ecf7; color: #2e4a8a; }
.status-chip.pending { background: #eef4f1; color: #2f6b4f; }
.status-chip:not(.active):not(.revoked):not(.conflict):not(.merged):not(.pending) { background: #eceff1; color: #5c6b66; }
.checkbox-row { display: flex; align-items: center; gap: 8px; }
.checkbox-row input { width: auto; }
.annotation-list { list-style: none; margin: 0; padding: 0; display: grid; gap: 10px; }
.annotation-item { display: flex; gap: 10px; border: 1px solid #e2eae6; border-radius: 10px; padding: 10px 12px; }
.annotation-item.conflict { border-color: #e3c96f; background: #fffdf4; }
.annotation-body { display: grid; gap: 6px; min-width: 0; }
.annotation-body p { margin: 0; }
.tag { background: #eef4f1; border-radius: 6px; padding: 1px 8px; font-size: 0.8rem; }
.pre-wrap { white-space: pre-wrap; }
.merge-result { background: #eef4f1; border-radius: 10px; padding: 12px; display: grid; gap: 8px; }
.conflict-group ol { margin: 6px 0 0; padding-left: 20px; }
.audit-panel { border: 1px solid #e2eae6; border-radius: 10px; padding: 12px; overflow-x: auto; }
.audit-table { width: 100%; border-collapse: collapse; font-size: 0.9rem; }
.audit-table th, .audit-table td { text-align: left; padding: 6px 8px; border-bottom: 1px solid #e2eae6; }
.audit-table code { font-size: 0.78rem; }
</style>
