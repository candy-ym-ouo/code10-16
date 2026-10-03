// Browser verification for the teacher review handover flow (variant A).
// Drives the real UI: create a timestamped read-only share, collect two conflicting
// annotations, merge them with versions preserved, revoke, and confirm audit trail.
import fs from "node:fs";
import path from "node:path";

export default async function verify({ page, webUrl, variant }) {
  const checks = [];
  const record = (kind, value, ok) => checks.push({ kind, value: String(value), ok: Boolean(ok) });
  const fixture = JSON.parse(fs.readFileSync(path.join(variant.stateDir, "repro-session.json"), "utf8"));
  const abs = (route) => new URL(route, webUrl).href;

  page.on("dialog", (dialog) => void dialog.accept());

  // 1. Teacher signs in.
  await page.goto(abs("/login"), { waitUntil: "domcontentloaded", timeout: 30000 });
  await page.locator('input[type="email"]').fill(fixture.email);
  await page.locator('input[type="password"]').fill(variant.password);
  await page.getByRole("button", { name: "登录" }).first().click();
  await page.waitForFunction(() => !location.pathname.endsWith("/login"), null, { timeout: 20000 });
  record("登录", fixture.email, true);

  // 2. Session detail exposes the handover entry.
  await page.goto(abs(`/sessions/${fixture.sessionId}`), { waitUntil: "domcontentloaded", timeout: 30000 });
  await page.getByRole("heading", { name: fixture.sessionTitle }).first().waitFor({ timeout: 20000 });
  const handoverLink = page.getByRole("link", { name: "复盘交接" }).first();
  await handoverLink.waitFor({ timeout: 15000 });
  record("练习详情出现「复盘交接」入口", fixture.sessionTitle, true);

  // 3. Create the share from the handover page.
  await handoverLink.click();
  await page.getByRole("heading", { name: "教师复盘交接" }).first().waitFor({ timeout: 20000 });
  await page.locator('input[placeholder*="交接给王老师"]').fill("交接给王老师，重点关注音准");
  await page.getByRole("button", { name: "生成分享链接" }).click();
  const tokenInput = page.locator(".created-token input");
  await tokenInput.waitFor({ timeout: 20000 });
  const shareUrl = await tokenInput.inputValue();
  const shareCardText = await page.locator(".share-row").first().innerText();
  record("生成带时间戳的只读分享", shareUrl.replace(/^.*\/shared\//, "/shared/"), /\/shared\//.test(shareUrl));
  record("分享列表展示快照时间", shareCardText.match(/快照[^\n]*/)?.[0] ?? shareCardText, /快照\s*\d{4}/.test(shareCardText));

  // 4. Open the public link: read-only snapshot with no edit controls.
  await page.goto(shareUrl, { waitUntil: "domcontentloaded", timeout: 30000 });
  await page.getByRole("heading", { name: fixture.sessionTitle }).first().waitFor({ timeout: 25000 });
  const sharedText = await page.locator("body").innerText();
  const editButtons = await page.getByRole("button", { name: /保存|编辑|删除|归档|继续复盘/ }).count();
  record("公开链接展示只读快照", "只读快照 · 快照时间", sharedText.includes("只读快照") && sharedText.includes("快照时间"));
  record("快照页无编辑入口", `匹配编辑类按钮 ${editButtons} 个`, editButtons === 0);

  // 5. Guest collects two annotations in the same section (different content -> conflict).
  async function submitAnnotation(author, content) {
    await page.locator('form input[placeholder*="姓名"]').fill(author);
    await page.locator("form select").selectOption({ label: "主要问题" });
    await page.locator("form textarea").fill(content);
    await page.getByRole("button", { name: "提交批注" }).click();
    await page.getByText("批注已提交", { exact: false }).first().waitFor({ timeout: 15000 });
  }
  await submitAnnotation("王老师", "中段换把后偏高，建议先做空弦校准再回到乐句。");
  await submitAnnotation("李老师", "结尾两小节偏低，建议 60 BPM 单独慢练后再合练。");
  record("只读分享收集批注", "2 条批注已提交", true);

  // 6. Merge in the admin UI; conflicting versions must all stay.
  await page.goto(abs(`/sessions/${fixture.sessionId}/handover`), { waitUntil: "domcontentloaded", timeout: 30000 });
  await page.getByRole("heading", { name: "教师复盘交接" }).first().waitFor({ timeout: 20000 });
  await page.getByRole("button", { name: "批注", exact: true }).first().click();
  await page.getByText("全选待处理", { exact: false }).first().waitFor({ timeout: 15000 });
  await page.getByText("全选待处理", { exact: false }).first().click();
  await page.getByRole("button", { name: /合并选中/ }).click();
  await page.getByText("冲突版本已全部保留", { exact: false }).first().waitFor({ timeout: 20000 });
  const mergedText = await page.locator("body").innerText();
  const keptBoth =
    mergedText.includes("中段换把后偏高，建议先做空弦校准再回到乐句。") &&
    mergedText.includes("结尾两小节偏低，建议 60 BPM 单独慢练后再合练。");
  record("合并批注保留冲突版本", mergedText.match(/已合并\s*\d+\s*条；冲突\s*\d+\s*条/)?.[0] ?? "冲突已生成", keptBoth && mergedText.includes("冲突待取舍"));

  // 7. Audit trail is visible and traceable.
  await page.getByRole("button", { name: /审计轨迹/ }).click();
  await page.locator(".audit-table tbody tr").first().waitFor({ timeout: 15000 });
  const auditText = await page.locator(".audit-table").innerText();
  const auditRows = await page.locator(".audit-table tbody tr").count();
  const auditKinds = ["创建分享", "收到批注", "合并批注"].filter((label) => auditText.includes(label));
  record("审计轨迹可追溯", `${auditKinds.join(" / ")}；审计 ${auditRows} 条`, auditKinds.length >= 2 && auditRows >= 3);

  // 8. Revoke takes effect on the next request.
  await page.getByRole("button", { name: "撤销", exact: true }).first().click();
  await page.getByText("已撤销", { exact: false }).first().waitFor({ timeout: 15000 });
  await page.goto(shareUrl, { waitUntil: "domcontentloaded", timeout: 30000 });
  await page.getByRole("heading", { name: "无法查看分享" }).first().waitFor({ timeout: 20000 });
  const blockedText = await page.locator("body").innerText();
  record("撤销立即生效", blockedText.match(/该分享已被撤销[^\n]*/)?.[0] ?? "撤销后链接不可访问", /撤销/.test(blockedText));

  const ok = checks.every((check) => check.ok);
  return { ok, checks, bodyText: blockedText.slice(0, 500) };
}
