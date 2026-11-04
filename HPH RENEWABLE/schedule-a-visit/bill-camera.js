// Camera capture for the electricity bill on the Schedule a Visit form.
//
// openBillCamera() shows a full-screen camera with a guide frame. The visitor
// lines the bill up inside the frame; once what's inside it looks like a
// page of text (enough contrast and fine detail, bright like paper), is in
// focus and has held still for about a second, the photo is taken by itself.
// A "Take photo" button is always there as a fallback. The photo is cropped to
// the frame and returned as a JPEG File.
//
// The check is a plain image heuristic, not recognition: it can't tell a
// Meralco bill from any other printed page. The thresholds below were chosen
// without a real bill in front of the camera, so tune them if it fires too
// early or never fires. Add ?camdebug=1 to the page address to see the live
// numbers.

// What the frame must show before the photo is taken automatically.
const MIN_SHARPNESS = 60;      // variance of the Laplacian: how crisp the edges are
const MIN_DETAIL = 0.05;       // share of pixels on a strong edge: text, lines, the graph
const MIN_PAPER = 0.35;        // share of bright pixels: a mostly white page
const MAX_PAPER = 0.97;        // above this it's a blank sheet or glare, not a bill
const MAX_MOVEMENT = 6;        // mean change between checks (0-255) that still counts as still
const HOLD_CHECKS = 4;         // checks in a row that must pass (CHECK_MS apart)
const CHECK_MS = 250;
const ANALYSE_WIDTH = 480;     // the frame is shrunk to this width for the check
const FOCUS_SETTLED = 0.25;    // sharpness may change by at most this share between checks (autofocus still hunting)
const BURST_FRAMES = 4;        // frames grabbed when the photo is taken; the sharpest is kept
const BURST_GAP_MS = 90;

// The guide frame: portrait, like a bill held upright.
const GUIDE_ASPECT = 3 / 4;    // width / height
const GUIDE_MAX_WIDTH = 0.86;  // share of the screen's width
const GUIDE_MAX_HEIGHT = 0.64; // share of the screen's height

const OUT_MAX_EDGE = 8192;     // effectively no shrinking: the photo keeps every pixel the camera gave
const OUT_QUALITY = 0.95;
const CROP_MARGIN = 0.02;      // a little around the frame, as a share of its size

// Numbers for a grayscale picture (Uint8 values, width w, height h).
export function measureGray(gray, w, h, previous) {
    let bright = 0;
    let edges = 0;
    let lapSum = 0;
    let lapSq = 0;
    let count = 0;
    for (let y = 1; y < h - 1; y++) {
        for (let x = 1; x < w - 1; x++) {
            const i = y * w + x;
            const c = gray[i];
            const lap = 4 * c - gray[i - 1] - gray[i + 1] - gray[i - w] - gray[i + w];
            lapSum += lap;
            lapSq += lap * lap;
            const gx = gray[i + 1] - gray[i - 1];
            const gy = gray[i + w] - gray[i - w];
            if (Math.abs(gx) + Math.abs(gy) > 60) edges++;
            if (c > 150) bright++;
            count++;
        }
    }
    const mean = lapSum / count;
    let movement = Infinity;
    if (previous && previous.length === gray.length) {
        let diff = 0;
        for (let i = 0; i < gray.length; i += 7) diff += Math.abs(gray[i] - previous[i]);
        movement = diff / Math.ceil(gray.length / 7);
    }
    return {
        sharpness: lapSq / count - mean * mean,
        detail: edges / count,
        paper: bright / count,
        movement,
    };
}

export function looksReady(m) {
    return m.sharpness >= MIN_SHARPNESS && m.detail >= MIN_DETAIL && m.paper >= MIN_PAPER && m.paper <= MAX_PAPER && m.movement <= MAX_MOVEMENT;
}

// Why it isn't ready yet, in words for the visitor.
function hint(m) {
    if (m.paper < MIN_PAPER || m.detail < MIN_DETAIL) return "Fit the whole bill inside the frame";
    if (m.paper > MAX_PAPER) return "Too bright. Move away from glare";
    if (m.sharpness < MIN_SHARPNESS) return "Hold still so the text is sharp";
    return "Hold steady…";
}

function make(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text) node.textContent = text;
    return node;
}

function icon(name) {
    const node = make("span", "material-symbols-rounded", name);
    node.setAttribute("aria-hidden", "true");
    return node;
}

// Phones and tablets only: a computer's webcam isn't offered for the bill.
const isTouchDevice = () => window.matchMedia("(hover: none) and (pointer: coarse)").matches;

