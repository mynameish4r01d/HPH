// "Share Your Experience" feedback form.
//
// Saves each submission to Firestore (collection: feedback) in the same
// Firebase project as the Schedule a Visit form. View them in the Firebase
// console → Firestore → feedback. Security rules: /firestore.rules.
//
// Firebase settings come from ../firebase-config.js. The Firebase SDK is
// only downloaded when someone submits.

import { firebaseConfig } from "../firebase-config.js";
import { tidyName, tidyOnBlur } from "../text-format.js";

const FIREBASE_VERSION = "12.3.0";
const COLLECTION = "feedback";
const SUBMIT_TIMEOUT_MS = 20000;

const isConfigured = Boolean(firebaseConfig && firebaseConfig.projectId && !firebaseConfig.projectId.startsWith("YOUR_"));

const form = document.querySelector(".visit-form");
// Names typed in ALL CAPS or all lowercase are tidied when the visitor
// leaves the field, e.g. "harold t. hermosa" → "Harold T. Hermosa".
tidyOnBlur(form.querySelector('[name="name"]'), tidyName);
const success = document.querySelector(".visit-success");
const error = form.querySelector(".visit-error");
const button = form.querySelector(".visit-submit");
const ratingField = form.querySelector(".visit-rating-field");


// -------------------------------------------------------------- validation

function setFieldError(field, message) {
    field.classList.toggle("visit-invalid", Boolean(message));
    field.querySelector(".visit-hint").textContent = message;
    return !message;
}

function validateRating() {
    const chosen = form.querySelector('[name="rating"]:checked');
    return setFieldError(ratingField, chosen ? "" : "Please choose a rating.");
}

function validateField(input) {
    if (input.name === "rating") return validateRating();
    const field = input.closest(".visit-field");
    if (!field) return input.checkValidity();

    let message = "";
    if (input.validity.valueMissing) {
        message = "This field is required.";
    } else if (!input.checkValidity()) {
        message = input.validationMessage;
    }
    return setFieldError(field, message);
}

function validateForm() {
    let firstInvalid = null;

    if (!validateRating()) firstInvalid = form.querySelector('[name="rating"]');

    form.querySelectorAll(".visit-grid input, .visit-grid textarea").forEach((input) => {
        if (!validateField(input) && !firstInvalid) firstInvalid = input;
    });

    if (firstInvalid) firstInvalid.focus();
    return !firstInvalid;
}

form.addEventListener("input", (e) => {
    const field = e.target.closest(".visit-field");
    if (field && field.classList.contains("visit-invalid")) validateField(e.target);
});

form.addEventListener("change", (e) => {
    if (e.target.name === "rating") validateRating();
});


// ------------------------------------------------------------------ submit

let firebasePromise = null;

function loadFirebase() {
    if (!firebasePromise) {
        const base = `https://www.gstatic.com/firebasejs/${FIREBASE_VERSION}`;
        firebasePromise = Promise.all([
            import(`${base}/firebase-app.js`),
            import(`${base}/firebase-firestore.js`),
        ]).then(([appSdk, firestore]) => {
            const app = appSdk.initializeApp(firebaseConfig);
            return { firestore, db: firestore.getFirestore(app) };
        }).catch((err) => {
            firebasePromise = null;
            throw err;
        });
    }
    return firebasePromise;
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
        console.warn("Feedback: Firebase isn't configured yet — see firebase-config.js");
        showError("Online feedback isn't available just yet. Please email us at inquiries@hphtechsolutions.com.");
        return;
    }

    button.disabled = true;
    button.textContent = "Sending…";

    try {
        const { firestore, db } = await loadFirebase();
        const write = firestore.addDoc(firestore.collection(db, COLLECTION), {
            rating: Number(value("rating")),
            message: value("message"),
            name: tidyName(value("name")),
            contact: value("contact"),
            allowPublish: data.get("allowPublish") === "on",
            sourcePage: decodeURIComponent(window.location.pathname).slice(0, 300),
            status: "new",
            createdAt: firestore.serverTimestamp(),
        });
        const timeout = new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), SUBMIT_TIMEOUT_MS));
        await Promise.race([write, timeout]);
        showSuccess();
    } catch (err) {
        console.error("Feedback: submission failed", err);
        showError("Sorry, we couldn't send your feedback. Please check your connection and try again, or email inquiries@hphtechsolutions.com.");
    } finally {
        button.disabled = false;
        button.textContent = "Send Feedback";
    }
});

function showSuccess() {
    form.hidden = true;
    success.hidden = false;
    success.scrollIntoView({ block: "center" });
}
