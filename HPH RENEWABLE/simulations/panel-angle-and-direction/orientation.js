// "Panel angle and direction" simulation.
//
// Estimates a year's output for a 4-panel (2.6 kWp) system from the
// direction the panels face (compass bearing) and their tilt, at a few
// Philippine latitudes. Sun positions are calculated for a mid-month day,
// every 15 minutes. Sunlight uses a simple clear-sky model (direct beam
// plus diffuse sky plus ground reflection), with each month scaled by
// typical cloudiness and the year scaled to ~1,700 kWh/m² of sunlight on
// flat ground. Illustrative only (see the page footnote).

(function () {
    const SYSTEM_KWP = 2.6;
    const PERFORMANCE = 0.8;          // wiring, heat, inverter and dust losses
    const HORIZONTAL_KWH_M2 = 1700;   // typical yearly sunlight on flat ground
    const ALBEDO = 0.2;
    const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
    const MID_DAY = [17, 47, 75, 105, 135, 162, 198, 228, 258, 288, 318, 344];
    const DAYS = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
    // Relative sunshine by month: sunnier dry season, cloudier rainy season.
    const CLOUD = [1.0, 1.05, 1.1, 1.1, 1.0, 0.86, 0.8, 0.78, 0.84, 0.9, 0.92, 0.95];
    const STEP_H = 0.25;

    const rad = (d) => (d * Math.PI) / 180;
    const deg = (r) => (r * 180) / Math.PI;
    const $ = (sel) => document.querySelector(sel);
    const setOut = (key, text) => document.querySelectorAll(`[data-out="${key}"]`).forEach((el) => { el.textContent = text; });

    const dirInput = $("#ori-direction");
    const tiltInput = $("#ori-tilt");
    const placeInput = $("#ori-place");
    if (!dirInput) return;

    const state = { az: Number(dirInput.value), tilt: Number(tiltInput.value), lat: Number(placeInput.value) };

    // ----------------------------------------------------------- sun model

    // Sun direction as an east/north/up unit vector.
    function sunVector(lat, day, hour) {
        const decl = rad(23.44 * Math.sin((2 * Math.PI * (284 + day)) / 365));
        const h = rad(15 * (hour - 12));
        const phi = rad(lat);
        return {
            e: -Math.cos(decl) * Math.sin(h),
            n: Math.cos(phi) * Math.sin(decl) - Math.sin(phi) * Math.cos(decl) * Math.cos(h),
            u: Math.sin(phi) * Math.sin(decl) + Math.cos(phi) * Math.cos(decl) * Math.cos(h),
        };
    }

    // Per location: every daylight sample's sun vector and irradiance.
    const cache = new Map();
    function samplesFor(lat) {
        if (cache.has(lat)) return cache.get(lat);
        const months = MID_DAY.map((day, m) => {
            const list = [];
            for (let hour = 5; hour <= 19; hour += STEP_H) {
                const s = sunVector(lat, day, hour);
                if (s.u <= 0.01) continue;
                const elev = deg(Math.asin(s.u));
                const airMass = 1 / (s.u + 0.50572 * Math.pow(6.07995 + elev, -1.6364));
                const dni = 1353 * Math.pow(0.7, Math.pow(airMass, 0.678));
                const dhi = 0.1 * dni;
                list.push({ s, dni, dhi, ghi: dni * s.u + dhi });
            }
            return list;
        });
        const entry = { months, scale: 1 };
        // Scale so flat ground gets HORIZONTAL_KWH_M2 a year.
        const flat = monthlySunlight(entry, 0, 180).reduce((a, b) => a + b, 0);
        entry.scale = HORIZONTAL_KWH_M2 / flat;
        cache.set(lat, entry);
        return entry;
    }

    // kWh/m² reaching the panel each month, for a tilt and compass bearing.
    function monthlySunlight(entry, tilt, az) {
        const b = rad(tilt), g = rad(az);
        const nE = Math.sin(b) * Math.sin(g), nN = Math.sin(b) * Math.cos(g), nU = Math.cos(b);
        const skyView = (1 + Math.cos(b)) / 2, groundView = (1 - Math.cos(b)) / 2;
        return entry.months.map((list, m) => {
            let wh = 0;
            for (const { s, dni, dhi, ghi } of list) {
                const cosI = s.e * nE + s.n * nN + s.u * nU;
                wh += (dni * Math.max(0, cosI) + dhi * skyView + ghi * ALBEDO * groundView) * STEP_H;
            }
            return (wh / 1000) * DAYS[m] * CLOUD[m] * entry.scale;
        });
    }

    const toOutput = (sunlight) => sunlight.map((kwhM2) => kwhM2 * SYSTEM_KWP * PERFORMANCE);
    const sum = (list) => list.reduce((a, b) => a + b, 0);

    const bestCache = new Map();
    function best(lat) {
        if (bestCache.has(lat)) return bestCache.get(lat);
        const entry = samplesFor(lat);
        let top = { total: -1 };
        for (let tilt = 0; tilt <= 60; tilt += 1) {
            for (let az = 0; az < 360; az += 5) {
                const monthly = toOutput(monthlySunlight(entry, tilt, az));
                const total = sum(monthly);
                if (total > top.total) top = { tilt, az, monthly, total };
                if (tilt === 0) break; // direction doesn't matter when flat
            }
        }
        bestCache.set(lat, top);
        return top;
    }

    // -------------------------------------------------------------- labels

    const POINTS = ["North", "North-east", "East", "South-east", "South", "South-west", "West", "North-west"];
    const directionName = (az) => POINTS[Math.round(((az % 360) + 360) % 360 / 45) % 8];
    const kwh = (v) => Math.round(v).toLocaleString();

    // ------------------------------------------------------------ compass

    const compass = $(".ori-compass");
    const ticks = compass.querySelector(".ori-ticks");
    const SVGNS = "http://www.w3.org/2000/svg";
    const svg = (tag, attrs, parent) => {
        const node = document.createElementNS(SVGNS, tag);
        Object.entries(attrs || {}).forEach(([k, v]) => node.setAttribute(k, v));
        if (parent) parent.appendChild(node);
        return node;
    };
    for (let a = 0; a < 360; a += 15) {
        if (a % 90 === 0) continue; // N/E/S/W letters sit there
        const long = a % 45 === 0;
        const r1 = 150, r2 = long ? 136 : 143;
        svg("line", {
            x1: 160 + r1 * Math.sin(rad(a)), y1: 160 - r1 * Math.cos(rad(a)),
            x2: 160 + r2 * Math.sin(rad(a)), y2: 160 - r2 * Math.cos(rad(a)),
            class: long ? "ori-tick ori-tick-long" : "ori-tick",
        }, ticks);
    }

    // Sun's path across the sky (seen from above) in June and December.
    function drawSunPaths() {
        const group = compass.querySelector(".ori-sunpaths");
        group.replaceChildren();
        [[172, "Jun"], [355, "Dec"]].forEach(([day, label]) => {
            const pts = [];
            for (let hour = 5; hour <= 19; hour += 0.25) {
                const s = sunVector(state.lat, day, hour);
                if (s.u <= 0) continue;
                const elev = deg(Math.asin(s.u));
                const az = Math.atan2(s.e, s.n);
                const r = 112 * (1 - elev / 90);
                pts.push([160 + r * Math.sin(az), 160 - r * Math.cos(az)]);
            }
            svg("polyline", { points: pts.map((p) => p.map((v) => v.toFixed(1)).join(",")).join(" "), class: "ori-sunpath" }, group);
            // Label at the morning (east) end of the path, clear of the panel.
            const start = pts[0];
            svg("circle", { cx: start[0], cy: start[1], r: 5, class: "ori-sunpath-sun" }, group);
            const t = svg("text", { x: start[0] - 8, y: start[1] + (label === "Jun" ? -10 : 18), class: "ori-sunpath-label", "text-anchor": "end" }, group);
            t.textContent = `${label} sun`;
        });
    }

    function setDirection(az) {
        state.az = ((Math.round(az) % 360) + 360) % 360;
        dirInput.value = state.az;
        update();
    }

    let dragging = false;
    function angleFromEvent(e) {
        const r = compass.getBoundingClientRect();
        const x = e.clientX - (r.left + r.width / 2), y = e.clientY - (r.top + r.height / 2);
        return deg(Math.atan2(x, -y));
    }
    compass.addEventListener("pointerdown", (e) => {
        dragging = true;
        compass.setPointerCapture(e.pointerId);
        setDirection(angleFromEvent(e));
    });
    compass.addEventListener("pointermove", (e) => { if (dragging) setDirection(angleFromEvent(e)); });
    compass.addEventListener("pointerup", () => { dragging = false; });
    compass.addEventListener("pointercancel", () => { dragging = false; });
    compass.addEventListener("keydown", (e) => {
        const step = e.shiftKey ? 15 : 5;
        if (e.key === "ArrowRight" || e.key === "ArrowUp") { e.preventDefault(); setDirection(state.az + step); }
        if (e.key === "ArrowLeft" || e.key === "ArrowDown") { e.preventDefault(); setDirection(state.az - step); }
    });

    // ------------------------------------------------------------ tilt view

    const tiltSvg = $(".ori-tilt");
    function drawTilt() {
        const t = rad(state.tilt);
        const ox = 60, oy = 250, L = 210;
        const ex = ox + L * Math.cos(t), ey = oy - L * Math.sin(t);
        const set = (sel, attrs) => Object.entries(attrs).forEach(([k, v]) => tiltSvg.querySelector(sel).setAttribute(k, v));
        set(".ori-roof", { x1: ox, y1: oy, x2: ex, y2: ey });
        // Panel sits just above the roof line, along its middle.
        const off = 7;
        const px1 = ox + 50 * Math.cos(t) - off * Math.sin(t), py1 = oy - 50 * Math.sin(t) - off * Math.cos(t);
        const px2 = ox + 190 * Math.cos(t) - off * Math.sin(t), py2 = oy - 190 * Math.sin(t) - off * Math.cos(t);
        set(".ori-side-glass", { x1: px1, y1: py1, x2: px2, y2: py2 });
        set(".ori-side-frame", { x1: px1, y1: py1, x2: px2, y2: py2 });
        // Angle arc and label.
        const ar = 46;
        set(".ori-angle-arc", { d: `M${ox + ar} ${oy} A${ar} ${ar} 0 0 0 ${ox + ar * Math.cos(t)} ${oy - ar * Math.sin(t)}` });
        const label = tiltSvg.querySelector(".ori-tag-text");
        label.textContent = `${state.tilt}°`;
        const lx = ox + 70 * Math.cos(t / 2), ly = oy - 70 * Math.sin(t / 2) + 4;
        label.setAttribute("x", lx); label.setAttribute("y", ly);
        const box = label.getBBox();
        set(".ori-tag-bg", { x: box.x - 7, y: box.y - 3, width: box.width + 14, height: box.height + 6, rx: (box.height + 6) / 2 });
        // Midday sun around the equinoxes: 90° − latitude above the horizon,
        // on the side the panel faces (drawn on the left).
        const elev = rad(90 - state.lat);
        const cx = (px1 + px2) / 2, cy = (py1 + py2) / 2;
        const sx = cx - 150 * Math.cos(elev), sy = Math.max(30, cy - 190 * Math.sin(elev));
        tiltSvg.querySelector(".ori-sun").setAttribute("transform", `translate(${sx} ${sy})`);
        set(".ori-ray", { x1: sx, y1: sy, x2: cx, y2: cy });
    }

    // ---------------------------------------------------------------- chart

    const chart = $(".ori-chart");
    const tooltip = $(".ori-tooltip");
    const tableBody = $(".ori-table tbody");
    const C = { w: 720, h: 270, left: 48, right: 8, top: 26, bottom: 30 };

    function drawChart(mine, top) {
        chart.replaceChildren();
        const maxVal = Math.max(...mine, ...top.monthly);
        const yMax = Math.ceil(maxVal / 50) * 50;
        const plotW = C.w - C.left - C.right, plotH = C.h - C.top - C.bottom;
        const y = (v) => C.top + plotH - (v / yMax) * plotH;
        const band = plotW / 12, barW = Math.min(30, band * 0.52);

        for (let i = 0; i <= 4; i++) {
            const v = (yMax / 4) * i;
            svg("line", { x1: C.left, x2: C.w - C.right, y1: y(v), y2: y(v), class: i === 0 ? "ori-axis" : "ori-grid" }, chart);
            const t = svg("text", { x: C.left - 8, y: y(v) + 4, class: "ori-axis-label", "text-anchor": "end" }, chart);
            t.textContent = Math.round(v);
        }
        const unit = svg("text", { x: C.left - 8, y: C.top - 14, class: "ori-axis-label", "text-anchor": "end" }, chart);
        unit.textContent = "kWh";

        MONTHS.forEach((name, i) => {
            const cx = C.left + band * i + band / 2;
            const v = mine[i], b = top.monthly[i];
            // Bar with a 4px rounded top, anchored to the baseline.
            const x0 = cx - barW / 2, yTop = y(v), yBase = y(0), r = Math.min(4, (yBase - yTop) / 2);
            svg("path", { d: `M${x0} ${yBase}V${yTop + r}Q${x0} ${yTop} ${x0 + r} ${yTop}H${x0 + barW - r}Q${x0 + barW} ${yTop} ${x0 + barW} ${yTop + r}V${yBase}Z`, class: "ori-bar" }, chart);
            svg("line", { x1: cx - barW / 2 - 5, x2: cx + barW / 2 + 5, y1: y(b), y2: y(b), class: "ori-best-ring" }, chart);
            svg("line", { x1: cx - barW / 2 - 5, x2: cx + barW / 2 + 5, y1: y(b), y2: y(b), class: "ori-best-tick" }, chart);
            const label = svg("text", { x: cx, y: C.h - 10, class: "ori-axis-label", "text-anchor": "middle" }, chart);
            label.textContent = name;

            const hit = svg("rect", { x: C.left + band * i, y: C.top, width: band, height: plotH, class: "ori-hit" }, chart);
            hit.addEventListener("pointerenter", () => showTip(i, cx, Math.min(yTop, y(b)), v, b));
            hit.addEventListener("pointerleave", hideTip);
        });

        tableBody.replaceChildren(...MONTHS.map((name, i) => {
            const row = document.createElement("tr");
            [name, kwh(mine[i]), kwh(top.monthly[i])].forEach((text, c) => {
                const cell = document.createElement(c === 0 ? "th" : "td");
                if (c === 0) cell.scope = "row";
                cell.textContent = text;
                row.appendChild(cell);
            });
            return row;
        }));
    }

    function showTip(i, cx, cy, v, b) {
        tooltip.replaceChildren();
        const title = document.createElement("strong");
        title.textContent = MONTHS[i];
        const a = document.createElement("span");
        a.textContent = `Your panels: ${kwh(v)} kWh`;
        const c = document.createElement("span");
        c.textContent = `Best possible: ${kwh(b)} kWh`;
        tooltip.append(title, a, c);
        tooltip.hidden = false;
        const rect = chart.getBoundingClientRect();
        const scale = rect.width / C.w;
        tooltip.style.left = `${cx * scale}px`;
        tooltip.style.top = `${cy * scale}px`;
    }
    function hideTip() { tooltip.hidden = true; }

    // -------------------------------------------------------------- update

    function update() {
        const entry = samplesFor(state.lat);
        const top = best(state.lat);
        const mine = toOutput(monthlySunlight(entry, state.tilt, state.az));
        const total = sum(mine);
        const pct = Math.round((total / top.total) * 100);

        compass.querySelector(".ori-panel").setAttribute("transform", `rotate(${state.az - 180} 160 160)`);
        compass.setAttribute("aria-valuenow", state.az);
        compass.setAttribute("aria-valuetext", `${directionName(state.az)}, ${state.az} degrees`);
        drawTilt();
        drawChart(mine, top);

        setOut("direction-label", `${directionName(state.az)} (${state.az}°)`);
        setOut("tilt-label", `${state.tilt}°`);
        setOut("yearly", kwh(total));
        setOut("percent", pct);
        setOut("place", placeInput.selectedOptions[0].dataset.name);
        setOut("best", top.tilt === 0 ? "Flat (0°)" : `${directionName(top.az)}, ${top.tilt}° tilt`);

        let verdict;
        if (pct >= 97) verdict = "Excellent: within a few percent of the best for this location.";
        else if (pct >= 90) verdict = `Very good: only ${100 - pct}% below the best setup here.`;
        else if (pct >= 80) verdict = `Good: still a solid choice, about ${100 - pct}% below the best.`;
        else verdict = `This setup misses a lot of sunlight (${100 - pct}% below the best). Facing more south or a lower tilt would help.`;
        setOut("verdict", verdict);

        document.querySelectorAll("[data-direction]").forEach((b) => b.classList.toggle("is-active", Number(b.dataset.direction) === state.az));
        document.querySelectorAll("[data-tilt]").forEach((b) => b.classList.toggle("is-active", Number(b.dataset.tilt) === state.tilt));
    }

    dirInput.addEventListener("input", () => setDirection(Number(dirInput.value)));
    tiltInput.addEventListener("input", () => { state.tilt = Number(tiltInput.value); update(); });
    placeInput.addEventListener("change", () => { state.lat = Number(placeInput.value); drawSunPaths(); update(); });
    document.querySelectorAll("[data-direction]").forEach((b) => b.addEventListener("click", () => setDirection(Number(b.dataset.direction))));
    document.querySelectorAll("[data-tilt]").forEach((b) => b.addEventListener("click", () => {
        state.tilt = Number(b.dataset.tilt);
        tiltInput.value = state.tilt;
        update();
    }));
    $(".ori-best-button").addEventListener("click", () => {
        const top = best(state.lat);
        state.tilt = top.tilt;
        tiltInput.value = top.tilt;
        setDirection(top.az);
    });

    drawSunPaths();
    update();
})();
