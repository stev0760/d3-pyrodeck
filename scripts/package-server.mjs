#!/usr/bin/env node
/**
 * Build a Node SEA (Single Executable Application) for the Pyrodeck server.
 *
 * Usage:
 *   node scripts/package-server.mjs            # current platform
 *   node scripts/package-server.mjs --linux    # Linux x64 binary
 *   node scripts/package-server.mjs --windows  # Windows x64 .exe (cross-compiles from Linux)
 *
 * Output (dist-server/):
 *   pyrodeck-server[.exe]   — self-contained executable
 *   resources/              — compiled SPA (must stay next to the binary)
 *
 * Requirements:
 *   pnpm install already run
 *   esbuild in server devDependencies (already added)
 *   postject available via npx
 *   Network access to nodejs.org (official node binary is downloaded + verified)
 *   For --windows cross-compile: unzip must be on PATH; Linux: tar with xz
 */

import { execSync, execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import https from "node:https";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..");
const SERVER_PKG = path.join(ROOT, "packages", "server");
const CLIENT_PKG = path.join(ROOT, "packages", "client");
const OUT = path.join(ROOT, "dist-server");

// ── Target detection ──────────────────────────────────────────────────────
const args = process.argv.slice(2);
const forceLinux = args.includes("--linux");
const forceWindows = args.includes("--windows");
const hostWin = process.platform === "win32";
const hostMac = process.platform === "darwin";
const targetWindows = forceWindows || (!forceLinux && hostWin);

const outExt = targetWindows ? ".exe" : "";

// Strip "v" prefix, e.g. "v20.20.2" → "20.20.2"
const nodeVer = process.version.replace(/^v/, "");

function run(cmd, cwd = ROOT) {
  console.log(`\n> ${cmd}`);
  execSync(cmd, { cwd, stdio: "inherit", shell: true });
}

// ── 1. Clean ──────────────────────────────────────────────────────────────
console.log("\n[1/7] Cleaning output directory...");
fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });

// ── 2. Build TypeScript ───────────────────────────────────────────────────
console.log("\n[2/7] Compiling server TypeScript...");
run("pnpm tsc --noEmit false", SERVER_PKG);

// ── 3. Build client SPA ───────────────────────────────────────────────────
console.log("\n[3/7] Building client SPA...");
run("pnpm build", CLIENT_PKG);

// ── 4. Bundle server to single CJS ───────────────────────────────────────
console.log("\n[4/7] Bundling server with esbuild...");
const entryPoint = path.join(SERVER_PKG, "dist", "index.js");
const bundleOut = path.join(OUT, "server.cjs");
// esbuild is in server's node_modules — use its binary directly
const esbuildBin = path.join(SERVER_PKG, "node_modules", ".bin", "esbuild");
run(
  `"${esbuildBin}" "${entryPoint}" --bundle --platform=node --format=cjs --target=node24 --outfile="${bundleOut}"`,
  ROOT,
);

// ── 5. Copy SPA ───────────────────────────────────────────────────────────
console.log("\n[5/7] Copying SPA to resources/...");
fs.cpSync(path.join(CLIENT_PKG, "dist"), path.join(OUT, "resources"), {
  recursive: true,
});

// ── 6. Generate SEA blob ──────────────────────────────────────────────────
console.log("\n[6/7] Generating SEA blob...");
const seaConfig = {
  main: bundleOut,
  output: path.join(OUT, "sea-prep.blob"),
  disableExperimentalSEAWarning: true,
};
const seaConfigPath = path.join(OUT, "sea-config.json");
fs.writeFileSync(seaConfigPath, JSON.stringify(seaConfig, null, 2));
run(`node --experimental-sea-config "${seaConfigPath}"`);

// ── 7. Inject blob into a Node binary ─────────────────────────────────────
console.log("\n[7/7] Preparing Node binary and injecting blob...");

const outBin = path.join(OUT, `pyrodeck-server${outExt}`);
const blobPath = path.join(OUT, "sea-prep.blob");
const postjectSentinel =
  "NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2";

