// Live portfolio counters, shared by the Home, Portfolio, Our Advocacy and
// Admin pages.
//
// Counts Micro Inverter and Solar Panel serial numbers (and their total kW /
// kWp capacity) and refreshes every 30 seconds while the tab is visible.
//
// Source: Firebase first. Each installation added on the admin page's
// Installs tab has a public `installCounts/<installId>` document holding just
// { inverters, panels } (panels include any whose serial wasn't recorded),
// and the totals are a Firestore sum query over those, so no client details
// reach visitors' browsers. While that collection is empty (before the
// one-time import from the sheet) or Firebase can't be reached, the counts
// come from the "HPH Renewable Master Database" Google Sheet as before.
//
// Speed: only the two serial-number columns of the sheet are requested
// (COLUMNS_QUERY), the last counts are remembered in localStorage and shown
// instantly on the next visit, and background refreshes don't dim the numbers.
//
// Any element on the page can show a value by carrying one of these markers
// (desktop and mobile copies are all filled in):
//   data-portfolio-count="inverters"          Micro inverters installed
//   data-portfolio-count="panels"             Solar panels installed
//   data-portfolio-count="inverter-capacity"  Total inverter capacity (kW)
//   data-portfolio-count="solar-capacity"     Total solar capacity (kWp)
//   data-portfolio-count="yearly-savings"     Customer savings per year (₱)
//   data-portfolio-count="lifetime-savings"   Customer savings over 25 years (₱)
//   data-portfolio-goal="inverters"           Progress toward GOALS.inverters:
//       sets --progress (0–100%) and aria-valuenow on the element, and fills
//       any [data-portfolio-goal-text] inside it ("312 of 1,000 · 31%")
//   data-portfolio-status-dot / -status-text / -error   Live status line
// Capacity elements also need data-unit="kW" / "kWp" for the unit label.

