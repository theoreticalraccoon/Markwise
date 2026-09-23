/**
 * Parse check for everything the unit tests cannot import.
 *
 *   node test/parse.test.mjs
 *
 * The browser modules import Supabase from a CDN and the edge functions are
 * Deno TypeScript, so neither can be loaded in Node. Both are therefore the
 * easiest places in the repo for a syntax error to survive a green test run
 * all the way to a deploy. This parses every one of them.
 *
 * It is a parse, not a type check: esbuild strips types rather than verifying
 * them, and Deno does the real check in CI. Catching a stray brace in a file
 * nobody can run locally is still worth the two seconds.
 */
import { readFile, readdir } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..");

let transform;
try {
  ({ transform } = await import("esbuild"));
} catch {
  console.log("skipped: esbuild not installed (npm i -D esbuild)");
  process.exit(0);
}

let bad = 0;

/* ---------------------------------------------------- browser ES modules -- */

async function jsFiles(dir) {
  const out = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...await jsFiles(p));
    else if (entry.name.endsWith(".js")) out.push(p);
  }
  return out;
}

const browser = [...await jsFiles(join(REPO, "src/js")), join(REPO, "sw.js")];
for (const f of browser) {
  try {
    execFileSync(process.execPath, ["--check", f], { stdio: "pipe" });
  } catch (e) {
    bad++;
    console.log(`FAIL ${f}\n     ${String(e.stderr ?? e).split("\n").slice(0, 3).join("\n     ")}`);
  }
}
console.log(`browser modules: ${browser.length - bad} of ${browser.length} parse`);

/* ------------------------------------------------------- edge functions -- */

const FN = join(REPO, "supabase/functions");
const ts = [];
for (const entry of await readdir(FN, { withFileTypes: true })) {
  if (!entry.isDirectory()) continue;
  for (const f of await readdir(join(FN, entry.name))) {
    if (f.endsWith(".ts")) ts.push(join(FN, entry.name, f));
  }
}

let tsBad = 0;
for (const f of ts) {
  try {
    await transform(await readFile(f, "utf8"), { loader: "ts", target: "es2022" });
  } catch (e) {
    tsBad++;
    bad++;
    console.log(`FAIL ${f}`);
    for (const err of e.errors ?? []) console.log(`     line ${err.location?.line}: ${err.text}`);
  }
}
console.log(`edge functions: ${ts.length - tsBad} of ${ts.length} parse`);

/* ------------------------------------------------- stray control characters -- */

// A regex written as "\\b" in a patch script silently becomes a literal
// backspace (0x08) when the escaping is off by one. The file still parses, the
// regex just never matches, and the feature is dead with every check green.
// This has happened three times. Source files have no business containing
// control characters other than tab, newline and carriage return.
const SOURCE = /\.(js|mjs|cjs|ts|sql|css|html|json|md|webmanifest|yml)$/;
async function sourceFiles(dir) {
  const out = [];
  for (const e of await readdir(dir, { withFileTypes: true })) {
    if (e.name === "node_modules" || e.name === ".git") continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...await sourceFiles(p));
    else if (SOURCE.test(e.name)) out.push(p);
  }
  return out;
}
let stray = 0;
const everything = await sourceFiles(REPO);
for (const f of everything) {
  const text = await readFile(f, "utf8");
  const hit = text.match(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g);
  if (hit) {
    stray++;
    bad++;
    console.log(`FAIL ${f}: ${hit.length} control character(s), e.g. 0x${hit[0].charCodeAt(0).toString(16).padStart(2, "0")}`);
  }
}
console.log(`control characters: ${everything.length - stray} of ${everything.length} files clean`);

console.log(bad ? `\n${bad} file(s) failed` : "\neverything parses");
process.exit(bad ? 1 : 0);
