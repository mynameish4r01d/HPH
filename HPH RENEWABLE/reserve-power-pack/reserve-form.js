// "Reserve a Power Pack" form.
//
// Saves each reservation to Firestore collection `waitlist` (the admin page's
// Waitlist tab) as system "Power Pack", with one product in `quantities`:
// "Power Pack" (Basic) or "Power Pack DIY Kit" (the Power Pack plus one Eco
// Comet 650 W panel, mounting equipment and PV cable), 1-10. Checked by
// isValidWaitlist()/isWaitlistOrder() in /firestore.rules.
//
// The Power Pack page links here with ?option=basic or ?option=diy-kit, which
// picks that option. Prices come from each option's data-price in index.html;
// keep them in step with the Power Pack page's tabs and WAITLIST_SYSTEMS in
// admin/admin.js.
//
// Firebase settings come from ../firebase-config.js. The Firebase SDK is only
// downloaded when someone submits.

import { firebaseConfig } from "../firebase-config.js";
import { tidyName, tidyAddress, tidyOnBlur } from "../text-format.js";
import { findReferrer, findReferrerByName, searchReferrers } from "../referral-codes.js";

const FIREBASE_VERSION = "12.3.0";
const COLLECTION = "waitlist";
const SYSTEM = "Power Pack";
const MAX_QTY = 10;
const SUBMIT_TIMEOUT_MS = 30000;

const isConfigured = Boolean(firebaseConfig && firebaseConfig.projectId && !firebaseConfig.projectId.startsWith("YOUR_"));

const form = document.querySelector(".visit-form");
tidyOnBlur(form.querySelector('[name="name"]'), tidyName);
tidyOnBlur(form.querySelector('[name="address"]'), tidyAddress);
const success = document.querySelector(".visit-success");
const error = form.querySelector(".visit-error");
const button = form.querySelector(".visit-submit");
const consent = form.querySelector('[name="consent"]');
const optionField = form.querySelector(".visit-system-field");
const qtyField = form.querySelector(".visit-qty-field");
const qtyInput = qtyField.querySelector('[name="qty"]');
const qtyName = qtyField.querySelector(".visit-qty-name");
const estimateLines = qtyField.querySelector(".visit-estimate-lines");
const estimateAmount = qtyField.querySelector(".visit-estimate-amount");
const BUTTON_TEXT = button.textContent;


// ------------------------------------------------------- option + quantity

const chosenRadio = () => form.querySelector('[name="option"]:checked');

function qty() {
    const n = parseInt(qtyInput.value, 10);
    return Number.isFinite(n) ? Math.min(Math.max(n, 1), MAX_QTY) : 1;
}

const peso = (amount) => `₱${amount.toLocaleString("en-PH")}`;

// What the visitor was shown (starting price × quantity), not a quotation.
function estimate() {
    const radio = chosenRadio();
    return radio ? qty() * (Number(radio.dataset.price) || 0) : 0;
}

function refresh() {
    const radio = chosenRadio();
    const n = qty();
    qtyField.querySelector('[data-step="-1"]').disabled = n <= 1;
    qtyField.querySelector('[data-step="1"]').disabled = n >= MAX_QTY;
    qtyName.textContent = radio ? radio.value : "Power Pack";
    if (radio) {
        const line = document.createElement("li");
        const label = document.createElement("span");
        label.textContent = `${n} × ${radio.value}`;
        const amount = document.createElement("span");
        amount.textContent = peso(estimate());
        line.append(label, amount);
        estimateLines.replaceChildren(line);
    } else {
        estimateLines.replaceChildren();
    }
    estimateAmount.textContent = peso(estimate());
}

qtyField.addEventListener("click", (e) => {
    const step = e.target.closest(".visit-step");
    if (!step) return;
    qtyInput.value = Math.min(Math.max(qty() + Number(step.dataset.step), 1), MAX_QTY);
    refresh();
});
qtyInput.addEventListener("input", refresh);
// Tidy a typed value once the field is left (e.g. empty -> 1, 99 -> 10).
qtyInput.addEventListener("blur", () => {
    qtyInput.value = qty();
    refresh();
});

// Opened from the Power Pack page: pick the option it was showing.
const params = new URLSearchParams(window.location.search);
const linked = form.querySelector(`[name="option"][data-option="${CSS.escape(params.get("option") || "")}"]`);
if (linked) linked.checked = true;
refresh();


// ---------------------------------------------------------- referral code
// Optional; if typed it must be a sales team code (../referral-codes.js), as
// on the Schedule a Visit form. A full name that fits one person counts as
// their code, and the code is what's saved. Links can carry ?ref=<code>.

const referralInput = form.querySelector('[name="referralCode"]');
const referralList = form.querySelector(".visit-referral-suggest");
let referralActive = -1;

const resolveReferrer = (text) => findReferrer(text) || findReferrerByName(text);

function closeReferralList() {
    referralList.hidden = true;
    referralList.replaceChildren();
    referralActive = -1;
}

function markReferral(index) {
    const options = referralList.querySelectorAll(".visit-address-option");
    referralActive = options.length ? (index + options.length) % options.length : -1;
    options.forEach((option, i) => option.setAttribute("aria-selected", String(i === referralActive)));
}

