// Live portfolio counters, shared by the Home and Portfolio pages.
//
// Counts Micro Inverter and Solar Panel serial numbers (and their total kW /
// kWp capacity) straight from the "HPH Renewable Master Database" Google
// Sheet — the same sheet the installation-report form writes to — and
// refreshes every few seconds while the tab is visible.
//
// Any element on the page can show a value by carrying one of these markers
// (desktop and mobile copies are all filled in):
//   data-portfolio-count="inverters"          Micro inverters installed
//   data-portfolio-count="panels"             Solar panels installed
//   data-portfolio-count="inverter-capacity"  Total inverter capacity (kW)
//   data-portfolio-count="solar-capacity"     Total solar capacity (kWp)
//   data-portfolio-status-dot / -status-text / -error   Live status line
// Capacity elements also need data-unit="kW" / "kWp" for the unit label.

(function () {
    const SHEET_ID = "1I7w59tsa54pBLcBUs2T55pb-8lvfLKzCe0in_eY41WY";
    const CSV_URL = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/gviz/tq?tqx=out:csv`;
    const LIVE_REFRESH_MS = 5000;

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

    const countEls = (key) => Array.from(document.querySelectorAll(`[data-portfolio-count="${key}"]`));
    const allCountEls = [...METRICS, ...CAPACITIES].flatMap((m) => countEls(m.key));

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

    async function loadPortfolioCounts() {
        allCountEls.forEach((el) => el.classList.add("loading"));
        statusDots.forEach((d) => d.classList.remove("error"));
        statusTexts.forEach((t) => (t.textContent = "Loading…"));
        errorMessages.forEach((e) => e.classList.remove("show"));

        try {
            const res = await fetch(`${CSV_URL}&_=${Date.now()}`, { cache: "no-store" });
            if (!res.ok) throw new Error(`Sheet request failed (HTTP ${res.status})`);

            const csvText = await res.text();
            const rows = parsePortfolioCSV(csvText);

            if (rows.length === 0) throw new Error("Sheet returned no data");

            const header = rows[0];
            const dataRows = rows.slice(1);
            const counts = {};

            METRICS.forEach((metric) => {
                const colIndex = header.findIndex(
                    (h) => h.trim().toLowerCase() === metric.column.toLowerCase()
                );

                if (colIndex === -1) {
                    throw new Error(`Column "${metric.column}" not found in sheet`);
                }

                const count = dataRows.reduce(
                    (total, r) => total + countPortfolioTokens(r[colIndex], metric.pattern),
                    0
                );

                counts[metric.key] = count;

                countEls(metric.key).forEach((el) => {
                    el.textContent = count.toLocaleString();
                    el.classList.remove("loading");
                });
            });

            CAPACITIES.forEach((capacity) => {
                const value = counts[capacity.from] * capacity.perUnit;
                countEls(capacity.key).forEach((el) => showCapacity(el, value));
            });

            statusDots.forEach((d) => d.classList.remove("paused"));
            statusTexts.forEach((t) => (t.textContent = `Live — updated ${new Date().toLocaleTimeString()}`));
        } catch (err) {
            allCountEls.forEach((el) => {
                el.textContent = "!";
                el.classList.remove("loading");
            });
            statusDots.forEach((d) => d.classList.add("error"));
            statusTexts.forEach((t) => (t.textContent = "Failed to load"));
            errorMessages.forEach((e) => {
                e.textContent = err.message;
                e.classList.add("show");
            });
        }
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
