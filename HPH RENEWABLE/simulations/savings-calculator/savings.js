// Savings calculator.
//
// Estimates savings from a monthly Meralco bill, using the same figures as
// the FAQ: ₱16/kWh by default, and each MX2250 kit (micro inverter + 4
// panels, 2.6 kWp, from ₱120,000) making about 3,100 kWh a year (≈₱49,600).
// Only solar the home actually uses counts: directly in the daytime, or
// stored in a battery for the evening. Extra power earns nothing (no net
// metering, as the FAQ recommends). Estimates only (see the page footnote).

(function () {
    const KIT_KWH_YEAR = 3100;
    const KIT_PRICE = 120000;
    const KIT_PANELS = 4, KIT_KWP = 2.6;
    const KIT_WATTS = 2250;           // MX2250 rated output
    const MAX_KITS = 30;              // room for the largest battery setups
    // Battery storage (keep prices in sync with the product pages, the FAQ
    // and the waitlist's data-price values): 1-5 MAU5000 Elite head units,
    // each with up to 4 B5000 Elite stackable batteries under it (25.1 kWh
    // per full stack).
    const HEAD_KWH = 5.024, HEAD_PRICE = 150000, MAX_HEADS = 5;
    const EXT_KWH = (25.1 - HEAD_KWH) / 4, EXT_PRICE = 100000, EXT_PER_HEAD = 4;
    function batterySetup(on, heads, exts) {
        if (!on) return { kwh: 0, price: 0, items: [] };
        const items = [`${heads} × MAU5000 Elite head unit (5 kWh each)`];
        if (exts) items.push(`${exts} × B5000 Elite stackable battery (+5 kWh each)`);
        return { kwh: heads * HEAD_KWH + exts * EXT_KWH, price: heads * HEAD_PRICE + exts * EXT_PRICE, items };
    }
    const kwhText = (v) => String(Math.round(v * 10) / 10);
    const BATTERY_EFFICIENCY = 0.9;
    const DEGRADATION = 0.005;        // panels lose 0.5% a year
    const YEARS = 25;

    const $ = (sel) => document.querySelector(sel);
    const setOut = (key, text) => document.querySelectorAll(`[data-out="${key}"]`).forEach((el) => { el.textContent = text; });
    const peso = (v) => Math.round(v).toLocaleString("en-PH");

    const billRange = $("#calc-bill");
    const billNumber = $("#calc-bill-number");
    const rateInput = $("#calc-rate");
    if (!billRange) return;

    const state = { bill: 6000, rate: 16, dayShare: 0.45, batteryOn: false, heads: 1, exts: 0, battery: 0, kits: null }; // kits null = recommended; battery = kWh

    // ------------------------------------------------------------- model

    function monthly(kits, s) {
        const usage = s.bill / s.rate;                        // kWh a month
        const solar = kits * KIT_KWH_YEAR / 12;
        const dayUse = usage * s.dayShare;
        const eveningUse = usage - dayUse;
        const direct = Math.min(solar, dayUse);
        const excess = solar - direct;
        const batteryMonth = s.battery * 30 * BATTERY_EFFICIENCY; // max a full cycle a day
        const shifted = Math.min(excess * BATTERY_EFFICIENCY, eveningUse, batteryMonth);
        const used = direct + shifted;
        return { usage, solar, used, savings: used * s.rate, unused: excess - shifted / BATTERY_EFFICIENCY };
    }

    // Enough kits to cover what the home can use: daytime use plus what the
    // battery can carry into the evening. Stops adding kits once one more
    // would mostly go unused.
    function recommendedKits(s) {
        let best = 1;
        for (let k = 1; k <= MAX_KITS; k++) {
            const gain = monthly(k, s).used - monthly(k - 1, s).used;
            if (gain >= 0.6 * (KIT_KWH_YEAR / 12)) best = k; else break;
        }
        return best;
    }

    function calculate() {
        const recommended = recommendedKits(state);
        const kits = state.kits === null ? recommended : state.kits;
        const m = monthly(kits, state);
        const cost = kits * KIT_PRICE + batterySetup(state.batteryOn, state.heads, state.exts).price;
        const yearly = m.savings * 12;
        const years = [];
        let total = -cost;
        for (let y = 1; y <= YEARS; y++) {
            const saving = yearly * Math.pow(1 - DEGRADATION, y - 1);
            total += saving;
            years.push({ year: y, saving, total });
        }
        const payback = yearly > 0 ? cost / yearly : Infinity;
        return { kits, recommended, m, cost, yearly, years, payback, lifetime: years[YEARS - 1].total + cost };
    }

    // "Recommend a setup": try no battery and every battery combination
    // (1-5 head units, 0-4 B5000 Elite each), size the solar for each with
    // recommendedKits(), and keep the one with the most savings over 25 years
    // after its cost. Ties go to the cheaper setup.
    const LIFETIME_FACTOR = Array.from({ length: YEARS }, (_, y) => Math.pow(1 - DEGRADATION, y)).reduce((a, b) => a + b, 0);
    function bestSetup(s) {
        const options = [{ on: false, heads: 1, exts: 0 }];
        for (let h = 1; h <= MAX_HEADS; h++) for (let e = 0; e <= h * EXT_PER_HEAD; e++) options.push({ on: true, heads: h, exts: e });
        let best = null;
        options.forEach((o) => {
            const setup = batterySetup(o.on, o.heads, o.exts);
            const trial = { ...s, battery: setup.kwh };
            const kits = recommendedKits(trial);
            const cost = kits * KIT_PRICE + setup.price;
            const net = monthly(kits, trial).savings * 12 * LIFETIME_FACTOR - cost;
            if (!best || net > best.net + 1 || (Math.abs(net - best.net) <= 1 && cost < best.cost)) best = { ...o, kits, cost, net };
        });
        return best;
    }
    // Snapshot of the inputs a recommendation was made for; the note shows only while they still match.
    let recommendedFor = null;
    const inputsKey = () => JSON.stringify([state.bill, state.rate, state.dayShare, state.batteryOn, state.heads, state.exts, state.kits]);

    // ------------------------------------------------------------- chart

    const chart = $(".calc-chart");
    const tooltip = $(".ori-tooltip");
    const tableBody = $(".ori-table tbody");
    const SVGNS = "http://www.w3.org/2000/svg";
    const svg = (tag, attrs, parent) => {
        const node = document.createElementNS(SVGNS, tag);
        Object.entries(attrs || {}).forEach(([k, v]) => node.setAttribute(k, v));
        if (parent) parent.appendChild(node);
        return node;
    };
    const C = { w: 720, h: 280, left: 70, right: 16, top: 20, bottom: 30 };
    const short = (v) => {
        const a = Math.abs(v);
        const str = a >= 1e6 ? `${(a / 1e6).toFixed(a >= 1e7 ? 0 : 1)}M` : a >= 1e3 ? `${Math.round(a / 1e3)}k` : `${Math.round(a)}`;
        return `${v < 0 ? "−" : ""}₱${str}`;
    };

    function niceStep(range) {
        const raw = range / 5;
        const mag = Math.pow(10, Math.floor(Math.log10(raw)));
        return [1, 2, 2.5, 5, 10].map((f) => f * mag).find((s) => s >= raw);
    }

    function drawChart(r) {
        chart.replaceChildren();
        const pts = [{ year: 0, total: -r.cost }, ...r.years];
        const minV = Math.min(0, ...pts.map((p) => p.total));
        const maxV = Math.max(0, ...pts.map((p) => p.total));
        const step = niceStep(maxV - minV || 1);
        const lo = Math.floor(minV / step) * step, hi = Math.ceil(maxV / step) * step;
        const plotW = C.w - C.left - C.right, plotH = C.h - C.top - C.bottom;
        const x = (yr) => C.left + (yr / YEARS) * plotW;
        const y = (v) => C.top + plotH - ((v - lo) / (hi - lo)) * plotH;

        for (let v = lo; v <= hi + 1; v += step) {
            svg("line", { x1: C.left, x2: C.w - C.right, y1: y(v), y2: y(v), class: Math.abs(v) < 1 ? "ori-axis" : "ori-grid" }, chart);
            const t = svg("text", { x: C.left - 8, y: y(v) + 4, class: "ori-axis-label", "text-anchor": "end" }, chart);
            t.textContent = short(v);
        }
        [0, 5, 10, 15, 20, 25].forEach((yr) => {
            const t = svg("text", { x: x(yr), y: C.h - 8, class: "ori-axis-label", "text-anchor": "middle" }, chart);
            t.textContent = yr === 0 ? "Today" : `Year ${yr}`;
        });

        // Area under the line, then the line itself.
        const line = pts.map((p, i) => `${i ? "L" : "M"}${x(p.year).toFixed(1)} ${y(p.total).toFixed(1)}`).join("");
        svg("path", { d: `${line}L${x(YEARS)} ${y(0)}L${x(0)} ${y(0)}Z`, class: "calc-area" }, chart);
        svg("path", { d: line, class: "calc-line" }, chart);

        // Payback marker where the line crosses zero.
        if (r.payback <= YEARS) {
            const px = x(r.payback), py = y(0);
            svg("circle", { cx: px, cy: py, r: 6, class: "calc-payback-dot" }, chart);
            // Below the zero line, clear of the rising line.
            const label = svg("text", { x: px + 12, y: py + 22, class: "calc-payback-label" }, chart);
            label.textContent = `Paid off in ${formatYears(r.payback)}`;
        }

        // Hover: crosshair + tooltip at the nearest year.
        const cross = svg("line", { y1: C.top, y2: C.top + plotH, class: "calc-cross" }, chart);
        const dot = svg("circle", { r: 5, class: "calc-hover-dot" }, chart);
        cross.style.display = dot.style.display = "none";
        const hit = svg("rect", { x: C.left, y: C.top, width: plotW, height: plotH, class: "ori-hit" }, chart);
        const move = (e) => {
            const rect = chart.getBoundingClientRect();
            const sx = ((e.clientX - rect.left) / rect.width) * C.w;
            const yr = Math.max(0, Math.min(YEARS, Math.round(((sx - C.left) / plotW) * YEARS)));
            const p = pts[yr];
            cross.setAttribute("x1", x(yr)); cross.setAttribute("x2", x(yr));
            dot.setAttribute("cx", x(yr)); dot.setAttribute("cy", y(p.total));
            cross.style.display = dot.style.display = "";
            tooltip.replaceChildren();
            const title = document.createElement("strong");
            title.textContent = yr === 0 ? "Today" : `Year ${yr}`;
            const a = document.createElement("span");
            a.textContent = `${p.total < 0 ? "Still to recover" : "Ahead by"}: ₱${peso(Math.abs(p.total))}`;
            tooltip.append(title, a);
            if (yr > 0) {
                const b = document.createElement("span");
                b.textContent = `Saved that year: ₱${peso(p.saving)}`;
                tooltip.append(b);
            }
            tooltip.hidden = false;
            const scale = rect.width / C.w;
            tooltip.style.left = `${x(yr) * scale}px`;
            tooltip.style.top = `${y(p.total) * scale}px`;
        };
        hit.addEventListener("pointermove", move);
        hit.addEventListener("pointerenter", move);
        hit.addEventListener("pointerleave", () => { tooltip.hidden = true; cross.style.display = dot.style.display = "none"; });

        tableBody.replaceChildren(...r.years.map((p) => {
            const row = document.createElement("tr");
            [`Year ${p.year}`, `₱${peso(p.saving)}`, `${p.total < 0 ? "−" : ""}₱${peso(Math.abs(p.total))}`].forEach((text, c) => {
                const cell = document.createElement(c === 0 ? "th" : "td");
                if (c === 0) cell.scope = "row";
                cell.textContent = text;
                row.appendChild(cell);
            });
            return row;
        }));
    }

    function formatYears(y) {
        if (!isFinite(y)) return "more than 25 years";
        if (y < 1) return `${Math.max(1, Math.round(y * 12))} months`;
        return `${y.toFixed(1)} years`;
    }

    // ------------------------------------------------------------ render

    function render() {
        const r = calculate();
        const billAfter = Math.max(0, state.bill - r.m.savings);

        setOut("monthly-savings", peso(r.m.savings));
        setOut("bill-before", peso(state.bill));
        setOut("bill-after", peso(billAfter));
        if (isFinite(r.payback) && r.payback <= 99) {
            setOut("payback", r.payback < 1 ? Math.max(1, Math.round(r.payback * 12)) : r.payback.toFixed(1));
            setOut("payback-unit", r.payback < 1 ? "months" : "years");
        } else {
            setOut("payback", "—");
            setOut("payback-unit", "");
        }
        setOut("yearly-savings", peso(r.yearly));
        setOut("lifetime-savings", peso(r.lifetime));
        setOut("offset", Math.round((r.m.savings / state.bill) * 100));
        setOut("cost", peso(r.cost));

        setOut("kits-watts", (r.kits * KIT_WATTS).toLocaleString("en-PH"));
        setOut("kits-detail", `${r.kits} × MX2250 · ${r.kits * KIT_PANELS} panels · ${(r.kits * KIT_KWP).toFixed(1)} kWp`);
        const isRec = r.kits === r.recommended;
        setOut("kits-note", isRec ? "Recommended for your bill." : `We'd recommend ${r.recommended} for your bill.`);
        document.querySelectorAll("[data-out-hide-when-recommended]").forEach((el) => { el.hidden = isRec; });
        document.querySelector('[data-kits-step="-1"]').disabled = r.kits <= 1;
        document.querySelector('[data-kits-step="1"]').disabled = r.kits >= MAX_KITS;

        const setup = batterySetup(state.batteryOn, state.heads, state.exts);
        const maxExts = state.heads * EXT_PER_HEAD;
        $("[data-battery-size]").hidden = !state.batteryOn;
        setOut("battery-heads", state.heads);
        setOut("battery-exts", state.exts);
        setOut("battery-exts-detail", `B5000 Elite stackable batteries · up to ${maxExts}`);
        setOut("battery-kwh", kwhText(setup.kwh));
        document.querySelector('[data-battery-step="heads:-1"]').disabled = state.heads <= 1;
        document.querySelector('[data-battery-step="heads:1"]').disabled = state.heads >= MAX_HEADS;
        document.querySelector('[data-battery-step="exts:-1"]').disabled = state.exts <= 0;
        document.querySelector('[data-battery-step="exts:1"]').disabled = state.exts >= maxExts;
        setOut("battery-help", state.batteryOn
            ? `Stores extra daytime solar for the evening (up to ${kwhText(setup.kwh)} kWh a day). Each MAU5000 Elite takes up to 4 B5000 Elite batteries under it. Stacking batteries is the cheapest way to add storage; extra head units add their own inverter, so more appliances can run at once.`
            : "Solar only: your home uses solar power as it's made.");

        const note = $('[data-out="recommend-note"]');
        note.hidden = recommendedFor !== inputsKey();
        if (!note.hidden) {
            const what = state.batteryOn
                ? `${r.kits} × MX2250 with ${kwhText(batterySetup(true, state.heads, state.exts).kwh)} kWh of battery`
                : `${r.kits} × MX2250, no battery`;
            note.textContent = `Recommended: ${what}. This setup saves the most over 25 years, after its cost, for your bill and usage.`;
        }

        const list = $('[data-out-list="system"]');
        const items = [`${r.kits} × MX2250 micro inverter kit (${r.kits * KIT_PANELS} panels)`, ...setup.items];
        list.replaceChildren(...items.map((text) => { const li = document.createElement("li"); li.textContent = text; return li; }));

        document.querySelectorAll("[data-day-share]").forEach((b) => b.setAttribute("aria-checked", String(Number(b.dataset.dayShare) === state.dayShare)));
        document.querySelectorAll("[data-battery-mode]").forEach((b) => b.setAttribute("aria-checked", String((b.dataset.batteryMode === "battery") === state.batteryOn)));

        drawChart(r);
    }

    // ---------------------------------------------------------- controls

    const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

    billRange.addEventListener("input", () => {
        state.bill = Number(billRange.value);
        billNumber.value = state.bill;
        state.kits = null;
        render();
    });
    billNumber.addEventListener("input", () => {
        const v = Number(billNumber.value);
        if (!v || v < 500) return; // wait for a sensible amount while typing
        state.bill = clamp(v, 500, 100000);
        billRange.value = clamp(state.bill, 1000, 30000);
        state.kits = null;
        render();
    });
    billNumber.addEventListener("change", () => { billNumber.value = state.bill; });
    rateInput.addEventListener("input", () => {
        const v = Number(rateInput.value);
        if (!v || v < 5) return;
        state.rate = clamp(v, 5, 30);
        state.kits = null;
        render();
    });
    rateInput.addEventListener("change", () => { rateInput.value = state.rate; });

    document.querySelectorAll("[data-day-share]").forEach((b) => b.addEventListener("click", () => {
        state.dayShare = Number(b.dataset.dayShare);
        state.kits = null;
        render();
    }));
    function setBattery(on, heads, exts) {
        state.batteryOn = on;
        state.heads = clamp(heads, 1, MAX_HEADS);
        // Fewer head units can hold fewer batteries.
        state.exts = clamp(exts, 0, state.heads * EXT_PER_HEAD);
        state.battery = batterySetup(on, state.heads, state.exts).kwh;
        state.kits = null;
        render();
    }
    document.querySelectorAll("[data-battery-mode]").forEach((b) => b.addEventListener("click", () => {
        setBattery(b.dataset.batteryMode === "battery", state.heads, state.exts);
    }));
    document.querySelectorAll("[data-battery-step]").forEach((b) => b.addEventListener("click", () => {
        const [which, step] = b.dataset.batteryStep.split(":");
        if (which === "heads") setBattery(true, state.heads + Number(step), state.exts);
        else setBattery(true, state.heads, state.exts + Number(step));
    }));
    $("[data-recommend]").addEventListener("click", () => {
        const best = bestSetup(state);
        state.batteryOn = best.on;
        state.heads = best.heads;
        state.exts = best.exts;
        state.battery = batterySetup(best.on, best.heads, best.exts).kwh;
        state.kits = null; // bestSetup() used the recommended kits for this battery
        recommendedFor = inputsKey();
        render();
    });
    document.querySelectorAll("[data-kits-step]").forEach((b) => b.addEventListener("click", () => {
        const current = calculate().kits;
        state.kits = clamp(current + Number(b.dataset.kitsStep), 1, MAX_KITS);
        render();
    }));
    document.querySelector("[data-out-hide-when-recommended]").addEventListener("click", () => {
        state.kits = null;
        render();
    });

    render();
})();
