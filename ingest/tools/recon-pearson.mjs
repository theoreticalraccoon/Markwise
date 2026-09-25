/**
 * First recon of Pearson's past-papers page: what it lists for one subject and
 * series, using the page's own public search client. Read-only.
 *
 *   node tools/recon-pearson.mjs "Physics" "Summer-2024"
 */
import { chromium } from "playwright";

const BASE = "https://qualifications.pearson.com/en/support/support-topics/exams/past-papers.html";
const UA = "Markwise-corpus-loader/1.0 (educational study tool)";
const subject = process.argv[2] ?? "Physics";
const series = process.argv[3] ?? "Summer-2024";

const browser = await chromium.launch({ headless: true });
const page = await (await browser.newContext({ userAgent: UA })).newPage();
await page.goto(BASE, { waitUntil: "networkidle", timeout: 60000 });
await page.locator("#onetrust-accept-btn-handler").click({ timeout: 3000 }).catch(() => {});

const out = await page.evaluate(async ({ subject, series }) => {
  const key = document.querySelector(".algoliaAPIKey")?.value;
  const app = document.querySelector(".algoliaAppId")?.value;
  const name = document.querySelector(".algoliaIndexName")?.value;
  if (!key || !app || !name) return { error: "no search config on the page", key: !!key, app: !!app, name: !!name };
  const index = window.algoliasearch(app, key).initIndex(name);

  const fam = `category:"Pearson-UK:Qualification-Family/International-GCSE"`;
  const r1 = await index.search("", { filters: fam, hitsPerPage: 3, facets: ["*"], maxValuesPerFacet: 300 });
  const r2 = await index.search("4PH1 question paper 2024", { hitsPerPage: 6 });
  const pick = (facets, re) => Object.entries(facets ?? {}).filter(([k]) => re.test(k));
  return {
    familyHits: r1.nbHits,
    facetGroups: Object.keys(r1.facets ?? {}),
    subjects: pick(r1.facets, /Qualification-Subject/).map(([k, v]) => [k, Object.keys(v).slice(0, 60)]),
    series: pick(r1.facets, /Exam-Series/).map(([k, v]) => [k, Object.keys(v).slice(0, 80)]),
    docTypes: pick(r1.facets, /Document-Type/).map(([k, v]) => [k, Object.keys(v)]),
    sample: r1.hits.map((h) => ({ url: h.url, title: h.title, cats: (h.category ?? []).slice(0, 12) })),
    textSearch: r2.hits.map((h) => ({ url: h.url, title: h.title, cats: (h.category ?? []).slice(0, 10) })),
  };
}, { subject, series });

console.log(JSON.stringify(out, null, 2).slice(0, 4500));
await browser.close();
