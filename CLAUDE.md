# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Overview

This is a static, framework-free multi-brand marketing website (plain HTML/CSS/JS, no build step, no package manager). It's deployed via GitHub Pages — the `CNAME` file at the repo root points the custom domain `hphtechsolutions.com` at this repo. There is no bundler, dev server, linter, or test suite; pages are opened directly as static files or served via GitHub Pages.

## Development workflow

- There are no build/lint/test commands — this repo has no `package.json`. Edit HTML/CSS/JS files directly.
- To preview locally, open an `index.html` file directly in a browser, or serve the repo root with any static file server (e.g. `python3 -m http.server`) so relative paths resolve correctly.
- Changes are deployed by pushing to `main`; GitHub Pages serves directly from the repo root using the `CNAME` domain.

## Site structure

The repo root (`index.html`, `app.js`, `styles.css`) is a landing/splash page that links out to two independent sub-sites, each a self-contained brand:

- `HPH TECHNICAL SOLUTIONS/` — brand site with `home/`, `about/`, `milestones/` sections.
- `HPH RENEWABLE/` — brand site with `home/`, `about/`, `contact/`, `products/` (including nested `product-pages/content1/page1|2|3/`), and `legal-policies/` (privacy-policy, return-and-refund-policy, terms-and-conditions).

Each **page** lives in its own directory containing an `index.html` and a page-scoped `styles.css`. Shared/media assets for a page live in a local `elements/` subfolder (images, videos). There is a root-level shared `app.js` used by all pages across both brands (see below) — some brand folders also have their own local copy/variant of `app.js` (e.g. `HPH RENEWABLE/app.js`), so check which script a given `index.html` actually references before assuming shared behavior.

Global/shared brand assets (logos, favicon) live in a `global-elements/` or `global elements/` folder per brand — **note the inconsistent naming** (`HPH RENEWABLE/global-elements/` uses a hyphen, `HPH TECHNICAL SOLUTIONS/global elements/` uses a space). Match whichever convention the specific brand folder already uses; don't rename existing files/folders without updating every relative link that references them.

## Key conventions

- **Relative paths everywhere.** Every page links CSS, JS, favicons, and internal nav links via relative paths (e.g. `../../app.js`, `../about/index.html`). When adding or moving a page, carefully recount `../` segments — there is no root-relative (`/...`) linking and no path aliasing.
- **Per-page `<head>` boilerplate is duplicated** across every `index.html` (Google Material Symbols font, Inter font via Google Fonts preconnect, viewport meta, favicon link, `<script defer src="...app.js">`). When editing this boilerplate (e.g. changing the font setup), it must be updated consistently across all pages that share the same intent — there's no shared template/include mechanism.
- **Root `app.js` responsibilities** (shared across pages that reference it): an `IntersectionObserver`-driven scroll-reveal animation (toggles `.show` on elements with class `.hidden`), a hamburger-menu toggle (`myFunction`/`toggleMenu` via `.menu`/`.dropdown`/`header` classes), and a manual before/after-style image/content slider (`showSlides`/`plusSlides`/`currentSlide` operating on `.mySlides`/`.dot` elements). Not every page uses every feature — `document.querySelector(...)` calls in `app.js` will throw if a page's HTML lacks the expected elements, so when reusing `app.js` on a new page, ensure the matching markup (`.menu`, `.dropdown`, `header`, `.mySlides`/`.dot` if using the slider) exists, or scope/guard the code.
- **CSS pattern:** desktop (`.desktop`) and mobile (`.mobile`) layouts are maintained as separate DOM trees/rulesets in the same stylesheet, switched via a `max-width: 750px` media query (mobile shown, desktop hidden below that breakpoint). Follow this same desktop/mobile split when adding new sections rather than trying to make one ruleset responsive.
- Nested CSS (e.g. `.desktop { .content { ... } }` in `styles.css`) is used directly — this relies on native CSS nesting support in modern browsers, not a preprocessor.
- External "Get in Touch" / contact CTAs link out to a Google Form (`https://forms.gle/...`); there is no backend or form-handling code in this repo.
