// Built-in "Schedule a Visit" form.
//
// Every link on the page that points at the old Schedule a Visit Google Form
// opens this form in a dialog instead, and submissions are saved to Firestore
// (collection: visitRequests). View them in the Firebase console → Firestore.
//
// If Firebase isn't configured yet (see firebase-config.js) or this script
// fails to load, the links simply keep opening the Google Form.

import { firebaseConfig } from "./firebase-config.js";

const SCHEDULE_LINK = "forms.gle/orQuM7UsENUJpYNd6";
const FIREBASE_VERSION = "12.3.0";
const COLLECTION = "visitRequests";
const SUBMIT_TIMEOUT_MS = 15000;

const PRODUCTS = ["MX2250", "MSU4000 Elite", "MAU5000 Elite", "B4000 Elite", "B5000 Elite"];

const isConfigured = Boolean(firebaseConfig && firebaseConfig.projectId && !firebaseConfig.projectId.startsWith("YOUR_"));

if (isConfigured) {
    init();
}

function init() {
    const stylesheet = document.createElement("link");
    stylesheet.rel = "stylesheet";
    stylesheet.href = new URL("schedule-visit.css", import.meta.url).href;
    document.head.appendChild(stylesheet);

    let dialog = null;

    document.addEventListener("click", (e) => {
        const link = e.target.closest(`a[href*="${SCHEDULE_LINK}"]`);
        if (!link) return;
        e.preventDefault();

        // Close the mobile menu first if the tap came from inside it.
        const menuBtn = document.querySelector(".mobile .menu");
        if (menuBtn && menuBtn.classList.contains("active")) menuBtn.click();

        if (!dialog) dialog = buildDialog();
        openDialog(dialog);
    });
}


// ------------------------------------------------------------------ dialog

