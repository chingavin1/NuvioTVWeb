// Touch-tier probe suite, regression gate for the mobile web (.web-touch) tier.
// Per-screen audits at 390x844 with touch: horizontal overflow, offscreen
// elements, sub-44px tap targets, and overlapping leaf text pairs.
// Requires a built app served over http (what CI does; locally:
//   npm run build && npm run serve   # port 4173
//   npm run test:touch-probe).
// BASE_URL env overrides the server origin. Exit 0 = all screens pass.
import { chromium } from "playwright";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const BASE_URL = (process.env.BASE_URL || "http://127.0.0.1:4173").replace(/\/+$/, "");
const HERE = path.dirname(fileURLToPath(import.meta.url));
// Viewport override for the 3-viewport verification pass (T8):
//   VW=390 VH=660 npm run test:mobile-web   (real portrait Safari height)
//   VW=844 VH=390 npm run test:mobile-web   (landscape phone)
const VW = Number(process.env.VW) || 390,
  VH = Number(process.env.VH) || 844,
  OVER = 4;

// The app checks NuvioMedia/NuvioTVSmart's GitHub releases on startup and
// raises a modal update prompt when upstream is ahead. That external state
// changes independently of the app build (it started firing ~24h ago and
// silently broke the swipe/hold/auth gates by stealing gestures and taps).
// Probe sessions must be deterministic: neutralize that one endpoint.
const NEUTRAL_UPDATE_CHECK = () => {
  const realFetch = window.fetch.bind(window);
  window.fetch = (input, ...rest) => {
    const url = typeof input === "string" ? input : (input && input.url) || "";
    if (url.includes("/repos/NuvioMedia/NuvioTVSmart/releases"))
      return Promise.resolve(new Response("probe: update check disabled", { status: 503 }));
    return realFetch(input, ...rest);
  };
};

const AUDIT = (arg) => {
  const scopeSelector = typeof arg === "string" ? arg : arg.scope;
  const VW = (typeof arg === "object" && arg.vw) || 390,
    OVER = 4;
  const root = scopeSelector ? document.querySelector(scopeSelector) : document.body;
  if (!root) return { missing: scopeSelector };
  const vis = (el) => {
    const r = el.getBoundingClientRect(),
      s = getComputedStyle(el);
    return (
      r.width > 0 &&
      r.height > 0 &&
      s.display !== "none" &&
      s.visibility !== "hidden" &&
      s.opacity !== "0"
    );
  };
  const fails = [];
  if (document.documentElement.scrollWidth > VW + OVER)
    fails.push({ kind: "h-overflow", scrollW: document.documentElement.scrollWidth });
  const hScroller = (el) => {
    for (let a = el.parentElement; a && a !== document.documentElement; a = a.parentElement) {
      const s = getComputedStyle(a);
      if (["auto", "scroll"].includes(s.overflowX) && a.scrollWidth > a.clientWidth + 2)
        return true;
    }
    return false;
  };
  const off = [...root.querySelectorAll("*")]
    .filter((el) => {
      if (!vis(el) || hScroller(el)) return false;
      const r = el.getBoundingClientRect();
      return (
        r.width > 20 &&
        // Horizontal overflow without a scroller is unreachable; vertical
        // below/above-fold content is natively scrollable on the touch tier.
        (r.right > VW + OVER || r.left < -OVER)
      );
    })
    .slice(0, 10)
    .map((el) => ({
      kind: "offscreen",
      cls: el.className.toString().slice(0, 45),
      r: ((b) => ({
        x: Math.round(b.x),
        y: Math.round(b.y),
        w: Math.round(b.width),
        h: Math.round(b.height)
      }))(el.getBoundingClientRect())
    }));
  off.forEach((o) => fails.push(o));
  const small = [...root.querySelectorAll("button,[data-focusable],a,input,select,summary")]
    .filter(vis)
    .map((el) => ({ el, r: el.getBoundingClientRect() }))
    .filter(
      ({ el, r }) => (r.width < 44 || r.height < 40) && getComputedStyle(el).position !== "fixed"
    )
    .slice(0, 10)
    .map(({ el, r }) => ({
      kind: "tap-target",
      cls: el.className.toString().slice(0, 45) || el.tagName.toLowerCase(),
      w: Math.round(r.width),
      h: Math.round(r.height)
    }));
  small.forEach((s) => fails.push(s));
  const texts = [...root.querySelectorAll("h1,h2,h3,p,span,li,label,button,td,th")].filter(
    (el) =>
      vis(el) &&
      (el.innerText || "").trim() &&
      ![...el.children].some((c) => (c.innerText || "").trim() === (el.innerText || "").trim())
  );
  // Leaves pushed outside an overflow-clip parent (marquee transforms)
  // report rects they do not visibly occupy; exclude them up front.
  const clippedLeaf = (el, r) => {
    const p = el.parentElement;
    if (!p) return false;
    const st = getComputedStyle(p);
    if (!/hidden|clip|auto/.test(st.overflowX + st.overflowY)) return false;
    const pr = p.getBoundingClientRect();
    return r.left < pr.left - 2 || r.right > pr.right + 2;
  };
  const rects = texts
    .map((el) => ({ el, r: el.getBoundingClientRect() }))
    .filter((x) => x.r.width > 2 && x.r.height > 2 && !clippedLeaf(x.el, x.r));
  const hits = [];
  // Overlay layers in the player are separate states (controls vs seek overlay
  // vs skip-intro vs episode panel vs modal). Their texts only coexist in the
  // static harness; real playback swaps them, so cross-layer pairs are skipped.
  const layerOf = (el) =>
    el.closest(
      ".player-controls-overlay,.player-seek-overlay,.player-skip-intro,.player-episode-panel,.player-modal,.player-pause-overlay-content,.player-chapters-list"
    );
  for (let i = 0; i < rects.length && hits.length < 6; i++)
    for (let j = i + 1; j < rects.length; j++) {
      const a = rects[i],
        b = rects[j];
      if (a.el.contains(b.el) || b.el.contains(a.el)) continue;
      // Marquee labels are transformed inside an overflow-hidden clip;
      // their raw rects extend past the visible window and produce
      // phantom overlaps against neighbouring icons.
      if (
        a.el.closest('[class*="marquee"]') &&
        a.el.parentElement &&
        a.el.parentElement.getBoundingClientRect().width < a.r.width
      )
        continue;
      if (
        b.el.closest('[class*="marquee"]') &&
        b.el.parentElement &&
        b.el.parentElement.getBoundingClientRect().width < b.r.width
      )
        continue;
      const la = layerOf(a.el),
        lb = layerOf(b.el);
      if (la && lb && la !== lb) continue;
      const ox = Math.max(0, Math.min(a.r.right, b.r.right) - Math.max(a.r.left, b.r.left));
      const oy = Math.max(0, Math.min(a.r.bottom, b.r.bottom) - Math.max(a.r.top, b.r.top));
      const minArea = Math.min(a.r.width * a.r.height, b.r.width * b.r.height);
      if (ox * oy > 0.35 * minArea)
        hits.push({
          kind: "text-overlap",
          a: a.el.innerText.slice(0, 20),
          b: b.el.innerText.slice(0, 20)
        });
    }
  hits.forEach((h) => fails.push(h));
  // TV-scale guard: the Android TV dp x 2 port (96px buttons, 40px text
  // line-heights) has repeatedly bled through into the phone tier when a
  // re-derivation was mis-scoped. App screens only (not the player harness,
  // whose overlays are legitimately large); poster/content cards excluded.
  if (!scopeSelector) {
    for (const el of root.querySelectorAll("button")) {
      if (!vis(el) || /-card/.test(el.className.toString())) continue;
      // Collapsible groups put option stacks INSIDE the row element; its
      // height tracks content and is not a tap-target scale signal.
      if (el.querySelector('button,[role="button"],.focusable,input,select')) continue;
      // Settings and collections form rows are content-height buttons
      // (title+description wrap at phone width); their scale signal is the
      // copy type, caught by the font/line-height guards, not the height.
      if (el.querySelector(".settings-row-copy, .collections-form-copy")) continue;
      const h = el.getBoundingClientRect().height;
      if (h > 72)
        fails.push({
          kind: "tv-scale",
          cls: el.className.toString().slice(0, 40),
          h: Math.round(h)
        });
    }
    for (const el of root.querySelectorAll("p")) {
      if (!vis(el)) continue;
      const lh = parseFloat(getComputedStyle(el).lineHeight);
      if (lh > 30)
        fails.push({
          kind: "tv-scale-lh",
          cls: el.className.toString().slice(0, 40),
          lh: Math.round(lh)
        });
    }
  }
  return fails;
};