function showReferralList() {
    const text = referralInput.value.trim();
    const matches = text && !findReferrer(text) ? searchReferrers(text).slice(0, 5) : [];
    if (!matches.length) return closeReferralList();
    referralList.replaceChildren(...matches.map((person) => {
        const option = document.createElement("li");
        option.className = "visit-address-option";
        option.setAttribute("role", "option");
        const main = document.createElement("span");
        main.className = "visit-address-main";
        main.textContent = person.name;
        const sub = document.createElement("span");
        sub.className = "visit-address-sub";
        sub.textContent = person.code;
        option.append(main, sub);
        // mousedown, so it's picked before the box loses focus.
        option.addEventListener("mousedown", (e) => {
            e.preventDefault();
            pickReferral(person);
        });
        option.person = person;
        return option;
    }));
    referralList.hidden = false;
    markReferral(-1);
}

function pickReferral(person) {
    referralInput.value = person.code;
    closeReferralList();
    checkReferral();
}

function checkReferral() {
    const field = referralInput.closest(".visit-field");
    const hint = field.querySelector(".visit-hint");
    const text = referralInput.value.trim();
    const person = text ? resolveReferrer(text) : null;
    hint.classList.toggle("visit-hint-ok", Boolean(person));
    if (!text) return setFieldError(field, "");
    if (person) {
        if (referralInput.value.trim() !== person.code && document.activeElement !== referralInput) referralInput.value = person.code;
        field.classList.remove("visit-invalid");
        hint.textContent = `Referred by ${person.name}`;
        return true;
    }
    return setFieldError(field, "That is not a real referral code. Please check it, or leave it blank.");
}

const referral = params.get("ref");
if (referral) {
    referralInput.value = referral.trim().slice(0, 50);
    checkReferral();
}
referralInput.addEventListener("input", () => {
    const field = referralInput.closest(".visit-field");
    showReferralList();
    if (resolveReferrer(referralInput.value) || !referralInput.value.trim() || field.classList.contains("visit-invalid")) {
        checkReferral();
    } else {
        // Mid-typing: drop an earlier "Referred by …" without an error yet.
        const hint = field.querySelector(".visit-hint");
        hint.textContent = "";
        hint.classList.remove("visit-hint-ok");
    }
});
referralInput.addEventListener("blur", () => {
    closeReferralList();
    checkReferral();
});
referralInput.addEventListener("keydown", (e) => {
    if (referralList.hidden) return;
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        markReferral(referralActive + (e.key === "ArrowDown" ? 1 : -1));
    } else if (e.key === "Enter" && referralActive >= 0) {
        e.preventDefault();
        pickReferral(referralList.children[referralActive].person);
    } else if (e.key === "Escape") {
        closeReferralList();
    }
});


// -------------------------------------------------------------- validation

function setFieldError(field, message) {
    field.classList.toggle("visit-invalid", Boolean(message));
    const hint = field.querySelector(".visit-hint");
    hint.classList.remove("visit-hint-ok");
    hint.textContent = message;
    return !message;
}

function validateOption() {
    return setFieldError(optionField, chosenRadio() ? "" : "Please choose Basic or DIY Kit.");
}

function validateField(input) {
    const field = input.closest(".visit-field");
    if (!field) return input.checkValidity();
    if (input === referralInput) return checkReferral();

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
    if (!validateOption()) firstInvalid = form.querySelector('[name="option"]');

    form.querySelectorAll(".visit-grid .visit-field:not(.visit-system-field, .visit-qty-field) :is(input, select, textarea)").forEach((input) => {
        if (!validateField(input) && !firstInvalid) firstInvalid = input;
    });

    consent.closest(".visit-consent").classList.toggle("visit-invalid", !consent.checked);
    if (!consent.checked && !firstInvalid) firstInvalid = consent;

    if (firstInvalid) firstInvalid.focus();
    return !firstInvalid;
}

form.addEventListener("input", (e) => {
    if (e.target.name === "qty" || e.target === referralInput) return;
    const field = e.target.closest(".visit-field");
    if (field && field.classList.contains("visit-invalid")) validateField(e.target);
});

form.addEventListener("change", (e) => {
    if (e.target === consent) {
        consent.closest(".visit-consent").classList.toggle("visit-invalid", !consent.checked);
    } else if (e.target.name === "option") {
        validateOption();
        refresh();
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
        console.warn("Reserve: Firebase isn't configured yet — see firebase-config.js");
        showError("Online reservations aren't available just yet. Please email us at inquiries@hphtechsolutions.com.");
        return;
    }

    const referrer = value("referralCode") ? resolveReferrer(value("referralCode")) : null;
    button.disabled = true;
    button.textContent = "Sending…";

    try {
        const { firestore, db } = await loadFirebase();
        const write = firestore.addDoc(firestore.collection(db, COLLECTION), {
            system: SYSTEM,
            quantities: { [chosenRadio().value]: qty() },
            estimatedTotal: estimate(),
            name: tidyName(value("name")),
            phone: value("phone"),
            email: value("email"),
            address: tidyAddress(value("address")),
            message: "",
            // The official spelling of a valid code; left out when blank.
            ...(referrer ? { referralCode: referrer.code } : {}),
            consent: true,
            sourcePage: decodeURIComponent(window.location.pathname).slice(0, 300),
            status: "new",
            createdAt: firestore.serverTimestamp(),
        });
        const timeout = new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), SUBMIT_TIMEOUT_MS));
        await Promise.race([write, timeout]);
        showSuccess();
    } catch (err) {
        console.error("Reserve: submission failed", err);
        showError("Sorry, we couldn't send your reservation. Please check your connection and try again, or email inquiries@hphtechsolutions.com.");
    } finally {
        button.disabled = false;
        button.textContent = BUTTON_TEXT;
    }
});

function showSuccess() {
    form.hidden = true;
    success.hidden = false;
    success.scrollIntoView({ block: "center" });
}
