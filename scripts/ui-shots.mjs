#!/usr/bin/env node
// Screenshot every Pyrodeck screen at phone, tablet and desktop sizes with headless
// Chromium, so a layout change can be compared against a baseline:
//
//   node scripts/ui-shots.mjs --out .playwright-mcp/shots/baseline
//   node scripts/ui-shots.mjs --out .playwright-mcp/shots/after --connected
//   for f in .playwright-mcp/shots/baseline/desktop/*.png; do \
//     magick compare -metric AE "$f" ".playwright-mcp/shots/after/desktop/$(basename "$f")" null: ; echo " $f"; done
//
// Needs the dev servers (`pnpm dev`) and the `playwright` package: either installed
// (`pnpm dlx playwright install chromium` once) or pointed at with PLAYWRIGHT_DIR.
// The admin password comes from --password or PYRODECK_UI_PASSWORD; with no
// password set on the server the login page never shows.
//
// --connected launches the profile selected in the Launch panel through the UI,
// screenshots the in-game screens, then stops it again through the UI. Only use
// it against a local instance whose selected profile you are happy to start.
//
// Output is gitignored (.playwright-mcp/). Desktop and tablet shots use a device
// scale of 1 so a pixel diff is cheap; phone shots use 2 like a real phone.

import { createRequire } from "node:module";
import { mkdirSync } from "node:fs";
import path from "node:path";

const args = Object.fromEntries(
  process.argv.slice(2).map((a, i, all) => {
    if (!a.startsWith("--")) return [];
    const next = all[i + 1];
    return [a.slice(2), next && !next.startsWith("--") ? next : true];
  }).filter((e) => e.length),
);
const base = args.base ?? "http://localhost:5173/";
const outDir = args.out ?? ".playwright-mcp/shots/run";
const password = args.password ?? process.env.PYRODECK_UI_PASSWORD ?? "";
const connected = args.connected === true;
const only = typeof args.viewports === "string" ? args.viewports.split(",") : null;

const require = createRequire(import.meta.url);
let chromium;
try {
  ({ chromium } = require("playwright"));
} catch {
  if (!process.env.PLAYWRIGHT_DIR) {
    console.error("playwright not found: install it or set PLAYWRIGHT_DIR to a directory holding node_modules/playwright");
    process.exit(2);
  }
  ({ chromium } = createRequire(process.env.PLAYWRIGHT_DIR + "/")("playwright"));
}

const VIEWPORTS = {
  phone: { width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true },
  narrow: { width: 360, height: 780, deviceScaleFactor: 2, isMobile: true, hasTouch: true },
  tablet: { width: 768, height: 1024, deviceScaleFactor: 1, isMobile: true, hasTouch: true },
  desktop: { width: 1440, height: 900, deviceScaleFactor: 1 },
};

const PRIMARY_TABS = ["Output", "Console", "Players", "Bots"];
const MORE_TABS = ["Config", "Playlists", "Logs", "Bans", "Rules", "Settings"];

async function run() {
  const browser = await chromium.launch();
  try {
    for (const [name, vp] of Object.entries(VIEWPORTS)) {
      if (only && !only.includes(name)) continue;
      const dir = path.join(outDir, name);
      mkdirSync(dir, { recursive: true });
      const ctx = await browser.newContext({
        viewport: { width: vp.width, height: vp.height },
        deviceScaleFactor: vp.deviceScaleFactor,
        isMobile: vp.isMobile ?? false,
        hasTouch: vp.hasTouch ?? false,
        colorScheme: "dark",
        reducedMotion: "reduce",
      });
      const page = await ctx.newPage();
      page.setDefaultTimeout(5000);
      let n = 0;
      const shot = async (label, opts = {}) => {
        n += 1;
        const file = path.join(dir, `${String(n).padStart(2, "0")}-${label}.png`);
        await page.evaluate(() => document.fonts.ready);
        await page.screenshot({ path: file, ...opts });
        console.log(`[${name}] ${file}`);
      };
      const step = async (label, fn) => {
        try {
          await fn();
        } catch (e) {
          console.log(`[${name}] skip ${label}: ${String(e.message || e).split("\n")[0]}`);
        }
      };
      try {
        if (vp.width < 768 && !args["legacy-phone"]) await mobileFlow(page, name, shot, step);
        else await legacyFlow(page, name, vp, shot, step);
      } finally {
        await ctx.close();
      }
    }
  } finally {
    await browser.close();
  }
}

