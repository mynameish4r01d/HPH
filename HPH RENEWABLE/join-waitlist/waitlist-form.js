// "Join the Waitlist" form.
//
// Saves each sign-up to Firestore (collection: waitlist) in the same
// Firebase project as the Schedule a Visit form, and an optional electricity
// bill (up to 3 images/PDFs, handled as on that form) to Cloud Storage under
// waitlist/<sign-up id>/. Sign-ups show on the admin page (../admin/).
// Security rules: /firestore.rules and /storage.rules.
//
// There are two systems, each a unit plus its own extension battery (see
// SYSTEMS). People choose how many of each product in one system. Product
// pages link here with ?product=<name>: that picks the system, hides the
// system choice (so unrelated products never show) and starts that product
// at 1.
//
// Firebase settings come from ../firebase-config.js. The Firebase SDK is
// only downloaded when someone submits.

import { firebaseConfig } from "../firebase-config.js";
import { tidyName, tidyAddress, tidyOnBlur } from "../text-format.js";

const FIREBASE_VERSION = "12.3.0";
const COLLECTION = "waitlist";
// Longer than a plain sign-up needs, for uploading bills on a slow connection.
const SUBMIT_TIMEOUT_MS = 90000;

// Uploads, as on the Schedule a Visit form: keep in step with /storage.rules
// and /firestore.rules.
const MAX_FILES = 3;
const MAX_FILE_BYTES = 10 * 1024 * 1024;
const ACCEPTED_TYPE = /^(image\/.+|application\/pdf)$/;
// Photos bigger than this (JPEG/PNG/WebP) are shrunk in the browser before
// upload. Bills stay readable at 2400px on the long edge.
const SHRINK_OVER_BYTES = 2 * 1024 * 1024;
const SHRINK_MAX_EDGE = 2400;
const SHRINKABLE_TYPE = /^image\/(jpeg|png|webp)$/;

// Keep in step with index.html and isValidWaitlist() in /firestore.rules.
// Batteries per unit comes from the TSUN data sheets (max. 4 expansion packs).
const SYSTEMS = {
    "MSU4000 Elite": { unit: "MSU4000 Elite", battery: "B4000 Elite" },
    "MAU5000 Elite": { unit: "MAU5000 Elite", battery: "B5000 Elite" },
};
const MAX_UNITS = 10;
const BATTERIES_PER_UNIT = 4;

const isConfigured = Boolean(firebaseConfig && firebaseConfig.projectId && !firebaseConfig.projectId.startsWith("YOUR_"));

const form = document.querySelector(".visit-form");
// Names and addresses typed in ALL CAPS or all lowercase are tidied when the visitor
// leaves the field, e.g. "harold t. hermosa" → "Harold T. Hermosa".
tidyOnBlur(form.querySelector('[name="name"]'), tidyName);
tidyOnBlur(form.querySelector('[name="address"]'), tidyAddress);
const success = document.querySelector(".visit-success");
const error = form.querySelector(".visit-error");
const button = form.querySelector(".visit-submit");
const consent = form.querySelector('[name="consent"]');
const systemField = form.querySelector(".visit-system-field");
const qtyField = form.querySelector(".visit-qty-field");
const estimateLines = qtyField.querySelector(".visit-estimate-lines");
const estimateAmount = qtyField.querySelector(".visit-estimate-amount");
const fileInput = form.querySelector('[name="files"]');
const fileList = form.querySelector(".visit-file-list");

// Files chosen so far. Each pick adds to this list (a file input on its own
// replaces the previous pick), so bills can be added one at a time.
// `sourceKeys` remembers each original file (name, size, date) so picking the
// same one twice is ignored even after it was shrunk and renamed.
let chosenFiles = [];
let sourceKeys = [];
const sourceKey = (f) => `${f.name}|${f.size}|${f.lastModified}`;


// ------------------------------------------------------ system + quantities

function chosenSystem() {
    const radio = form.querySelector('[name="system"]:checked');
    return radio ? radio.value : null;
}

