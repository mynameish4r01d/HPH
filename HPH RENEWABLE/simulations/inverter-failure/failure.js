// "Micro inverter vs string inverter: when something fails".
//
// The same 8 panels (650 W each, full sun) on two systems:
//   micro  - 2 × MX2250, each with 4 independent inputs (panels 1-4, 5-8)
//   string - one inverter, all 8 panels in a single series string
// Panel faults apply to both: dirty (−30%) or broken cable/connector (0 W,
// and an open circuit for a series string). Inverters fail separately.
// Illustrative only (see the page footnote).

(function () {
    const PANEL_WATTS = 650;
    const PANELS = 8;
    const STATES = ["ok", "dirty", "broken"];
    const FACTOR = { ok: 1, dirty: 0.7, broken: 0 };
    const STATE_TAG = { ok: "", dirty: "Dirty", broken: "Broken" };
    const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const SVGNS = "http://www.w3.org/2000/svg";
    const svg = (tag, attrs, parent) => {
        const node = document.createElementNS(SVGNS, tag);
        Object.entries(attrs || {}).forEach(([k, v]) => node.setAttribute(k, v));
        if (parent) parent.appendChild(node);
        return node;
    };
    const setOut = (key, text) => document.querySelectorAll(`[data-out="${key}"]`).forEach((el) => { el.textContent = text; });
    const watts = (w) => Math.round(w).toLocaleString();

    const state = {
        panels: Array(PANELS).fill("ok"),
        microFailed: [false, false],
        stringFailed: false,
    };

    // --------------------------------------------------------------- model

    function microResult() {
        const perPanel = state.panels.map((s, i) => (state.microFailed[i < 4 ? 0 : 1] ? 0 : PANEL_WATTS * FACTOR[s]));
        return { perPanel, total: perPanel.reduce((a, b) => a + b, 0), inverterOut: [0, 1].map((k) => perPanel.slice(k * 4, k * 4 + 4).reduce((a, b) => a + b, 0)) };
    }

    function stringResult() {
        const avail = state.panels.map((s) => PANEL_WATTS * FACTOR[s]);
        // A failed inverter or a broken cable anywhere in the series string stops it all.
        if (state.stringFailed || state.panels.includes("broken")) {
            return { perPanel: avail.map(() => 0), total: 0, bypassed: avail.map(() => false), open: !state.stringFailed };
        }
        // Series panels share one current: the weakest panel drags every panel down to its level.
        const level = Math.min(...avail);
        return { perPanel: avail.map(() => level), total: level * PANELS, bypassed: avail.map(() => false), heldBack: avail.map((w) => w > level + 0.5), open: false };
    }

    // --------------------------------------------------------------- scenes

    // Panels fill as much of the 480-wide scene as 8 in a row allows.
    const W = 54, H = 120, TOP = 14, STEP = 58, LEFT = 8;
    const BUS_Y = 170, INV_TOP = 206, INV_H = 30, AC_Y = 256;
    const cx = (i) => LEFT + i * STEP + W / 2;

    const scenes = {};
    ["micro", "string"].forEach((system) => {
        const root = document.querySelector(`[data-system="${system}"] .fail-scene`);
        const panelsG = root.querySelector(".fail-panels");
        const wiringG = root.querySelector(".fail-wiring");
        const invG = root.querySelector(".fail-inverters");
        const p = system;
        const flows = [];
        const addFlow = (d, key) => {
            svg("path", { d, class: "sim-flow-base" }, wiringG);
            const path = svg("path", { d, class: "sim-flow", filter: `url(#${p}-glow)` }, wiringG);
            flows.push({ path, key, offset: 0 });
        };

        // Panels
        const panels = [];
        for (let i = 0; i < PANELS; i++) {
            const x = LEFT + i * STEP;
            const g = svg("g", { class: "sim-panel-btn", tabindex: "0", role: "button" }, panelsG);
            svg("rect", { x, y: TOP, width: W, height: H, rx: 3, fill: `url(#${p}-panel-face)` }, g);
            const lines = [];
            for (let c = 1; c < 3; c++) lines.push(`M${x + (W * c) / 3} ${TOP}v${H}`);
            for (let r = 1; r < 6; r++) lines.push(`M${x} ${TOP + (H * r) / 6}h${W}`);
            svg("path", { d: lines.join(""), class: "sim-panel-lines" }, g);
            svg("rect", { x, y: TOP, width: W, height: H, rx: 3, fill: `url(#${p}-panel-sheen)` }, g);
            const dust = svg("rect", { x, y: TOP, width: W, height: H, rx: 3, fill: `url(#${p}-dust)`, class: "fail-dust" }, g);
            const dead = svg("rect", { x, y: TOP, width: W, height: H, rx: 3, class: "fail-dead" }, g);
            svg("rect", { x, y: TOP, width: W, height: H, rx: 3, class: "sim-panel-frame" }, g);
            svg("rect", { x: x - 4, y: TOP - 4, width: W + 8, height: H + 8, rx: 6, class: "sim-focus-ring" }, g);
            const num = svg("text", { x: x + W / 2, y: TOP + H + 16, class: "fail-panel-num" }, g);
            num.textContent = i + 1;
            const tag = svg("g", { class: "sim-tag fail-panel-tag", transform: `translate(${x + W / 2} ${TOP + H / 2 + 4})` }, g);
            svg("text", {}, tag);
            const wattTag = svg("g", { class: "sim-tag fail-watt-tag", transform: `translate(${x + W / 2} ${TOP + H - 10})` }, g);
            svg("text", {}, wattTag);
            g.addEventListener("click", () => cyclePanel(i));
            g.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); cyclePanel(i); } });
            panels.push({ g, dust, dead, tag, wattTag });
        }

        // Inverters + wiring
        const inverters = [];
        const addInverter = (x, width, label, onToggle) => {
            const g = svg("g", { class: "fail-inverter", tabindex: "0", role: "button" }, invG);
            svg("rect", { x, y: INV_TOP, width, height: INV_H, rx: 6, class: "sim-inverter-body" }, g);
            const led = svg("circle", { cx: x + width - 10, cy: INV_TOP + 9, r: 2.5, class: "sim-led" }, g);
            const t = svg("text", { x: x + width / 2, y: INV_TOP + 22, class: "fail-inverter-name" }, g);
            t.textContent = label;
            const tag = svg("g", { class: "sim-tag fail-inverter-tag", transform: `translate(${x + width / 2} ${INV_TOP - 8})` }, g);
            svg("text", {}, tag);
            g.addEventListener("click", onToggle);
            g.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onToggle(); } });
            inverters.push({ g, led, tag });
        };

        if (system === "micro") {
            [0, 1].forEach((k) => {
                // Each MX2250 sits centred under its 4 panels.
                const mid = LEFT + k * 4 * STEP + (3 * STEP + W) / 2;
                const boxX = mid - 40, inputs = [-27, -9, 9, 27].map((v) => mid + v);
                const levels = [BUS_Y + 12, BUS_Y, BUS_Y, BUS_Y + 12];
                for (let j = 0; j < 4; j++) {
                    const i = k * 4 + j;
                    addFlow(`M${cx(i)} ${TOP + H + 22}V${levels[j]}H${inputs[j]}V${INV_TOP}`, `panel${i}`);
                }
                addFlow(`M${boxX + 40} ${INV_TOP + INV_H}V${AC_Y}`, `inv${k}`);
                addInverter(boxX, 80, "MX2250", () => { state.microFailed[k] = !state.microFailed[k]; render(); });
            });
            addFlow(`M${LEFT + (3 * STEP + W) / 2} ${AC_Y}H450`, "ac");
        } else {
            // One series string: each panel is jumpered to the next under the
            // panels, and a single lead runs from the last panel to the inverter.
            const x = (i) => LEFT + i * STEP;
            for (let i = 0; i < PANELS - 1; i++) addFlow(`M${x(i) + W - 8} ${TOP + H}V${TOP + H + 8}H${x(i + 1) + 8}V${TOP + H}`, `jump${i}`);
            addFlow(`M${x(PANELS - 1) + W - 8} ${TOP + H}V${BUS_Y}H240V${INV_TOP}`, "string");
            addFlow(`M240 ${INV_TOP + INV_H}V${AC_Y}H450`, "ac");
            addInverter(180, 120, "String", () => { state.stringFailed = !state.stringFailed; render(); });
        }
        const home = svg("g", { class: "sim-tag", transform: `translate(400 ${AC_Y + 22})` }, root);
        svg("text", {}, home).textContent = "To your home";

        scenes[system] = { root, panels, inverters, flows };
    });

    // ---------------------------------------------------------------- tags

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
    const sizeAllTags = () => document.querySelectorAll(".fail-scene .sim-tag").forEach(sizeTag);

    // One <tspan> per word, centred on the tag's anchor, so labels like
    // "Held back" fit the narrow panels without running into the next one.
    function setWords(tag, label) {
        const words = label ? label.split(" ") : [];
        tag.querySelector("text").replaceChildren(...words.map((word, n) => {
            const span = svg("tspan", { x: 0, dy: n ? "1.15em" : `${-0.575 * (words.length - 1)}em` });
            span.textContent = word;
            return span;
        }));
    }

    // -------------------------------------------------------------- render

    let results = { micro: microResult(), string: stringResult() };

    function monitorMicro(r) {
        const lines = [];
        [0, 1].forEach((k) => {
            if (state.microFailed[k]) lines.push({ level: "bad", text: `MX2250 #${k + 1} offline: panels ${k * 4 + 1}–${k * 4 + 4} not reporting.` });
        });
        state.panels.forEach((s, i) => {
            if (state.microFailed[i < 4 ? 0 : 1]) return;
            if (s === "broken") lines.push({ level: "bad", text: `Panel ${i + 1}: no output. Check its cable or connector.` });
            if (s === "dirty") lines.push({ level: "warn", text: `Panel ${i + 1}: ${watts(r.perPanel[i])} W, ${watts(PANEL_WATTS - r.perPanel[i])} W below the others. Probably needs cleaning.` });
        });
        if (!lines.length) lines.push({ level: "good", text: "All 8 panels reporting normally." });
        else lines.push({ level: "info", text: `Everything else is producing: ${watts(r.total)} W.` });
        return lines;
    }

    function monitorString(r) {
        const full = PANEL_WATTS * PANELS;
        if (r.total === 0) {
            return state.stringFailed
                ? [
                    { level: "bad", text: "Inverter offline. No output from the whole system." },
                    { level: "info", text: "Nothing can produce until the inverter is repaired or replaced." },
                ]
                : [
                    { level: "bad", text: "No output from the whole system." },
                    { level: "info", text: "The app can't tell which part failed. A technician has to check every panel and connection." },
                ];
        }
        if (r.total < full - 1) {
            return [
                { level: "warn", text: `Output ${watts(r.total)} W, ${watts(full - r.total)} W lower than expected (${Math.round((1 - r.total / full) * 100)}%).` },
                { level: "info", text: "Cause unknown: it could be any of the 8 panels." },
            ];
        }
        return [{ level: "good", text: "System producing normally." }];
    }

    function renderMonitor(key, lines) {
        const list = document.querySelector(`[data-out-list="${key}"]`);
        list.replaceChildren(...lines.map(({ level, text }) => {
            const li = document.createElement("li");
            li.className = `fail-monitor-${level}`;
            const icon = document.createElement("span");
            icon.className = "material-symbols-rounded";
            icon.textContent = { good: "check_circle", warn: "warning", bad: "error", info: "info" }[level];
            const span = document.createElement("span");
            span.textContent = text;
            li.append(icon, span);
            return li;
        }));
    }

    function render() {
        results = { micro: microResult(), string: stringResult() };
        const full = PANEL_WATTS * PANELS;

        ["micro", "string"].forEach((system) => {
            const r = results[system];
            const scene = scenes[system];
            scene.panels.forEach((p, i) => {
                const s = state.panels[i];
                p.dust.style.opacity = s === "dirty" ? 1 : 0;
                p.dead.style.opacity = s === "broken" ? 1 : 0;
                let tag = STATE_TAG[s];
                const off = r.perPanel[i] === 0 && s !== "broken";
                if (!tag && off) tag = "Off";
                if (system === "string" && r.bypassed && r.bypassed[i] && s === "dirty") tag = "Bypassed";
                if (!tag && r.heldBack && r.heldBack[i]) tag = "Held back";
                setWords(p.tag, tag);
                p.tag.classList.toggle("sim-tag-warn", Boolean(tag) && tag !== "Dirty");
                p.g.classList.toggle("fail-panel-off", off);
                p.wattTag.querySelector("text").textContent = `${watts(r.perPanel[i])} W`;
                p.wattTag.classList.toggle("sim-tag-warn", r.perPanel[i] < PANEL_WATTS - 0.5);
                p.g.setAttribute("aria-label", `Panel ${i + 1}: ${s === "ok" ? "working" : s === "dirty" ? "dirty" : "broken cable"}, producing ${watts(r.perPanel[i])} W. Press to change.`);
            });
            scene.inverters.forEach((inv, k) => {
                const failed = system === "micro" ? state.microFailed[k] : state.stringFailed;
                inv.g.classList.toggle("fail-inverter-failed", failed);
                inv.tag.querySelector("text").textContent = failed ? "Failed" : "";
                inv.tag.classList.toggle("sim-tag-warn", failed);
                inv.g.setAttribute("aria-label", `${system === "micro" ? `MX2250 micro inverter ${k + 1}` : "String inverter"}: ${failed ? "failed" : "working"}. Press to ${failed ? "fix" : "make it fail"}.`);
            });
            setOut(`${system}-watts`, watts(r.total));
            setOut(`${system}-percent`, Math.round((r.total / full) * 100));
            setOut(`${system}-panels`, r.perPanel.filter((w) => w > 0).length);
        });
        sizeAllTags();

        renderMonitor("micro-monitor", monitorMicro(results.micro));
        renderMonitor("string-monitor", monitorString(results.string));

        const m = results.micro.total, s = results.string.total;
        let summary;
        if (Math.abs(m - s) < 1) summary = "With everything working, both systems produce the same. Now break something.";
        else if (s === 0) summary = `The string system has stopped completely. The micro inverter system is still making ${watts(m)} W (${Math.round((m / full) * 100)}% of normal).`;
        else if (m > s) summary = `The micro inverter system keeps ${watts(m - s)} W more than the string system with the same faults.`;
        else summary = `The string system is ahead by ${watts(s - m)} W here: a failed MX2250 takes its 4 panels offline, while the string inverter is still working. Its monitoring still pinpoints the problem.`;
        setOut("summary", summary);

        document.querySelectorAll("[data-preset]").forEach((b) => b.classList.toggle("is-active", b.dataset.preset === currentPreset()));
        moveFlows(0);
    }

    function cyclePanel(i) {
        state.panels[i] = STATES[(STATES.indexOf(state.panels[i]) + 1) % STATES.length];
        render();
    }

    // ------------------------------------------------------------- presets

    const PRESETS = {
        none: { panels: Array(8).fill("ok"), micro: [false, false], string: false },
        dirty: { panels: ["ok", "ok", "dirty", "ok", "ok", "ok", "ok", "ok"], micro: [false, false], string: false },
        broken: { panels: ["ok", "ok", "ok", "ok", "ok", "broken", "ok", "ok"], micro: [false, false], string: false },
        inverter: { panels: Array(8).fill("ok"), micro: [true, false], string: true },
    };
    function currentPreset() {
        return Object.keys(PRESETS).find((k) => {
            const p = PRESETS[k];
            return p.panels.join() === state.panels.join() && p.micro.join() === state.microFailed.join() && p.string === state.stringFailed;
        });
    }
    document.querySelectorAll("[data-preset]").forEach((b) => b.addEventListener("click", () => {
        const p = PRESETS[b.dataset.preset];
        state.panels = p.panels.slice();
        state.microFailed = p.micro.slice();
        state.stringFailed = p.string;
        render();
    }));

    // ----------------------------------------------------------- animation

    // String chain: dots slow down step by step on the jumpers leading into
    // the weakest panel, then stay at its reduced speed for the rest of the
    // string. An open circuit or failed inverter stops them all.
    const APPROACH = 3; // jumpers over which the slowdown builds up
    function jumperWatts(r, j) {
        const full = PANEL_WATTS * PANELS, weak = r.total;
        if (weak <= 1) return 0;
        const factors = state.panels.map((s) => FACTOR[s]);
        const k = factors.indexOf(Math.min(...factors));
        const d = k - (j + 1); // panels between this jumper's end and the weakest panel
        if (d < 0) return weak;
        return weak + (full - weak) * Math.min(1, (d + 1) / (APPROACH + 1));
    }

    function moveFlows(dt) {
        ["micro", "string"].forEach((system) => {
            const r = results[system];
            scenes[system].flows.forEach((f) => {
                let w;
                if (f.key.startsWith("panel")) w = r.perPanel[Number(f.key.slice(5))];
                else if (f.key.startsWith("inv")) w = r.inverterOut[Number(f.key.slice(3))];
                else if (f.key.startsWith("jump")) w = jumperWatts(r, Number(f.key.slice(4)));
                else if (f.key === "bus") w = r.total / 2;
                else w = r.total;
                f.path.classList.toggle("sim-flow-on", w > 1);
                if (!reduceMotion && dt) {
                    // The string's speed is scaled to its full output so a weaker string visibly slows.
                    const speed = system === "string" ? (4 * w) / (PANEL_WATTS * PANELS) : Math.min(4, w / PANEL_WATTS);
                    f.offset -= speed * 40 * dt;
                    f.path.style.strokeDashoffset = f.offset.toFixed(1);
                }
            });
        });
    }

    let last = performance.now();
    function frame(now) {
        const dt = Math.min(0.1, (now - last) / 1000);
        last = now;
        moveFlows(dt);
        requestAnimationFrame(frame);
    }

    render();
    if (document.fonts && document.fonts.ready) document.fonts.ready.then(sizeAllTags);
    window.matchMedia("(max-width: 750px)").addEventListener("change", sizeAllTags);
    requestAnimationFrame(frame);
})();
