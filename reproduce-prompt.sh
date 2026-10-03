#!/usr/bin/env bash
# Prepares deterministic fixtures for the teacher handover verification:
# demo account -> practice session -> saved review (snapshot source for the read-only share).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT"

STATE_DIR="${STATE_DIR:-$HOME/.cache/code10-16-a}"
export STATE_DIR
export API_BASE_URL="${API_BASE_URL:-$(cat "$STATE_DIR/api-url")}"

echo "[repro] API: $API_BASE_URL"

node --input-type=module - <<'NODE'
import fs from "node:fs";
import path from "node:path";

const api = process.env.API_BASE_URL;
const stateDir = process.env.STATE_DIR;
const email = "handover-teacher@code4.local";
const password = "Code10-16-A-Repro-2026!";
const displayName = "王老师";

async function call(method, route, body, token) {
  const response = await fetch(`${api}${route}`, {
    method,
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let payload = null;
  try { payload = text ? JSON.parse(text) : null; } catch { payload = text; }
  if (!response.ok) {
    const error = new Error(`${method} ${route} -> ${response.status} ${text.slice(0, 240)}`);
    error.status = response.status;
    throw error;
  }
  return payload;
}

let auth;
try {
  auth = await call("POST", "/api/v1/auth/register", { email, password, displayName });
  console.log(`[repro] 创建演示账号 ${email}`);
} catch (error) {
  if (error.status !== 409) throw error;
  auth = await call("POST", "/api/v1/auth/login", { email, password });
  console.log(`[repro] 复用演示账号 ${email}`);
}
const token = auth.accessToken;

const existing = await call("GET", "/api/v1/sessions?status=ALL&limit=50", undefined, token);
let session = existing.data.find((item) => item.title === "音准专项练习 · 教师交接演示");
if (session) {
  console.log(`[repro] 复用练习 ${session.id}`);
} else {
  session = (await call("POST", "/api/v1/sessions", {
    title: "音准专项练习 · 教师交接演示",
    instrument: "小提琴",
    focus: "三周把音准偏差收敛到 ±10 音分",
    location: "琴房 A",
    startedAt: new Date(Date.now() - 90 * 60 * 1000).toISOString(),
    actualDurationMs: 45 * 60 * 1000,
  }, token)).session;
  console.log(`[repro] 创建练习 ${session.id}`);
}

await call("PUT", `/api/v1/sessions/${session.id}/review`, {
  version: session.version,
  goodPoints: "长音稳定度明显提升，慢练时能主动监听音准。",
  mainIssues: "中段换把后偏高，乐句结尾第二个音容易偏低。",
  nextFocus: "换把后立即用空弦校准，再用节拍器 60 BPM 慢练两小节。",
  noIssues: false,
  suggestedNextPracticeAt: new Date(Date.now() + 2 * 24 * 3600 * 1000).toISOString(),
}, token);
console.log("[repro] 复盘内容已保存，可生成带时间戳的只读交接分享");

fs.writeFileSync(path.join(stateDir, "repro-session.json"), JSON.stringify({
  email,
  password,
  sessionId: session.id,
  sessionTitle: "音准专项练习 · 教师交接演示",
}, null, 2));

console.log(`[repro] 准备完成：浏览器将打开 /sessions/${session.id}`);
NODE