function rowsFor(system) {
    return Array.from(qtyField.querySelectorAll(`.visit-qty-group[data-system="${system}"] .visit-qty-row`));
}

function row(system, kind) {
    return rowsFor(system).find((r) => r.dataset.kind === kind);
}

function qty(r) {
    const n = parseInt(r.querySelector("input").value, 10);
    return Number.isFinite(n) && n > 0 ? n : 0;
}

const peso = (amount) => `₱${amount.toLocaleString("en-PH")}`;

// Estimated total from each row's data-price (starting prices in index.html).
// Only an estimate: the final quote after a site assessment sets the price.
function estimate() {
    const system = chosenSystem();
    if (!system) return 0;
    return rowsFor(system).reduce((sum, r) => sum + qty(r) * Number(r.dataset.price), 0);
}

function renderEstimate() {
    const system = chosenSystem();
    const rows = system ? rowsFor(system).filter((r) => qty(r) > 0) : [];
    estimateLines.replaceChildren(...rows.map((r) => {
        const line = document.createElement("li");
        const label = document.createElement("span");
        label.textContent = `${qty(r)} × ${r.dataset.product}`;
        const amount = document.createElement("span");
        amount.textContent = peso(qty(r) * Number(r.dataset.price));
        line.append(label, amount);
        return line;
    }));
    estimateAmount.textContent = peso(estimate());
}

function batteryMax(system) {
    return BATTERIES_PER_UNIT * Math.max(1, qty(row(system, "unit")));
}

// Clamps values, updates the +/- buttons and highlights rows above zero.
function refreshQuantities() {
    const system = chosenSystem();
    if (!system) return;
    for (const r of rowsFor(system)) {
        const input = r.querySelector("input");
        const max = r.dataset.kind === "unit" ? MAX_UNITS : batteryMax(system);
        input.max = max;
        const value = Math.min(qty(r), max);
        if (input.value !== String(value) && document.activeElement !== input) input.value = value;
        r.querySelector('[data-step="-1"]').disabled = value <= 0;
        r.querySelector('[data-step="1"]').disabled = value >= max;
        r.classList.toggle("visit-qty-active", value > 0);
    }
    renderEstimate();
}

function showSystem(system) {
    qtyField.hidden = !system;
    qtyField.querySelectorAll(".visit-qty-group").forEach((group) => {
        group.hidden = group.dataset.system !== system;
    });
    if (!system) return;
    // Start with one unit if nothing is picked yet in this system.
    if (rowsFor(system).every((r) => qty(r) === 0)) row(system, "unit").querySelector("input").value = 1;
    refreshQuantities();
}

qtyField.addEventListener("click", (e) => {
    const step = e.target.closest(".visit-step");
    if (!step) return;
    const input = step.closest(".visit-qty-row").querySelector("input");
    input.value = Math.max(0, qty(step.closest(".visit-qty-row")) + Number(step.dataset.step));
    refreshQuantities();
    if (qtyField.classList.contains("visit-invalid")) validateQuantities();
});

qtyField.addEventListener("input", () => {
    refreshQuantities();
    if (qtyField.classList.contains("visit-invalid")) validateQuantities();
});

// Tidy a typed value once the field is left (e.g. empty -> 0, 99 -> max).
qtyField.addEventListener("focusout", (e) => {
    if (e.target.name !== "qty") return;
    const r = e.target.closest(".visit-qty-row");
    const system = chosenSystem();
    const max = r.dataset.kind === "unit" ? MAX_UNITS : batteryMax(system);
    e.target.value = Math.min(qty(r), max);
    refreshQuantities();
});

// Opened from a product page: pick that product's system and hide the choice.
const product = new URLSearchParams(window.location.search).get("product");
const linkedSystem = Object.keys(SYSTEMS).find((key) => SYSTEMS[key].unit === product || SYSTEMS[key].battery === product);
if (linkedSystem) {
    form.querySelector(`[name="system"][value="${linkedSystem}"]`).checked = true;
    systemField.hidden = true;
    rowsFor(linkedSystem).find((r) => r.dataset.product === product).querySelector("input").value = 1;
    showSystem(linkedSystem);
}


