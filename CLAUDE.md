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

Every "Schedule a Visit" link on HPH RENEWABLE points to the dedicated page `HPH RENEWABLE/schedule-a-visit/` (same tab; product pages append `?product=<name>`, which pre-selects the product). The form there is one shared block (`<main class="visit-page">`, outside `.desktop`/`.mobile`, like the FAQ page) handled by `schedule-a-visit/visit-form.js` (ES module). Answers go to Firestore collection `visitRequests`; optional attachments (≤3 images/PDFs, 10 MB each) go to Cloud Storage under `visitRequests/<request id>/`, and their paths are stored in the request's `attachments` field. Firebase settings: `HPH RENEWABLE/firebase-config.js` (while `projectId` starts with `YOUR_`, submitting shows a call/email fallback message). The SDK loads from gstatic only on submit.

- Security rules: `/firestore.rules` and `/storage.rules` — the public may create validated requests/files only; no public reads, edits or deletes. If you add or rename a form field, update `visit-form.js` and the field list in `firestore.rules`, or every submission will be rejected; upload limits live in both `visit-form.js` and `storage.rules`.
- ES modules don't load over `file://` — test the form through a local server (`python3 -m http.server`).

## Feedback form (HPH RENEWABLE, Firebase)

The Portfolio page's "Send Feedback" buttons link to `HPH RENEWABLE/feedback/`, built the same way as the Schedule a Visit page (shared `<main class="visit-page">`, same `visit-*` form styles, plus a star rating). `feedback/feedback-form.js` saves to Firestore collection `feedback` in the same project (not a separate database); its field list is validated by `isValidFeedback` in `/firestore.rules`.

## 3D model slides (MAU5000 Elite, MSU4000 Elite and B5000 Elite product pages)

`products/product-pages/content1/page3/` shows a 3D model as the carousel's 2nd slide using Google's `<model-viewer>` web component (loaded from jsDelivr in that page's `<head>`). It displays `elements/mau5000elite.glb`, a web-optimised version of the supplied `elements/mau5000elite.gltf` (19 MB, mm units, 1M triangles, no normals, near-white material): scaled to metres for AR, rotated +90° about X to stand upright (the export lies on its back, front panel facing up), simplified to ~267k triangles, smooth normals added, material set to charcoal, Draco-compressed (~1 MB). Re-export from the source if the model changes rather than editing the .glb. `content1/page2/` (MSU4000 Elite) does the same with `elements/msu4000elite.glb`, built the same way from `elements/mau4000elite.gltf` (the source file's name says "mau", but it is the MSU4000; ~945k → ~236k triangles, ~1 MB). `content2/page2/` (B5000 Elite) likewise shows `elements/b5000elite.glb` from `elements/b5000elite.gltf` (~607k → ~243k triangles, ~0.95 MB); adding the 3D slide made its carousel two slides, so its mobile carousel no longer has the `mobile-carousel-single` class that hid the arrows/dots. Styles are top-level `.carousel-slide-3d` / `.mobile-carousel-slide-3d` rules in each page's `styles.css`; the carousel's touch-swipe handler ignores drags that start on a `<model-viewer>` so they rotate the model instead.

## Live portfolio counters (HPH RENEWABLE)

`HPH RENEWABLE/portfolio-counters.js` (plain `defer` script) reads the installation Google Sheet and fills in the installed-count and total-capacity counters. It's loaded by both `home/` and `portfolio/` and finds its elements by data attributes — `data-portfolio-count="inverters|panels|inverter-capacity|solar-capacity"` (capacities also need `data-unit`), plus optional `data-portfolio-status-dot` / `-status-text` / `-error` — so any page can show them without its own copy of the logic. The per-unit ratings (2.25 kW per inverter, 0.65 kWp per panel) live at the top of that file.

## Conventions to follow

- Each page's CSS lives in a `styles.css` next to its `index.html`; there is no shared/global stylesheet imported across pages beyond what's copy-pasted from the root `styles.css` patterns (`.hidden`/`.show`, desktop/mobile toggle, font/icon `<link>` tags in `<head>`).
- Google Fonts (Inter) and Material Symbols Rounded icons are loaded per-page via the same `<link>` block copied at the top of every `<head>` — replicate this block rather than inventing a new font-loading approach.
- Images/videos live in an `elements/` folder alongside the page that uses them, not in a shared media directory.
