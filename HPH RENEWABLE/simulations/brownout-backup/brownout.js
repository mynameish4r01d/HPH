// "Brownout backup simulator".
//
// How long an MSU4000 Elite or MAU5000 Elite (plus extension batteries) keeps
// a home running through a brownout, with optional solar panels recharging it
// in daytime. Backup limits and switch time are from the TSUN data sheets in
// product-data-sheets/: 2,500 W off-grid output (MSU4000 Elite), 6,000 W
// (MAU5000 Elite, Pro version, which is what we sell), switch time ≤10 ms.
// Illustrative only (see the page footnote).

(function () {
    const SYSTEMS = {
        msu: { name: "MSU4000 Elite", battery: "B4000 Elite", baseKwh: 4, addKwh: 4, maxW: 2500 },
        mau: { name: "MAU5000 Elite", battery: "B5000 Elite", baseKwh: 5.024, addKwh: 5.024, maxW: 6000 },
    };
    const MAX_EXTRA = 4;
    const USABLE = 0.9;      // 10% kept in reserve to protect the battery
    const EFF = 0.95;        // battery <-> appliances, each way
    const RESTART = 0.2;     // after running out, restarts at 20% usable charge
    const STEP_H = 5 / 60;   // model resolution: 5 minutes
    const PANEL_KW = 0.65;
    // Peak output per kWp on an average day: 3,100 kWh a year per 2.6 kWp kit,
    // spread over a sine-shaped 6 AM-6 PM day (24/π equivalent full-sun hours).
    const PEAK_PER_KWP = 3100 / 2.6 / 365 / (24 / Math.PI);
    const WEATHER = { sunny: 1.35, cloudy: 0.6, storm: 0.2 };
    const PLAY_SECONDS = 10;

    const APPLIANCES = [
        { id: "lights", name: "LED bulbs", icon: "lightbulb", watts: 10, qty: 6, max: 20 },
        { id: "fans", name: "Electric fans", icon: "mode_fan", watts: 55, qty: 2, max: 6 },
        { id: "router", name: "Wi-Fi router", icon: "router", watts: 15, qty: 1, max: 2 },
        { id: "chargers", name: "Phone and laptop chargers", icon: "devices", watts: 45, qty: 2, max: 6 },
        { id: "fridge", name: "Refrigerator", icon: "kitchen", watts: 70, qty: 1, max: 2 },
        { id: "tv", name: "TV", icon: "tv", watts: 100, qty: 1, max: 3 },
        { id: "pc", name: "Desktop computer", icon: "desktop_windows", watts: 150, qty: 0, max: 3 },
        { id: "aircon", name: "Aircon (1 HP inverter)", icon: "ac_unit", watts: 750, qty: 0, max: 3 },
    ];

    const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const SVGNS = "http://www.w3.org/2000/svg";
    const svg = (tag, attrs, parent) => {
        const node = document.createElementNS(SVGNS, tag);
        Object.entries(attrs || {}).forEach(([k, v]) => node.setAttribute(k, v));
        if (parent) parent.appendChild(node);
        return node;
    };
    const $ = (sel) => document.querySelector(sel);
    const setOut = (key, text) => document.querySelectorAll(`[data-out="${key}"]`).forEach((el) => { el.textContent = text; });
    const num = (n, digits = 0) => n.toLocaleString(undefined, { minimumFractionDigits: digits, maximumFractionDigits: digits });
    const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

    const state = {
        system: "msu",
        extra: 0,
        panels: 0,
        weather: "sunny",
        start: 18,
        hours: 4,
        qty: Object.fromEntries(APPLIANCES.map((a) => [a.id, a.qty])),
        t: 0,          // playhead, hours into the brownout
        playing: false,
    };

    // --------------------------------------------------------------- model

    const totalLoad = (s) => APPLIANCES.reduce((sum, a) => sum + a.watts * s.qty[a.id], 0);
    const capacityKwh = (s) => SYSTEMS[s.system].baseKwh + SYSTEMS[s.system].addKwh * s.extra;
    const daylight = (hour) => Math.max(0, Math.sin((Math.PI * (hour - 6)) / 12));
    const solarWatts = (s, hour) => s.panels * PANEL_KW * 1000 * PEAK_PER_KWP * WEATHER[s.weather] * daylight(hour % 24);

    function simulate(s) {
        const sys = SYSTEMS[s.system];
        const capWh = capacityKwh(s) * 1000 * USABLE;
        const load = totalLoad(s);
        const overload = load > sys.maxW;
        const steps = Math.round(s.hours / STEP_H);
        let e = capWh;
        let on = !overload;
        const soc = [1], power = [], sun = [];
        let solarUsedWh = 0, firstOut = null, onSteps = 0;

        for (let k = 0; k < steps; k++) {
            const w = solarWatts(s, s.start + (k + 0.5) * STEP_H);
            const room = capWh - e;
            if (!overload && !on && (w >= load || e >= capWh * RESTART)) on = true;
            if (on) {
                const net = load - w;
                if (net <= 0) {
                    const charge = Math.min(room, -net * EFF * STEP_H);
                    e += charge;
                    solarUsedWh += load * STEP_H + charge / EFF;
                } else if (e >= (net / EFF) * STEP_H) {
                    e -= (net / EFF) * STEP_H;
                    solarUsedWh += w * STEP_H;
                } else {
                    e = 0;
                    on = false;
                }
            }
            if (!on) {
                // Home disconnected: any sun goes into the battery.
                const charge = Math.min(capWh - e, w * EFF * STEP_H);
                e += charge;
                solarUsedWh += charge / EFF;
                if (firstOut === null) firstOut = k * STEP_H;
            } else onSteps++;
            soc.push(e / capWh);
            power.push(on);
            sun.push(w);
        }
        return {
            load, overload, steps, soc, power, sun, firstOut,
            onHours: onSteps * STEP_H,
            covered: onSteps === steps,
            solarUsedKwh: solarUsedWh / 1000,
        };
    }

    // Fewest extra extension batteries that cover the whole brownout, if any.
    function batteriesNeeded(s) {
        for (let n = s.extra + 1; n <= MAX_EXTRA; n++) {
            if (simulate({ ...s, extra: n }).covered) return n;
        }
        return null;
    }

    // ------------------------------------------------------------- formats

    function clock(hour, withDay) {
        const h = ((hour % 24) + 24) % 24;
        let hh = Math.floor(h), mm = Math.round((h - hh) * 60);
        if (mm === 60) { hh = (hh + 1) % 24; mm = 0; }
        const text = `${hh % 12 || 12}:${String(mm).padStart(2, "0")} ${hh < 12 ? "AM" : "PM"}`;
        const day = Math.floor(hour / 24);
        return withDay && day > 0 ? `${text}, day ${day + 1}` : text;
    }
    const shortClock = (hour) => {
        const h = ((Math.round(hour) % 24) + 24) % 24;
        return `${h % 12 || 12} ${h < 12 ? "AM" : "PM"}`;
    };
    function duration(hours) {
        const total = Math.round(hours * 60);
        const h = Math.floor(total / 60), m = total % 60;
        if (!h) return `${m} min`;
        return m ? `${h} h ${m} min` : `${h} h`;
    }
    const hoursLabel = (h) => `${h} hour${h === 1 ? "" : "s"}`;

    // --------------------------------------------------------------- scene

    const root = $(".bk-scene-root");
    const scene = {};
    const GROUND = 300;
    (function buildScene() {
        svg("rect", { x: -100, y: -100, width: 960, height: 560, fill: "url(#bk-sky)" }, root);
        scene.night = svg("rect", { x: -100, y: -100, width: 960, height: 560, fill: "url(#bk-night)" }, root);
        scene.stars = svg("g", { class: "bk-stars" }, root);
        // Fixed pseudo-random stars so they don't jump between renders.
        for (let i = 0; i < 40; i++) {
            const x = 10 + ((i * 197) % 740), y = 12 + ((i * 89) % 170);
            svg("circle", { cx: x, cy: y, r: i % 5 === 0 ? 1.4 : 0.9 }, scene.stars);
        }
        scene.sun = svg("circle", { r: 16, class: "sim-sun-disc", filter: "url(#bk-glow)" }, root);
        scene.moon = svg("circle", { r: 11, class: "bk-moon" }, root);

        svg("rect", { x: -100, y: GROUND, width: 960, height: 260, fill: "url(#bk-ground)" }, root);
        svg("rect", { x: -100, y: GROUND - 0.5, width: 960, height: 1, class: "sim-horizon" }, root);

        // Utility pole and its dead line to the house
        const pole = svg("g", { class: "bk-pole" }, root);
        svg("rect", { x: 66, y: 108, width: 8, height: GROUND - 108 }, pole);
        svg("rect", { x: 40, y: 122, width: 60, height: 6, rx: 2 }, pole);
        svg("circle", { cx: 46, cy: 119, r: 3.5 }, pole);
        svg("circle", { cx: 94, cy: 119, r: 3.5 }, pole);
        svg("path", { d: "M94 119Q176 182 262 210", class: "bk-wire-dead" }, root);
        const gridTag = svg("g", { class: "sim-tag sim-tag-warn", transform: "translate(96 92)" }, root);
        svg("text", {}, gridTag).textContent = "Grid down";

        // House
        const house = svg("g", { class: "bk-house" }, root);
        svg("rect", { x: 262, y: 196, width: 236, height: GROUND - 196, class: "bk-wall" }, house);
        svg("path", { d: "M246 202L302 128H458L514 202Z", class: "bk-roof" }, house);
        scene.windows = [[282, 214], [422, 214]].map(([x, y]) => {
            svg("rect", { x, y, width: 56, height: 42, rx: 2, class: "bk-window" }, house);
            const glow = svg("rect", { x, y, width: 56, height: 42, rx: 2, fill: "url(#bk-window-light)", class: "bk-window-glow" }, house);
            svg("path", { d: `M${x + 28} ${y}v42M${x} ${y + 21}h56`, class: "bk-window-bars" }, house);
            return glow;
        });
        svg("rect", { x: 362, y: 236, width: 36, height: GROUND - 236, rx: 2, class: "bk-door" }, house);
        scene.doorGlow = svg("rect", { x: 362, y: 236, width: 36, height: 4, class: "bk-door-glow" }, house);
        scene.panels = svg("g", { class: "bk-panels" }, root);

        // Flows (drawn under the battery so they tuck in behind it)
        scene.flowsG = svg("g", {}, root);
        scene.battery = svg("g", { class: "bk-battery" }, root);
        scene.meter = svg("g", {}, root);
        svg("rect", { x: 664, y: 160, width: 10, height: 140, rx: 5, class: "bk-meter-bg" }, scene.meter);
        scene.meterFill = svg("rect", { x: 664, width: 10, rx: 5, class: "bk-meter-level" }, scene.meter);
        scene.socTag = svg("g", { class: "sim-tag", transform: "translate(669 146)" }, root);
        svg("text", {}, scene.socTag);

        scene.icons = svg("g", { class: "bk-icons" }, root);
        scene.status = svg("g", { class: "sim-tag bk-status", transform: "translate(380 30)" }, root);
        svg("text", {}, scene.status);
        scene.switchTag = svg("g", { class: "sim-tag bk-switch-tag", transform: "translate(380 64)" }, root);
        svg("text", {}, scene.switchTag).textContent = "Switched to battery in under 10 ms";
        const homeTag = svg("g", { class: "sim-tag", transform: "translate(120 336)" }, root);
        svg("text", {}, homeTag).textContent = "Running now";
    })();

    const flows = [];
    function addFlow(d, key) {
        svg("path", { d, class: "sim-flow-base" }, scene.flowsG);
        const path = svg("path", { d, class: `sim-flow bk-flow-${key}`, filter: "url(#bk-glow)" }, scene.flowsG);
        flows.push({ path, key, offset: 0 });
    }

    // Parts that change with the setup (battery stack, panels, icons, flows).
    function buildSetup() {
        const sys = SYSTEMS[state.system];
        scene.battery.replaceChildren();
        // Extension batteries stack under the head unit, as installed.
        const x = 578, w = 70;
        for (let j = 0; j < state.extra; j++) {
            const y = GROUND - (j + 1) * 30 + 3;
            svg("rect", { x, y, width: w, height: 27, rx: 5, class: "bk-pack" }, scene.battery);
        }
        const unitY = GROUND - state.extra * 30 - 46;
        svg("rect", { x, y: unitY, width: w, height: 46, rx: 6, class: "bk-unit" }, scene.battery);
        scene.led = svg("path", { d: `M${x + 14} ${unitY + 12}h${w - 28}`, class: "bk-unit-led" }, scene.battery);
        const name = svg("text", { x: x + w / 2, y: unitY + 32, class: "bk-unit-name" }, scene.battery);
        name.textContent = sys.name.split(" ")[0];
        const stackTop = unitY;

        scene.panels.replaceChildren();
        for (let i = 0; i < state.panels; i++) {
            const row = state.panels === 8 && i < 4 ? 0 : 1;
            const px = 314 + (i % 4) * 34, py = row ? 168 : 140;
            svg("rect", { x: px, y: py, width: 30, height: 24, rx: 2, fill: "url(#bk-panel-face)", class: "bk-panel" }, scene.panels);
            svg("path", { d: `M${px + 15} ${py}v24M${px} ${py + 12}h30`, class: "sim-panel-lines" }, scene.panels);
        }

        scene.flowsG.replaceChildren();
        flows.length = 0;
        // Power to the home leaves from the head unit, wherever it sits.
        addFlow(state.extra
            ? `M${x} ${unitY + 26}H540V${GROUND - 20}H498`
            : `M${x} ${GROUND - 20}H498`, "home");
        if (state.panels) addFlow(`M450 ${state.panels === 8 ? 152 : 180}H613V${stackTop}`, "solar");

        scene.icons.replaceChildren();
        const active = APPLIANCES.filter((a) => state.qty[a.id] > 0);
        // Icon-font ligatures don't centre reliably with text-anchor, so each
        // 28-unit glyph is placed by its left edge.
        const gap = 40, x0 = 380 - ((active.length - 1) * gap) / 2 - 14;
        scene.iconNodes = active.map((a, i) => {
            const t = svg("text", { x: x0 + i * gap, y: 346, class: "bk-icon" }, scene.icons);
            t.textContent = a.icon;
            return t;
        });
    }

    function sizeTag(tag) {
        const text = tag.querySelector("text");
        let bg = tag.querySelector(".sim-tag-bg");
        if (!bg) bg = tag.insertBefore(svg("rect", { class: "sim-tag-bg" }), text);
        const box = text.getBBox();
        bg.style.display = box.width ? "" : "none";
        if (!box.width) return;
        bg.setAttribute("x", (box.x - 6).toFixed(1));
        bg.setAttribute("y", (box.y - 3).toFixed(1));
        bg.setAttribute("width", (box.width + 12).toFixed(1));
        bg.setAttribute("height", (box.height + 6).toFixed(1));
        bg.setAttribute("rx", ((box.height + 6) / 2).toFixed(1));
    }
    const sizeAllTags = () => document.querySelectorAll(".bk-scene .sim-tag").forEach(sizeTag);

    // Where the playhead is: step index, charge, power and sun at that moment.
    function momentAt(r, t) {
        const k = Math.min(r.steps - 1, Math.floor(t / STEP_H + 1e-6));
        const f = clamp(t / STEP_H - k, 0, 1);
        const soc = r.soc[k] + (r.soc[k + 1] - r.soc[k]) * f;
        return { k, soc, on: r.power[k], sun: r.sun[k] };
    }

    function renderScene() {
        const r = result;
        const m = momentAt(r, state.t);
        const hour = state.start + state.t;
        const night = 1 - clamp(daylight(hour % 24) * 4 + 0.15, 0, 1);

        scene.night.style.opacity = night.toFixed(3);
        scene.stars.style.opacity = (night * 0.9).toFixed(3);
        const h = ((hour % 24) + 24) % 24;
        const arc = (x) => ({ x: 40 + ((x - 6) / 12) * 680, y: 270 - Math.sin((Math.PI * (x - 6)) / 12) * 230 });
        const s = arc(h), mo = arc((h + 12) % 24);
        scene.sun.setAttribute("cx", s.x.toFixed(1));
        scene.sun.setAttribute("cy", s.y.toFixed(1));
        scene.sun.style.display = h > 6 && h < 18 ? "" : "none";
        scene.moon.setAttribute("cx", mo.x.toFixed(1));
        scene.moon.setAttribute("cy", mo.y.toFixed(1));
        scene.moon.style.display = h < 6 || h > 18 ? "" : "none";

        const glow = m.on ? 0.25 + 0.7 * night : 0;
        scene.windows.forEach((g) => { g.style.opacity = glow.toFixed(3); });
        scene.doorGlow.style.opacity = glow.toFixed(3);

        const level = clamp(m.soc, 0, 1);
        scene.meterFill.setAttribute("height", (140 * level).toFixed(1));
        scene.meterFill.setAttribute("y", (160 + 140 * (1 - level)).toFixed(1));
        scene.meterFill.classList.toggle("bk-meter-low", level < 0.2);
        scene.socTag.querySelector("text").textContent = `${Math.round(level * 100)}%`;
        scene.led.classList.toggle("bk-unit-led-on", m.on);
        scene.iconNodes.forEach((n) => n.classList.toggle("bk-icon-off", !m.on));

        let status;
        if (r.overload) status = "Overloaded: too much at once";
        else if (!m.on) status = "No power";
        else if (m.sun >= r.load) status = level >= 0.999 ? "Running on solar" : "Solar running home + charging";
        else if (m.sun > 1) status = "Solar + battery";
        else status = "Running on battery";
        scene.status.querySelector("text").textContent = status;
        scene.status.classList.toggle("sim-tag-warn", r.overload || !m.on);
        scene.switchTag.style.display = !r.overload && m.on && state.t < 0.5 ? "" : "none";

        scene.flowState = {
            home: m.on ? r.load : 0,
            solar: m.sun > 1 && (level < 0.999 || m.sun > r.load) ? m.sun : 0,
        };
        sizeAllTags();

        setOut("clock", clock(hour, true));
        setOut("elapsed", state.t < 1e-6 ? "Start of brownout" : `${duration(state.t)} into the brownout`);
        const scrub = $(".bk-scrub");
        scrub.value = state.t;
        scrub.setAttribute("aria-valuetext", `${clock(hour, true)}, ${duration(state.t)} into the brownout. ${status}.`);
        renderPlayhead(m);
    }

    // ---------------------------------------------------------- animation

    function moveFlows(dt) {
        if (!scene.flowState) return;
        flows.forEach((f) => {
            const w = scene.flowState[f.key] || 0;
            f.path.classList.toggle("sim-flow-on", w > 1);
            if (!reduceMotion && dt) {
                f.offset -= (12 + Math.min(1, w / 2500) * 50) * dt;
                f.path.style.strokeDashoffset = f.offset.toFixed(1);
            }
        });
    }

    const playBtn = $(".bk-play");
    function setPlaying(on) {
        state.playing = on;
        playBtn.querySelector(".material-symbols-rounded").textContent = on ? "pause" : "play_arrow";
        playBtn.setAttribute("aria-label", on ? "Pause" : "Play the brownout");
    }
    playBtn.addEventListener("click", () => {
        if (!state.playing && state.t >= state.hours - 1e-6) state.t = 0;
        setPlaying(!state.playing);
    });
    $(".bk-scrub").addEventListener("input", (e) => {
        setPlaying(false);
        state.t = Number(e.target.value);
        renderScene();
    });

    let last = performance.now();
    function frame(now) {
        const dt = Math.min(0.1, (now - last) / 1000);
        last = now;
        if (state.playing) {
            state.t = Math.min(state.hours, state.t + (state.hours / PLAY_SECONDS) * dt);
            if (state.t >= state.hours) setPlaying(false);
            renderScene();
        }
        moveFlows(dt);
        requestAnimationFrame(frame);
    }

    // --------------------------------------------------------------- chart

    const chart = $(".bk-chart");
    const tooltip = $(".bk-chart + .ori-tooltip");
    const CW = 720, CH = 260, M = { l: 46, r: 14, t: 14, b: 30 };
    const cx = (t) => M.l + (t / state.hours) * (CW - M.l - M.r);
    const cy = (soc) => M.t + (1 - soc) * (CH - M.t - M.b);
    const chartParts = {};

    function renderChart() {
        const r = result;
        chart.replaceChildren();
        const bottom = CH - M.b;

        // Daylight and no-power bands
        for (let k = 0; k < r.steps; ) {
            const day = daylight((state.start + (k + 0.5) * STEP_H) % 24) > 0;
            let j = k;
            while (j < r.steps && (daylight((state.start + (j + 0.5) * STEP_H) % 24) > 0) === day) j++;
            if (day) svg("rect", { x: cx(k * STEP_H), y: M.t, width: cx(j * STEP_H) - cx(k * STEP_H), height: bottom - M.t, class: "bk-day-band" }, chart);
            k = j;
        }
        for (let k = 0; k < r.steps; ) {
            if (r.power[k]) { k++; continue; }
            let j = k;
            while (j < r.steps && !r.power[j]) j++;
            svg("rect", { x: cx(k * STEP_H), y: M.t, width: Math.max(1, cx(j * STEP_H) - cx(k * STEP_H)), height: bottom - M.t, class: "bk-off-band" }, chart);
            k = j;
        }

        [0, 0.25, 0.5, 0.75, 1].forEach((v) => {
            svg("line", { x1: M.l, x2: CW - M.r, y1: cy(v), y2: cy(v), class: v ? "ori-grid" : "ori-axis" }, chart);
            const label = svg("text", { x: M.l - 8, y: cy(v) + 4, class: "ori-axis-label", "text-anchor": "end" }, chart);
            label.textContent = `${v * 100}%`;
        });
        const every = state.hours <= 6 ? 1 : state.hours <= 12 ? 2 : state.hours <= 24 ? 4 : 8;
        for (let h = 0; h <= state.hours; h += every) {
            svg("line", { x1: cx(h), x2: cx(h), y1: bottom, y2: bottom + 4, class: "ori-axis" }, chart);
            const label = svg("text", { x: cx(h), y: bottom + 18, class: "ori-axis-label", "text-anchor": h === 0 ? "start" : "middle" }, chart);
            label.textContent = shortClock(state.start + h);
        }

        const pts = r.soc.map((v, k) => `${cx(Math.min(state.hours, k * STEP_H)).toFixed(1)},${cy(v).toFixed(1)}`);
        svg("path", { d: `M${cx(0)},${bottom}L${pts.join("L")}L${cx(state.hours)},${bottom}Z`, class: "calc-area" }, chart);
        svg("path", { d: `M${pts.join("L")}`, class: "calc-line" }, chart);

        chartParts.cross = svg("line", { y1: M.t, y2: bottom, class: "calc-cross", visibility: "hidden" }, chart);
        chartParts.hoverDot = svg("circle", { r: 4.5, class: "calc-hover-dot", visibility: "hidden" }, chart);
        chartParts.playhead = svg("line", { y1: M.t, y2: bottom, class: "bk-playhead" }, chart);
        chartParts.playDot = svg("circle", { r: 5, class: "calc-payback-dot" }, chart);
        const hit = svg("rect", { x: M.l, y: M.t, width: CW - M.l - M.r, height: bottom - M.t, class: "ori-hit bk-chart-hit" }, chart);
        hit.addEventListener("pointermove", hover);
        hit.addEventListener("pointerleave", unhover);
        hit.addEventListener("click", (e) => {
            setPlaying(false);
            state.t = timeAt(e);
            renderScene();
        });

        renderTable(r);
    }

    function renderPlayhead(m) {
        if (!chartParts.playhead) return;
        const x = cx(state.t).toFixed(1);
        chartParts.playhead.setAttribute("x1", x);
        chartParts.playhead.setAttribute("x2", x);
        chartParts.playDot.setAttribute("cx", x);
        chartParts.playDot.setAttribute("cy", cy(m.soc).toFixed(1));
    }

    function timeAt(e) {
        const box = chart.getBoundingClientRect();
        const x = ((e.clientX - box.left) / box.width) * CW;
        return clamp(((x - M.l) / (CW - M.l - M.r)) * state.hours, 0, state.hours);
    }

    function hover(e) {
        const t = timeAt(e);
        const m = momentAt(result, t);
        const x = cx(t), y = cy(m.soc);
        chartParts.cross.setAttribute("x1", x);
        chartParts.cross.setAttribute("x2", x);
        chartParts.cross.setAttribute("visibility", "visible");
        chartParts.hoverDot.setAttribute("cx", x);
        chartParts.hoverDot.setAttribute("cy", y);
        chartParts.hoverDot.setAttribute("visibility", "visible");
        const lines = [
            [`${clock(state.start + t, true)}`, true],
            [`Battery ${Math.round(m.soc * 100)}%`],
            [result.overload ? "Overloaded, no power" : m.on ? `Home powered, using ${num(result.load)} W` : "No power"],
        ];
        if (state.panels) lines.push([`Solar ${num(m.sun)} W`]);
        tooltip.replaceChildren(...lines.map(([text, strong]) => {
            const el = document.createElement(strong ? "strong" : "span");
            el.textContent = text;
            return el;
        }));
        tooltip.hidden = false;
        const box = chart.getBoundingClientRect();
        tooltip.style.left = `${clamp((x / CW) * box.width, 70, box.width - 70)}px`;
        tooltip.style.top = `${(y / CH) * box.height}px`;
    }

    function unhover() {
        chartParts.cross.setAttribute("visibility", "hidden");
        chartParts.hoverDot.setAttribute("visibility", "hidden");
        tooltip.hidden = true;
    }

    function renderTable(r) {
        const rows = [];
        for (let h = 0; h <= state.hours; h++) {
            const m = momentAt(r, h);
            const tr = document.createElement("tr");
            [
                clock(state.start + h, true),
                `${Math.round(m.soc * 100)}%`,
                r.overload || !m.on ? "No power" : "Powered",
                state.panels ? `${num(m.sun)} W` : "None",
            ].forEach((text) => {
                const td = document.createElement("td");
                td.textContent = text;
                tr.appendChild(td);
            });
            rows.push(tr);
        }
        $(".ori-table tbody").replaceChildren(...rows);
    }

    // ------------------------------------------------------------- inputs

    const list = $(".bk-appliances");
    const applianceRows = APPLIANCES.map((a) => {
        const li = document.createElement("li");
        li.className = "bk-appliance";
        const icon = document.createElement("span");
        icon.className = "material-symbols-rounded bk-appliance-icon";
        icon.textContent = a.icon;
        const text = document.createElement("div");
        text.className = "bk-appliance-text";
        const name = document.createElement("span");
        name.className = "bk-appliance-name";
        name.textContent = a.name;
        const watts = document.createElement("span");
        watts.className = "bk-appliance-watts";
        watts.textContent = `${a.watts} W${a.max > 1 ? " each" : ""}`;
        text.append(name, watts);
        const stepper = document.createElement("div");
        stepper.className = "bk-stepper";
        const minus = document.createElement("button");
        const plus = document.createElement("button");
        const value = document.createElement("output");
        [[minus, "remove", `Fewer: ${a.name}`, -1], [plus, "add", `More: ${a.name}`, 1]].forEach(([b, glyph, label, d]) => {
            b.type = "button";
            b.className = "calc-step bk-step";
            b.setAttribute("aria-label", label);
            const g = document.createElement("span");
            g.className = "material-symbols-rounded";
            g.textContent = glyph;
            b.appendChild(g);
            b.addEventListener("click", () => {
                state.qty[a.id] = clamp(state.qty[a.id] + d, 0, a.max);
                update();
            });
        });
        stepper.append(minus, value, plus);
        li.append(icon, text, stepper);
        list.appendChild(li);
        return { a, li, minus, plus, value };
    });

    const startSelect = $("#bk-start");
    for (let h = 0; h < 24; h++) {
        const o = document.createElement("option");
        o.value = h;
        o.textContent = clock(h);
        startSelect.appendChild(o);
    }
    startSelect.addEventListener("change", () => { state.start = Number(startSelect.value); update(); });
    const hoursInput = $("#bk-hours");
    hoursInput.addEventListener("input", () => { state.hours = Number(hoursInput.value); update(); });

    function radioGroup(attr, key, parse) {
        document.querySelectorAll(`[data-${attr}]`).forEach((b) => {
            if (b.tagName !== "BUTTON") return;
            b.addEventListener("click", () => {
                state[key] = parse(b.dataset[attr]);
                update();
            });
        });
    }
    radioGroup("system", "system", String);
    radioGroup("panels", "panels", Number);
    radioGroup("weather", "weather", String);
    document.querySelectorAll("[data-extra-step]").forEach((b) => b.addEventListener("click", () => {
        state.extra = clamp(state.extra + Number(b.dataset.extraStep), 0, MAX_EXTRA);
        update();
    }));

    const PRESETS = {
        evening: { start: 18, hours: 4, weather: "sunny" },
        maintenance: { start: 8, hours: 9, weather: "sunny" },
        overnight: { start: 20, hours: 10, weather: "sunny" },
        typhoon: { start: 12, hours: 48, weather: "storm" },
    };
    document.querySelectorAll("[data-preset]").forEach((b) => b.addEventListener("click", () => {
        Object.assign(state, PRESETS[b.dataset.preset]);
        update();
    }));

    // -------------------------------------------------------------- render

    let result = simulate(state);

    function renderInputs() {
        const sys = SYSTEMS[state.system];
        const sync = (attr, value) => document.querySelectorAll(`button[data-${attr}]`).forEach((b) => b.setAttribute("aria-checked", String(b.dataset[attr] === String(value))));
        sync("system", state.system);
        sync("panels", state.panels);
        sync("weather", state.weather);
        // Weather only matters with solar panels.
        document.querySelectorAll("button[data-weather]").forEach((b) => { b.disabled = !state.panels; });
        $("[data-weather-field]").classList.toggle("bk-disabled", !state.panels);

        setOut("system-help", `${num(sys.baseKwh, 0)} kWh built in, up to ${num(sys.maxW)} W during a brownout. Expands with the ${sys.battery} only.`);
        setOut("extra", state.extra);
        setOut("extra-name", `× ${sys.battery}`);
        setOut("extra-detail", `${num(capacityKwh(state), 1)} kWh in total`);
        document.querySelector('[data-extra-step="-1"]').disabled = state.extra === 0;
        document.querySelector('[data-extra-step="1"]').disabled = state.extra === MAX_EXTRA;

        startSelect.value = state.start;
        hoursInput.value = state.hours;
        setOut("hours-label", hoursLabel(state.hours));

        applianceRows.forEach(({ a, li, minus, plus, value }) => {
            const n = state.qty[a.id];
            value.textContent = n;
            minus.disabled = n === 0;
            plus.disabled = n === a.max;
            li.classList.toggle("bk-appliance-off", n === 0);
        });
        const load = totalLoad(state);
        setOut("load-total", `${num(load)} W`);
        setOut("load-max", `${num(sys.maxW)} W`);
        const fill = $(".bk-meter-fill");
        fill.style.width = `${clamp((load / sys.maxW) * 100, 0, 100)}%`;
        fill.classList.toggle("bk-meter-high", load > sys.maxW * 0.8 && load <= sys.maxW);
        fill.classList.toggle("bk-meter-over", load > sys.maxW);

        document.querySelectorAll("[data-preset]").forEach((b) => {
            const p = PRESETS[b.dataset.preset];
            b.classList.toggle("is-active", p.start === state.start && p.hours === state.hours && p.weather === state.weather);
        });
    }

    function renderResults() {
        const r = result;
        const sys = SYSTEMS[state.system];
        const total = state.hours;
        let label, value, sub;
        if (r.overload) {
            label = "Backup can't start";
            value = "Overloaded";
            sub = `Your appliances need ${num(r.load)} W, more than the ${sys.name}'s ${num(sys.maxW)} W backup limit. Turn something off.`;
        } else if (r.load === 0) {
            label = "Your home stays powered for";
            value = `${duration(total)}`;
            sub = "Pick some appliances to see how long the battery lasts.";
        } else if (r.covered) {
            label = "Your home stays powered for";
            value = `All ${duration(total)}`;
            sub = `The whole brownout is covered, with ${Math.round(r.soc[r.steps] * 100)}% battery left at the end.`;
        } else {
            label = "Your home stays powered for";
            value = `${duration(r.onHours)}`;
            const outAt = clock(state.start + r.firstOut, true);
            const back = r.power.slice(Math.round(r.firstOut / STEP_H)).indexOf(true);
            sub = `of the ${duration(total)} brownout. The battery runs out at ${outAt}`
                + (back > 0 ? `, and solar brings the power back at ${clock(state.start + r.firstOut + back * STEP_H, true)}.` : ".");
        }
        setOut("hero-label", label);
        setOut("hero-value", value);
        setOut("hero-sub", sub);
        $(".bk-hero").classList.toggle("bk-hero-warn", r.overload || (!r.covered && r.load > 0));

        setOut("load", num(r.load));
        setOut("capacity", num(capacityKwh(state), 1));
        setOut("solar", state.panels ? num(r.solarUsedKwh, 1) : "0");

        let advice = "";
        if (r.overload) {
            advice = state.system === "msu" && r.load <= SYSTEMS.mau.maxW
                ? `The MAU5000 Elite can run up to ${num(SYSTEMS.mau.maxW)} W, enough for this setup.`
                : "Big loads like aircon use the most power. Try running fewer at once.";
        } else if (!r.covered && r.load > 0) {
            const need = batteriesNeeded(state);
            const add = need === null ? 0 : need - state.extra;
            if (need !== null) advice = `Add ${add} ${state.extra ? "more " : ""}${sys.battery}${add > 1 ? "s" : ""}${state.extra ? ` (${need} in total)` : ""} to cover the whole brownout.`;
            else if (!state.panels) advice = "Even with four extension batteries this brownout is too long. Add solar panels to recharge during the day, or keep fewer appliances running.";
            else advice = "Keep fewer appliances running, or add more batteries and panels, to cover the whole brownout.";
        }
        const adviceEl = $(".bk-advice");
        adviceEl.textContent = advice;
        adviceEl.hidden = !advice;
    }

    function update() {
        setPlaying(false);
        state.t = Math.min(state.t, state.hours);
        $(".bk-scrub").max = state.hours;
        result = simulate(state);
        buildSetup();
        renderInputs();
        renderResults();
        renderChart();
        renderScene();
    }

    update();
    if (document.fonts && document.fonts.ready) document.fonts.ready.then(sizeAllTags);
    window.matchMedia("(max-width: 750px)").addEventListener("change", sizeAllTags);
    requestAnimationFrame(frame);
})();