// ------------------------------------------------------- electricity bill

function formatSize(bytes) {
    return bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

// Some browsers leave file.type empty (e.g. iPhone HEIC photos on Windows),
// so fall back to the file extension.
const TYPE_BY_EXTENSION = {
    jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", webp: "image/webp", gif: "image/gif",
    heic: "image/heic", heif: "image/heif", pdf: "application/pdf",
};

function fileType(file) {
    if (file.type) return file.type;
    const ext = (file.name.split(".").pop() || "").toLowerCase();
    return TYPE_BY_EXTENSION[ext] || "";
}

// Large JPEG/PNG/WebP photos -> JPEG at most SHRINK_MAX_EDGE px. Anything
// else, or anything that fails to shrink, is returned unchanged.
async function shrinkImage(file) {
    if (!SHRINKABLE_TYPE.test(fileType(file)) || file.size <= SHRINK_OVER_BYTES) return file;
    try {
        const bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
        const scale = Math.min(1, SHRINK_MAX_EDGE / Math.max(bitmap.width, bitmap.height));
        const canvas = document.createElement("canvas");
        canvas.width = Math.round(bitmap.width * scale);
        canvas.height = Math.round(bitmap.height * scale);
        const context = canvas.getContext("2d");
        context.fillStyle = "#FFFFFF"; // transparent PNG areas -> white, not black
        context.fillRect(0, 0, canvas.width, canvas.height);
        context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
        bitmap.close();
        const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.85));
        if (!blob || blob.size >= file.size) return file;
        const name = file.name.replace(/\.[^.]+$/, "") + ".jpg";
        return new File([blob], name, { type: "image/jpeg", lastModified: file.lastModified });
    } catch (err) {
        console.warn("Waitlist: couldn't shrink image, uploading as is", err);
        return file;
    }
}

function fileProblem(files) {
    if (files.length > MAX_FILES) return `Please choose up to ${MAX_FILES} files.`;
    if (files.some((f) => !ACCEPTED_TYPE.test(fileType(f)))) return "Only images or PDF files can be uploaded.";
    if (files.some((f) => f.size > MAX_FILE_BYTES)) return "Each file must be 10 MB or smaller.";
    return "";
}

function renderFileList() {
    fileList.replaceChildren(...chosenFiles.map((file, index) => {
        const item = document.createElement("li");
        const name = document.createElement("span");
        name.className = "visit-file-name";
        name.textContent = file.name;
        const size = document.createElement("span");
        size.className = "visit-file-size";
        size.textContent = formatSize(file.size);
        const remove = document.createElement("button");
        remove.type = "button";
        remove.className = "visit-file-remove";
        remove.setAttribute("aria-label", `Remove ${file.name}`);
        remove.innerHTML = '<span class="material-symbols-rounded">close</span>';
        remove.addEventListener("click", () => {
            chosenFiles.splice(index, 1);
            sourceKeys.splice(index, 1);
            renderFileList();
            validateField(fileInput);
        });
        item.append(name, size, remove);
        return item;
    }));
    fileInput.closest(".visit-upload").hidden = chosenFiles.length >= MAX_FILES;
}

// Adds picked or dropped files (up to MAX_FILES in total), shrinking large photos.
async function addFiles(picked) {
    if (!picked.length) return;

    const room = MAX_FILES - chosenFiles.length;
    const fresh = picked.filter((f) => !sourceKeys.includes(sourceKey(f)));
    const adding = fresh.slice(0, room);

    const uploadField = fileInput.closest(".visit-field");
    const sub = uploadField.querySelector(".visit-upload-sub");
    const subText = sub.textContent;
    sub.textContent = "Preparing photos…";
    const prepared = await Promise.all(adding.map(shrinkImage));
    sub.textContent = subText;

    chosenFiles = chosenFiles.concat(prepared);
    sourceKeys = sourceKeys.concat(adding.map(sourceKey));
    renderFileList();

    if (fresh.length > room) {
        setFieldError(uploadField, `You can add up to ${MAX_FILES} files. Remove one to add another.`);
    } else {
        validateField(fileInput);
    }
}