(function () {
    // Where this script lives, so firebase-config.js (next to it) can be found
    // from any page depth.
    const SCRIPT_URL = document.currentScript ? document.currentScript.src : location.href;
    // Same Firebase SDK version as the admin page.
    const FIREBASE_BASE = "https://www.gstatic.com/firebasejs/12.3.0";

    const SHEET_ID = "1I7w59tsa54pBLcBUs2T55pb-8lvfLKzCe0in_eY41WY";
    const SHEET_CSV_URL = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/gviz/tq?tqx=out:csv`;
    // Just the serial-number columns (F = Micro Inverter SN, H = Solar Panel
    // SN): smaller and faster, and visitors' browsers don't receive client
    // details. If the columns move, the header check below notices and the
    // whole sheet is read instead.
    const COLUMNS_QUERY = "select F, H";
    const LIVE_REFRESH_MS = 30000;
    const CACHE_KEY = "hph-portfolio-counts";

    // Each metric: which sheet column to read, and the exact token shape that
    // counts as a valid serial number for it. A cell can contain several
    // serials separated by a space, comma, slash, or line break — each
    // matching token is counted as its own entry.
    const METRICS = [
        {
            key: "inverters",
            column: "Micro Inverter SN",
            // "Y" + 15 alphanumeric characters, e.g. "Y0019A57121D00D2"
            pattern: /^Y[0-9A-Z]{15}$/i,
        },
        {
            key: "panels",
            column: "Solar Panel SN",
            // "Z" + 18 alphanumeric characters, e.g. "Z2026300G1210029683"
            pattern: /^Z[0-9A-Z]{18}$/i,
        },
    ];

    // Capacity totals derived from the counts above: each MX2250 micro
    // inverter is rated 2,250 W (2.25 kW) and each solar panel 650 W
    // (0.65 kWp). Shown with their unit (data-unit) after the number.
    const CAPACITIES = [
        { key: "inverter-capacity", from: "inverters", perUnit: 2.25 },
        { key: "solar-capacity", from: "panels", perUnit: 0.65 },
    ];

    // Install goals, by metric. Shown as a progress bar on the admin page.
    const GOALS = { inverters: 1000 };

    // Customer savings: about ₱49,600 a year per MX2250 kit (4 panels,
    // ~3,100 kWh a year at ₱16/kWh — the FAQ and savings calculator's figure).
    // An estimate that will change with electricity rates: update it here and
    // keep it in step with the FAQ and simulations/savings-calculator/savings.js.
    const SAVINGS_PER_MX2250_YEAR = 49600;
    const SAVINGS_YEARS = 25;
    const SAVINGS = [
        { key: "yearly-savings", from: "inverters", perUnit: SAVINGS_PER_MX2250_YEAR },
        { key: "lifetime-savings", from: "inverters", perUnit: SAVINGS_PER_MX2250_YEAR * SAVINGS_YEARS },
    ];

    const countEls = (key) => Array.from(document.querySelectorAll(`[data-portfolio-count="${key}"]`));
    const allCountEls = [...METRICS, ...CAPACITIES, ...SAVINGS].flatMap((m) => countEls(m.key));

    // Nothing to fill in on this page.
    if (!allCountEls.length) return;

    const statusDots = Array.from(document.querySelectorAll("[data-portfolio-status-dot]"));
    const statusTexts = Array.from(document.querySelectorAll("[data-portfolio-status-text]"));
    const errorMessages = Array.from(document.querySelectorAll("[data-portfolio-error]"));

    function showCapacity(el, value) {
        const number = value.toLocaleString(undefined, { maximumFractionDigits: 2 });
        el.innerHTML = `${number}<span class="portfolio-unit">${el.dataset.unit}</span>`;
        el.classList.remove("loading");
    }

    const goalEls = Array.from(document.querySelectorAll("[data-portfolio-goal]"));

    // "₱15.4M" style for large amounts, so the number fits its tile.
    function formatPesos(value) {
        if (value >= 1e6) {
            return `₱${(value / 1e6).toLocaleString(undefined, { maximumFractionDigits: value >= 1e8 ? 0 : 1 })}M`;
        }
        return `₱${Math.round(value).toLocaleString()}`;
    }

    function showGoal(el, count) {
        const goal = GOALS[el.dataset.portfolioGoal];
        if (!goal) return;
        const percent = Math.min(100, (count / goal) * 100);
        el.style.setProperty("--progress", `${percent}%`);
        el.setAttribute("aria-valuenow", String(Math.min(count, goal)));
        el.setAttribute("aria-valuemax", String(goal));
        el.querySelectorAll("[data-portfolio-goal-text]").forEach((t) => {
            t.textContent = `${count.toLocaleString()} of ${goal.toLocaleString()} · ${Math.floor(percent)}%`;
        });
        el.classList.toggle("reached", count >= goal);
    }

    let hasValues = false;

    function showCounts(counts) {
        METRICS.forEach((metric) => {
            countEls(metric.key).forEach((el) => {
                el.textContent = counts[metric.key].toLocaleString();
                el.classList.remove("loading");
            });
        });
        CAPACITIES.forEach((capacity) => {
            const value = counts[capacity.from] * capacity.perUnit;
            countEls(capacity.key).forEach((el) => showCapacity(el, value));
        });
        SAVINGS.forEach((saving) => {
            const value = counts[saving.from] * saving.perUnit;
            countEls(saving.key).forEach((el) => {
                el.textContent = formatPesos(value);
                el.title = `₱${value.toLocaleString()}`;
                el.classList.remove("loading");
            });
        });
        goalEls.forEach((el) => showGoal(el, counts[el.dataset.portfolioGoal] || 0));
        hasValues = true;
    }

    // localStorage can be unavailable (private mode, blocked storage).
    function readCache() {
        try {
            const cached = JSON.parse(localStorage.getItem(CACHE_KEY));
            return cached && METRICS.every((m) => Number.isFinite(cached.counts[m.key])) ? cached : null;
        } catch (err) {
            return null;
        }
    }

    function writeCache(counts) {
        try {
            localStorage.setItem(CACHE_KEY, JSON.stringify({ counts, savedAt: Date.now() }));
        } catch (err) {
            // Not critical: the next visit just waits for the sheet.
        }
    }

    function parsePortfolioCSV(text) {
        const rows = [];
        let row = [];
        let field = "";
        let inQuotes = false;

        for (let i = 0; i < text.length; i++) {
            const char = text[i];
            const next = text[i + 1];

            if (inQuotes) {
                if (char === '"' && next === '"') {
                    field += '"';
                    i++;
                } else if (char === '"') {
                    inQuotes = false;
                } else {
                    field += char;
                }
            } else {
                if (char === '"') {
                    inQuotes = true;
                } else if (char === ",") {
                    row.push(field);
                    field = "";
                } else if (char === "\n" || char === "\r") {
                    if (char === "\r" && next === "\n") i++;
                    row.push(field);
                    rows.push(row);
                    row = [];
                    field = "";
                } else {
                    field += char;
                }
            }
        }

        if (field.length > 0 || row.length > 0) {
            row.push(field);
            rows.push(row);
        }

        return rows.filter((r) => r.length > 1 || (r.length === 1 && r[0] !== ""));
    }

    function countPortfolioTokens(cellText, pattern) {
        if (!cellText) return 0;
        return cellText
            .split(/[^A-Za-z0-9]+/)
            .filter((token) => pattern.test(token))
            .length;
    }

    async function fetchRows(query) {
        const url = `${SHEET_CSV_URL}${query ? `&tq=${encodeURIComponent(query)}` : ""}&_=${Date.now()}`;
        const res = await fetch(url, { cache: "no-store" });
        if (!res.ok) throw new Error(`Sheet request failed (HTTP ${res.status})`);
        const rows = parsePortfolioCSV(await res.text());
        if (rows.length === 0) throw new Error("Sheet returned no data");
        return rows;
    }

    function columnIndexes(header) {
        return METRICS.map((metric) =>
            header.findIndex((h) => h.trim().toLowerCase() === metric.column.toLowerCase())
        );
    }

    // Firebase (loaded on first use). Resolves to null when the project isn't
    // set up yet (firebase-config.js still has YOUR_ placeholders). Uses its
    // own named app so it never clashes with the admin page's default app.
    let firebasePromise = null;

    function loadFirebase() {
        if (!firebasePromise) {
            firebasePromise = (async () => {
                const { firebaseConfig } = await import(new URL("firebase-config.js", SCRIPT_URL).href);
                if (!firebaseConfig || String(firebaseConfig.projectId || "").startsWith("YOUR_")) return null;
                const [appSdk, fs] = await Promise.all([
                    import(`${FIREBASE_BASE}/firebase-app.js`),
                    import(`${FIREBASE_BASE}/firebase-firestore.js`),
                ]);
                const app = appSdk.getApps().find((a) => a.name === "portfolio-counters")
                    || appSdk.initializeApp(firebaseConfig, "portfolio-counters");
                return { fs, db: fs.getFirestore(app) };
            })().catch((err) => {
                firebasePromise = null;
                throw err;
            });
        }
        return firebasePromise;
    }

    // Totals from the public `installCounts` collection; null while it's
    // empty (not imported yet), so the sheet is used instead.
    async function firebaseCounts() {
        const firebase = await loadFirebase();
        if (!firebase) return null;
        const { fs, db } = firebase;
        const totals = await fs.getAggregateFromServer(fs.collection(db, "installCounts"), {
            inverters: fs.sum("inverters"),
            panels: fs.sum("panels"),
            installs: fs.count(),
        });
        const { inverters, panels, installs } = totals.data();
        return installs > 0 ? { inverters: inverters || 0, panels: panels || 0 } : null;
    }

    async function sheetCounts() {
        let rows = await fetchRows(COLUMNS_QUERY);
        let indexes = columnIndexes(rows[0]);
        if (indexes.includes(-1)) {
            console.warn("Portfolio counters: serial-number columns moved; reading the whole sheet. Update COLUMNS_QUERY.");
            rows = await fetchRows("");
            indexes = columnIndexes(rows[0]);
        }

        const missing = METRICS.find((metric, i) => indexes[i] === -1);
        if (missing) throw new Error(`Column "${missing.column}" not found in sheet`);

        const dataRows = rows.slice(1);
        const counts = {};
        METRICS.forEach((metric, i) => {
            counts[metric.key] = dataRows.reduce(
                (total, r) => total + countPortfolioTokens(r[indexes[i]], metric.pattern),
                0
            );
        });
        return counts;
    }

    async function loadPortfolioCounts() {
        // Only the very first load (nothing cached) shows the dimmed state;
        // later refreshes swap the numbers in quietly.
        if (!hasValues) {
            allCountEls.forEach((el) => el.classList.add("loading"));
            statusTexts.forEach((t) => (t.textContent = "Loading…"));
        }

        try {
            let counts = null;
            try {
                counts = await firebaseCounts();
            } catch (err) {
                console.warn("Portfolio counters: Firebase count failed; reading the Google Sheet instead", err);
            }
            if (!counts) counts = await sheetCounts();

            showCounts(counts);
            writeCache(counts);

            statusDots.forEach((d) => d.classList.remove("error", "paused"));
            statusTexts.forEach((t) => (t.textContent = `Live — updated ${new Date().toLocaleTimeString()}`));
            errorMessages.forEach((e) => e.classList.remove("show"));
        } catch (err) {
            console.error("Portfolio counters: refresh failed", err);
            statusDots.forEach((d) => d.classList.add("error"));
            if (hasValues) {
                // Keep showing the last known numbers rather than "!".
                statusTexts.forEach((t) => (t.textContent = "Couldn't refresh — showing last known numbers"));
                return;
            }
            allCountEls.forEach((el) => {
                el.textContent = "!";
                el.classList.remove("loading");
            });
            statusTexts.forEach((t) => (t.textContent = "Failed to load"));
            errorMessages.forEach((e) => {
                e.textContent = err.message;
                e.classList.add("show");
            });
        }
    }

    // Returning visitors see the last counts immediately; the live refresh
    // then updates them.
    const cached = readCache();
    if (cached) {
        showCounts(cached.counts);
        statusTexts.forEach((t) => (t.textContent = "Updating…"));
    }

    let portfolioLiveTimer = null;

    function startPortfolioLive() {
        if (portfolioLiveTimer) return;
        loadPortfolioCounts();
        portfolioLiveTimer = setInterval(loadPortfolioCounts, LIVE_REFRESH_MS);
    }

    function stopPortfolioLive() {
        if (!portfolioLiveTimer) return;
        clearInterval(portfolioLiveTimer);
        portfolioLiveTimer = null;
        statusDots.forEach((d) => d.classList.add("paused"));
        statusTexts.forEach((t) => (t.textContent = "Paused — tab hidden"));
    }

    document.addEventListener("visibilitychange", () => {
        if (document.hidden) {
            stopPortfolioLive();
        } else {
            startPortfolioLive();
        }
    });

    startPortfolioLive();
})();
