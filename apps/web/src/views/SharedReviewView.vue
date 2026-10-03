<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { useRoute } from "vue-router";
import { apiFetch, ApiError } from "../api/client.js";
import LoadingBlock from "../components/LoadingBlock.vue";
import { annotationLabels, formatDateTime, formatDuration, formatTimeMs, shareSectionLabels } from "../utils/format.js";

interface Snapshot {
  session: { id: string; title: string; instrument: string; focus: string | null; location: string | null; startedAt: string; actualDurationMs: number; completedAt: string | null };
  review: { goodPoints: string | null; mainIssues: string | null; nextFocus: string | null; noIssues: boolean; suggestedNextPracticeAt: string | null; completedAt: string | null };
  goals: Array<{ id: string; title: string; category: string; targetValue: string; unit: string; dueDate: string; status: string }>;
  markers: Array<{ id: string; type: keyof typeof annotationLabels; severity: number; startMs: number; endMs: number; title: string }>;
}
interface SharedResponse {
  share: { id: string; note: string | null; snapshotAt: string; createdAt: string; expiresAt: string | null };
  snapshot: Snapshot;
  serverTime: string;
}

const route = useRoute();
const data = ref<SharedResponse | null>(null);
const loading = ref(true);
const error = ref("");
const errorCode = ref("");

const authorName = ref("");
const section = ref<keyof typeof shareSectionLabels>("GENERAL");
const content = ref("");
const clientRequestId = ref(crypto.randomUUID());
const submitting = ref(false);
const submitted = ref(false);
const submitError = ref("");

const sectionOptions = computed(() => Object.entries(shareSectionLabels) as Array<[keyof typeof shareSectionLabels, string]>);

async function load(): Promise<void> {
  loading.value = true;
  error.value = "";
  try {
    data.value = await apiFetch<SharedResponse>(`/api/v1/shared/${String(route.params.token)}`);
  } catch (reason) {
    if (reason instanceof ApiError) {
      errorCode.value = reason.code;
      error.value = reason.message;
    } else {
      error.value = "分享加载失败，请稍后重试";
    }
  } finally {
    loading.value = false;
  }
}

async function submitAnnotation(): Promise<void> {
  if (submitting.value) return;
  submitting.value = true;
  submitError.value = "";
  try {
    await apiFetch(`/api/v1/shared/${String(route.params.token)}/annotations`, {
      method: "POST",
      body: JSON.stringify({
        authorName: authorName.value,
        section: section.value,
        content: content.value,
        clientRequestId: clientRequestId.value,
      }),
    });
    submitted.value = true;
    content.value = "";
    clientRequestId.value = crypto.randomUUID();
  } catch (reason) {
    submitError.value = reason instanceof ApiError ? reason.message : "批注提交失败，请稍后重试";
    if (reason instanceof ApiError && (reason.code === "SHARE_REVOKED" || reason.code === "SHARE_EXPIRED")) {
      errorCode.value = reason.code;
      error.value = reason.message;
      data.value = null;
    }
  } finally {
    submitting.value = false;
  }
}

onMounted(load);
</script>

