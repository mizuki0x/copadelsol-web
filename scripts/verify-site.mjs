import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, extname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const htmlFiles = [
  "index.html",
  "game/index.html",
  "paid/index.html",
  "rules/index.html",
  "terms/index.html",
  "privacy/index.html",
];
const required = [
  "robots.txt",
  "sitemap.xml",
  "site.webmanifest",
  "site.css",
  "game-demo-faceoff.png",
  "fonts/anton.woff2",
  "game/copa-config.js",
];

function fail(message) {
  throw new Error(message);
}

function sitePath(from, ref) {
  const clean = decodeURIComponent(ref.split(/[?#]/, 1)[0]);
  const target = clean.startsWith("/")
    ? join(root, clean.slice(1))
    : resolve(root, dirname(from), clean);
  return clean.endsWith("/") ? join(target, "index.html") : target;
}

function refs(html) {
  const found = [];
  for (const match of html.matchAll(/(?:src|href)=["']([^"'#]+)["']/g)) {
    found.push(match[1]);
  }
  for (const match of html.matchAll(/url\(["']?([^)"']+)["']?\)/g)) {
    found.push(match[1]);
  }
  return found.filter((ref) => !/^(?:https?:|mailto:|data:)/.test(ref));
}

let refCount = 0;
for (const file of htmlFiles) {
  const html = readFileSync(join(root, file), "utf8");
  if (!html.includes('href="/site.css"')) fail(`${file}: missing shared form styles`);
  const ids = [...html.matchAll(/\sid=["']([^"']+)["']/g)].map((match) => match[1]);
  const duplicates = ids.filter((id, index) => ids.indexOf(id) !== index);
  if (duplicates.length) fail(`${file}: duplicate ids: ${[...new Set(duplicates)].join(", ")}`);

  for (const ref of refs(html)) {
    const target = sitePath(file, ref);
    if (!existsSync(target)) fail(`${file}: missing ${ref}`);
    refCount += 1;
  }
}

for (const file of required) {
  if (!existsSync(join(root, file))) fail(`missing required file: ${file}`);
}

const formStyles = readFileSync(join(root, "site.css"), "utf8");
if (!/select\s*\{[\s\S]*?\n\s*appearance:\s*none/.test(formStyles)) {
  fail("shared form styles must disable native select appearance");
}

const homeHtml = readFileSync(join(root, "index.html"), "utf8");
if (
  !homeHtml.includes(
    '<span class="hero-h1__line">Drop the gloves.</span><span class="hero-h1__line">Settle it onchain.</span>',
  ) ||
  !/\.hero-h1__line\{[^}]*white-space:nowrap/.test(homeHtml)
) {
  fail("hero headline must render as two locked lines");
}
if (!/\.club \.crest\{[^}]*width:200px;[^}]*height:200px/.test(homeHtml)) {
  fail("club crests must render at 200px");
}

const manifest = JSON.parse(readFileSync(join(root, "site.webmanifest"), "utf8"));
for (const icon of manifest.icons ?? []) {
  if (!existsSync(sitePath("site.webmanifest", icon.src))) {
    fail(`manifest icon missing: ${icon.src}`);
  }
}

const gameHtml = readFileSync(join(root, "game/index.html"), "utf8");
let integrityCount = 0;
for (const match of gameHtml.matchAll(/href="([^"]+)"[^>]*integrity="sha384-([^"]+)"/g)) {
  const file = sitePath("game/index.html", match[1]);
  const digest = createHash("sha384").update(readFileSync(file)).digest("base64");
  if (digest !== match[2]) fail(`integrity mismatch: ${relative(root, file)}`);
  integrityCount += 1;
}
if (integrityCount !== 2) fail(`expected 2 game integrity hashes, found ${integrityCount}`);

const wasm = readdirSync(join(root, "game")).find((file) => file.endsWith(".wasm"));
if (!wasm) fail("missing game WASM");
const wasmPath = join(root, "game", wasm);
const wasmBytes = readFileSync(wasmPath);
if (wasmBytes.length > 23 * 1024 * 1024) fail(`WASM exceeds 23 MiB: ${wasmBytes.length} bytes`);

const demo = readFileSync(join(root, "game-demo-faceoff.png"));
if (demo.readUInt32BE(16) !== 1500 || demo.readUInt32BE(20) !== 500) {
  fail("hero demo must be 1500x500");
}

const ignored = new Set([".git", ".playwright-cli", "node_modules", "output"]);
const textExtensions = new Set([".html", ".js", ".json", ".md", ".txt", ".xml", ".yaml", ".yml"]);
const leakPatterns = [
  ["absolute home path", /\/Users\//],
  ["private key", /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  ["Privy app secret", /privy_app_secret_/i],
  ["GitHub token", /gh[opsu]_[A-Za-z0-9_]{20,}/],
];

function walk(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    if (ignored.has(entry.name)) return [];
    const path = join(dir, entry.name);
    return entry.isDirectory() ? walk(path) : [path];
  });
}

for (const file of walk(root)) {
  if (!textExtensions.has(extname(file))) continue;
  const content = readFileSync(file, "utf8");
  for (const [name, pattern] of leakPatterns) {
    if (pattern.test(content)) fail(`${relative(root, file)}: ${name} found`);
  }
}
for (const marker of ["/Users/", "privy_app_secret_", "PRIVATE KEY"]) {
  if (wasmBytes.includes(Buffer.from(marker))) fail(`game WASM contains ${marker}`);
}

console.log(
  `verified ${htmlFiles.length} HTML pages, ${refCount} asset references, ` +
    `${integrityCount} integrity hashes, and ${(statSync(wasmPath).size / 1024 / 1024).toFixed(2)} MiB WASM`,
);
