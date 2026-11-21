// Phone-scale audit tool (ACTIVE GOAL T1): rank live-DOM computed font sizes /
// control heights by class at phone viewports, for the profile picker, home,
// series detail episodes and the player episode-panel harness. Run against a
// built + served app: npm run build && npm run serve (4173), then:
//   node scripts/probes/scale-audit.mjs          # 390x844
//   VW=390 VH=660 node scripts/probes/scale-audit.mjs
//   VW=844 VH=390 node scripts/probes/scale-audit.mjs
// Screenshots land in OUT_DIR (default: repo scripts/probes/audit-out).
import { chromium } from "playwright";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const BASE = (process.env.BASE_URL || "http://127.0.0.1:4173").replace(/\/+$/, "");
const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT = process.env.OUT_DIR || path.join(HERE, "audit-out");
const VW = Number(process.env.VW || 390);
const VH = Number(process.env.VH || 844);

const RANKER = (scope) => {
  const root = scope ? document.querySelector(scope) : document.body;
  if (!root) return { missing: scope };
  const groups = {};
  for (const el of root.querySelectorAll("*")) {
    const r = el.getBoundingClientRect();
    const s = getComputedStyle(el);
    if (r.width === 0 || r.height === 0) continue;
    if (s.display === "none" || s.visibility === "hidden" || s.opacity === "0") continue;
    const fs = parseFloat(s.fontSize);
    const isLeaf = !el.querySelector(":scope > *");
    const hasText = (el.innerText || el.textContent || "").trim().length > 0;
    if (!(isLeaf && hasText && fs >= 16) && !(r.height >= 56)) continue;
    const cls =
      (el.className?.toString?.() || "").split(/\s+/).filter(Boolean).slice(0, 2).join(".") ||
      el.tagName.toLowerCase();
    const key = el.tagName.toLowerCase() + "." + cls;
    const rec = (groups[key] ||= { n: 0, fs: 0, h: 0, w: 0, lh: 0 });
    rec.n++;
    rec.fs = Math.max(rec.fs, Math.round(fs));
    rec.h = Math.max(rec.h, Math.round(r.height));
    rec.w = Math.max(rec.w, Math.round(r.width));
    const lh = parseFloat(s.lineHeight);
    if (Number.isFinite(lh)) rec.lh = Math.max(rec.lh, Math.round(lh));
  }
  const gaps = {};
  for (const el of root.querySelectorAll("*")) {
    const s = getComputedStyle(el);
    if (!["flex", "grid"].includes(s.display)) continue;
    const m = Math.max(parseFloat(s.rowGap) || 0, parseFloat(s.columnGap) || 0);
    if (m < 24) continue;
    const cls =
      (el.className?.toString?.() || "").split(/\s+/).filter(Boolean).slice(0, 2).join(".") ||
      el.tagName.toLowerCase();
    gaps[el.tagName.toLowerCase() + "." + cls] = Math.max(
      gaps[el.tagName.toLowerCase() + "." + cls] || 0,
      Math.round(m)
    );
  }
  return { groups, gaps };
};

const dump = (label, data) => {
  if (!data || data.missing) return console.log(`!! scope missing: ${data?.missing}`);
  const rows = Object.entries(data.groups)
    .map(([k, v]) => `${k} n=${v.n} fs=${v.fs} h=${v.h} w=${v.w} lh=${v.lh}`)
    .sort((a, b) => {
      const fa = +/fs=(\d+)/.exec(a)[1],
        fb = +/fs=(\d+)/.exec(b)[1];
      const ha = +/ h=(\d+)/.exec(a)[1],
        hb = +/ h=(\d+)/.exec(b)[1];
      return fb - fa || hb - ha;
    });
  console.log(`\n===== ${label} =====`);
  console.log(rows.slice(0, 45).join("\n") || "(no TV-scale offenders)");
  console.log(
    "-- gaps >=24px --\n" +
      Object.entries(data.gaps)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 20)
        .map(([k, v]) => `${k} gap=${v}`)
        .join("\n")
  );
};

const scopeDump = (page, selector, label) =>
  page
    .evaluate((sel) => {
      const out = [];
      const seen = new Set();
      for (const el of document.querySelectorAll(sel + ", " + sel + " *")) {
        const r = el.getBoundingClientRect();
        const s = getComputedStyle(el);
        if (r.width === 0 || r.height === 0) continue;
        const key =
          el.tagName.toLowerCase() +
          "." +
          ((el.className?.toString?.() || "").split(/\s+/)[0] || "");
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(
          `${key} w=${Math.round(r.width)} h=${Math.round(r.height)} fs=${Math.round(parseFloat(s.fontSize))} lh=${s.lineHeight}`
        );
      }
      return out.slice(0, 50);
    }, selector)
    .then((rows) => console.log(`-- ${label} --\n` + rows.join("\n")));

