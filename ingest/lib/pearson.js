/**
 * Pearson's official past-papers catalogue.
 *
 * Pearson publishes past papers for students free of charge on its own website,
 * and the page that lists them is driven by a search index whose public,
 * search-only credentials it ships to every visitor. This module opens that
 * page in a browser, as a student would, and asks the page's own search client
 * the same questions it asks when someone presses Search. It never touches
 * anything but qualifications.pearson.com, and it says what it is.
 *
 * What it will NOT do:
 *   - fetch from any other site (the whole point of this loader is that every
 *     file comes from the copyright holder's own public pages);
 *   - fetch anything the catalogue marks as needing a teacher login;
 *   - go faster than one request every couple of seconds.
 */

import { chromium } from "playwright";

export const SITE = "https://qualifications.pearson.com";
export const PAGE = `${SITE}/en/support/support-topics/exams/past-papers.html`;
export const USER_AGENT = "Markwise-corpus-loader/1.0 (educational study tool)";

/** Pause between requests to the site, in milliseconds. */
export const POLITE_DELAY_MS = 2000;

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Open the catalogue page and return a search function bound to its client. */
export async function openCatalogue() {
  const browser = await chromium.launch({ headless: true });
  const page = await (await browser.newContext({ userAgent: USER_AGENT })).newPage();
  await page.goto(PAGE, { waitUntil: "networkidle", timeout: 60000 });
  await page.locator("#onetrust-accept-btn-handler").click({ timeout: 3000 }).catch(() => {});

  const ready = await page.evaluate(() =>
    !!(document.querySelector(".algoliaAPIKey")?.value && window.algoliasearch));
  if (!ready) {
    await browser.close();
    throw new Error("The past-papers page no longer carries its search configuration. Its layout has changed.");
  }

  /**
   * Every document matching `filters`, paged. A pause between pages keeps this
   * to a few requests, not a burst.
   */
  async function search(filters, query = "") {
    const all = [];
    for (let pageNo = 0; ; pageNo++) {
      const res = await page.evaluate(async ({ filters, query, pageNo }) => {
        const key = document.querySelector(".algoliaAPIKey").value;
        const app = document.querySelector(".algoliaAppId").value;
        const name = document.querySelector(".algoliaIndexName").value;
        const index = window.algoliasearch(app, key).initIndex(name);
        const r = await index.search(query, { filters, hitsPerPage: 500, page: pageNo });
        return {
          nbPages: r.nbPages,
          hits: r.hits.map((h) => ({ title: h.title, url: h.url, category: h.category ?? [] })),
        };
      }, { filters, query, pageNo });
      all.push(...res.hits);
      if (pageNo + 1 >= res.nbPages) break;
      await sleep(POLITE_DELAY_MS);
    }
    return all;
  }

  return { search, close: () => browser.close() };
}

/** The value of a category tag, e.g. tagOf(doc, "Exam-Series") -> "June-2024". */
export function tagOf(doc, kind) {
  const prefix = `Pearson-UK:${kind}/`;
  const hit = doc.category.find((c) => c.startsWith(prefix));
  return hit ? hit.slice(prefix.length) : null;
}

/** Is this document behind a teacher login? Those are never fetched. */
export function isGated(doc) {
  return doc.category.some((c) => /secure-content\/(gold)/i.test(c));
}

/** "Jun" / "Jan" / "Nov" and the year, from a series tag like "June-2024". */
export function parseSeries(tag) {
  const m = String(tag ?? "").match(/^(January|June|May|October|November|February|March)[-\s](20\d\d)$/i);
  if (!m) return null;
  const month = m[1].toLowerCase();
  const session = month === "january" ? "Jan" : month === "june" || month === "may" ? "Jun" : "Nov";
  return { session, year: Number(m[2]) };
}

/** Markwise's file naming: E-4PH1_s24_qp_1P.pdf */
export function markwiseName({ code, session, year, kind, ref }) {
  const letter = { Jan: "j", Jun: "s", Nov: "w" }[session];
  return `E-${code}_${letter}${String(year).slice(2)}_${kind}${ref ? `_${ref}` : ""}.pdf`;
}
