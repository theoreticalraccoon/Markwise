import assert from "node:assert/strict";
import { test } from "node:test";
import { build } from "esbuild";

const { outputFiles } = await build({
  stdin: { contents: 'export * from "./src/js/api/data.js"; export { store } from "./src/js/store.js";', resolveDir: process.cwd() },
  bundle: true, format: "esm", write: false,
  plugins: [{ name: "database-boundary", setup(build) {
    build.onResolve({ filter: /\/client\.js$|^\.\/client\.js$/ }, () => ({ path: "db", namespace: "test" }));
    build.onLoad({ filter: /.*/, namespace: "test" }, () => ({ contents: "export const sb = { from: (...a) => globalThis.testDB.from(...a) };" }));
  } }],
});
const source = outputFiles[0].text + "\n//# sourceURL=markwise-offline-test.mjs";
const api = await import(`data:text/javascript;base64,${Buffer.from(source).toString("base64")}`);

function environment(t) {
  const values = new Map();
  globalThis.localStorage = {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
    removeItem: (key) => values.delete(key),
  };
  navigator.onLine = true;
  api.store.user = { id: "alice" };
  let calls = 0;
  const paper = { id: "paper", user_id: "alice", status: "ready", questions: [{ n: 1, text: "2 + 3", marks: 2 }] };
  globalThis.testDB = { from(table) {
    calls++;
    const result = navigator.onLine
      ? { data: table === "mocks" ? paper : table === "profiles" ? { subjects: ["E-4MA1"] } : [{ code: "E-4MA1" }], error: null }
      : { data: null, error: { message: "Network unavailable" } };
    const q = { then: (resolve) => Promise.resolve(result).then(resolve) };
    for (const method of ["select", "eq", "order", "maybeSingle", "single", "update", "delete"]) q[method] = () => q;
    return q;
  } };
  t.after(() => { delete globalThis.localStorage; delete globalThis.testDB; delete navigator.onLine; });
  return { paper, calls: () => calls };
}

test("previously opened mock is available offline without a database request", async (t) => {
  const env = environment(t);
  await api.getMock("paper");
  navigator.onLine = false;
  assert.deepEqual(await api.getMock("paper"), env.paper);
  assert.equal(env.calls(), 1);
});

test("profile and catalogue restore enough state to reopen a mock offline", async (t) => {
  const env = environment(t);
  await api.loadCatalogue();
  await api.loadProfile("alice");
  api.store.mySubjects = [];
  api.store.subjects = [];
  navigator.onLine = false;
  await api.loadCatalogue();
  await api.loadProfile("alice");
  assert.deepEqual(api.store.mySubjects, ["E-4MA1"]);
  assert.equal(api.store.subjects[0].code, "E-4MA1");
  assert.equal(env.calls(), 3);
});

test("offline paper snapshots cannot be read by a different account", async (t) => {
  environment(t);
  await api.getMock("paper");
  api.store.user = { id: "bob" };
  navigator.onLine = false;
  await assert.rejects(api.getMock("paper"), /offline|saved|network/i);
});

test("a deleted mock cannot reappear from offline storage", async (t) => {
  environment(t);
  await api.getMock("paper");
  await api.deleteMock("paper");
  navigator.onLine = false;
  await assert.rejects(api.getMock("paper"), /offline|saved|network/i);
});

test("legacy Further Pure Maths selections normalize to one canonical subject", () => {
  assert.deepEqual(
    api.normalizeSubjectCodes(["X-FPM", "E-4MA1", "E-4PM1", "X-FPM"]),
    ["E-4PM1", "E-4MA1"],
  );
  assert.deepEqual(
    api.normalizeCatalogue([
      { code: "X-FPM", name: "Further Pure Maths" },
      { code: "E-4PM1", name: "Further Pure Mathematics" },
      { code: "E-4MA1", name: "Mathematics A" },
    ]).map((subject) => subject.code),
    ["E-4PM1", "E-4MA1"],
  );
});
