import assert from "node:assert/strict";
import { test } from "node:test";
import { build } from "esbuild";

process.env.SUPABASE_URL = "https://example.supabase.co";
process.env.SUPABASE_SERVICE_ROLE_KEY = "dummy";
process.env.GEMINI_API_KEYS = "key-one,key-two";
process.env.GEMINI_CHAT_MODEL = "model-one,model-two";

async function client(kind, id) {
  if (kind === "cli") return import(`../ingest/lib/gemini.js?test=${id}`);
  const { outputFiles } = await build({
    entryPoints: ["supabase/functions/_shared/gemini.ts"],
    bundle: true, format: "esm", write: false,
  });
  globalThis.Deno = { env: { get: (name) => process.env[name] } };
  try {
    const source = outputFiles[0].text + `\n// ${id}\n//# sourceURL=markwise-gemini-test.mjs`;
    return await import(`data:text/javascript;base64,${Buffer.from(source).toString("base64")}`);
  } finally { delete globalThis.Deno; }
}

for (const kind of ["cli", "edge"]) {
  test(`${kind}: exhausted keys are each tried once with no quota sleep`, async (t) => {
    const api = await client(kind, "exhausted");
    const keys = [], sleeps = [];
    // Move time forwards so the old cooldown loop can finish and fail its assertion.
    let now = Date.now();
    t.mock.method(Date, "now", () => now);
    t.mock.method(globalThis, "setTimeout", (done, ms) => { sleeps.push(ms); now += ms; done(); });
    t.mock.method(globalThis, "fetch", async (url) => {
      keys.push(new URL(url).searchParams.get("key"));
      return new Response("quota exhausted", { status: 429 });
    });
    await assert.rejects(api.embedBatch(["question"]), /quota|429/i);
    assert.deepEqual(keys, ["key-one", "key-two"]);
    assert.deepEqual(sleeps, []);
  });

  test(`${kind}: another configured key can serve the same model`, async (t) => {
    const api = await client(kind, "second-key");
    let requests = 0;
    t.mock.method(globalThis, "fetch", async () => ++requests === 1
      ? new Response("quota exhausted", { status: 429 })
      : Response.json({ embeddings: [{ values: [3, 4, ...Array(766).fill(0)] }] }));
    assert.deepEqual(await api.embedBatch(["question"]), [[0.6, 0.8, ...Array(766).fill(0)]]);
    assert.equal(requests, 2);
  });

  test(`${kind}: invalid or incomplete embedding batches fail instead of corrupting retrieval`, async (t) => {
    const api = await client(kind, "invalid-vectors");
    for (const embeddings of [[], [{ values: [3, 4] }], [{ values: Array(768).fill(0) }], [{ values: Array(768).fill(null) }]]) {
      t.mock.method(globalThis, "fetch", async () => Response.json({ embeddings }));
      await assert.rejects(api.embedBatch(["question"]), /embedding/i);
    }
  });
}