fileInput.addEventListener("change", () => {
    const picked = Array.from(fileInput.files);
    // Clear the input so the same file can be picked again after removing it.
    fileInput.value = "";
    addFiles(picked);
});

// Drag and drop onto the upload box. dragDepth counts enter/leave pairs,
// since moving over the box's own children fires them too.
const dropZone = fileInput.closest(".visit-upload");
let dragDepth = 0;
const hasFiles = (e) => Array.from((e.dataTransfer && e.dataTransfer.types) || []).includes("Files");

dropZone.addEventListener("dragenter", (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    dragDepth++;
    dropZone.classList.add("visit-upload-dragover");
});

dropZone.addEventListener("dragover", (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "copy";
});

dropZone.addEventListener("dragleave", () => {
    dragDepth = Math.max(0, dragDepth - 1);
    if (!dragDepth) dropZone.classList.remove("visit-upload-dragover");
});

dropZone.addEventListener("drop", (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    dragDepth = 0;
    dropZone.classList.remove("visit-upload-dragover");
    addFiles(Array.from(e.dataTransfer.files));
});

// A file dropped just outside the box would otherwise make the browser leave
// the page to open it (losing the form), so ignore drops elsewhere.
window.addEventListener("dragover", (e) => { if (hasFiles(e)) e.preventDefault(); });
window.addEventListener("drop", (e) => { if (hasFiles(e)) e.preventDefault(); });


// -------------------------------------------------------------- validation

function setFieldError(field, message) {
    field.classList.toggle("visit-invalid", Boolean(message));
    field.querySelector(".visit-hint").textContent = message;
    return !message;
}

function validateSystem() {
    return setFieldError(systemField, chosenSystem() ? "" : "Please choose a system.");
}

function validateQuantities() {
    const system = chosenSystem();
    if (!system) return true; // reported by validateSystem()
    const { unit, battery } = SYSTEMS[system];
    const units = qty(row(system, "unit"));
    const batteries = qty(row(system, "battery"));
    let message = "";
    if (units + batteries === 0) {
        message = "Please add at least one product.";
    } else if (units > MAX_UNITS) {
        message = `Please choose up to ${MAX_UNITS} ${unit} units, or contact us for larger orders.`;
    } else if (batteries > batteryMax(system)) {
        message = `Each ${unit} supports up to ${BATTERIES_PER_UNIT} ${battery} batteries.`;
    }
    return setFieldError(qtyField, message);
}

function validateField(input) {
    const field = input.closest(".visit-field");
    if (!field) return input.checkValidity();
    if (input === fileInput) return setFieldError(field, fileProblem(chosenFiles));

    let message = "";
    if (input.validity.valueMissing) {
        message = "This field is required.";
    } else if (input.validity.typeMismatch && input.type === "email") {
        message = "Please enter a valid email address.";
    } else if (input.validity.patternMismatch && input.name === "phone") {
        message = "Please enter a valid phone number.";
    } else if (!input.checkValidity()) {
        message = input.validationMessage;
    }
    return setFieldError(field, message);
}

function validateForm() {
    let firstInvalid = null;

    if (!validateSystem()) firstInvalid = form.querySelector('[name="system"]');
    if (!validateQuantities() && !firstInvalid) firstInvalid = rowsFor(chosenSystem())[0].querySelector("input");

    form.querySelectorAll(".visit-grid .visit-field:not(.visit-system-field, .visit-qty-field) :is(input, select, textarea)").forEach((input) => {
        if (!validateField(input) && !firstInvalid) firstInvalid = input;
    });

    consent.closest(".visit-consent").classList.toggle("visit-invalid", !consent.checked);
    if (!consent.checked && !firstInvalid) firstInvalid = consent;

    if (firstInvalid) firstInvalid.focus();
    return !firstInvalid;
}

form.addEventListener("input", (e) => {
    if (e.target.name === "qty") return;
    const field = e.target.closest(".visit-field");
    if (field && field.classList.contains("visit-invalid")) validateField(e.target);
});

