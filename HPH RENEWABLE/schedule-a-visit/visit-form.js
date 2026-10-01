// "Schedule a Visit" form.
//
// Saves each request to Firestore (collection: visitRequests) and any
// attached files to Cloud Storage under visitRequests/<request id>/. View
// them in the Firebase console: Firestore → visitRequests, Storage →
// visitRequests. Security rules: /firestore.rules and /storage.rules.
//
// Firebase settings come from ../firebase-config.js. The Firebase SDK is
// only downloaded when someone submits.

import { firebaseConfig } from "../firebase-config.js";

const FIREBASE_VERSION = "12.3.0";
const COLLECTION = "visitRequests";
const SUBMIT_TIMEOUT_MS = 90000;

// Uploads — keep in step with /storage.rules and /firestore.rules.
const MAX_FILES = 3;
const MAX_FILE_BYTES = 10 * 1024 * 1024;
const ACCEPTED_TYPE = /^(image\/.+|application\/pdf)$/;
// Photos bigger than this (JPEG/PNG/WebP) are shrunk in the browser before
// upload: phone photos can exceed 10 MB, and smaller files upload faster.
// Bills stay readable at 2400px on the long edge.
const SHRINK_OVER_BYTES = 2 * 1024 * 1024;
const SHRINK_MAX_EDGE = 2400;
const SHRINKABLE_TYPE = /^image\/(jpeg|png|webp)$/;

const PRODUCTS = ["MX2250", "MSU4000 Elite", "MAU5000 Elite", "B4000 Elite", "B5000 Elite"];

const isConfigured = Boolean(firebaseConfig && firebaseConfig.projectId && !firebaseConfig.projectId.startsWith("YOUR_"));

const form = document.querySelector(".visit-form");
const success = document.querySelector(".visit-success");
const error = form.querySelector(".visit-error");
const button = form.querySelector(".visit-submit");
const fileInput = form.querySelector('[name="files"]');
const fileList = form.querySelector(".visit-file-list");

// Files chosen so far. Each pick adds to this list (a file input on its own
// replaces the previous pick), so bills can be added one at a time.
// `sourceKeys` remembers each original file (name, size, date) so picking the
// same one twice is ignored even after it was shrunk and renamed.
let chosenFiles = [];
let sourceKeys = [];
const sourceKey = (f) => `${f.name}|${f.size}|${f.lastModified}`;

// Dates from today onward (local time).
const today = new Date();
form.querySelector('[name="preferredDate"]').min =
    new Date(today.getTime() - today.getTimezoneOffset() * 60000).toISOString().slice(0, 10);

// Product pages link here with ?product=<name>; pre-select it.
const product = new URLSearchParams(window.location.search).get("product");
if (PRODUCTS.includes(product)) form.querySelector('[name="product"]').value = product;

// Referral links can carry ?ref=<code>; pre-fill it.
const referral = new URLSearchParams(window.location.search).get("ref");
if (referral) form.querySelector('[name="referralCode"]').value = referral.trim().slice(0, 50);


// -------------------------------------------------------------- validation

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
        console.warn("Schedule a Visit: couldn't shrink image, uploading as is", err);
        return file;
    }
}

function fileProblem(files) {
    if (files.length > MAX_FILES) return `Please choose up to ${MAX_FILES} files.`;
    if (files.some((f) => !ACCEPTED_TYPE.test(fileType(f)))) return "Only images or PDF files can be uploaded.";
    if (files.some((f) => f.size > MAX_FILE_BYTES)) return "Each file must be 10 MB or smaller.";
    return "";
}

function setFieldError(field, message) {
    field.classList.toggle("visit-invalid", Boolean(message));
    field.querySelector(".visit-hint").textContent = message;
    return !message;
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
    } else if (input.validity.rangeUnderflow) {
        message = "Please choose a date from today onward.";
    } else if (!input.checkValidity()) {
        message = input.validationMessage;
    }
    return setFieldError(field, message);
}

function validateForm() {
    let firstInvalid = null;

    form.querySelectorAll(".visit-field input, .visit-field select, .visit-field textarea").forEach((input) => {
        if (!validateField(input) && !firstInvalid) firstInvalid = input;
    });

    const consent = form.querySelector('[name="consent"]');
    consent.closest(".visit-consent").classList.toggle("visit-invalid", !consent.checked);
    if (!consent.checked && !firstInvalid) firstInvalid = consent;

    if (firstInvalid) firstInvalid.focus();
    return !firstInvalid;
}

form.addEventListener("input", (e) => {
    const field = e.target.closest(".visit-field");
    if (field && field.classList.contains("visit-invalid")) validateField(e.target);
});

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
        console.warn("Schedule a Visit: Firebase isn't configured yet — see firebase-config.js");
        showError("Online requests aren't available just yet. Please call us at (+63) 2 880 84735 or email inquiries@hphtechsolutions.com.");
        return;
    }

    const files = chosenFiles;
    button.disabled = true;
    button.textContent = files.length ? "Uploading…" : "Sending…";

    try {
        const { firestore, storage, db, bucket } = await loadFirebase();
        const requestRef = firestore.doc(firestore.collection(db, COLLECTION));

        const work = (async () => {
            const attachments = [];
            for (const [i, file] of files.entries()) {
                const path = `${COLLECTION}/${requestRef.id}/${i + 1}-${safeFileName(file.name)}`;
                await storage.uploadBytes(storage.ref(bucket, path), file, { contentType: fileType(file) });
                attachments.push(path);
            }

            await firestore.setDoc(requestRef, {
                name: value("name"),
                phone: value("phone"),
                email: value("email"),
                address: value("address"),
                propertyType: value("propertyType"),
                product: value("product"),
                monthlyBill: value("monthlyBill"),
                preferredDate: value("preferredDate"),
                preferredTime: value("preferredTime"),
                message: value("message"),
                // Upper-cased so "juan01" and "JUAN01" group together in the admin page.
                referralCode: value("referralCode").toUpperCase().slice(0, 50),
                attachments,
                consent: true,
                sourcePage: decodeURIComponent(window.location.pathname).slice(0, 300),
                status: "new",
                createdAt: firestore.serverTimestamp(),
            });
        })();

        const timeout = new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), SUBMIT_TIMEOUT_MS));
        await Promise.race([work, timeout]);
        showSuccess();
    } catch (err) {
        console.error("Schedule a Visit: submission failed", err);
        showError("Sorry, we couldn't send your request. Please check your connection and try again, or call us at (+63) 2 880 84735.");
    } finally {
        button.disabled = false;
        button.textContent = "Request a Visit";
    }
});

function showSuccess() {
    form.hidden = true;
    success.hidden = false;
    success.scrollIntoView({ block: "center" });
}
