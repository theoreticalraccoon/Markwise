/**
 * Hash router.
 *
 * Hash rather than history API because the app is a static file that may be
 * opened from disk or from a subpath on any host. There is no server to
 * rewrite deep links.
 *
 * Each route exports `render(container, params)` and may return a cleanup
 * function, which is called before the next route mounts. That is how the mock
 * timer and the in-flight ask request get cancelled on navigation.
 */

import { esc } from "./ui/dom.js";

const routes = new Map();

/** Bumped on every navigation, so a slow render can tell it has been replaced. */
let navToken = 0;
let current = null;
let cleanup = null;
let container = null;

export function defineRoute(name, module) {
  routes.set(name, module);
}

export function setOutlet(el) {
  container = el;
}

/** '#/mock/abc?x=1' → { name:'mock', segments:['abc'], query:{x:'1'} } */
export function parseHash(hash = location.hash) {
  const raw = hash.replace(/^#\/?/, "");
  const [path, search = ""] = raw.split("?");
  const segments = path.split("/").filter(Boolean);
  const query = Object.fromEntries(new URLSearchParams(search));
  return { name: segments[0] || "planner", segments: segments.slice(1), query };
}

export function navigate(path, { replace = false } = {}) {
  const target = path.startsWith("#") ? path : `#/${path.replace(/^\/+/, "")}`;
  if (location.hash === target) {
    handleRoute();
    return;
  }
  if (replace) {
    // replaceState rewrites the URL without firing hashchange, so the router
    // would never hear about it. The address bar would say "../marked" while
    // the previous view stayed on screen. Render it explicitly.
    history.replaceState(null, "", target);
    handleRoute();
  } else {
    location.hash = target;   // hashchange drives the render
  }
}

/**
 * Replace the outlet with a clean copy of itself.
 *
 * Every view wires its buttons with delegated listeners on the outlet, and
 * `innerHTML = ...` does not remove listeners from the element that holds the
 * markup. The outlet is the same element for the whole session, so each visit
 * to a view stacked another set of handlers on it: on the third visit, one
 * click on "Next" skipped three pages, "Revise" created three tasks, and
 * "Show the mark scheme" toggled itself straight back. A fresh element per
 * navigation has no listeners, no leftover markup, and no way for a render that
 * is still in flight to write into the screen that replaced it.
 */
function freshOutlet() {
  const next = container.cloneNode(false);
  container.replaceWith(next);
  container = next;
  return next;
}

export async function handleRoute() {
  if (!container) return;
  const { name, segments, query } = parseHash();
  const module = routes.get(name) ?? routes.get("planner");
  if (!module) return;

  const id = ++navToken;

  // Same route, different params: let the view decide rather than remounting.
  const sameRoute = current === name;
  if (!sameRoute) {
    cleanup?.();
    cleanup = null;
  } else if (cleanup) {
    // The outlet is about to be replaced, so whatever the view attached to the
    // old one (timers, document listeners) has to go with it.
    cleanup();
    cleanup = null;
  }

  current = name;
  document.body.dataset.route = name;
  markActiveNav(name);

  const outlet = freshOutlet();

  try {
    const result = await module.render(outlet, { segments, query, sameRoute });

    // The student navigated again while this was loading. Whatever it built is
    // in an outlet that is no longer on screen; only its cleanup still matters.
    if (id !== navToken) {
      if (typeof result === "function") result();
      return;
    }
    if (typeof result === "function") cleanup = result;

    // Move keyboard and screen-reader focus to the new page, unless the view
    // already put it somewhere useful (an autofocused input, say).
    if (document.activeElement === document.body || !outlet.contains(document.activeElement)) {
      if (!outlet.contains(document.activeElement) && document.activeElement?.tagName !== "INPUT") {
        outlet.focus({ preventScroll: true });
      }
    }
  } catch (e) {
    console.error(`Route "${name}" failed`, e);
    if (id === navToken) {
      outlet.innerHTML = `<div class="empty error"><h3>This page failed to load</h3><p>${esc(e.message ?? "")}</p></div>`;
    }
  }
}

function markActiveNav(name) {
  document.querySelectorAll("[data-nav]").forEach((el) => {
    const active = el.dataset.nav === name;
    el.classList.toggle("active", active);
    if (active) el.setAttribute("aria-current", "page");
    else el.removeAttribute("aria-current");
  });
}

export function startRouter() {
  window.addEventListener("hashchange", handleRoute);
  handleRoute();
}

export function stopRouter() {
  window.removeEventListener("hashchange", handleRoute);
  cleanup?.();
  cleanup = null;
  current = null;
}

export function currentRoute() {
  return current;
}
