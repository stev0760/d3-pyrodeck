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
 *   For --windows cross-compile: curl and unzip must be on PATH
 */

import { execSync, execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import https from "node:https";
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
  `"${esbuildBin}" "${entryPoint}" --bundle --platform=node --format=cjs --target=node20 --outfile="${bundleOut}"`,
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

if (targetWindows && !hostWin) {
  // ── Cross-compile: download Windows node binary ────────────────────────
  console.log(`  Downloading node v${nodeVer} for Windows x64...`);
  const zipUrl = `https://nodejs.org/dist/v${nodeVer}/node-v${nodeVer}-win-x64.zip`;
  const zipPath = path.join(OUT, "node-win.zip");

  await new Promise((resolve, reject) => {
    const file = fs.createWriteStream(zipPath);
    https.get(zipUrl, (res) => {
      if (res.statusCode === 302 || res.statusCode === 301) {
        https.get(res.headers.location, (r) => r.pipe(file));
      } else {
        res.pipe(file);
      }
      file.on("finish", () => { file.close(); resolve(); });
    }).on("error", reject);
  });

  console.log("  Extracting node.exe from zip...");
  // Extract just node.exe from the zip (works on Linux with system unzip)
  run(
    `unzip -j "${zipPath}" "node-v${nodeVer}-win-x64/node.exe" -d "${OUT}"`,
  );
  fs.renameSync(path.join(OUT, "node.exe"), outBin);
  fs.rmSync(zipPath, { force: true });

  console.log("  Injecting SEA blob into Windows binary...");
  run(
    `npx postject "${outBin}" NODE_SEA_BLOB "${blobPath}" --sentinel-fuse ${postjectSentinel}`,
  );
} else {
  // ── Native: use current platform's node binary ─────────────────────────
  fs.copyFileSync(process.execPath, outBin);
  fs.chmodSync(outBin, 0o755);

  if (hostMac) {
    run(`codesign --remove-signature "${outBin}"`);
    run(
      `npx postject "${outBin}" NODE_SEA_BLOB "${blobPath}" --sentinel-fuse ${postjectSentinel} --macho-segment-name NODE_SEA`,
    );
    run(`codesign --sign - "${outBin}"`);
  } else {
    // Linux: objcopy is more reliable than postject for ELF injection
    run(
      `objcopy --add-section NODE_SEA_BLOB="${blobPath}" ` +
        `--set-section-flags NODE_SEA_BLOB=noload,readonly "${outBin}"`,
    );
  }
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
