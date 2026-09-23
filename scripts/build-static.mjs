import { cp, mkdir, rm, lstat } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const root = fileURLToPath(new URL("../", import.meta.url));
const output = join(root, "dist");
const existing = await lstat(output).catch(() => null);
if (existing?.isSymbolicLink()) throw new Error("Refusing to replace a linked dist directory.");
await rm(output, { recursive: true, force: true });
await mkdir(output);
for (const name of ["index.html", "manifest.webmanifest", "sw.js", "src"]) {
  await cp(join(root, name), join(output, name), { recursive: true });
}
console.log("Built dist: browser files only.");