/** The pre-0.5.5 layout: header, tab strip, left panel inline (lg) or in a sheet. */
async function legacyFlow(page, name, vp, shot, step) {
  const phone = vp.width < 768;
  const tablet = vp.width >= 768 && vp.width < 1024;

  await page.goto(base, { waitUntil: "networkidle" });
  await page.waitForTimeout(600);
  const onDashboard = async () => (await page.getByRole("button", { name: "Logout" }).count()) > 0
    || (await page.getByRole("tab", { name: "Console", exact: true }).count()) > 0;
  if (!(await onDashboard())) {
    await shot("login");
    const pw = page.locator('input[type="password"]:visible').first();
    if (!(await pw.count()) || !password) throw new Error("login page shown and no password given");
    await pw.fill(password);
    await page.keyboard.press("Enter");
    await page.waitForTimeout(1200);
    if (!(await onDashboard())) throw new Error("login failed");
  }

  // Panel helpers: the left panel is inline on desktop, a sheet elsewhere.
  const openPanel = async () => {
    if (phone) await page.getByRole("button", { name: "Open panel" }).click();
    else if (tablet) await page.getByRole("button", { name: "Panel", exact: true }).click();
    await page.waitForTimeout(400);
  };
  const closePanel = async () => {
    if (!phone && !tablet) return;
    await page.keyboard.press("Escape");
    await page.waitForTimeout(300);
  };
  const setMode = async (mode) => {
    await openPanel();
    await page.getByRole("button", { name: mode, exact: true }).first().click();
    await page.waitForTimeout(500);
  };

  // Connect mode, idle.
  await setMode("Connect");
  await shot("connect-panel");
  await closePanel();
  await shot("connect-dashboard");

  // Launch mode, idle: the panel and every tab.
  await setMode("Launch");
  await shot("launch-panel");
  if (phone || tablet) await shot("launch-panel-full", { fullPage: true });
  await closePanel();
  await snapTabs(page, shot, step, "idle");

  if (connected) {
    await step("launch server", async () => {
      await openPanel();
      await page.getByRole("button", { name: /launch server/i }).first().click();
      let ok = false;
      for (let i = 0; i < 60; i++) {
        await page.waitForTimeout(1000);
        if ((await page.getByRole("tab", { name: "Bots", exact: true }).count()) > 0) { ok = true; break; }
      }
      if (!ok) throw new Error("server did not come up");
      await page.waitForTimeout(1500);
      await shot("running-panel");
      await closePanel();
    });
    try {
      await snapTabs(page, shot, step, "live");
      await step("server controls", async () => {
        if (phone) {
          await page.getByRole("button", { name: "Server controls" }).click();
          await page.waitForTimeout(500);
          await shot("live-server-sheet");
          await shot("live-server-sheet-full", { fullPage: true });
          await page.keyboard.press("Escape");
        }
      });
      await step("console command", async () => {
        await page.getByRole("tab", { name: "Console", exact: true }).click();
        await page.waitForTimeout(400);
        const term = page.locator(".xterm-helper-textarea").first();
        await term.focus();
        await page.keyboard.type("$botlist");
        await page.keyboard.press("Enter");
        await page.waitForTimeout(1500);
        await shot("live-console-botlist");
      });
    } finally {
      await step("stop server", async () => {
        await page.keyboard.press("Escape");
        await openPanel();
        await page.getByRole("button", { name: /^stop server$/i }).first().click();
        for (let i = 0; i < 40; i++) {
          await page.waitForTimeout(1000);
          if ((await page.getByRole("button", { name: /launch server/i }).count()) > 0) break;
        }
        await shot("stopped-panel");
        await closePanel();
      });
    }
  }
}