const browser = await chromium.launch();
const ctx = await browser.newContext({
  viewport: { width: VW, height: VH },
  hasTouch: true,
  isMobile: true
});
const page = await ctx.newPage();
page.on("pageerror", (e) => console.log("PAGEERR:", String(e).slice(0, 300)));
const shoot = (name) => page.screenshot({ path: path.join(OUT, `scale-${name}-${VW}x${VH}.png`) });

const walkBoot = async ({ stopAtPicker = false, budgetMs = 25000 } = {}) => {
  const deadline = Date.now() + budgetMs;
  while (Date.now() < deadline) {
    if (await page.locator(".home-nav-item").count()) break;
    if (stopAtPicker && (await page.locator(".profile-card[data-profile-id]").count())) break;
    const handled = await page.evaluate((stop) => {
      const back = document.querySelector("#qr-back-btn");
      if (back) {
        back.click();
        return "qr";
      }
      if (!stop) {
        const pick = document.querySelector(".profile-card[data-profile-id]");
        if (pick) {
          pick.click();
          return "profile";
        }
      }
      const layout =
        [...document.querySelectorAll(".experience-mode-card[data-layout]")].find((n) =>
          /modern/i.test(n.textContent || "")
        ) || document.querySelector(".experience-mode-card[data-layout]");
      if (layout) {
        layout.click();
        return "layout";
      }
      const mode =
        document.querySelector('.experience-mode-card[data-mode="ADVANCED"]') ||
        document.querySelector(".experience-mode-card[data-mode]");
      if (mode) {
        mode.click();
        return "mode";
      }
      return null;
    }, stopAtPicker);
    await page.waitForTimeout(handled ? 700 : 400);
  }
};

// 1) Profile picker ("Who's watching?" screen). The boot-time auto-open needs
// a reachable profile-sync backend; the touch-reachable entry is
// Settings -> Manage profiles, which mounts the SAME #profileSelection screen
// (management mode). Walk there instead.
await page.goto(BASE + "/", { waitUntil: "domcontentloaded" });
await walkBoot();
await page.waitForTimeout(1000);
await page.evaluate(() =>
  [...document.querySelectorAll(".home-nav-item")]
    .find((n) => (n.innerText || "").includes("Settings"))
    ?.click()
);
await page.waitForTimeout(2500);
const settingsProbe = await page.evaluate(() => {
  const chip = [...document.querySelectorAll(".settings-nav-item")].find((n) =>
    /profile/i.test(n.innerText || "")
  );
  if (chip) chip.click();
  return chip ? "chip:" + chip.innerText.trim().slice(0, 20) : "no-chip";
});
console.log("settings profiles chip:", settingsProbe);
await page.waitForTimeout(1500);
const manageProbe = await page.evaluate(() => {
  const row =
    document.querySelector(".settings-profile-manage-row") ||
    [...document.querySelectorAll('[data-action*="profile"]')].find((n) =>
      /manage/i.test(n.innerText || "")
    );
  if (row) {
    row.click();
    return "clicked:" + (row.innerText || "").trim().slice(0, 30);
  }
  return (
    "row-missing; actions=" +
    JSON.stringify(
      [...document.querySelectorAll("[data-action]")]
        .map((n) => n.getAttribute("data-action"))
        .filter((a) => /profile/i.test(a || ""))
    )
  );
});
console.log("manage row probe:", manageProbe);
await page.waitForTimeout(2500);
if (!(await page.locator(".profile-card").count())) {
  console.log(
    "picker-absent diagnostic:",
    JSON.stringify(
      await page.evaluate(() => ({
        body: document.body.innerText.replace(/\s+/g, " ").slice(0, 200),
        cards: document.querySelectorAll(".profile-card,.experience-mode-card").length,
        qrBack: !!document.querySelector("#qr-back-btn"),
        route: location.hash || location.pathname
      }))
    )
  );
}
if (await page.locator(".profile-card").count()) {
  dump(`PROFILE PICKER ${VW}x${VH}`, await page.evaluate(RANKER, "#profileSelection"));
  await scopeDump(page, "#profileSelection", "profile picker classes");
  await shoot("profile-picker");
  const opened = await page.evaluate(() => {
    const b = [
      ...document.querySelectorAll(
        "#profileSelection button, #profileSelection [role=button], #profileSelection .focusable"
      )
    ].find((n) =>
      /add|edit|create|manage/i.test(n.innerText || n.getAttribute("aria-label") || "")
    );
    if (b) {
      b.click();
      return (b.innerText || b.getAttribute("aria-label") || "").trim().slice(0, 40);
    }
    return null;
  });
  console.log("editor affordance:", JSON.stringify(opened));
  if (opened) {
    await page.waitForTimeout(1200);
    dump(`PROFILE EDITOR ${VW}x${VH}`, await page.evaluate(RANKER, ".profile-editor-backdrop"));
    await scopeDump(page, ".profile-editor-panel", "profile editor scope");
    await shoot("profile-editor");
    // PIN overlay: pick a profile with a PIN would need server state; open the
    // PIN UI via any pin affordance if present, else dump editor only.
    const pin = await page.evaluate(() => {
      const b = [...document.querySelectorAll("#profileSelection *")].find(
        (n) => n.children.length === 0 && /pin/i.test(n.innerText || "")
      );
      if (b) {
        b.click();
        return (b.innerText || "").trim().slice(0, 30);
      }
      return null;
    });
    if (pin) {
      await page.waitForTimeout(1000);
      await scopeDump(page, ".profile-pin-overlay, [class*=pin-]", "profile pin scope");
      await shoot("profile-pin");
    }
  }
  // Reset to a clean home for the rest of the walk (dialogs/state persist
  // across in-app navigation; a reload is the cheapest reliable reset).
  await page.goto(BASE + "/", { waitUntil: "domcontentloaded" });
  await walkBoot();
} else {
  await shoot("profile-picker-missing");
}

