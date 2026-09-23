import assert from "node:assert/strict";
import { test } from "node:test";
import { spawnSync } from "node:child_process";
import { readFile, readdir, stat } from "node:fs/promises";
import { join } from "node:path";

test("Vercel build emits only the runnable browser app, without secrets or corpus files", async () => {
  const run = spawnSync(process.execPath, ["scripts/build-static.mjs"], { encoding: "utf8" });
  assert.equal(run.status, 0, run.stderr);
  const files = [];
  async function walk(dir, prefix = "") {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const name = join(prefix, entry.name).replaceAll("\\", "/");
      if (entry.isDirectory()) await walk(join(dir, entry.name), name);
      else files.push(name);
    }
  }
  await walk("dist");
  for (const required of ["index.html", "sw.js", "manifest.webmanifest", "src/js/app.js", "src/js/lib/offline.js", "src/css/app.css"]) {
    assert.ok(files.includes(required), `${required} missing from build`);
  }
  assert.ok(files.every((name) => name.startsWith("src/") || ["index.html", "sw.js", "manifest.webmanifest"].includes(name)));
  assert.ok(!files.some((name) => /\.pdf$|\.env|ingest\/|supabase\/|node_modules\//.test(name)));
  const html = await readFile("dist/index.html", "utf8");
  for (const match of html.matchAll(/(?:src|href)="([^"]+)"/g)) {
    if (/^(?:https?:|#)/.test(match[1])) continue;
    assert.ok((await stat(join("dist", match[1]))).isFile(), `missing HTML asset ${match[1]}`);
  }
  const workspaceCss = await readFile("dist/src/css/workspace.css", "utf8");
  for (const match of workspaceCss.matchAll(/url\(['"]([^'"]+)['"]\)/g)) {
    assert.ok((await stat(join("dist/src/css", match[1]))).size > 0, `missing workspace asset ${match[1]}`);
  }
});