form.addEventListener("change", (e) => {
    if (e.target === consent) {
        consent.closest(".visit-consent").classList.toggle("visit-invalid", !consent.checked);
    } else if (e.target.name === "system") {
        showSystem(chosenSystem());
        validateSystem();
    }
});


// ------------------------------------------------------------------ submit

let firebasePromise = null;

function loadFirebase() {
    if (!firebasePromise) {
        const base = `https://www.gstatic.com/firebasejs/${FIREBASE_VERSION}`;
        firebasePromise = Promise.all([
            import(`${base}/firebase-app.js`),
            import(`${base}/firebase-firestore.js`),
            import(`${base}/firebase-storage.js`),
        ]).then(([appSdk, firestore, storage]) => {
            const app = appSdk.initializeApp(firebaseConfig);
            return { firestore, storage, db: firestore.getFirestore(app), bucket: storage.getStorage(app) };
        }).catch((err) => {
            firebasePromise = null;
            throw err;
        });
    }
    return firebasePromise;
}

function safeFileName(name) {
    return name.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(-80) || "file";
}

function showError(message) {
    error.textContent = message;
    error.hidden = false;
}

form.addEventListener("submit", async (e) => {
    e.preventDefault();
    error.hidden = true;
    if (!validateForm()) return;

    const data = new FormData(form);
    const value = (key) => String(data.get(key) || "").trim();

    // Bots that fill the hidden trap field get a fake success.
    if (value("website")) {
        showSuccess();
        return;
    }

    if (!isConfigured) {
        console.warn("Waitlist: Firebase isn't configured yet — see firebase-config.js");
        showError("Online sign-up isn't available just yet. Please email us at inquiries@hphtechsolutions.com.");
        return;
    }

    const files = chosenFiles;
    button.disabled = true;
    button.textContent = files.length ? "Uploading…" : "Sending…";

    try {
        const { firestore, storage, db, bucket } = await loadFirebase();
        const signupRef = firestore.doc(firestore.collection(db, COLLECTION));
        const write = (async () => {
            const attachments = [];
            for (const [i, file] of files.entries()) {
                const path = `${COLLECTION}/${signupRef.id}/${i + 1}-${safeFileName(file.name)}`;
                await storage.uploadBytes(storage.ref(bucket, path), file, { contentType: fileType(file) });
                attachments.push(path);
            }
            await firestore.setDoc(signupRef, {
                system: chosenSystem(),
                quantities: quantities(),
                // What the visitor was shown (starting prices), not a quotation.
                estimatedTotal: estimate(),
                name: tidyName(value("name")),
                phone: value("phone"),
                email: value("email"),
                address: tidyAddress(value("address")),
                message: value("message"),
                // Cloud Storage paths of the uploaded bill (see /storage.rules).
                // Left out when there's none, so sign-ups without a bill don't
                // depend on the newer rule that allows this field.
                ...(attachments.length ? { attachments } : {}),
                consent: true,
                sourcePage: decodeURIComponent(window.location.pathname).slice(0, 300),
                status: "new",
                createdAt: firestore.serverTimestamp(),
            });
        })();
        const timeout = new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), SUBMIT_TIMEOUT_MS));
        await Promise.race([write, timeout]);
        showSuccess();
    } catch (err) {
        console.error("Waitlist: submission failed", err);
        showError("Sorry, we couldn't add you to the waitlist. Please check your connection and try again, or email inquiries@hphtechsolutions.com.");
    } finally {
        button.disabled = false;
        button.textContent = "Join the Waitlist";
    }
});

// { "<product>": count } for the chosen system, leaving out zeros.
function quantities() {
    const system = chosenSystem();
    const result = {};
    for (const r of rowsFor(system)) {
        if (qty(r) > 0) result[r.dataset.product] = qty(r);
    }
    return result;
}

function showSuccess() {
    form.hidden = true;
    success.hidden = false;
    success.scrollIntoView({ block: "center" });
}