if (process.env.ONLY === "picker") {
  await browser.close();
  process.exit(0);
}

// 2) Home
await walkBoot();
await page.waitForTimeout(1500);
dump(`HOME ${VW}x${VH}`, await page.evaluate(RANKER));
await shoot("home");

// 3) Series detail: sweep home cards until .series-episode-card appears.
const detailState = () =>
  page.evaluate(() => ({
    episodes: document.querySelectorAll(".series-episode-card").length,
    title: (
      document.querySelector(".detail-title, .series-detail-title, [class*=detail-title]")
        ?.innerText || ""
    ).slice(0, 50),
    seasons: [...document.querySelectorAll("[class*=season]")]
      .map((e) => e.className.toString().split(" ")[0])
      .slice(0, 6)
  }));
let found = null;
const nCards = await page.locator(".home-main .home-poster-card").count();
for (let i = 0; i < Math.min(nCards, 24) && !found; i++) {
  await page.evaluate(
    (idx) => document.querySelectorAll(".home-main .home-poster-card")[idx]?.click(),
    i
  );
  await page.waitForTimeout(1800);
  const st = await detailState();
  if (st.episodes > 0) {
    found = { via: "card" + i, ...st };
    break;
  }
  await page.goBack().catch(() => {});
  await page.waitForTimeout(900);
  if (!(await page.locator(".home-nav-item").count())) await walkBoot({ budgetMs: 8000 });
}
// Fallback: search a known series.
if (!found) {
  await page.evaluate(() =>
    [...document.querySelectorAll(".home-nav-item")]
      .find((n) => (n.innerText || "").includes("Search"))
      ?.click()
  );
  await page.waitForTimeout(2500);
  try {
    await page.waitForSelector("#searchInput", { timeout: 10000 });
    await page.fill("#searchInput", "Severance");
    await page.keyboard.press("Enter");
    await page.waitForTimeout(4000);
    await page.evaluate(() =>
      document.querySelector(".search-results-row .home-poster-card, .home-poster-card")?.click()
    );
    await page.waitForTimeout(2500);
    const st = await detailState();
    if (st.episodes > 0) found = { via: "search", ...st };
  } catch (e) {
    console.log("search fallback failed:", String(e).slice(0, 120));
  }
}
if (found) {
  console.log("\nFOUND SERIES DETAIL:", JSON.stringify(found));
  dump(`DETAIL ${VW}x${VH}`, await page.evaluate(RANKER, ".series-detail-shell, .detail-shell"));
  await scopeDump(page, ".series-episode-card", "episode card scope");
  await scopeDump(page, "[class*=season]", "season selector scope");
  await shoot("detail");
} else {
  console.log(
    "!! no series-with-episodes found across sweep; last:",
    JSON.stringify(await detailState())
  );
}

// 4) Player episode panel via the static harness.
const harnessHtml = (await readFile(path.join(HERE, "player-harness.html"), "utf8")).replaceAll(
  "http://127.0.0.1:4173",
  BASE
);
const p2 = await ctx.newPage();
await p2.setContent(harnessHtml, { waitUntil: "domcontentloaded" });
await p2.waitForTimeout(1200);
dump(`PLAYER EPISODE PANEL ${VW}x${VH}`, await p2.evaluate(RANKER, ".player-episode-panel"));
await p2
  .evaluate(() => document.querySelector(".player-episode-panel").scrollIntoView())
  .catch(() => {});
await p2.screenshot({ path: path.join(OUT, `scale-episode-panel-${VW}x${VH}.png`) });

await browser.close();