<template>
  <main class="page shared-page">
    <LoadingBlock v-if="loading" />
    <div v-else-if="error" class="card stack" style="max-width: 640px; margin: 60px auto">
      <h1>无法查看分享</h1>
      <p class="alert">{{ error }}</p>
      <p v-if="errorCode === 'SHARE_REVOKED'">如需继续查看，请联系分享人重新生成链接。</p>
    </div>

    <template v-else-if="data">
      <header class="page-header">
        <div>
          <h1>{{ data.snapshot.session.title }}</h1>
          <p>{{ data.snapshot.session.instrument }} · 练习于 {{ formatDateTime(data.snapshot.session.startedAt) }} · {{ formatDuration(data.snapshot.session.actualDurationMs) }}</p>
          <p class="share-meta">
            只读快照 · 快照时间 {{ formatDateTime(data.share.snapshotAt) }} · 分享创建于 {{ formatDateTime(data.share.createdAt) }} ·
            {{ data.share.expiresAt ? `有效期至 ${formatDateTime(data.share.expiresAt)}` : "长期有效" }}
          </p>
        </div>
        <span class="badge readonly">只读</span>
      </header>

      <p v-if="data.share.note" class="card">交接备注：{{ data.share.note }}</p>

      <div class="stack">
        <article class="card stack">
          <h2>复盘内容</h2>
          <section>
            <h3>做得好的地方</h3>
            <p class="pre-wrap">{{ data.snapshot.review.goodPoints || "（未填写）" }}</p>
          </section>
          <section>
            <h3>主要问题</h3>
            <p v-if="data.snapshot.review.noIssues">本次练习无异常</p>
            <p v-else class="pre-wrap">{{ data.snapshot.review.mainIssues || "（未填写）" }}</p>
          </section>
          <section>
            <h3>下次练习重点</h3>
            <p class="pre-wrap">{{ data.snapshot.review.nextFocus || "（未填写）" }}</p>
          </section>
          <p v-if="data.snapshot.review.suggestedNextPracticeAt">建议下次练习时间：{{ formatDateTime(data.snapshot.review.suggestedNextPracticeAt) }}</p>
        </article>

        <article v-if="data.snapshot.markers.length" class="card stack">
          <h2>问题标记（{{ data.snapshot.markers.length }}）</h2>
          <ul class="plain-list">
            <li v-for="marker in data.snapshot.markers" :key="marker.id">
              <strong>{{ marker.title }}</strong>
              <span>{{ annotationLabels[marker.type] }} · 严重度 {{ marker.severity }} · {{ formatTimeMs(marker.startMs) }} – {{ formatTimeMs(marker.endMs) }}</span>
            </li>
          </ul>
        </article>

        <article v-if="data.snapshot.goals.length" class="card stack">
          <h2>练习目标（{{ data.snapshot.goals.length }}）</h2>
          <ul class="plain-list">
            <li v-for="goal in data.snapshot.goals" :key="goal.id">
              <strong>{{ goal.title }}</strong>
              <span>目标 {{ goal.targetValue }} {{ goal.unit }} · 截止 {{ goal.dueDate }}</span>
            </li>
          </ul>
        </article>

        <article class="card stack">
          <h2>提交批注</h2>
          <p v-if="submitted" class="success-note">批注已提交，感谢反馈。可继续提交下一条。</p>
          <p v-if="submitError" class="alert">{{ submitError }}</p>
          <form class="form-grid" @submit.prevent="submitAnnotation">
            <label class="field"><span>署名</span><input v-model="authorName" required maxlength="80" placeholder="您的姓名或称呼" /></label>
            <label class="field"><span>批注栏目</span>
              <select v-model="section">
                <option v-for="[value, label] in sectionOptions" :key="value" :value="value">{{ label }}</option>
              </select>
            </label>
            <label class="field full"><span>批注内容</span><textarea v-model="content" required maxlength="2000" placeholder="针对复盘内容写下您的意见或建议"></textarea></label>
            <div class="row end full"><button class="button" type="submit" :disabled="submitting">{{ submitting ? "提交中…" : "提交批注" }}</button></div>
          </form>
        </article>
      </div>
    </template>
  </main>
</template>

<style scoped>
.shared-page { max-width: 880px; margin: 0 auto; padding: 32px 18px 64px; }
.share-meta { font-size: 0.85rem; color: #5c6b66; }
.badge.readonly { background: #eef4f1; color: #2f6b4f; border-radius: 999px; padding: 4px 14px; font-weight: 700; align-self: flex-start; }
.pre-wrap { white-space: pre-wrap; }
.plain-list { list-style: none; padding: 0; margin: 0; display: grid; gap: 10px; }
.plain-list li { display: grid; gap: 2px; border-left: 3px solid #9fc3b2; padding-left: 10px; }
.plain-list span { color: #5c6b66; font-size: 0.9rem; }
.success-note { color: #2f6b4f; font-weight: 700; }
.full { grid-column: 1 / -1; }
</style>