function buildDialog() {
    const privacyHref = new URL("legal-policies/privacy-policy/index.html", import.meta.url).href;
    const today = new Date();
    const minDate = new Date(today.getTime() - today.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
    const productOptions = PRODUCTS.map((p) => `<option value="${p}">${p}</option>`).join("");

    const dialog = document.createElement("dialog");
    dialog.className = "sv-dialog";
    dialog.setAttribute("aria-labelledby", "sv-title");
    dialog.innerHTML = `
        <div class="sv-header">
            <div class="sv-heading" id="sv-title">Schedule a Visit</div>
            <button type="button" class="sv-close" aria-label="Close">
                <span class="material-symbols-rounded">close</span>
            </button>
        </div>

        <div class="sv-body">
            <form class="sv-form" novalidate>
                <p class="sv-intro">Tell us a little about your property and we'll get in touch to confirm a site visit.</p>

                <div class="sv-grid">
                    <label class="sv-field">
                        <span class="sv-label">Full name</span>
                        <input type="text" name="name" autocomplete="name" required maxlength="100">
                        <span class="sv-hint"></span>
                    </label>

                    <label class="sv-field">
                        <span class="sv-label">Mobile number</span>
                        <input type="tel" name="phone" autocomplete="tel" inputmode="tel" placeholder="09XX XXX XXXX" required pattern="[0-9+\\(\\)\\-\\s]{7,30}" maxlength="30">
                        <span class="sv-hint"></span>
                    </label>

                    <label class="sv-field">
                        <span class="sv-label">Email <span class="sv-optional">(optional)</span></span>
                        <input type="email" name="email" autocomplete="email" maxlength="200">
                        <span class="sv-hint"></span>
                    </label>

                    <label class="sv-field">
                        <span class="sv-label">Property type</span>
                        <select name="propertyType" required>
                            <option value="" disabled selected>Select one</option>
                            <option value="Residential">Residential</option>
                            <option value="Commercial">Commercial</option>
                            <option value="Industrial">Industrial</option>
                        </select>
                        <span class="sv-hint"></span>
                    </label>

                    <label class="sv-field sv-span">
                        <span class="sv-label">Property address</span>
                        <input type="text" name="address" autocomplete="street-address" placeholder="Street, barangay, city" required maxlength="300">
                        <span class="sv-hint"></span>
                    </label>

                    <label class="sv-field">
                        <span class="sv-label">Product of interest</span>
                        <select name="product">
                            <option value="Not sure yet">Not sure yet</option>
                            ${productOptions}
                        </select>
                        <span class="sv-hint"></span>
                    </label>

                    <label class="sv-field">
                        <span class="sv-label">Average monthly electric bill</span>
                        <select name="monthlyBill">
                            <option value="">Prefer not to say</option>
                            <option value="Below ₱3,000">Below ₱3,000</option>
                            <option value="₱3,000 – ₱6,000">₱3,000 – ₱6,000</option>
                            <option value="₱6,000 – ₱10,000">₱6,000 – ₱10,000</option>
                            <option value="Above ₱10,000">Above ₱10,000</option>
                        </select>
                        <span class="sv-hint"></span>
                    </label>

                    <label class="sv-field">
                        <span class="sv-label">Preferred visit date <span class="sv-optional">(optional)</span></span>
                        <input type="date" name="preferredDate" min="${minDate}">
                        <span class="sv-hint"></span>
                    </label>

                    <label class="sv-field">
                        <span class="sv-label">Preferred time</span>
                        <select name="preferredTime">
                            <option value="Any time">Any time</option>
                            <option value="Morning (9AM – 12PM)">Morning (9AM – 12PM)</option>
                            <option value="Afternoon (1PM – 5PM)">Afternoon (1PM – 5PM)</option>
                        </select>
                        <span class="sv-hint"></span>
                    </label>

                    <label class="sv-field sv-span">
                        <span class="sv-label">Message <span class="sv-optional">(optional)</span></span>
                        <textarea name="message" rows="3" maxlength="2000" placeholder="Anything we should know before the visit?"></textarea>
                        <span class="sv-hint"></span>
                    </label>
                </div>

                <!-- Spam trap: hidden from people, often filled in by bots. -->
                <input type="text" name="website" class="sv-trap" tabindex="-1" autocomplete="off" aria-hidden="true">

                <label class="sv-consent">
                    <input type="checkbox" name="consent" required>
                    <span>I agree to HPH Renewable using these details to arrange my visit, as described in the <a href="${privacyHref}" target="_blank" rel="noopener">Privacy Policy</a>.</span>
                </label>

                <p class="sv-error" role="alert" hidden></p>

                <button type="submit" class="sv-submit">Request a Visit</button>
            </form>

            <div class="sv-success" hidden>
                <span class="material-symbols-rounded sv-success-icon">check_circle</span>
                <div class="sv-success-title">Request received</div>
                <p class="sv-success-text">Thank you — we'll contact you soon to confirm your visit.</p>
                <button type="button" class="sv-submit sv-done">Done</button>
            </div>
        </div>
    `;

    document.body.appendChild(dialog);

    const form = dialog.querySelector(".sv-form");

    dialog.querySelector(".sv-close").addEventListener("click", () => dialog.close());
    dialog.querySelector(".sv-done").addEventListener("click", () => dialog.close());

    // Clicking the dimmed backdrop (outside the panel) closes the dialog.
    dialog.addEventListener("click", (e) => {
        if (e.target === dialog) dialog.close();
    });

    dialog.addEventListener("close", () => {
        document.body.classList.remove("sv-open");
        if (!dialog.querySelector(".sv-success").hidden) resetDialog(dialog);
    });

    form.addEventListener("input", (e) => {
        const field = e.target.closest(".sv-field");
        if (field && field.classList.contains("sv-invalid")) validateField(e.target);
    });

    form.addEventListener("submit", (e) => {
        e.preventDefault();
        submit(dialog);
    });

    return dialog;
}

function openDialog(dialog) {
    preselectProduct(dialog);
    document.body.classList.add("sv-open");
    dialog.showModal();
    dialog.querySelector(".sv-body").scrollTop = 0;
}

// On a product page, pre-select that product.
function preselectProduct(dialog) {
    const heading = document.querySelector(".mobile-product-head .mobile-page-title, .text-container-content > .title");
    const name = heading ? heading.textContent.trim() : "";
    if (PRODUCTS.includes(name)) dialog.querySelector('[name="product"]').value = name;
}

function resetDialog(dialog) {
    dialog.querySelector(".sv-form").reset();
    dialog.querySelector(".sv-form").hidden = false;
    dialog.querySelector(".sv-success").hidden = true;
    dialog.querySelector(".sv-error").hidden = true;
    dialog.querySelectorAll(".sv-invalid").forEach((el) => el.classList.remove("sv-invalid"));
}


// -------------------------------------------------------------- validation

function validateField(input) {
    const field = input.closest(".sv-field");
    if (!field) return input.checkValidity();

    const hint = field.querySelector(".sv-hint");
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

    field.classList.toggle("sv-invalid", Boolean(message));
    hint.textContent = message;
    return !message;
}

function validateForm(form) {
    let firstInvalid = null;

    form.querySelectorAll(".sv-field input, .sv-field select, .sv-field textarea").forEach((input) => {
        if (!validateField(input) && !firstInvalid) firstInvalid = input;
    });

    const consent = form.querySelector('[name="consent"]');
    const consentLabel = consent.closest(".sv-consent");
    consentLabel.classList.toggle("sv-invalid", !consent.checked);
    if (!consent.checked && !firstInvalid) firstInvalid = consent;

    if (firstInvalid) firstInvalid.focus();
    return !firstInvalid;
}


// ------------------------------------------------------------------ submit

let firebasePromise = null;

// Loaded on first submit, so pages don't pay for Firebase until it's needed.
function loadFirebase() {
    if (!firebasePromise) {
        const base = `https://www.gstatic.com/firebasejs/${FIREBASE_VERSION}`;
        firebasePromise = Promise.all([
            import(`${base}/firebase-app.js`),
            import(`${base}/firebase-firestore.js`),
        ]).then(([appSdk, firestoreSdk]) => {
            const app = appSdk.initializeApp(firebaseConfig);
            return { firestore: firestoreSdk, db: firestoreSdk.getFirestore(app) };
        }).catch((err) => {
            firebasePromise = null;
            throw err;
        });
    }
    return firebasePromise;
}

async function submit(dialog) {
    const form = dialog.querySelector(".sv-form");
    const error = dialog.querySelector(".sv-error");
    const button = form.querySelector(".sv-submit");

    error.hidden = true;
    if (!validateForm(form)) return;

    const data = new FormData(form);
    const value = (key) => String(data.get(key) || "").trim();

    // Bots that fill the hidden trap field get a fake success.
    if (value("website")) {
        showSuccess(dialog);
        return;
    }

    const request = {
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
        consent: true,
        sourcePage: decodeURIComponent(window.location.pathname).slice(0, 300),
        status: "new",
    };

    button.disabled = true;
    button.textContent = "Sending…";

    try {
        const { firestore, db } = await loadFirebase();
        const write = firestore.addDoc(firestore.collection(db, COLLECTION), {
            ...request,
            createdAt: firestore.serverTimestamp(),
        });
        const timeout = new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), SUBMIT_TIMEOUT_MS));
        await Promise.race([write, timeout]);
        showSuccess(dialog);
    } catch (err) {
        console.error("Schedule a Visit: submission failed", err);
        error.textContent = "Sorry, we couldn't send your request. Please check your connection and try again, or call us at (+63) 2 880 84735.";
        error.hidden = false;
    } finally {
        button.disabled = false;
        button.textContent = "Request a Visit";
    }
}

function showSuccess(dialog) {
    dialog.querySelector(".sv-form").hidden = true;
    dialog.querySelector(".sv-success").hidden = false;
    dialog.querySelector(".sv-body").scrollTop = 0;
    dialog.querySelector(".sv-done").focus();
}