/** The phone shell (0.5.5+): hash routes, a tab bar, one screen at a time. */
async function mobileFlow(page, name, shot, step) {
  const go = async (hash) => {
    await page.evaluate((h) => { window.location.hash = h; }, hash);
    await page.waitForTimeout(700);
  };
  await page.goto(base, { waitUntil: "networkidle" });
  await page.waitForTimeout(600);
  const onShell = async () => (await page.locator("nav[aria-label='Sections']").count()) > 0;
  if (!(await onShell())) {
    await shot("login");
    const pw = page.locator('input[type="password"]:visible').first();
    if (!(await pw.count()) || !password) throw new Error("login page shown and no password given");
    await pw.fill(password);
    await page.keyboard.press("Enter");
    await page.waitForTimeout(1200);
    if (!(await onShell())) throw new Error("login failed or the phone shell did not render");
  }
  const setMode = async (mode) => {
    await go("#/server");
    await page.getByRole("radio", { name: mode, exact: true }).click();
    await page.waitForTimeout(500);
  };

  await setMode("Connect");
  await shot("connect-server");
  await setMode("Launch");
  await shot("launch-server");
  await shot("launch-server-full", { fullPage: true });
  await step("profile picker", async () => {
    const row = page.locator("button", { hasText: /Choose a profile|No profile selected|\.cfg|Descent3/ }).first();
    await row.click();
    await page.waitForTimeout(500);
    await shot("launch-profile-sheet");
    await page.keyboard.press("Escape");
    await page.waitForTimeout(300);
  });
  for (const r of ["console", "console/output", "players", "bots", "more", "more/profiles", "more/config", "more/playlists", "more/logs", "more/bans", "more/rules", "more/settings"]) {
    await step(`route ${r}`, async () => {
      await go(`#/${r}`);
      await shot(`idle-${r.replace(/\//g, "-")}`);
      await shot(`idle-${r.replace(/\//g, "-")}-full`, { fullPage: true });
    });
  }

  if (connected) {
    await step("launch server", async () => {
      await go("#/server");
      await page.getByRole("button", { name: /launch server/i }).first().click();
      let ok = false;
      for (let i = 0; i < 60; i++) {
        await page.waitForTimeout(1000);
        if ((await page.getByText(/^running$/i).count()) > 0 && (await page.getByText("Connected", { exact: true }).count()) + (await page.getByText("Running", { exact: true }).count()) > 0) { ok = true; break; }
      }
      if (!ok) throw new Error("server did not come up");
      await page.waitForTimeout(2500);
      await shot("live-server");
      await shot("live-server-full", { fullPage: true });
    });
    try {
      for (const r of ["console", "console/output", "players", "bots"]) {
        await step(`live route ${r}`, async () => {
          await go(`#/${r}`);
          await page.waitForTimeout(1200);
          await shot(`live-${r.replace(/\//g, "-")}`);
          await shot(`live-${r.replace(/\//g, "-")}-full`, { fullPage: true });
        });
      }
    } finally {
      await step("stop server", async () => {
        await go("#/server");
        await page.getByRole("button", { name: /^stop server$/i }).first().click();
        await page.waitForTimeout(400);
        await shot("live-stop-dialog");
        await page.getByRole("button", { name: "Stop", exact: true }).click();
        for (let i = 0; i < 40; i++) {
          await page.waitForTimeout(1000);
          if ((await page.getByRole("button", { name: /launch server/i }).count()) > 0) break;
        }
        await shot("stopped-server");
      });
    }
  }
}

async function snapTabs(page, shot, step, prefix) {
  for (const t of PRIMARY_TABS) {
    await step(`tab ${t}`, async () => {
      const tab = page.getByRole("tab", { name: t, exact: true });
      if (!(await tab.count())) throw new Error("not shown");
      await tab.click();
      await page.waitForTimeout(700);
      await shot(`${prefix}-tab-${t.toLowerCase()}`);
    });
  }
  for (const t of MORE_TABS) {
    await step(`more ${t}`, async () => {
      const trigger = page.locator('[data-slot="dropdown-menu-trigger"]').first();
      await trigger.click();
      await page.waitForTimeout(300);
      if (t === MORE_TABS[0]) await shot(`${prefix}-more-menu`);
      await page.getByRole("menuitem", { name: t, exact: true }).click();
      await page.waitForTimeout(800);
      await shot(`${prefix}-more-${t.toLowerCase()}`);
      await shot(`${prefix}-more-${t.toLowerCase()}-full`, { fullPage: true });
    });
  }
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
