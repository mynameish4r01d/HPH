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

const PRODUCTS = ["MX2250", "MSU4000 Elite", "MAU5000 Elite", "B4000 Elite", "B5000 Elite"];

const isConfigured = Boolean(firebaseConfig && firebaseConfig.projectId && !firebaseConfig.projectId.startsWith("YOUR_"));

const form = document.querySelector(".visit-form");
const success = document.querySelector(".visit-success");
const error = form.querySelector(".visit-error");
const button = form.querySelector(".visit-submit");
const fileInput = form.querySelector('[name="files"]');
const fileList = form.querySelector(".visit-file-list");

// Dates from today onward (local time).
const today = new Date();
form.querySelector('[name="preferredDate"]').min =
    new Date(today.getTime() - today.getTimezoneOffset() * 60000).toISOString().slice(0, 10);

// Product pages link here with ?product=<name>; pre-select it.
const product = new URLSearchParams(window.location.search).get("product");
if (PRODUCTS.includes(product)) form.querySelector('[name="product"]').value = product;


// -------------------------------------------------------------- validation

function formatSize(bytes) {
    return bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

function fileProblem(files) {
    if (files.length > MAX_FILES) return `Please choose up to ${MAX_FILES} files.`;
    if (files.some((f) => !ACCEPTED_TYPE.test(f.type))) return "Only images or PDF files can be uploaded.";
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

    if (input === fileInput) return setFieldError(field, fileProblem(Array.from(fileInput.files)));

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

fileInput.addEventListener("change", () => {
    fileList.innerHTML = "";
    Array.from(fileInput.files).forEach((file) => {
        const item = document.createElement("li");
        const name = document.createElement("span");
        name.className = "visit-file-name";
        name.textContent = file.name;
        const size = document.createElement("span");
        size.className = "visit-file-size";
        size.textContent = formatSize(file.size);
        item.append(name, size);
        fileList.appendChild(item);
    });
    validateField(fileInput);
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
        console.warn("Schedule a Visit: Firebase isn't configured yet — see firebase-config.js");
        showError("Online requests aren't available just yet. Please call us at (+63) 2 880 84735 or email inquiries@hphtechsolutions.com.");
        return;
    }

    const files = Array.from(fileInput.files);
    button.disabled = true;
    button.textContent = files.length ? "Uploading…" : "Sending…";

    try {
        const { firestore, storage, db, bucket } = await loadFirebase();
        const requestRef = firestore.doc(firestore.collection(db, COLLECTION));

        const work = (async () => {
            const attachments = [];
            for (const [i, file] of files.entries()) {
                const path = `${COLLECTION}/${requestRef.id}/${i + 1}-${safeFileName(file.name)}`;
                await storage.uploadBytes(storage.ref(bucket, path), file, { contentType: file.type });
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
