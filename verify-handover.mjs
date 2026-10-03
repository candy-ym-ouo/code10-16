// Browser verification for the teacher review handover flow (variant B).
// Opens the real UI the prompt describes. Variant B ships the handover backend but no
// web surface for it, so the browser checks fail; the panel also reports what the API can do.
import fs from "node:fs";
import path from "node:path";

export default async function verify({ page, webUrl, variant }) {
  const checks = [];
  const record = (kind, value, ok) => checks.push({ kind, value: String(value), ok: Boolean(ok) });
  const fixture = JSON.parse(fs.readFileSync(path.join(variant.stateDir, "repro-session.json"), "utf8"));
  const abs = (route) => new URL(route, webUrl).href;

  // 1. Teacher signs in.
  await page.goto(abs("/login"), { waitUntil: "domcontentloaded", timeout: 30000 });
  await page.locator('input[type="email"]').fill(fixture.email);
  await page.locator('input[type="password"]').fill(variant.password);
  await page.getByRole("button", { name: "登录" }).first().click();
  await page.waitForFunction(() => !location.pathname.endsWith("/login"), null, { timeout: 20000 });
  record("登录", fixture.email, true);

  // 2. Session detail: the handover entry point the prompt requires.
  await page.goto(abs(`/sessions/${fixture.sessionId}`), { waitUntil: "domcontentloaded", timeout: 30000 });
  await page.getByRole("heading", { name: fixture.sessionTitle }).first().waitFor({ timeout: 20000 });
  const entryCount = await page.getByText("复盘交接", { exact: false }).count();
  record("练习详情出现「复盘交接」入口", `匹配 ${entryCount} 处`, entryCount > 0);

  // 3. The route the feature would live on.
  await page.goto(abs(`/sessions/${fixture.sessionId}/handover`), { waitUntil: "domcontentloaded", timeout: 30000 });
  await page.waitForTimeout(400);
  const notFoundText = await page.locator("body").innerText();
  const missingRoute = notFoundText.includes("页面不存在");
  record("交接页面可访问", missingRoute ? "显示「页面不存在」" : notFoundText.slice(0, 60), !missingRoute);

  // 4. Probe the API from the browser session to show what the backend actually provides.
  const probe = await page.evaluate(async ({ sessionId }) => {
    const out = { steps: [] };
    const refresh = await fetch("/api/v1/auth/refresh", {
      method: "POST",
      credentials: "include",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    if (!refresh.ok) return { ok: false, message: `refresh ${refresh.status}` };
    const { accessToken } = await refresh.json();
    const call = async (method, url, body, token) => {
      const response = await fetch(url, {
        method,
        credentials: "include",
        headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const text = await response.text();
      let payload = null;
      try { payload = text ? JSON.parse(text) : null; } catch { payload = text; }
      return { status: response.status, payload };
    };
    const handover = await call("POST", "/api/v1/handovers", { sessionId, title: "教师交接（接口探针）" }, accessToken);
    out.createHandover = handover.status;
    out.handoverId = handover.payload?.handover?.id;
    if (!out.handoverId) return { ok: false, message: `create handover ${handover.status}`, out };
    const share = await call("POST", `/api/v1/handovers/${out.handoverId}/shares`, { label: "只读分享", expiresInSeconds: 3600 }, accessToken);
    out.createShare = share.status;
    out.shareId = share.payload?.share?.id;
    out.token = share.payload?.token;
    const snapshot = await call("GET", `/api/v1/shared/handovers/${out.token}`);
    out.publicSnapshot = snapshot.status;
    const nextFocus = snapshot.payload?.snapshot?.review?.nextFocus ?? "";
    const annotation = await call("POST", `/api/v1/shared/handovers/${out.token}/annotations`, {
      authorName: "王老师",
      kind: "COMMENT",
      fieldPath: "nextFocus",
      start: 0,
      end: nextFocus.length || 1,
      quote: nextFocus || "x",
      body: "建议先做空弦校准再慢练。",
    });
    out.addAnnotation = annotation.status;
    const revoke = await call("POST", `/api/v1/handovers/${out.handoverId}/shares/${out.shareId}/revoke`, {}, accessToken);
    out.revoke = revoke.status;
    const denied = await call("GET", `/api/v1/shared/handovers/${out.token}`);
    out.afterRevoke = denied.status;
    const audit = await call("GET", `/api/v1/handovers/${out.handoverId}/audit`, undefined, accessToken);
    out.auditEntries = audit.payload?.entries?.length ?? 0;
    out.ok = true;
    return out;
  }, { sessionId: fixture.sessionId });

  const apiLine = probe.ok
    ? `接口探针：创建交接 ${probe.createHandover} · 创建分享 ${probe.createShare} · 公开快照 ${probe.publicSnapshot} · 提交批注 ${probe.addAnnotation} · 撤销 ${probe.revoke} · 撤销后访问 ${probe.afterRevoke} · 审计 ${probe.auditEntries} 条`
    : `接口探针失败：${probe.message}`;
  record("后端交接接口可用", apiLine, Boolean(probe.ok && probe.afterRevoke >= 400));

  // 5. Explain the observed gap on the page that stays in the recording.
  await page.evaluate((lines) => {
    const box = document.createElement("div");
    box.id = "handover-gap-report";
    Object.assign(box.style, {
      position: "fixed", left: "24px", right: "24px", top: "20px", zIndex: "999999",
      padding: "16px 20px", borderRadius: "10px", background: "#b42318", color: "#fff",
      fontFamily: '-apple-system,BlinkMacSystemFont,"PingFang SC",sans-serif', fontSize: "15px",
      lineHeight: "1.6", boxShadow: "0 8px 30px rgba(0,0,0,.28)", textAlign: "left",
    });
    const title = document.createElement("strong");
    title.textContent = "B 复现结果：复盘交接在浏览器中不可用";
    const body = document.createElement("div");
    body.textContent = lines.join("\n");
    body.style.whiteSpace = "pre-wrap";
    body.style.marginTop = "6px";
    box.append(title, body);
    document.body.appendChild(box);
  }, [
    `练习详情没有「复盘交接」入口；访问 /sessions/:id/handover 显示「页面不存在」。`,
    apiLine,
    "Web 端未实现交接界面，教师无法生成只读分享、收集批注、撤销授权或查看审计。",
  ]);
  await page.waitForTimeout(1200);

  const ok = checks.every((check) => check.ok);
  return { ok, checks, bodyText: `${notFoundText.slice(0, 240)} | ${apiLine}` };
}