export const cameraAvailable = () => Boolean(isTouchDevice() && navigator.mediaDevices && navigator.mediaDevices.getUserMedia && window.isSecureContext);

// Opens the camera. Resolves with a File (the cropped photo), or null if the
// visitor closed it. Rejects if the camera can't be used.
export async function openBillCamera() {
    const debug = new URLSearchParams(window.location.search).has("camdebug");
    const stream = await navigator.mediaDevices.getUserMedia({
        // As many pixels as the camera gives (the photo is only the frame's
        // part of the video, so a 1080p feed leaves the text soft).
        video: { facingMode: { ideal: "environment" }, width: { ideal: 4096, min: 1920 }, height: { ideal: 2160, min: 1080 } },
        audio: false,
    });
    // Keep autofocus running where the browser allows it.
    try {
        const [track] = stream.getVideoTracks();
        const modes = (track.getCapabilities && track.getCapabilities().focusMode) || [];
        if (modes.includes("continuous")) await track.applyConstraints({ advanced: [{ focusMode: "continuous" }] });
    } catch (err) {
        console.warn("Bill camera: couldn't set autofocus", err);
    }

    const root = make("div", "visit-cam");
    root.setAttribute("role", "dialog");
    root.setAttribute("aria-modal", "true");
    root.setAttribute("aria-label", "Take a photo of your electricity bill");
    const video = make("video", "visit-cam-video");
    video.muted = true;
    video.playsInline = true;
    video.setAttribute("playsinline", "");
    video.srcObject = stream;
    const guide = make("div", "visit-cam-guide");
    for (const corner of ["tl", "tr", "bl", "br"]) guide.append(make("i", `visit-cam-corner visit-cam-${corner}`));
    const status = make("p", "visit-cam-status", "Fit the whole bill inside the frame");
    status.setAttribute("role", "status");
    const tip = make("p", "visit-cam-tip", "Lay the bill flat in good light, with the “Your Monthly Consumption” graph inside the frame. The photo is taken automatically.");
    const close = make("button", "visit-cam-close");
    close.type = "button";
    close.setAttribute("aria-label", "Close the camera");
    close.append(icon("close"));
    const shutter = make("button", "visit-cam-shutter");
    shutter.type = "button";
    shutter.setAttribute("aria-label", "Take photo now");
    const debugBox = make("pre", "visit-cam-debug");
    debugBox.hidden = !debug;
    root.append(video, guide, close, status, tip, shutter, debugBox);
    document.body.append(root);
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";

    return new Promise((resolve, reject) => {
        let timer = 0;
        let steady = 0;
        let previous = null;
        let lastSharpness = 0;
        let finished = false;
        const probe = document.createElement("canvas");
        const probeContext = probe.getContext("2d", { willReadFrequently: true });

        function finish(file, failure) {
            if (finished) return;
            finished = true;
            clearInterval(timer);
            document.removeEventListener("keydown", onKey);
            stream.getTracks().forEach((track) => track.stop());
            root.remove();
            document.body.style.overflow = previousOverflow;
            if (failure) reject(failure);
            else resolve(file);
        }

        const onKey = (e) => { if (e.key === "Escape") finish(null); };
        document.addEventListener("keydown", onKey);
        close.addEventListener("click", () => finish(null));

        // The guide frame as a rectangle of the video's own pixels. The video
        // fills the screen (object-fit: cover), so the screen's rectangle is
        // mapped back through the same scale and offset.
        function guideInVideo(margin = 0) {
            const box = root.getBoundingClientRect();
            const g = guide.getBoundingClientRect();
            const vw = video.videoWidth;
            const vh = video.videoHeight;
            const scale = Math.max(box.width / vw, box.height / vh);
            const offX = (box.width - vw * scale) / 2;
            const offY = (box.height - vh * scale) / 2;
            let x = (g.left - box.left - offX) / scale;
            let y = (g.top - box.top - offY) / scale;
            let w = g.width / scale;
            let h = g.height / scale;
            x -= w * margin;
            y -= h * margin;
            w *= 1 + 2 * margin;
            h *= 1 + 2 * margin;
            x = Math.max(0, x);
            y = Math.max(0, y);
            w = Math.min(vw - x, w);
            h = Math.min(vh - y, h);
            return { x, y, w, h };
        }

        function sizeGuide() {
            const box = root.getBoundingClientRect();
            let w = box.width * GUIDE_MAX_WIDTH;
            let h = w / GUIDE_ASPECT;
            if (h > box.height * GUIDE_MAX_HEIGHT) {
                h = box.height * GUIDE_MAX_HEIGHT;
                w = h * GUIDE_ASPECT;
            }
            guide.style.width = `${Math.round(w)}px`;
            guide.style.height = `${Math.round(h)}px`;
        }
        sizeGuide();
        window.addEventListener("resize", sizeGuide);

        // The frame's part of the video as a canvas at full resolution.
        function grabFrame() {
            const r = guideInVideo(CROP_MARGIN);
            const scale = Math.min(1, OUT_MAX_EDGE / Math.max(r.w, r.h));
            const canvas = document.createElement("canvas");
            canvas.width = Math.round(r.w * scale);
            canvas.height = Math.round(r.h * scale);
            canvas.getContext("2d").drawImage(video, r.x, r.y, r.w, r.h, 0, 0, canvas.width, canvas.height);
            return canvas;
        }

        function sharpnessOf(canvas) {
            const w = ANALYSE_WIDTH;
            const h = Math.max(8, Math.round(w * canvas.height / canvas.width));
            probe.width = w;
            probe.height = h;
            probeContext.drawImage(canvas, 0, 0, w, h);
            const data = probeContext.getImageData(0, 0, w, h).data;
            const gray = new Uint8Array(w * h);
            for (let i = 0, p = 0; i < gray.length; i++, p += 4) gray[i] = (data[p] * 77 + data[p + 1] * 150 + data[p + 2] * 29) >> 8;
            return measureGray(gray, w, h).sharpness;
        }

        let capturing = false;
        // Grabs a few frames a moment apart and keeps the sharpest.
        async function capture() {
            if (finished || capturing || !video.videoWidth) return;
            capturing = true;
            clearInterval(timer);
            status.textContent = "Taking photo…";
            let best = null;
            let bestScore = -1;
            for (let i = 0; i < BURST_FRAMES; i++) {
                const canvas = grabFrame();
                const score = sharpnessOf(canvas);
                if (score > bestScore) {
                    best = canvas;
                    bestScore = score;
                }
                if (i < BURST_FRAMES - 1) await new Promise((resolve) => setTimeout(resolve, BURST_GAP_MS));
            }
            root.classList.add("visit-cam-flash");
            best.toBlob((blob) => {
                window.removeEventListener("resize", sizeGuide);
                if (!blob) return finish(null);
                finish(new File([blob], `electricity-bill-${Date.now()}.jpg`, { type: "image/jpeg", lastModified: Date.now() }));
            }, "image/jpeg", OUT_QUALITY);
        }

        function check() {
            if (finished || !video.videoWidth) return;
            const r = guideInVideo();
            const w = ANALYSE_WIDTH;
            const h = Math.max(8, Math.round(w * r.h / r.w));
            probe.width = w;
            probe.height = h;
            probeContext.drawImage(video, r.x, r.y, r.w, r.h, 0, 0, w, h);
            const data = probeContext.getImageData(0, 0, w, h).data;
            const gray = new Uint8Array(w * h);
            for (let i = 0, p = 0; i < gray.length; i++, p += 4) gray[i] = (data[p] * 77 + data[p + 1] * 150 + data[p + 2] * 29) >> 8;
            const m = measureGray(gray, w, h, previous);
            previous = gray;
            // Autofocus is still moving while the sharpness keeps changing.
            const settled = lastSharpness === 0 || Math.abs(m.sharpness - lastSharpness) <= FOCUS_SETTLED * Math.max(m.sharpness, lastSharpness);
            lastSharpness = m.sharpness;
            if (looksReady(m) && settled) {
                steady++;
                guide.classList.add("visit-cam-ready");
                status.textContent = "Hold steady…";
                if (steady >= HOLD_CHECKS) capture();
            } else {
                steady = 0;
                guide.classList.remove("visit-cam-ready");
                status.textContent = looksReady(m) ? "Hold steady…" : hint(m);
            }
            if (debug) debugBox.textContent = `sharp ${m.sharpness.toFixed(0)}\ndetail ${m.detail.toFixed(3)}\npaper ${m.paper.toFixed(2)}\nmove ${Number.isFinite(m.movement) ? m.movement.toFixed(1) : "-"}\nsteady ${steady}/${HOLD_CHECKS}`;
        }

        shutter.addEventListener("click", capture);
        video.play().then(() => {
            timer = setInterval(check, CHECK_MS);
            close.focus();
        }).catch((err) => {
            finish(null, err);
        });
    });
}
