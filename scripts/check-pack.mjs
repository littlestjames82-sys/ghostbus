#!/usr/bin/env node
/**
 * Pack-manifest assertion (v0.5.8) — what `npm publish` ships is a
 * security surface, so the tarball contents are pinned to an allowlist.
 *
 * Runs `npm pack --dry-run --json`, then fails (exit 1) if:
 *   - any file's top-level path is outside the allowlist,
 *   - any explicitly forbidden path appears (tests, deploy kits, dev
 *     scripts, CI config, runtime state, tarballs),
 *   - any required runtime file is missing.
 *
 * The allowlist mirrors package.json "files". If you intentionally add
 * something to "files", add it here in the same change — that friction
 * is the point.
 *
 * Usage: node scripts/check-pack.mjs   (exit 0 = manifest is as expected,
 * exit 2 = npm CLI unavailable, so nothing was verified)
 */
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

// Top-level paths allowed in the published tarball. package.json is
// always included by npm itself.
const ALLOWED_TOP = new Set([
  'package.json',
  'README.md',
  'LICENSE',
  'CHANGELOG.md',
  'PLAN.md',
  'SECURITY.md',
  'src',
  'docs',
  'examples',
]);

// Paths that must never ship, even if a future "files" edit or an npm
// behavior change would otherwise include them.
const FORBIDDEN = [
  /^test\.mjs$/,
  /^deploy\//,
  /^scripts\//,
  /^\.github\//,
  /^filestore-race-fix\//,
  /^node_modules\//,
  /\.tgz$/,
  /ghostbus-data/,
  /^ghostbus-hosted\//,
  /^LAUNCH\.md$/,
];

// Files the package cannot work (or be trusted) without.
const REQUIRED = [
  'package.json',
  'README.md',
  'LICENSE',
  'SECURITY.md',
  'docs/security.md',
  'src/core.mjs',
  'src/mcp-server.mjs',
  'src/cli.mjs',
  'src/http-server.mjs',
  'src/hosted-server.mjs',
  'src/handler.mjs',
  'src/tools.mjs',
];

const res = spawnSync('npm', ['pack', '--dry-run', '--json'], {
  cwd: root,
  encoding: 'utf8',
  maxBuffer: 16 * 1024 * 1024,
});
if (res.error || res.status !== 0) {
  console.error('check-pack: npm CLI unavailable or `npm pack --dry-run` failed — manifest NOT verified');
  if (res.error) console.error(`  ${res.error.message}`);
  if (res.stderr) console.error(res.stderr.split('\n').slice(0, 5).join('\n'));
  process.exit(2);
}

let pack;
try {
  pack = JSON.parse(res.stdout)[0];
} catch {
  console.error('check-pack: could not parse `npm pack --dry-run --json` output — manifest NOT verified');
  process.exit(2);
}

const files = pack.files.map(f => f.path);
const problems = [];

for (const f of files) {
  const top = f.split('/')[0];
  if (!ALLOWED_TOP.has(top)) problems.push(`unexpected top-level path in tarball: ${f}`);
  for (const re of FORBIDDEN) {
    if (re.test(f)) problems.push(`forbidden path in tarball: ${f}`);
  }
}
for (const req of REQUIRED) {
  if (!files.includes(req)) problems.push(`required file missing from tarball: ${req}`);
}

console.log(`check-pack: ${pack.name}@${pack.version} — ${files.length} files, ${(pack.size / 1024).toFixed(1)} kB packed`);
for (const f of files) console.log(`  ${f}`);
if (problems.length) {
  for (const p of problems) console.error(`check-pack FAIL: ${p}`);
  process.exit(1);
}
console.log('check-pack: manifest matches the allowlist');
