# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A static, hand-written HTML/CSS/JS marketing site with no build system, no package manager, and no test suite. There is no `package.json`, no bundler, no framework. Every page is a plain `.html` file paired with its own `styles.css`, linked directly via `<link>`/`<script>` tags.

## Running it locally

There is no dev server or build step. Open the HTML files directly in a browser, or serve the directory with any static file server, e.g.:

```
python3 -m http.server 8000
```

Then navigate to `http://localhost:8000/index.html`.

## Site structure

The repo root is a landing page (`index.html`, `app.js`, `styles.css`) that links out to two independent sub-sites, each a self-contained mini-site with its own home/about/etc. pages:

- `HPH TECHNICAL SOLUTIONS/` — pages: `home`, `about`, `milestones`
- `HPH RENEWABLE/` — pages: `home`, `about`, `products/product-pages/content1/page1|2|3` and `content2/page1|2` (individual product pages only — there is no all-products listing page; the product lineup is reached through the nav menu), `contact`, `legal-policies` (`terms-and-conditions`, `privacy-policy`, `return-and-refund-policy`)

Each page is a directory containing `index.html` + `styles.css`, and often an `elements/` subfolder holding page-local images/videos referenced by relative path.

**JS sharing is inconsistent between the two sub-sites** — don't assume one pattern applies to both:
- `HPH RENEWABLE` has its own copy of `app.js` (`HPH RENEWABLE/app.js`) that its pages reference via `../app.js`.
- `HPH TECHNICAL SOLUTIONS` has no local `app.js`; its pages reach up to the repo-root `app.js` via `../../app.js`.

Global asset folder naming also differs between sub-sites (not a typo to "fix" without checking both):
- `HPH RENEWABLE/global-elements/` (hyphenated)
- `HPH TECHNICAL SOLUTIONS/global elements/` (space)
- repo root: `global elements/` (space)

When adding a new page inside a sub-site, match that sub-site's existing relative-path depth and JS/asset-folder convention rather than copying from the other sub-site.

## Shared front-end patterns

`app.js` (and `HPH RENEWABLE/app.js`, kept in sync manually) provides the same behavior across all pages:

- **Scroll-reveal animation**: elements with class `hidden` are observed via `IntersectionObserver`; `show` is toggled on/off as they enter/leave the viewport. The corresponding CSS (`.hidden`/`.show` in each page's `styles.css`, derived from the root `styles.css`) defines the blur/translate/opacity transition. Siblings under a `.logo` container get staggered `transition-delay` via `:nth-child` for a cascading reveal effect.
- **Image slider**: `showSlides()` / `plusSlides()` / `currentSlide()` drive a manual slideshow over elements with class `mySlides` and dot indicators with class `dot`.
- **Hamburger/dropdown menu**: `toggleMenu()` toggles a `.menu a` active state and a `header.black` class; wired up via a listener on `.menu` and the first `.dropdown` element. Note this listener setup assumes both elements exist in the DOM — pages without a `.menu`/`.dropdown` element will throw on load if `app.js` is included unmodified.

**Desktop/mobile split**: layout is done via two top-level containers per page, `<div class="desktop">...</div>` and `<div class="mobile">...</div>`, toggled by a `@media (max-width: 750px)` query in each page's `styles.css` (desktop hidden, mobile shown below that width). **The `.mobile` containers are currently empty placeholders across every page in the repo** — mobile layouts have not been built out yet. Don't assume mobile support exists when making changes; flag it if a task depends on it.

CSS uses native nested selectors (e.g. `.desktop { .content { .text-container { ... } } }` in `styles.css`) rather than a preprocessor — there is no Sass/Less build step, so this relies on browser-native CSS nesting support.

## "Schedule a Visit" form (HPH RENEWABLE, Firebase)

Every HPH RENEWABLE page loads `HPH RENEWABLE/schedule-visit.js` (an ES module, `<script type="module">` right after the `app.js` tag). It intercepts clicks on any link to the old Schedule a Visit Google Form (`forms.gle/orQuM7UsENUJpYNd6`) and opens a built-in dialog form instead (styles in `HPH RENEWABLE/schedule-visit.css`). Submissions are written to Firestore, collection `visitRequests`, using the web config in `HPH RENEWABLE/firebase-config.js`; the Firebase SDK is loaded from gstatic only on first submit.

- Keep the Schedule a Visit links pointing at the Google Form URL — that's both the hook the script matches on and the fallback if Firebase isn't configured (placeholder `projectId` starting with `YOUR_`) or the module fails to load.
- Security rules live in `/firestore.rules` (public may create validated requests only; no public reads). If you add or rename a form field, update both `schedule-visit.js` and the field list in `firestore.rules`, or every submission will be rejected.
- ES modules don't load over `file://` — test the form through a local server (`python3 -m http.server`).

## Live portfolio counters (HPH RENEWABLE)

`HPH RENEWABLE/portfolio-counters.js` (plain `defer` script) reads the installation Google Sheet and fills in the installed-count and total-capacity counters. It's loaded by both `home/` and `portfolio/` and finds its elements by data attributes — `data-portfolio-count="inverters|panels|inverter-capacity|solar-capacity"` (capacities also need `data-unit`), plus optional `data-portfolio-status-dot` / `-status-text` / `-error` — so any page can show them without its own copy of the logic. The per-unit ratings (2.25 kW per inverter, 0.65 kWp per panel) live at the top of that file.

## Conventions to follow

- Each page's CSS lives in a `styles.css` next to its `index.html`; there is no shared/global stylesheet imported across pages beyond what's copy-pasted from the root `styles.css` patterns (`.hidden`/`.show`, desktop/mobile toggle, font/icon `<link>` tags in `<head>`).
- Google Fonts (Inter) and Material Symbols Rounded icons are loaded per-page via the same `<link>` block copied at the top of every `<head>` — replicate this block rather than inventing a new font-loading approach.
- Images/videos live in an `elements/` folder alongside the page that uses them, not in a shared media directory.