const results = [];
async function audit(page, label, scope) {
  const fails = await page.evaluate(AUDIT, { scope: scope || "", vw: VW, vh: VH });
  const ok = Array.isArray(fails) && fails.length === 0;
  results.push({ label, ok, fails: Array.isArray(fails) ? fails : [fails] });
  console.log(`${ok ? "PASS" : "FAIL"} ${label}${ok ? "" : " " + JSON.stringify(fails)}`);
}

async function gotoHome(page) {
  await page.goto(BASE_URL + "/", { waitUntil: "domcontentloaded" });
  // Fresh-state relaunches walk a chain of boot gates (QR auth back, profile
  // picker, welcome layout chooser, experience-mode chooser) in varying order
  // and timing. Loop over states instead of racing fixed per-screen waits.
  const deadline = Date.now() + 25000;
  while (Date.now() < deadline) {
    if (await page.locator(".home-nav-item").count()) break;
    const handled = await page.evaluate(() => {
      const back = document.querySelector("#qr-back-btn");
      if (back) {
        back.click();
        return "qr";
      }
      const pick = document.querySelector(".profile-card[data-profile-id]");
      if (pick) {
        pick.click();
        return "profile";
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
    });
    await page.waitForTimeout(handled ? 600 : 400);
  }
  if (!(await page.locator(".home-nav-item").count())) {
    console.log(
      "gotoHome: sidebar never appeared:",
      JSON.stringify(
        await page.evaluate(() => ({
          bodyCls: document.body.className,
          txt: document.body.innerText.replace(/\s+/g, " ").slice(0, 200),
          cards: document.querySelectorAll(
            ".profile-card,.experience-mode-card,.nuvio-dialog-button"
          ).length,
          hash: location.hash || location.pathname
        }))
      )
    );
  }
  await page.waitForTimeout(1200);
}
async function navTo(page, text) {
  // Route gates can leave the session one or two router entries deep
  // (settings drill views themselves push history). Unwind back to the
  // app shell before reaching for the bottom nav.
  for (let i = 0; i < 5; i++) {
    const hasNav = await page.evaluate(
      () => document.querySelectorAll(".home-nav-item").length > 0
    );
    if (hasNav) break;
    await page.goBack().catch(() => {});
    await page.waitForTimeout(700);
  }
  try {
    await page.waitForSelector(".home-nav-item", { timeout: 8000 });
  } catch (_) {}
  await page.evaluate(
    (t) =>
      [...document.querySelectorAll(".home-nav-item")]
        .find((n) => (n.innerText || n.textContent || "").includes(t))
        ?.click(),
    text
  );
  await page.waitForTimeout(2500);
}

// Real swipe gate: dispatch a horizontal touch drag across the first home rail
// and require the rail to actually scroll. Also asserts the rail exposes a
// swipeable overflow with snap and does not disable touch panning.
// Press-and-hold on a poster must open the title-actions dialog (watchlist,
// mark watched…). This menu used to exist only for TV input.
async function holdGate(
  page,
  cardSelector = ".home-main .home-poster-card",
  allowEmpty = false,
  leaveOpen = false,
  minLeft = 40
) {
  const findCard = ({ sel, minLeft }) => {
    // Bottom margin derives from the real nav's top edge — but only when the
    // nav is the horizontal bottom bar. Landscape phones render a vertical
    // side rail whose rect top is ~0; there, keep a generic bottom margin.
    const navCandidates = [...document.querySelectorAll(".home-nav-list")].filter(
      (e) => e.offsetParent
    );
    const nav = navCandidates
      .map((e) => e.getBoundingClientRect())
      .find((r) => r.width > innerWidth / 2 && r.top > innerHeight / 2);
    const navTop = nav ? nav.top : innerHeight - 74;
    // Top margin tracks the sticky header bottom where one exists (search,
    // discover, library, see-all): require the card CENTER below the header
    // (the hold tap lands at center); 140 stays the fallback for the home hero.
    const header = document.querySelector(
      ".seeall-header,.search-header,.library-header,.detail-header"
    );
    const headerBottom =
      header && header.offsetParent ? header.getBoundingClientRect().bottom : null;
    const topOk = (r) =>
      (r.top + r.bottom) / 2 >
      (headerBottom !== null ? headerBottom + 8 : Math.min(140, innerHeight * 0.22));
    const c = [...document.querySelectorAll(sel)].find((n) => {
      const r = n.getBoundingClientRect();
      return (
        r.left > minLeft &&
        r.right < innerWidth - 10 &&
        topOk(r) &&
        r.bottom < navTop &&
        (r.top + r.bottom) / 2 < navTop - 8
      );
    });
    if (!c) return null;
    const r = c.getBoundingClientRect();
    return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
  };
  let card = await page.evaluate(findCard, { sel: cardSelector, minLeft });
  if (!card) {
    // Catalog grids arrive asynchronously; give the route a bounded window
    // instead of racing a fixed sleep.
    try {
      await page.waitForFunction((sel) => document.querySelectorAll(sel).length > 0, cardSelector, {
        timeout: 8000
      });
    } catch (_) {}
    card = await page.evaluate(findCard, { sel: cardSelector, minLeft });
  }
  if (!card) {
    // Grids may start below the fixed header or above the nav bar; give the
    // first candidate one scroll-into-center retry before giving up.
    await page.evaluate(
      (sel) => document.querySelector(sel)?.scrollIntoView({ block: "center", inline: "center" }),
      cardSelector
    );
    await page.waitForTimeout(450);
    card = await page.evaluate(findCard, { sel: cardSelector, minLeft });
  }
  if (!card) {
    const total = await page.evaluate((sel) => document.querySelectorAll(sel).length, cardSelector);
    if (total === 0 && allowEmpty) return { skipped: true, problems: [] };
    return {
      skipped: false,
      problems: [
        {
          kind: "hold",
          why: "no poster card found",
          snap: await page.evaluate(
            (gsel) => ({
              gateCount: document.querySelectorAll(gsel).length,
              gateFirst3: [...document.querySelectorAll(gsel)].slice(0, 3).map((g) => {
                const gr = g.getBoundingClientRect();
                return {
                  x: Math.round(gr.x),
                  y: Math.round(gr.y),
                  w: Math.round(gr.width),
                  h: Math.round(gr.height),
                  op: g.offsetParent !== null
                };
              }),
              headerCls: (() => {
                const h = document.querySelector(
                  ".seeall-header,.search-header,.library-header,.detail-header"
                );
                return h
                  ? h.className.split(" ")[0] + "@" + Math.round(h.getBoundingClientRect().bottom)
                  : null;
              })(),
              body: document.body.innerText.replace(/\s+/g, " ").slice(0, 140),
              first: (() => {
                const c = document.querySelector(
                  ".library-grid-card,.discover-card,.home-poster-card"
                );
                if (!c) return null;
                const r = c.getBoundingClientRect();
                return {
                  vis: Boolean(c.offsetParent),
                  x: Math.round(r.x),
                  y: Math.round(r.y),
                  w: Math.round(r.width),
                  h: Math.round(r.height)
                };
              })()
            }),
            cardSelector
          )
        }
      ]
    };
  }
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Input.dispatchTouchEvent", {
    type: "touchStart",
    touchPoints: [{ x: card.x, y: card.y }]
  });
  await page.waitForTimeout(750);
  // Sample while the finger is still down: releasing lands a click on the
  // freshly-opened dialog backdrop, which dismisses it (correct UX, wrong gate).
  const res = await page.evaluate(() => {
    const d = document.querySelector(".nuvio-dialog-backdrop");
    const open = Boolean(
      d && getComputedStyle(d).display !== "none" && d.getBoundingClientRect().width > 0
    );
    const btn = open ? d.querySelector(".nuvio-dialog-button") : null;
    const r = btn ? btn.getBoundingClientRect() : null;
    return {
      open,
      panelW: open
        ? Math.round(d.querySelector(".nuvio-dialog-panel")?.getBoundingClientRect().width || 0)
        : 0,
      btnW: r ? Math.round(r.width) : 0,
      btnH: r ? Math.round(r.height) : 0
    };
  });
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  await cdp.detach();
  await page.waitForTimeout(400);
  const stillOpen = await page.evaluate(() =>
    Boolean(
      document.querySelector(".nuvio-dialog-backdrop") &&
      document.querySelector(".nuvio-dialog-button")
    )
  );
  const problems = [];
  if (!res.open) problems.push({ kind: "hold", why: "long-press did not open the actions dialog" });
  else {
    if (res.btnH < 40)
      problems.push({ kind: "hold-scale", why: `dialog button ${res.btnH}px tall` });
    if (res.panelW < 240)
      problems.push({ kind: "hold-scale", why: `dialog panel ${res.panelW}px wide` });
    // The phone contract: lifting the finger AFTER the menu opened must not
    // dismiss it (NuvioDialog backdrop mount-grace).
    if (!stillOpen)
      problems.push({ kind: "hold", why: "hold release dismissed the menu it just opened" });
  }
  if (!leaveOpen) {
    await page.keyboard.press("Escape");
    await page.waitForTimeout(600);
  }
  return { skipped: false, problems };
}