// Distro-packaged node binaries (e.g. Arch's /usr/bin/node) segfault when
// injected, so Linux and Windows targets always use the official nodejs.org
// build of the running node version, verified against SHASUMS256.txt.
function download(url) {
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      if (res.statusCode === 301 || res.statusCode === 302) {
        res.resume();
        return download(res.headers.location).then(resolve, reject);
      }
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error(`GET ${url} → HTTP ${res.statusCode}`));
      }
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => resolve(Buffer.concat(chunks)));
    }).on("error", reject);
  });
}

async function fetchOfficialNode(windows) {
  const base = `https://nodejs.org/dist/v${nodeVer}/`;
  const dirName = `node-v${nodeVer}-${windows ? "win-x64" : "linux-x64"}`;
  const archive = `${dirName}${windows ? ".zip" : ".tar.xz"}`;

  console.log(`  Downloading ${archive}...`);
  const sums = (await download(base + "SHASUMS256.txt")).toString("utf-8");
  const expected = sums
    .split("\n")
    .find((line) => line.endsWith(`  ${archive}`))
    ?.split(/\s+/)[0];
  const data = await download(base + archive);
  const actual = crypto.createHash("sha256").update(data).digest("hex");
  if (!expected || actual !== expected) {
    throw new Error(`Checksum mismatch for ${archive} (expected ${expected}, got ${actual})`);
  }
  console.log("  SHA-256 verified against SHASUMS256.txt");

  const archivePath = path.join(OUT, archive);
  fs.writeFileSync(archivePath, data);
  if (windows && hostWin) {
    // Windows' built-in tar (bsdtar) reads zip archives
    run(`tar -xf "${archivePath}" -C "${OUT}" "${dirName}/node.exe"`);
    fs.renameSync(path.join(OUT, dirName, "node.exe"), outBin);
    fs.rmSync(path.join(OUT, dirName), { recursive: true, force: true });
  } else if (windows) {
    run(`unzip -j "${archivePath}" "${dirName}/node.exe" -d "${OUT}"`);
    fs.renameSync(path.join(OUT, "node.exe"), outBin);
  } else {
    run(`tar -xJf "${archivePath}" -C "${OUT}" --strip-components=2 "${dirName}/bin/node"`);
    fs.renameSync(path.join(OUT, "node"), outBin);
    fs.chmodSync(outBin, 0o755);
  }
  fs.rmSync(archivePath, { force: true });
}

if (hostMac && !forceLinux && !forceWindows) {
  // ── Native macOS: use current node binary, re-sign after injection ─────
  fs.copyFileSync(process.execPath, outBin);
  fs.chmodSync(outBin, 0o755);
  run(`codesign --remove-signature "${outBin}"`);
  run(
    `npx postject "${outBin}" NODE_SEA_BLOB "${blobPath}" --sentinel-fuse ${postjectSentinel} --macho-segment-name NODE_SEA`,
  );
  run(`codesign --sign - "${outBin}"`);
} else {
  await fetchOfficialNode(targetWindows);
  console.log("  Injecting SEA blob...");
  run(
    `npx postject "${outBin}" NODE_SEA_BLOB "${blobPath}" --sentinel-fuse ${postjectSentinel}`,
  );
}

// ── Done ──────────────────────────────────────────────────────────────────
const targetLabel = targetWindows ? "Windows x64" : "Linux x64";
console.log(`
Build complete! (${targetLabel})
  Binary:    ${outBin}
  Resources: ${OUT}/resources/

Distribute both together — the binary reads resources/ from its own directory.

Run (Linux):
  ./dist-server/pyrodeck-server
  PYRODECK_ADMIN_PASSWORD=secret ./dist-server/pyrodeck-server

Run (Windows):
  dist-server\\pyrodeck-server.exe
  set PYRODECK_ADMIN_PASSWORD=secret && dist-server\\pyrodeck-server.exe
`);
