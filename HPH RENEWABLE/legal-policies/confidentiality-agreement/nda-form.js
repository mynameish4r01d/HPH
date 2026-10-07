// Confidentiality Agreement (NDA) form.
//
// Saves each response to Firestore (collection: ndaResponses) in the same
// Firebase project as the Schedule a Visit and Feedback forms. View them in
// the Firebase console → Firestore → ndaResponses. Security rules:
// /firestore.rules (isValidNdaResponse) — the public may only submit.
//
// Firebase settings come from ../../firebase-config.js. The Firebase SDK is
// only downloaded when someone submits.

import { firebaseConfig } from "../../firebase-config.js";

const FIREBASE_VERSION = "12.3.0";
const COLLECTION = "ndaResponses";
const SUBMIT_TIMEOUT_MS = 20000;
// Bump when the agreement wording on the page changes, so each response
// records which wording it agreed to (keep in step with firestore.rules).
const STATEMENT_VERSION = "2026-10";

const isConfigured = Boolean(firebaseConfig && firebaseConfig.projectId && !firebaseConfig.projectId.startsWith("YOUR_"));

const form = document.querySelector(".visit-form");
const success = document.querySelector(".visit-success");
const error = form.querySelector(".visit-error");
const button = form.querySelector(".visit-submit");
const responseField = form.querySelector(".nda-response-field");

// "The date below": today, in the visitor's own time zone.
const now = new Date();
const isoDate = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
form.querySelector(".nda-date").textContent = now.toLocaleDateString("en-PH", { year: "numeric", month: "long", day: "numeric" });


// -------------------------------------------------------------- validation

function setFieldError(field, message) {
    field.classList.toggle("visit-invalid", Boolean(message));
    field.querySelector(".visit-hint").textContent = message;
    return !message;
}

function validateResponse() {
    const chosen = form.querySelector('[name="response"]:checked');
    return setFieldError(responseField, chosen ? "" : "Please choose I Agree or I Do Not Agree.");
}

function validateField(input) {
    if (input.name === "response") return validateResponse();
    const field = input.closest(".visit-field");
    if (!field) return input.checkValidity();

    let message = "";
    if (input.validity.valueMissing) {
        message = "This field is required.";
    } else if (input.validity.typeMismatch && input.type === "email") {
        message = "Please enter a valid email address.";
    } else if (!input.checkValidity()) {
        message = input.validationMessage;
    }
    return setFieldError(field, message);
}

function validateForm() {
    let firstInvalid = null;

    form.querySelectorAll(".visit-grid input").forEach((input) => {
        if (!validateField(input) && !firstInvalid) firstInvalid = input;
    });
    if (!validateResponse() && !firstInvalid) firstInvalid = form.querySelector('[name="response"]');

    if (firstInvalid) firstInvalid.focus();
    return !firstInvalid;
}

form.addEventListener("input", (e) => {
    const field = e.target.closest(".visit-field");
    if (field && field.classList.contains("visit-invalid")) validateField(e.target);
});

form.addEventListener("change", (e) => {
    if (e.target.name === "response") validateResponse();
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
    const response = value("response");

    // Bots that fill the hidden trap field get a fake success.
    if (value("website")) {
        showSuccess(response);
        return;
    }

    if (!isConfigured) {
        console.warn("NDA: Firebase isn't configured yet — see firebase-config.js");
        showError("Online responses aren't available just yet. Please email us at inquiries@hphtechsolutions.com.");
        return;
    }

    button.disabled = true;
    button.textContent = "Submitting…";

    try {
        const { firestore, db } = await loadFirebase();
        const write = firestore.addDoc(firestore.collection(db, COLLECTION), {
            fullName: value("fullName"),
            email: value("email"),
            phone: value("phone"),
            reference: value("reference"),
            response,
            agreementDate: isoDate,
            statementVersion: STATEMENT_VERSION,
            sourcePage: decodeURIComponent(window.location.pathname).slice(0, 300),
            status: "new",
            createdAt: firestore.serverTimestamp(),
        });
        const timeout = new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), SUBMIT_TIMEOUT_MS));
        await Promise.race([write, timeout]);
        showSuccess(response);
    } catch (err) {
        console.error("NDA: submission failed", err);
        showError("Sorry, we couldn't record your response. Please check your connection and try again, or email inquiries@hphtechsolutions.com.");
    } finally {
        button.disabled = false;
        button.textContent = "Submit Response";
    }
});

function showSuccess(response) {
    const text = success.querySelector(".visit-success-text");
    text.textContent = response === "agree" ? text.dataset.agree : text.dataset.disagree;
    form.hidden = true;
    success.hidden = false;
    success.scrollIntoView({ block: "center" });
}