async function swipeGate(page) {
  const pre = await page.evaluate(() => {
    const track = [...document.querySelectorAll(".home-track")].find(
      (t) => t.scrollWidth > t.clientWidth + 40
    );
    if (!track) return { found: false };
    const s = getComputedStyle(track);
    window.__swipeTarget = track;
    const r = track.getBoundingClientRect();
    return {
      found: true,
      overflowX: s.overflowX,
      snap: s.scrollSnapType,
      touchAction: s.touchAction,
      scrollLeft: track.scrollLeft,
      y: Math.round(r.top + r.height / 2)
    };
  });
  if (!pre.found) return [{ kind: "swipe", why: "no swipeable .home-track found" }];
  if (pre.overflowX === "hidden") {
    // Environment-divergence diagnostic: which track was picked and why its
    // overflow is not scrollable (CI vs local rails behave differently).
    pre.diagnostic = await page.evaluate(() =>
      [...document.querySelectorAll(".home-track")].map((t) => ({
        cls: t.className.toString().slice(0, 60),
        sw: t.scrollWidth,
        cw: t.clientWidth,
        ox: getComputedStyle(t).overflowX,
        inline: (t.getAttribute("style") || "").slice(0, 120),
        parentCls: t.parentElement?.className.toString().slice(0, 60),
        parentOx: t.parentElement ? getComputedStyle(t.parentElement).overflowX : ""
      }))
    );
    return [{ kind: "swipe", why: "overflowX=hidden", tracks: pre.diagnostic.slice(0, 6) }];
  }
  const cdp = await page.context().newCDPSession(page);
  const send = (type, x) =>
    cdp.send("Input.dispatchTouchEvent", {
      type,
      touchPoints: type === "touchEnd" ? [] : [{ x, y: pre.y }]
    });
  // Continuous cadence (~15ms): gaps >20ms make Chromium end each move as its
  // own scroll gesture, and scroll-snap yanks the rail back between moves.
  await send("touchStart", 340);
  for (let x = 320; x >= 70; x -= 20) {
    await send("touchMove", x);
    await page.waitForTimeout(15);
  }
  await send("touchEnd", 70);
  await page.waitForTimeout(400);
  const post = await page.evaluate(() => ({ scrollLeft: window.__swipeTarget.scrollLeft }));
  const problems = [];
  if (!["auto", "scroll"].includes(pre.overflowX))
    problems.push({ kind: "swipe", why: "overflowX=" + pre.overflowX });
  if (pre.touchAction === "none")
    problems.push({ kind: "swipe", why: "touchAction=" + pre.touchAction });
  if (!/x/.test(pre.snap)) problems.push({ kind: "swipe", why: "scroll-snap=" + pre.snap });
  // Chromium reports pan-allowing touch-action as "manipulation"/"auto"; pan-x
  // and pan-y still allow panning the rail. Only "none" is a hard block.
  if (post.scrollLeft - pre.scrollLeft < 50)
    problems.push({
      kind: "swipe",
      why: `rail did not scroll (${pre.scrollLeft} -> ${post.scrollLeft})`
    });
  return problems;
}

