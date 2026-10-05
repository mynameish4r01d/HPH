// "How solar panels work": shading simulation.
//
// Four 650 W panels in full sun, wired either to one MX2250 micro inverter
// (four independent inputs, so each panel produces what its own light allows)
// or to a string inverter (panels in series). Visitors tap panels to add
// shade and compare the two. Figures are illustrative (see the page footnote).
//
// String model (simplified): panels in series share one current, so the
// weakest panel sets the level for the whole string. One shaded panel pulls
// every other panel down with it, while on the micro inverter each panel's
// shade stays isolated to that panel.

(function () {
    const PANEL_WATTS = 650;
    const PANELS = 4;
    const SHADE_STEPS = [0, 25, 50, 90]; // % of light blocked
    const SHADE_NAMES = { 0: "No shade", 25: "Light shade", 50: "Half shaded", 90: "Heavy shade" };

    const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const scene = document.querySelector(".sim-scene");
    if (!scene) return;
    const SVGNS = "http://www.w3.org/2000/svg";
    const svg = (tag, attrs, parent) => {
        const node = document.createElementNS(SVGNS, tag);
        Object.entries(attrs || {}).forEach(([k, v]) => node.setAttribute(k, v));
        if (parent) parent.appendChild(node);
        return node;
    };
    const setOut = (key, text) => document.querySelectorAll(`[data-out="${key}"]`).forEach((el) => { el.textContent = text; });
    const watts = (w) => Math.round(w).toLocaleString();

    const state = { shades: [0, 0, 0, 0], system: "micro" };

    // --------------------------------------------------------------- model

    function available() {
        return state.shades.map((s) => PANEL_WATTS * (1 - s / 100));
    }

    function micro(avail) {
        return { total: avail.reduce((a, b) => a + b, 0), perPanel: avail.slice(), bypassed: [false, false, false, false] };
    }

    function string(avail) {
        // Every panel in the series string runs at the weakest panel's level.
        const level = Math.min(...avail);
        return { total: level * avail.length, perPanel: avail.map(() => level), bypassed: [false, false, false, false] };
    }

    // --------------------------------------------------------------- scene

    const panelsGroup = scene.querySelector(".sim-panels");
    const wiringGroup = scene.querySelector(".sim-wiring");
    const W = 160, H = 230, GAP = 36, TOP = 40;
    const LEFT = (1000 - (PANELS * W + (PANELS - 1) * GAP)) / 2;
    const BUS_Y = 360, INV_TOP = 392;
    const INPUTS = [452, 486, 514, 548];

    const panels = [0, 1, 2, 3].map((i) => {
        const x = LEFT + i * (W + GAP);
        const cx = x + W / 2;
        const g = svg("g", { class: "sim-panel-btn", tabindex: "0", role: "button" }, panelsGroup);
        const clipId = `sim-panel-clip-${i}`;
        const clip = svg("clipPath", { id: clipId }, scene.querySelector("defs"));
        svg("rect", { x, y: TOP, width: W, height: H, rx: 4 }, clip);

        svg("rect", { x: x + 6, y: TOP + H + 4, width: W - 12, height: 6, rx: 3, class: "sim-panel-shadow" }, g);
        svg("rect", { x, y: TOP, width: W, height: H, rx: 4, fill: "url(#sim-panel-face)" }, g);
        const lines = [];
        for (let c = 1; c < 6; c++) lines.push(`M${x + (W * c) / 6} ${TOP}v${H}`);
        for (let r = 1; r < 10; r++) lines.push(`M${x} ${TOP + (H * r) / 10}h${W}`);
        svg("path", { d: lines.join(""), class: "sim-panel-lines" }, g);
        svg("rect", { x, y: TOP, width: W, height: H, rx: 4, fill: "url(#sim-panel-sheen)" }, g);

        // Shade: a soft-edged dark band from the top, clipped to the panel.
        const shadeWrap = svg("g", { "clip-path": `url(#${clipId})` }, g);
        const shade = svg("polygon", { class: "sim-shade", filter: "url(#sim-shade-blur)" }, shadeWrap);

        svg("rect", { x, y: TOP, width: W, height: H, rx: 4, class: "sim-panel-frame" }, g);
        svg("rect", { x: x - 5, y: TOP - 5, width: W + 10, height: H + 10, rx: 8, class: "sim-focus-ring" }, g);

        const shadeTag = svg("g", { class: "sim-tag sim-shade-tag", transform: `translate(${cx} ${TOP + 26})` }, g);
        svg("text", {}, shadeTag);
        const outTag = svg("g", { class: "sim-tag sim-out-tag", transform: `translate(${cx} ${TOP + H + 38})` }, g);
        svg("text", {}, outTag);

        g.addEventListener("click", () => cycleShade(i));
        g.addEventListener("keydown", (e) => {
            if (e.key === "Enter" || e.key === " ") { e.preventDefault(); cycleShade(i); }
        });
        return { g, x, cx, shade, shadeTag, outTag };
    });

    // Wiring: faint base lines plus glowing dots whose speed follows the power.
    const flows = [];
    function addFlow(d, key) {
        svg("path", { d, class: "sim-flow-base" }, wiringGroup);
        const path = svg("path", { d, class: "sim-flow", filter: "url(#sim-glow)" }, wiringGroup);
        flows.push({ path, key, offset: 0 });
    }

    function drawWiring() {
        wiringGroup.replaceChildren();
        flows.length = 0;
        if (state.system === "micro") {
            // Each panel on its own input. Outer panels run lower than inner
            // ones so no two wires cross.
            const LEVELS = [BUS_Y + 8, BUS_Y - 8, BUS_Y - 8, BUS_Y + 8];
            panels.forEach((p, i) => addFlow(`M${p.cx} ${TOP + H + 58}V${LEVELS[i]}H${INPUTS[i]}V${INV_TOP}`, `panel${i}`));
        } else {
            // One series string: each panel is jumpered to the next under the
            // panels, and a single lead runs from the last panel to the inverter.
            const JUMP_Y = TOP + H + 16;
            for (let i = 0; i < PANELS - 1; i++) {
                addFlow(`M${panels[i].x + W - 16} ${TOP + H}V${JUMP_Y}H${panels[i + 1].x + 16}V${TOP + H}`, `jump${i}`);
            }
            addFlow(`M${panels[PANELS - 1].x + W - 16} ${TOP + H}V${BUS_Y}H500V${INV_TOP}`, "string");
        }
    }

    function sizeTag(tag) {
        const text = tag.querySelector("text");
        let bg = tag.querySelector(".sim-tag-bg");
        if (!bg) bg = tag.insertBefore(svg("rect", { class: "sim-tag-bg" }), text);
        const box = text.getBBox();
        if (!box.width) return;
        const padX = 8, padY = 4;
        bg.setAttribute("x", (box.x - padX).toFixed(1));
        bg.setAttribute("y", (box.y - padY).toFixed(1));
        bg.setAttribute("width", (box.width + padX * 2).toFixed(1));
        bg.setAttribute("height", (box.height + padY * 2).toFixed(1));
        bg.setAttribute("rx", ((box.height + padY * 2) / 2).toFixed(1));
    }
    const sizeAllTags = () => scene.querySelectorAll(".sim-tag").forEach(sizeTag);

    // One <tspan> per line, stacked under the tag's anchor point.
    function setLines(tag, lines) {
        const text = tag.querySelector("text");
        text.replaceChildren(...lines.map((line, n) => {
            const span = svg("tspan", { x: 0, dy: n ? "1.25em" : 0 });
            span.textContent = line;
            return span;
        }));
    }

    // ------------------------------------------------------------ drawing

    let result = micro(available());

    function render() {
        const avail = available();
        const mine = state.system === "micro" ? micro(avail) : string(avail);
        const other = state.system === "micro" ? string(avail) : micro(avail);
        result = mine;
        const full = PANEL_WATTS * PANELS;

        panels.forEach((p, i) => {
            const s = state.shades[i];
            // Shade band covers the top of the panel, with a slanted edge.
            const depth = s === 0 ? -40 : TOP + H * (s / 100) * 1.05;
            p.shade.setAttribute("points", `${p.x - 20},${TOP - 30} ${p.x + W + 20},${TOP - 30} ${p.x + W + 20},${depth - 26} ${p.x - 20},${depth + 26}`);
            p.shade.setAttribute("opacity", s === 0 ? 0 : 0.78);

            const out = mine.perPanel[i];
            const heldBack = state.system === "string" && out < avail[i] - 0.5;
            const culprit = avail.indexOf(Math.min(...avail)) + 1;

            // Status on the panel face, in two short lines so neighbours' labels don't overlap.
            // A held-back panel has no shade of its own, so it uses the same slot.
            let status = [];
            if (s !== 0) status = [SHADE_NAMES[s], `${s}%`];
            else if (heldBack) status = ["Held back", `by panel ${culprit}`];
            setLines(p.shadeTag, status);
            p.shadeTag.style.display = status.length ? "" : "none";
            p.shadeTag.classList.toggle("sim-tag-warn", heldBack && s === 0);

            const label = mine.bypassed[i] ? "Bypassed · 0 W" : `${watts(out)} W`;
            p.outTag.querySelector("text").textContent = label;
            p.outTag.classList.toggle("sim-tag-warn", mine.bypassed[i] || heldBack);

            const note = heldBack ? `, held back by panel ${culprit}` : "";
            p.g.setAttribute("aria-label", `Panel ${i + 1}: ${SHADE_NAMES[s].toLowerCase()}, making ${label}${note}. Press to change shade.`);
        });

        scene.querySelector(".sim-inverter-name").textContent = state.system === "micro" ? "MX2250" : "String";
        scene.querySelector(".sim-inverter-tag text").textContent = state.system === "micro"
            ? "Micro inverter · 4 independent inputs"
            : "String inverter · panels in series";
        sizeAllTags();

        setOut("total", watts(mine.total));
        setOut("percent", Math.round((mine.total / full) * 100));
        setOut("lost", watts(full - mine.total));

        const diff = Math.round(Math.abs(mine.total - other.total));
        if (state.system === "micro") {
            setOut("compare-label", "The same shade on a string inverter");
            setOut("compare", watts(other.total));
            setOut("compare-note", diff === 0
                ? "No difference: with even light, both work the same."
                : `The MX2250 makes ${watts(diff)} W more here (${Math.round((diff / Math.max(other.total, 1)) * 100)}% more).`);
        } else {
            setOut("compare-label", "The same shade with an MX2250 micro inverter");
            setOut("compare", watts(other.total));
            setOut("compare-note", diff === 0
                ? "No difference: with even light, both work the same."
                : `You'd keep ${watts(diff)} W more with micro inverters.`);
        }

        document.querySelectorAll("[data-system]").forEach((b) => b.setAttribute("aria-checked", String(b.dataset.system === state.system)));
        document.querySelectorAll("[data-preset]").forEach((b) => b.classList.toggle("is-active", b.dataset.preset === state.shades.join(",")));

        const glow = document.querySelector(".sim-bulb-glow");
        if (glow) glow.setAttribute("opacity", (mine.total / full).toFixed(2));
        moveFlows(0);
    }

    function cycleShade(i) {
        const next = SHADE_STEPS[(SHADE_STEPS.indexOf(state.shades[i]) + 1) % SHADE_STEPS.length];
        state.shades[i] = next;
        render();
    }

    // ------------------------------------------------------------ controls

    document.querySelectorAll("[data-system]").forEach((button) => {
        button.addEventListener("click", () => {
            if (state.system === button.dataset.system) return;
            state.system = button.dataset.system;
            drawWiring();
            render();
        });
    });

    document.querySelectorAll("[data-preset]").forEach((button) => {
        button.addEventListener("click", () => {
            state.shades = button.dataset.preset.split(",").map(Number);
            render();
        });
    });

    // --------------------------------------------------------- animation

    const cellSvg = document.querySelector(".sim-cell-svg");
    const photonsGroup = cellSvg && cellSvg.querySelector(".sim-cell-photons");
    const electronsGroup = cellSvg && cellSvg.querySelector(".sim-cell-electrons");
    const circuit = cellSvg && svg("path", { d: "M300 150 V 190 H 360 V 262 H 60 V 190 H 120 V 150", fill: "none", stroke: "none" }, cellSvg);
    const circuitLength = circuit ? circuit.getTotalLength() : 0;
    const photons = [], electrons = [];
    let photonTimer = 0;

    function stepCell(dt) {
        if (!cellSvg || reduceMotion) return;
        photonTimer += dt * (result.total / (PANEL_WATTS * PANELS)) * 14;
        while (photonTimer > 1) {
            photonTimer -= 1;
            const x = 50 + Math.random() * 320;
            photons.push({ y: 36, node: svg("circle", { r: 4, class: "sim-photon", cx: x, cy: 36 }, photonsGroup) });
        }
        for (let i = photons.length - 1; i >= 0; i--) {
            const p = photons[i];
            p.y += dt * 160;
            p.node.setAttribute("cy", p.y.toFixed(1));
            if (p.y >= 150) {
                p.node.remove();
                photons.splice(i, 1);
                if (electrons.length < 40) electrons.push({ d: 0, node: svg("circle", { r: 4.5, class: "sim-electron" }, electronsGroup) });
            }
        }
        for (let i = electrons.length - 1; i >= 0; i--) {
            const e = electrons[i];
            e.d += dt * 140;
            if (e.d >= circuitLength) { e.node.remove(); electrons.splice(i, 1); continue; }
            const pt = circuit.getPointAtLength(e.d);
            e.node.setAttribute("cx", pt.x.toFixed(1));
            e.node.setAttribute("cy", pt.y.toFixed(1));
        }
    }

    const outFlow = scene.querySelector(".sim-flow-out");
    let outOffset = 0;

    // String chain: dots slow down step by step on the jumpers leading into
    // the weakest panel, then stay at its reduced speed for the rest of the
    // string. (Illustrative: in a real series string the current is the same
    // everywhere, which is the point the readouts make.)
    const APPROACH = 3; // jumpers over which the slowdown builds up
    function jumperWatts(j) {
        const full = PANEL_WATTS * PANELS, weak = result.total;
        if (weak <= 1) return 0;
        const avail = available();
        const k = avail.indexOf(Math.min(...avail));
        const d = k - (j + 1); // panels between this jumper's end and the weakest panel
        if (d < 0) return weak;
        return weak + (full - weak) * Math.min(1, (d + 1) / (APPROACH + 1));
    }

    // Dot speed follows each line's power; lines with no power go dark.
    function moveFlows(dt) {
        const on = (w) => w > 1;
        flows.forEach((f) => {
            const w = f.key.startsWith("panel") ? result.perPanel[Number(f.key.slice(5))]
                : f.key.startsWith("jump") ? jumperWatts(Number(f.key.slice(4)))
                : result.total;
            f.path.classList.toggle("sim-flow-on", on(w));
            if (!reduceMotion && dt) {
                f.offset -= (w / PANEL_WATTS) * 50 * dt;
                f.path.style.strokeDashoffset = f.offset.toFixed(1);
            }
        });
        outFlow.classList.toggle("sim-flow-on", on(result.total));
        if (!reduceMotion && dt) {
            outOffset -= (result.total / (PANEL_WATTS * PANELS)) * 70 * dt;
            outFlow.style.strokeDashoffset = outOffset.toFixed(1);
        }
    }

    let last = performance.now();
    function frame(now) {
        const dt = Math.min(0.1, (now - last) / 1000);
        last = now;
        moveFlows(dt);
        stepCell(dt);
        requestAnimationFrame(frame);
    }

    drawWiring();
    render();
    if (document.fonts && document.fonts.ready) document.fonts.ready.then(sizeAllTags);
    window.matchMedia("(max-width: 750px)").addEventListener("change", sizeAllTags);
    requestAnimationFrame(frame);
})();
