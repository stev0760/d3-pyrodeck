#!/usr/bin/env node
/**
 * Build a Node SEA (Single Executable Application) for the Pyrodeck server.
 *
 * Output layout (dist-server/):
 *   pyrodeck-server[.exe]   — self-contained Node binary
 *   resources/              — compiled SPA (must sit next to the binary at runtime)
 *
 * Usage:
 *   node scripts/package-server.mjs
 *
 * Requirements:
 *   npx postject   (used automatically via npx; no install needed)
 *   esbuild        (devDep in packages/server)
 *   Node 20+
 *
 * Windows cross-compilation note:
 *   This script packages for the CURRENT platform. To produce a Windows binary
 *   on Linux, copy a windows node.exe into dist-server/ manually, then re-run
 *   steps 7-9 (postject handles cross-platform injection).
 */

import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..");
const SERVER_PKG = path.join(ROOT, "packages", "server");
const CLIENT_PKG = path.join(ROOT, "packages", "client");
const OUT = path.join(ROOT, "dist-server");

const isWin = process.platform === "win32";
const isMac = process.platform === "darwin";
const ext = isWin ? ".exe" : "";

function run(cmd, cwd = ROOT) {
  console.log(`\n> ${cmd}`);
  execSync(cmd, { cwd, stdio: "inherit" });
}

// ── 1. Clean output directory ──────────────────────────────────────────────
fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });

// ── 2. Build TypeScript ────────────────────────────────────────────────────
console.log("\n[1/7] Compiling server TypeScript...");
run("pnpm tsc", SERVER_PKG);

// ── 3. Build client SPA ────────────────────────────────────────────────────
console.log("\n[2/7] Building client SPA...");
run("pnpm build", CLIENT_PKG);

// ── 4. Bundle server to single CJS with esbuild ────────────────────────────
console.log("\n[3/7] Bundling server with esbuild...");
const entryPoint = path.join(SERVER_PKG, "dist", "index.js");
const bundleOut = path.join(OUT, "server.cjs");
run(
  `npx esbuild "${entryPoint}" --bundle --platform=node --format=cjs ` +
    `--target=node20 --outfile="${bundleOut}"`,
  ROOT,
);

// ── 5. Copy SPA resources ──────────────────────────────────────────────────
console.log("\n[4/7] Copying SPA to resources/...");
fs.cpSync(path.join(CLIENT_PKG, "dist"), path.join(OUT, "resources"), {
  recursive: true,
});

// ── 6. Generate SEA blob ───────────────────────────────────────────────────
console.log("\n[5/7] Generating SEA blob...");
const seaConfig = {
  main: bundleOut,
  output: path.join(OUT, "sea-prep.blob"),
  disableExperimentalSEAWarning: true,
};
const seaConfigPath = path.join(OUT, "sea-config.json");
fs.writeFileSync(seaConfigPath, JSON.stringify(seaConfig, null, 2));
run(`node --experimental-sea-config "${seaConfigPath}"`, OUT);

// ── 7. Copy Node binary and inject blob ────────────────────────────────────
console.log("\n[6/7] Copying Node binary...");
const outBin = path.join(OUT, `pyrodeck-server${ext}`);
fs.copyFileSync(process.execPath, outBin);
fs.chmodSync(outBin, 0o755);

if (isMac) {
  run(`codesign --remove-signature "${outBin}"`);
}

console.log("\n[7/7] Injecting SEA blob with postject...");
const macFlag = isMac ? "--macho-segment-name NODE_SEA " : "";
run(
  `npx postject "${outBin}" NODE_SEA_BLOB "${path.join(OUT, "sea-prep.blob")}" ` +
    `--sentinel-fuse NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2 ${macFlag}`,
  OUT,
);

if (isMac) {
  run(`codesign --sign - "${outBin}"`);
}

// ── Done ───────────────────────────────────────────────────────────────────
console.log(`
Build complete!
  Binary:    ${outBin}
  Resources: ${OUT}/resources/

Run with:
  ${outBin}
Or with auth:
  PYRODECK_ADMIN_PASSWORD=secret ${outBin}
`);