const browser = await chromium.launch();
// Phone sign-in audit (task: replace QR with native flow on the touch tier).
// A) Official server (tvLogin-only): the phone must offer a same-device path,
//    not just a scannable QR: QR canvas visible AND a >=44px open-on-this-device link.
// B) Server declaring both caps: the phone must land on the native email form
//    by default (capability default), with autofill attrs, 44px targets, local
//    validation on empty submit, and a one-tap inline mode switch.
async function authPhoneGate(browser) {
  const qrProblems = [];
  const emailProblems = [];
  const probe = (page, sel) =>
    page.evaluate((s) => {
      const e = document.querySelector(s);
      if (!e) return null;
      const r = e.getBoundingClientRect();
      const st = getComputedStyle(e);
      if (r.width <= 0 || r.height <= 0 || st.display === "none" || st.visibility === "hidden")
        return { hidden: true, h: Math.round(r.height) };
      return {
        h: Math.round(r.height),
        ac: e.getAttribute("autocomplete") || "",
        type: e.getAttribute("type") || ""
      };
    }, sel);

  const opts = { viewport: { width: VW, height: VH }, hasTouch: true, isMobile: true };

  const ctxA = await browser.newContext(opts);
  await ctxA.addInitScript(NEUTRAL_UPDATE_CHECK);
  const a = await ctxA.newPage();
  await a.goto(BASE_URL + "/", { waitUntil: "domcontentloaded" });
  await a.waitForSelector("#qr-container, #auth-email-form", { timeout: 20000 }).catch(() => {});
  await a.waitForTimeout(3000);
  if (!(await a.evaluate(() => document.body.classList.contains("web-touch"))))
    qrProblems.push({ kind: "auth", why: "boot screen missing .web-touch" });
  if (await a.evaluate(() => !!document.querySelector("#auth-email-form")))
    qrProblems.push({ kind: "auth", why: "email form shown on tvLogin-only server" });
  const qrBox = await probe(a, "#qr-container canvas");
  if (qrBox && !qrBox.hidden)
    qrProblems.push({
      kind: "auth",
      why: "QR canvas rendered on phone tier; one-time link expected instead"
    });
  const link = await probe(a, ".qr-one-time-link");
  if (!link || link.hidden || link.h < 44)
    qrProblems.push({
      kind: "auth",
      why: "one-time sign-in link missing/<44px: " + JSON.stringify(link)
    });
  const href = await a.evaluate(
    () => document.querySelector(".qr-one-time-link")?.getAttribute("href") || ""
  );
  if (!/^https?:\/\//i.test(href))
    qrProblems.push({ kind: "auth", why: "one-time link href not https: " + href });
  const openLink = await probe(a, ".qr-open-link-primary");
  if (!openLink || openLink.hidden || openLink.h < 44)
    qrProblems.push({
      kind: "auth",
      why: "open-on-this-device link missing/<44px: " + JSON.stringify(openLink)
    });
  await ctxA.close();

  // Desktop web parity: the TV-canvas rule (longer side >=1440) keeps the
  // stock QR canvas path; the one-time-link block is phone/compact tier only.
  const ctxD = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
  await ctxD.addInitScript(NEUTRAL_UPDATE_CHECK);
  const d = await ctxD.newPage();
  await d.goto(BASE_URL + "/", { waitUntil: "domcontentloaded" });
  await d.waitForSelector("#qr-container canvas", { timeout: 20000 }).catch(() => {});
  await d.waitForTimeout(2000);
  if (await d.evaluate(() => !!document.querySelector(".qr-one-time-link")))
    qrProblems.push({ kind: "auth", why: "one-time link block leaked into desktop web tier" });
  if (!(await d.evaluate(() => !!document.querySelector("#qr-container canvas"))))
    qrProblems.push({ kind: "auth", why: "QR canvas missing on desktop web tier" });
  await ctxD.close();

  const ctxB = await browser.newContext(opts);
  await ctxB.addInitScript(NEUTRAL_UPDATE_CHECK);
  await ctxB.addInitScript(
    ([key, payload]) => localStorage.setItem(key, payload),
    [
      "nuvioServerConfigurationV1",
      JSON.stringify({
        isCustom: true,
        backendUrl: BASE_URL + "/probe-srv",
        publishableKey: "pk-probe-test",
        capabilities: { emailPasswordAuth: true, tvLogin: true }
      })
    ]
  );
  const b = await ctxB.newPage();
  await b.goto(BASE_URL + "/", { waitUntil: "domcontentloaded" });
  await b.waitForSelector("#auth-email-form", { timeout: 20000 }).catch(() => {});
  await b.waitForTimeout(1500);
  if (!(await b.evaluate(() => !!document.querySelector("#auth-email-form")))) {
    emailProblems.push({ kind: "auth-email", why: "email form not default on both-caps server" });
  } else {
    const email = await probe(b, "#auth-email-input");
    const pass = await probe(b, "#auth-password-input");
    const submit = await probe(b, "#auth-email-submit");
    if (!email || email.hidden || email.type !== "email" || email.ac !== "username")
      emailProblems.push({ kind: "auth-email", why: "email input: " + JSON.stringify(email) });
    if (!pass || pass.hidden || pass.type !== "password" || pass.ac !== "current-password")
      emailProblems.push({ kind: "auth-email", why: "password input: " + JSON.stringify(pass) });
    if (!submit || submit.hidden || submit.h < 44)
      emailProblems.push({ kind: "auth-email", why: "submit target: " + JSON.stringify(submit) });
    await b
      .locator("#auth-email-submit")
      .tap()
      .catch(() => {});
    await b.waitForTimeout(500);
    const err = await b.evaluate(() => {
      const e = document.querySelector(".qr-login-error");
      if (!e || e.hidden || !e.getBoundingClientRect().height) return null;
      return e.textContent.trim();
    });
    if (!err)
      emailProblems.push({ kind: "auth-email", why: "empty submit produced no inline error" });
    if (!(await b.locator(".qr-mode-switch").count())) {
      emailProblems.push({ kind: "auth-email", why: "no inline .qr-mode-switch on touch tier" });
    } else {
      await b.locator(".qr-mode-switch").tap();
      await b.waitForTimeout(1500);
      if (!(await b.evaluate(() => !!document.querySelector("#qr-container"))))
        emailProblems.push({ kind: "auth-email", why: "mode switch did not reach QR view" });
      await b
        .locator(".qr-mode-switch")
        .tap()
        .catch(() => {});
      await b.waitForTimeout(800);
      if (!(await b.evaluate(() => !!document.querySelector("#auth-email-form"))))
        emailProblems.push({ kind: "auth-email", why: "mode switch did not return to email form" });
    }
  }
  await ctxB.close();
  return { qrProblems, emailProblems };
}

const ctx = await browser.newContext({
  viewport: { width: VW, height: VH },
  hasTouch: true,
  isMobile: true
});
await ctx.addInitScript(NEUTRAL_UPDATE_CHECK);
const harnessOnly = process.argv.includes("--harness-only");

if (!harnessOnly) {
  const page = await ctx.newPage();
  await gotoHome(page); // first run bypasses auth (guest); later runs go straight home
  await audit(page, "home");
  const swipeProblems = await swipeGate(page);
  results.push({ label: "home-swipe", ok: swipeProblems.length === 0, fails: swipeProblems });
  console.log(
    `${swipeProblems.length ? "FAIL" : "PASS"} home-swipe${swipeProblems.length ? " " + JSON.stringify(swipeProblems) : ""}`
  );

  const holdProblems = (await holdGate(page)).problems;
  results.push({ label: "home-hold-menu", ok: holdProblems.length === 0, fails: holdProblems });
  console.log(
    `${holdProblems.length ? "FAIL" : "PASS"} home-hold-menu${holdProblems.length ? " " + JSON.stringify(holdProblems) : ""}`
  );

  const reportHold = (label, resProblems) => {
    const skipped = resProblems === null;
    results.push({
      label,
      ok: skipped || resProblems.length === 0,
      fails: skipped ? [] : resProblems
    });
    console.log(
      `${skipped ? "SKIP" : resProblems && resProblems.length ? "FAIL" : "PASS"} ${label}${skipped ? " (no cards on screen)" : resProblems && resProblems.length ? " " + JSON.stringify(resProblems) : ""}`
    );
  };

  const { qrProblems, emailProblems } = await authPhoneGate(browser);
  results.push({ label: "auth-qr-phone", ok: qrProblems.length === 0, fails: qrProblems });
  results.push({ label: "auth-email-form", ok: emailProblems.length === 0, fails: emailProblems });
  console.log(
    `${qrProblems.length ? "FAIL" : "PASS"} auth-qr-phone${qrProblems.length ? " " + JSON.stringify(qrProblems) : ""}`
  );
  console.log(
    `${emailProblems.length ? "FAIL" : "PASS"} auth-email-form${emailProblems.length ? " " + JSON.stringify(emailProblems) : ""}`
  );

  // Server-connection surface: boot sign-in screen -> server menu ->
  // "connect custom" -> serverConnectionScreen (input dialog over the
  // auth-simple shell), then the list view behind it.
  {
    const ctxC = await browser.newContext({
      viewport: { width: VW, height: VH },
      hasTouch: true,
      isMobile: true
    });
    await ctxC.addInitScript(NEUTRAL_UPDATE_CHECK);
    const c = await ctxC.newPage();
    await c.goto(BASE_URL + "/", { waitUntil: "domcontentloaded" });
    await c.waitForSelector("#qr-container, #auth-email-form", { timeout: 20000 }).catch(() => {});
    await c.waitForTimeout(2500);
    const menuOk = await c.evaluate(() => {
      const b = document.querySelector("[data-action='server-menu']");
      if (!b) return false;
      b.click();
      return true;
    });
    await c.waitForTimeout(900);
    const connectOk = await c.evaluate(() => {
      const b = document.querySelector("[data-action='connect-custom']");
      if (!b) return false;
      b.click();
      return true;
    });
    if (!menuOk || !connectOk) {
      results.push({
        label: "server-connection",
        ok: false,
        fails: [{ kind: "route", why: `menu=${menuOk} connect=${connectOk}` }]
      });
      console.log(
        `FAIL server-connection ${JSON.stringify([{ kind: "route", why: `menu=${menuOk} connect=${connectOk}` }])}`
      );
    } else {
      await c.waitForTimeout(2000);
      const shellOk = await c.evaluate(() =>
        Boolean(document.querySelector(".auth-simple-shell")?.offsetParent)
      );
      if (!shellOk) {
        results.push({
          label: "server-connection",
          ok: false,
          fails: [{ kind: "route", why: "connect-custom rendered no .auth-simple-shell" }]
        });
        console.log(
          'FAIL server-connection [{"kind":"route","why":"connect-custom rendered no .auth-simple-shell"}]'
        );
      } else {
        await audit(c, "server-connection");
        await c
          .evaluate(() =>
            document.querySelector(".server-connection-dialog [data-action='cancel']")?.click()
          )
          .catch(() => {});
        await c.waitForTimeout(1500);
        await audit(c, "server-connection-list");
      }
    }
    await ctxC.close();
  }

  await page.evaluate(() => document.querySelector(".home-track .home-poster-card")?.click());
  await page.waitForTimeout(2500);
  await audit(page, "detail");
  // Cast detail (castDetailScreen): reached from the detail cast row. Guest
  // data may fail to load — the error/loading state is itself part of the
  // phone tier and gets audited either way.
  const castEntry = page.locator('[data-action="openCastDetail"]').first();
  if (await castEntry.count()) {
    await castEntry.tap().catch(() => {});
    await page.waitForTimeout(2500);
    await audit(page, "cast");
    const castShell = await page.evaluate(() => {
      const s = document.querySelector(".cast-detail-shell");
      return Boolean(s && s.offsetParent);
    });
    if (!castShell)
      results.push({
        label: "cast-route",
        ok: false,
        fails: [{ kind: "route", why: "openCastDetail did not render .cast-detail-shell" }]
      });
    else results.push({ label: "cast-route", ok: true, fails: [] });
    console.log(`${castShell ? "PASS" : "FAIL"} cast-route`);
    await page.evaluate(() => document.querySelector(".cast-detail-back")?.click());
    await page.waitForTimeout(1500);
  }

  await gotoHome(page);
  await navTo(page, "Search");
  await audit(page, "search");
  // The Discover entry lives in the search recents view — visit it BEFORE
  // typing a query, otherwise the results view replaces it.
  let seeded = false;
  try {
    // The recents view (which owns the Discover entry) renders after the
    // search route's async layout/state boot; do not race it.
    await page.waitForSelector('[data-action="openDiscover"]', { timeout: 8000 });
  } catch (_) {}
  const disc = page.locator('[data-action="openDiscover"]').first();
  if (await disc.count()) {
    await disc.tap().catch(() => {});
    await page.waitForTimeout(2500);
    const discHold = await holdGate(
      page,
      '.discover-card[data-action="openDetail"]',
      true,
      true,
      12
    );
    reportHold("discover-hold-menu", discHold.skipped ? null : discHold.problems);
    // Seed the guest library from the still-open menu (LOCAL source mode) so
    // the library-hold gate cannot hide behind an empty-grid skip.
    seeded = await page.evaluate(() => {
      const b = [...document.querySelectorAll(".nuvio-dialog-button")].find((n) =>
        /add to library/i.test(n.innerText)
      );
      if (!b) return false;
      b.click();
      return true;
    });
    await page.waitForTimeout(1200);
    await page.keyboard.press("Escape");
    await page.waitForTimeout(500);
  } else {
    console.log(
      "  note: openDiscover absent — DOM:",
      JSON.stringify(
        await page.evaluate(() => ({
          shells: [...document.querySelectorAll(".search-screen-shell")].length,
          visibleSearch: Boolean(document.querySelector(".search-content")?.offsetParent),
          navItems: [...document.querySelectorAll(".home-nav-item")].map((n) =>
            (n.innerText || n.textContent || "?").trim().slice(0, 12)
          ),
          discoverBtn: Boolean(
            document.querySelector(".search-header")?.classList.contains("no-discover")
          )
        }))
      )
    );
    reportHold("discover-hold-menu", null);
  }
  await navTo(page, "Search");
  const inp = page.locator(".search-screen-shell input").first();
  if (await inp.count()) {
    await inp.tap();
    await inp.type("the", { delay: 60 });
    await page.waitForTimeout(3500);
    await audit(page, "search-results");
  }

  await gotoHome(page);
  await navTo(page, "Library");
  await audit(page, "library");
  // If the discover menu seeded an item, an empty library grid is a regression.
  const libHold = await holdGate(page, ".library-grid-card.focusable", !seeded, false, 12);
  reportHold("library-hold-menu", libHold.skipped ? null : libHold.problems);

  await gotoHome(page);
  await navTo(page, "Settings");
  await audit(page, "settings");
  await page.evaluate(() =>
    [...document.querySelectorAll(".settings-nav-item")]
      .find((n) => /Player|Playback/.test(n.innerText))
      ?.click()
  );
  await page.waitForTimeout(1500);
  await audit(page, "settings-player");

  // Add-ons and plugins management routes, reached from the Settings
  // landing drill-down rows (data-focus-key rows, not .settings-nav-item).
  for (const [label, rowKey, shellSel] of [
    ["addons", "contentDiscovery:addons", ".addons-route-shell"],
    ["plugins", "contentDiscovery:plugins", ".plugins-route-shell"]
  ]) {
    await navTo(page, "Settings");
    await page.waitForTimeout(1200);
    await page.evaluate(() => {
      const nav = [...document.querySelectorAll('[data-focus-key^="nav:"]')].find((n) =>
        /content/i.test(n.innerText || "")
      );
      if (nav) {
        nav.scrollIntoView({ block: "center" });
        nav.click();
      }
    });
    await page.waitForTimeout(1500);
    const rowOk = await page.evaluate((k) => {
      const row = document.querySelector(`[data-focus-key="${k}"]`);
      if (!row) return false;
      row.scrollIntoView({ block: "center" });
      const rc = row.getBoundingClientRect();
      row.dispatchEvent(
        new PointerEvent("pointerdown", {
          bubbles: true,
          clientX: rc.left + rc.width / 2,
          clientY: rc.top + rc.height / 2
        })
      );
      row.click();
      return true;
    }, rowKey);
    if (!rowOk) {
      results.push({ label, ok: true, fails: [], skipped: true });
      console.log(`SKIP ${label} (entry row not present in this mode)`);
      continue;
    }
    await page.waitForTimeout(2500);
    const shellOk = await page.evaluate(
      (sel) => Boolean(document.querySelector(sel)?.offsetParent),
      shellSel
    );
    if (!shellOk) {
      results.push({
        label,
        ok: false,
        fails: [{ kind: "route", why: `${rowKey} did not render ${shellSel}` }]
      });
      console.log(
        `FAIL ${label} ${JSON.stringify([{ kind: "route", why: `${rowKey} did not render ${shellSel}` }])}`
      );
    } else {
      await audit(page, label);
      // Collections manager lives on the add-ons screen; the New
      // Collection editor renders in place (no creation is submitted).
      if (label === "addons") {
        const collOk = await page.evaluate(() => {
          const b = document.querySelector('[data-action-id="open_collections"]');
          if (!b) return false;
          b.scrollIntoView({ block: "center" });
          b.click();
          return true;
        });
        if (collOk) {
          await page.waitForTimeout(2000);
          await audit(page, "collections");
          const editorOk = await page.evaluate(() => {
            const b = document.querySelector(
              '.collections-new [data-action="new"], [data-action="new"]'
            );
            if (!b) return false;
            b.scrollIntoView({ block: "center" });
            b.click();
            return true;
          });
          if (editorOk) {
            await page.waitForTimeout(1500);
            await audit(page, "collections-editor");
          } else {
            results.push({
              label: "collections-editor",
              ok: false,
              fails: [{ kind: "route", why: "no [data-action=new] on collections screen" }]
            });
            console.log(
              'FAIL collections-editor [{"kind":"route","why":"no [data-action=new] on collections screen"}]'
            );
          }
          await page.goBack().catch(() => {});
          await page.waitForTimeout(800);
        } else {
          results.push({
            label: "collections",
            ok: false,
            fails: [{ kind: "route", why: "no open_collections entry on addons screen" }]
          });
          console.log(
            'FAIL collections [{"kind":"route","why":"no open_collections entry on addons screen"}]'
          );
        }
      }
    }
    await page.goBack().catch(() => {});
    await page.waitForTimeout(900);
  }

  // Integration hub (in-settings views) + dedicated Trakt route.
  {
    await navTo(page, "Settings");
    await page.waitForTimeout(1200);
    const hubRow = await page.evaluate(() => {
      const nav = [...document.querySelectorAll('[data-focus-key^="nav:"]')].find((n) =>
        /integration/i.test((n.getAttribute("data-focus-key") || "") + " " + (n.innerText || ""))
      );
      if (!nav) return false;
      nav.scrollIntoView({ block: "center" });
      const rc = nav.getBoundingClientRect();
      nav.dispatchEvent(
        new PointerEvent("pointerdown", {
          bubbles: true,
          clientX: rc.left + rc.width / 2,
          clientY: rc.top + rc.height / 2
        })
      );
      nav.click();
      return true;
    });
    if (hubRow) {
      await page.waitForTimeout(1800);
      await audit(page, "integration-hub");
      const tmdbRow = await page.evaluate(() => {
        const row = document.querySelector('[data-focus-key="integration:hub:tmdb"]');
        if (!row) return false;
        row.scrollIntoView({ block: "center" });
        const rc = row.getBoundingClientRect();
        row.dispatchEvent(
          new PointerEvent("pointerdown", {
            bubbles: true,
            clientX: rc.left + rc.width / 2,
            clientY: rc.top + rc.height / 2
          })
        );
        row.click();
        return true;
      });
      if (tmdbRow) {
        await page.waitForTimeout(1800);
        await audit(page, "integration-tmdb");
      }
      await page.goBack().catch(() => {});
      await page.waitForTimeout(900);
    } else {
      console.log("SKIP integration-hub (nav row absent)");
    }
    const traktRow = await page.evaluate(() => {
      const n = document.querySelector('[data-focus-key="nav:trakt"]');
      if (!n) return false;
      n.scrollIntoView({ block: "center" });
      const rc = n.getBoundingClientRect();
      n.dispatchEvent(
        new PointerEvent("pointerdown", {
          bubbles: true,
          clientX: rc.left + rc.width / 2,
          clientY: rc.top + rc.height / 2
        })
      );
      n.click();
      return true;
    });
    if (traktRow) {
      await page.waitForTimeout(2500);
      // nav:trakt is the in-settings Trakt section (device-auth flow); the
      // dedicated traktScreen route only mounts after a connection exists
      // (trakt:open), so the guest-reachable surface is the section.
      const traktSection = await page.evaluate(() =>
        Boolean(document.querySelector('[class*="settings-trakt"]')?.offsetParent)
      );
      if (!traktSection) {
        results.push({
          label: "trakt",
          ok: false,
          fails: [{ kind: "route", why: "nav:trakt rendered no settings-trakt section" }]
        });
        console.log(
          'FAIL trakt [{"kind":"route","why":"nav:trakt rendered no settings-trakt section"}]'
        );
      } else {
        await audit(page, "trakt");
      }
      await page.goBack().catch(() => {});
      await page.waitForTimeout(900);
    } else {
      console.log("SKIP trakt (nav row absent)");
    }

    // Account screen: Settings landing -> nav:account -> accountShell
    // (sign-in prompt for guests; shares the auth-simple shell tokens).
    await navTo(page, "Settings");
    await page.waitForTimeout(1200);
    const accountRow = await page.evaluate(() => {
      const n = document.querySelector('[data-focus-key="nav:account"]');
      if (!n) return false;
      n.scrollIntoView({ block: "center" });
      const rc = n.getBoundingClientRect();
      n.dispatchEvent(
        new PointerEvent("pointerdown", {
          bubbles: true,
          clientX: rc.left + rc.width / 2,
          clientY: rc.top + rc.height / 2
        })
      );
      n.click();
      return true;
    });
    if (accountRow) {
      await page.waitForTimeout(2500);
      // nav:account is the in-settings account section (account+sync
      // status); the standalone accountShell route is reached from other
      // auth states. The guest-reachable surface is the section.
      const accountView = await page.evaluate(() => {
        const s =
          document.querySelector(".account-shell") ||
          document.querySelector(".settings-account-list");
        return Boolean(s?.offsetParent);
      });
      if (!accountView) {
        results.push({
          label: "account",
          ok: false,
          fails: [{ kind: "route", why: "nav:account rendered no account surface" }]
        });
        console.log(
          'FAIL account [{"kind":"route","why":"nav:account rendered no account surface"}]'
        );
      } else {
        await audit(page, "account");
      }
      await page.goBack().catch(() => {});
      await page.waitForTimeout(900);
    } else {
      console.log("SKIP account (nav row absent)");
    }
  }

  // Profile tier gates. The boot-time "Who's watching?" landing only
  // auto-mounts with a reachable profile-sync backend; Settings -> Profiles
  // chip -> Manage Profiles mounts the SAME #profileSelection screen, so the
  // phone-scale assertions run through that touch-reachable path.
  {
    const problems = [];
    await navTo(page, "Settings");
    try {
      await page.waitForSelector(".settings-nav-item", { timeout: 8000 });
    } catch (_) {}
    const chip = await page.evaluate(() => {
      const c = [...document.querySelectorAll(".settings-nav-item")].find((n) =>
        /profile/i.test(n.innerText || "")
      );
      if (c) c.click();
      return !!c;
    });
    const manageSeen = await page
      .waitForSelector(".settings-profile-manage-row", { timeout: 6000 })
      .then(() => true)
      .catch(() => false);
    const manage = await page.evaluate(() => {
      const row = document.querySelector(".settings-profile-manage-row");
      if (row) row.click();
      return !!row;
    });
    await page.waitForTimeout(2500);
    if (!chip || !manage || !(await page.locator(".profile-card").count())) {
      problems.push({ kind: "profile-picker", why: "manage entry not reachable", chip, manage });
    } else {
      for (const f of await page.evaluate(AUDIT, { scope: "#profileSelection", vw: VW, vh: VH }))
        problems.push({ ...f, screen: "profile-picker" });
      const scale = await page.evaluate(() => {
        const box = (s) => {
          const r = document.querySelector(s)?.getBoundingClientRect();
          return r ? { w: Math.round(r.width), h: Math.round(r.height) } : null;
        };
        const fs = (s) =>
          Math.round(
            parseFloat(getComputedStyle(document.querySelector(s) || document.body).fontSize)
          );
        return {
          avatar: box(".profile-avatar"),
          ring: box(".profile-avatar-ring"),
          card: box(".profile-card"),
          name: fs(".profile-name"),
          title: fs(".profile-title")
        };
      });
      if (!scale.avatar || scale.avatar.w > 150)
        problems.push({ kind: "picker-avatar-tv-size", avatar: scale.avatar });
      if (!scale.card || scale.card.w > 190)
        problems.push({ kind: "picker-card-tv-size", card: scale.card });
      if (scale.name > 18) problems.push({ kind: "picker-name-tv-size", fs: scale.name });
      if (scale.title > 24) problems.push({ kind: "picker-title-tv-size", fs: scale.title });

      // Editor overlay: its min(xvw,px) TV tokens collapse to ~5px text at
      // phone width, so the gate asserts the phone floor instead of a max.
      await page.evaluate(() => {
        [...document.querySelectorAll("#profileSelection .focusable")]
          .find((n) => /add profile/i.test(n.innerText || ""))
          ?.click();
      });
      await page.waitForTimeout(1200);
      if (!(await page.locator(".profile-editor-panel").count())) {
        problems.push({ kind: "profile-editor-missing" });
      } else {
        for (const f of await page.evaluate(AUDIT, {
          scope: ".profile-editor-backdrop",
          vw: VW,
          vh: VH
        }))
          problems.push({ ...f, screen: "profile-editor" });
        const floor = await page.evaluate(() => {
          const hs = [
            ...document.querySelectorAll(".profile-editor-panel .profile-overlay-button")
          ].map((b) => Math.round(b.getBoundingClientRect().height));
          const input = document.querySelector(".profile-editor-name-input");
          return {
            minBtn: hs.length ? Math.min(...hs) : 0,
            input: input ? Math.round(input.getBoundingClientRect().height) : 0,
            minFs: Math.min(
              ...[...document.querySelectorAll(".profile-editor-panel *")]
                .filter((e) => !e.children.length && (e.innerText || "").trim())
                .map((e) => Math.round(parseFloat(getComputedStyle(e).fontSize)))
            )
          };
        });
        if (floor.minBtn < 44) problems.push({ kind: "profile-editor-tap-target", ...floor });
        if (floor.input < 44) problems.push({ kind: "profile-editor-input", ...floor });
        if (floor.minFs < 11) problems.push({ kind: "profile-editor-collapsed-text", ...floor });
      }
    }
    results.push({ label: "profile-tier", ok: problems.length === 0, fails: problems });
    console.log(
      `${problems.length ? "FAIL" : "PASS"} profile-tier${problems.length ? " " + JSON.stringify(problems) : ""}`
    );
    await page.goto(BASE_URL + "/", { waitUntil: "domcontentloaded" });
    await gotoHome(page);
  }

  // Episode-selection gate: sweep home cards for a SERIES detail (card 0 is
  // usually a movie), then assert the episode rail/season chips sit at phone
  // scale — pre-fix they were 560x358 cards with fs32 titles and 220x88
  // season buttons on a 390px viewport.
  {
    const problems = [];
    let episodes = 0;
    let tried = 0;
    const nCards = await page.locator(".home-main .home-poster-card").count();
    for (let i = 0; i < Math.min(nCards, 20); i++) {
      tried++;
      await page.evaluate(
        (idx) => document.querySelectorAll(".home-main .home-poster-card")[idx]?.click(),
        i
      );
      await page.waitForTimeout(1700);
      episodes = await page.evaluate(
        () => document.querySelectorAll(".series-episode-card").length
      );
      if (episodes) break;
      await page.goBack().catch(() => {});
      await page.waitForTimeout(900);
    }
    if (!episodes) {
      problems.push({ kind: "episode-gate-no-series", cards: nCards, tried });
      results.push({ label: "detail-episodes", ok: nCards === 0, fails: problems });
      console.log(
        `${nCards === 0 ? "SKIP" : "FAIL"} detail-episodes${nCards === 0 ? " (no home cards to seed)" : " " + JSON.stringify(problems)}`
      );
    } else {
      for (const f of await page.evaluate(AUDIT, { scope: "#detail", vw: VW, vh: VH }))
        problems.push({ ...f, screen: "detail-episodes" });
      const scale = await page.evaluate(() => {
        const vw = window.innerWidth;
        const card = document.querySelector(".series-episode-card")?.getBoundingClientRect();
        const title = document.querySelector(".series-episode-title");
        const chips = [...document.querySelectorAll(".series-season-btn")].map((b) =>
          Math.round(b.getBoundingClientRect().height)
        );
        return {
          cardW: card ? Math.round(card.width) : 0,
          titleFs: title ? Math.round(parseFloat(getComputedStyle(title).fontSize)) : 0,
          minChip: chips.length ? Math.min(...chips) : 0,
          maxChip: chips.length ? Math.max(...chips) : 0,
          vw
        };
      });
      if (scale.cardW === 0 || scale.cardW > scale.vw - 60)
        problems.push({ kind: "episode-card-tv-size", ...scale });
      if (scale.titleFs > 20) problems.push({ kind: "episode-title-tv-size", ...scale });
      if (scale.minChip < 44 || scale.maxChip > 64)
        problems.push({ kind: "episode-season-chip-scale", ...scale });
      results.push({ label: "detail-episodes", ok: problems.length === 0, fails: problems });
      console.log(
        `${problems.length ? "FAIL" : "PASS"} detail-episodes${problems.length ? " " + JSON.stringify(problems) : ""}`
      );
    }
  }
}

// Static player harness: the live player needs an authenticated account with
// stream sources, so the player surfaces are exercised against a fixture that
// mounts every player layer at once. Served CSS comes from BASE_URL.
const harnessHtml = (await readFile(path.join(HERE, "player-harness.html"), "utf8")).replaceAll(
  "http://127.0.0.1:4173",
  BASE_URL
);
const p2 = await ctx.newPage();
await p2.setContent(harnessHtml, { waitUntil: "domcontentloaded" });
await p2.waitForTimeout(1200);
await audit(p2, "player-harness", "#playerUiRoot");

await browser.close();
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} screens pass`);
process.exit(failed.length ? 1 : 0);
