// "Schedule a Visit" form, in three screens (steps): the visitor's details
// (including the property address), then the electricity bill, then the
// roof's pinned location, the consent box and sending. Next checks the current screen's fields before moving on.
//
// Saves each request to Firestore (collection: visitRequests) and any
// attached bills to Cloud Storage under visitRequests/<request id>/. The roof
// is pinned on a live satellite map and saved as `roofPin`. View
// them in the Firebase console: Firestore → visitRequests, Storage →
// visitRequests. Security rules: /firestore.rules and /storage.rules.
//
// Firebase settings come from ../firebase-config.js. The Firebase SDK is
// only downloaded when someone submits.

import { firebaseConfig } from "../firebase-config.js";
import { tidyName, tidyAddress, tidyOnBlur } from "../text-format.js";
import { findReferrer, findReferrerByName, searchReferrers } from "../referral-codes.js";
import { GOOGLE_MAPS_API_KEY } from "../maps-config.js";

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

// "How many aircons do you use?": up to MAX_AIRCONS, each with one of these
// capacities. Keep in step with isAirconList() in /firestore.rules and
// AIRCON_SIZES in admin/admin.js.
const MAX_AIRCONS = 10;
const AIRCON_SIZES = ["Not sure", "0.5 HP", "0.75 HP", "1 HP", "1.5 HP", "2 HP", "2.5 HP", "3 HP"];

// "Interested in": Micro Inverter, Battery, or both. Product pages link here
// with ?product=<name>; that pre-ticks the matching interest.
const INTEREST_BY_PRODUCT = {
    "MX2250": "Micro Inverter",
    "MSU4000 Elite": "Battery",
    "MAU5000 Elite": "Battery",
    "B4000 Elite": "Battery",
    "B5000 Elite": "Battery",
};

const isConfigured = Boolean(firebaseConfig && firebaseConfig.projectId && !firebaseConfig.projectId.startsWith("YOUR_"));

const form = document.querySelector(".visit-form");
const success = document.querySelector(".visit-success");
const error = form.querySelector(".visit-error");
const button = form.querySelector(".visit-send");
const sourceKey = (f) => `${f.name}|${f.size}|${f.lastModified}`;

const product = new URLSearchParams(window.location.search).get("product");
const interest = INTEREST_BY_PRODUCT[product];
if (interest) form.querySelector(`[name="interest"][value="${interest}"]`).checked = true;

// Names (and addresses) typed in ALL CAPS or all lowercase are tidied when
// the visitor leaves the field, e.g. "harold t. hermosa" → "Harold T. Hermosa".
tidyOnBlur(form.querySelector('[name="name"]'), tidyName);
tidyOnBlur(form.querySelector('[name="address"]'), tidyAddress);

// Referral code (optional): if one is typed it must be a sales team code
// (../referral-codes.js). A valid one shows whose it is. Referral links can
// carry ?ref=<code>; pre-fill and check it.
const referralInput = form.querySelector('[name="referralCode"]');
const referralList = form.querySelector(".visit-referral-suggest");
let referralActive = -1;

// A typed code, or a salesperson's full name.
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

// Suggestions: people whose name or code contains what's been typed. Picking
// one fills in their code.
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
        // A name typed in full becomes the code, which is what's saved.
        if (referralInput.value.trim() !== person.code && document.activeElement !== referralInput) referralInput.value = person.code;
        field.classList.remove("visit-invalid");
        hint.textContent = `Referred by ${person.name}`;
        return true;
    }
    return setFieldError(field, "That is not a real referral code. Please check it, or leave it blank.");
}

const referral = new URLSearchParams(window.location.search).get("ref");
if (referral) {
    referralInput.value = referral.trim().slice(0, 50);
    checkReferral();
}
// Show the name as soon as a valid code is typed; say it's wrong once the
// visitor leaves the field (not on every keystroke).
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
        // Picks the suggestion instead of going to the next screen.
        e.preventDefault();
        pickReferral(referralList.children[referralActive].person);
    } else if (e.key === "Escape") {
        closeReferralList();
    }
});


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
async function shrinkImage(file, { over = SHRINK_OVER_BYTES, edge = SHRINK_MAX_EDGE, quality = 0.85 } = {}) {
    if (!SHRINKABLE_TYPE.test(fileType(file)) || file.size <= over) return file;
    try {
        const bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
        const scale = Math.min(1, edge / Math.max(bitmap.width, bitmap.height));
        const canvas = document.createElement("canvas");
        canvas.width = Math.round(bitmap.width * scale);
        canvas.height = Math.round(bitmap.height * scale);
        const context = canvas.getContext("2d");
        context.fillStyle = "#FFFFFF"; // transparent PNG areas -> white, not black
        context.fillRect(0, 0, canvas.width, canvas.height);
        context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
        bitmap.close();
        const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/jpeg", quality));
        if (!blob || blob.size >= file.size) return file;
        const name = file.name.replace(/\.[^.]+$/, "") + ".jpg";
        return new File([blob], name, { type: "image/jpeg", lastModified: file.lastModified });
    } catch (err) {
        console.warn("Schedule a Visit: couldn't shrink image, uploading as is", err);
        return file;
    }
}

// Photos taken with the camera are kept exactly as taken, so the bill stays
// clear. Only one over the 10 MB upload limit is shrunk, as little as it takes.
async function keepPhoto(file) {
    if (file.size <= MAX_FILE_BYTES) return file;
    const lighter = await shrinkImage(file, { over: MAX_FILE_BYTES, edge: 4000, quality: 0.92 });
    return lighter.size <= MAX_FILE_BYTES ? lighter : shrinkImage(lighter, { over: MAX_FILE_BYTES, edge: 3000, quality: 0.85 });
}

function fileProblem(files, { max, accept, typeError }) {
    if (files.length > max) return `Please choose up to ${max} files.`;
    if (files.some((f) => !accept.test(fileType(f)))) return typeError;
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

    const uploader = uploaders.find((u) => u.input === input);
    if (uploader) {
        return setFieldError(field, uploader.files.length || !uploader.required
            ? fileProblem(uploader.files, uploader)
            : "Please upload your latest electricity bill.");
    }
    if (input === referralInput) return checkReferral();
    // At least one of Solar / Battery.
    if (input.name === "interest") {
        return setFieldError(field, form.querySelector('[name="interest"]:checked') ? "" : "Please pick Solar, Battery or both.");
    }
    // The capacities always hold a valid choice; the count needs an answer,
    // even if it's "I don't use air-conditioning".
    if (field.classList.contains("visit-aircons")) {
        return setFieldError(field, Number(airconCount.value) > 0 || noAirconButton.getAttribute("aria-pressed") === "true"
            ? "" : "Please choose how many aircons you use, or tap “I don't use air-conditioning”.");
    }

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

// Checks the fields inside `scope` (one screen, or the whole form), and the
// consent box if it's there. Shows the screen with the first problem and
// puts the cursor in it.
function validateForm(scope = form) {
    let firstInvalid = null;

    scope.querySelectorAll(".visit-field input, .visit-field select, .visit-field textarea").forEach((input) => {
        if (!validateField(input) && !firstInvalid) firstInvalid = input;
    });

    // The roof must be pinned (unless the map can't be shown at all).
    if (scope.contains(roofField) && !roofFilled()) {
        setFieldError(roofField, "Please move the map until the pin is on your roof, then tap “The pin is on my roof”.");
        if (!firstInvalid) firstInvalid = roofConfirm.hidden ? roofLocate : roofConfirm;
    }

    const consent = scope.querySelector('[name="consent"]');
    if (consent) {
        consent.closest(".visit-consent").classList.toggle("visit-invalid", !consent.checked);
        if (!consent.checked && !firstInvalid) firstInvalid = consent;
    }

    if (firstInvalid) {
        showStep(Number(firstInvalid.closest(".visit-panel").dataset.step), { scroll: false });
        firstInvalid.focus();
    }
    return !firstInvalid;
}

form.addEventListener("input", (e) => {
    const field = e.target.closest(".visit-field");
    if (field && field.classList.contains("visit-invalid")) validateField(e.target);
});

// An upload box: files picked or dropped are added to `files` (a file input
// on its own replaces the previous pick, so they can be added one at a time),
// large photos are shrunk, and each listed file has a remove button.
// `sourceKeys` remembers each original file (name, size, date) so picking the
// same one twice is ignored even after it was shrunk and renamed.
function makeUploader(input, { max, accept, typeError, required = false }) {
    const field = input.closest(".visit-field");
    const list = field.querySelector(".visit-file-list");
    const dropZone = input.closest(".visit-upload");
    const up = { input, max, accept, typeError, required, files: [] };
    let sourceKeys = [];

    function render() {
        list.replaceChildren(...up.files.map((file, index) => {
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
                up.files.splice(index, 1);
                sourceKeys.splice(index, 1);
                render();
                validateField(input);
            });
            item.append(name, size, remove);
            return item;
        }));
        dropZone.hidden = up.files.length >= max;
        if (up.onRender) up.onRender();
    }

    // Adds picked or dropped files (up to `max` in total), shrinking large
    // photos, unless `original` (camera photos): those are kept as taken.
    async function addFiles(picked, { original = false } = {}) {
        if (!picked.length) return;
        const room = max - up.files.length;
        const fresh = picked.filter((f) => !sourceKeys.includes(sourceKey(f)));
        const adding = fresh.slice(0, room);

        const sub = field.querySelector(".visit-upload-sub");
        const subText = sub.textContent;
        sub.textContent = "Preparing photos…";
        const prepared = await Promise.all(adding.map(original ? keepPhoto : shrinkImage));
        sub.textContent = subText;

        up.files = up.files.concat(prepared);
        sourceKeys = sourceKeys.concat(adding.map(sourceKey));
        render();
        updateNext();

        if (fresh.length > room) setFieldError(field, `You can add up to ${max} files. Remove one to add another.`);
        else validateField(input);
    }

    input.addEventListener("change", () => {
        const picked = Array.from(input.files);
        // Clear the input so the same file can be picked again after removing it.
        input.value = "";
        addFiles(picked);
    });

    // Drag and drop onto the upload box. dragDepth counts enter/leave pairs,
    // since moving over the box's own children fires them too.
    let dragDepth = 0;
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

    up.addFiles = addFiles;
    return up;
}

const hasFiles = (e) => Array.from((e.dataTransfer && e.dataTransfer.types) || []).includes("Files");

// The electricity bill (images or PDFs).
const billUploader = makeUploader(form.querySelector('[name="files"]'), {
    max: MAX_FILES, accept: ACCEPTED_TYPE, typeError: "Only images or PDF files can be uploaded.", required: true,
});
const uploaders = [billUploader];

// The phone's own camera app (full quality, autofocus): a file input that
// asks for the camera. Shown on touch devices only (CSS); on a computer the
// same input would just open the file picker.
const nativeCameraInput = form.querySelector(".visit-native-camera-input");
const nativeCameraButton = form.querySelector(".visit-native-camera-btn");
nativeCameraButton.addEventListener("click", () => nativeCameraInput.click());
nativeCameraInput.addEventListener("change", () => {
    const photos = Array.from(nativeCameraInput.files);
    nativeCameraInput.value = "";
    billUploader.addFiles(photos, { original: true });
});
// The camera button goes away once the 3 files are in.
billUploader.onRender = () => {
    nativeCameraButton.hidden = billUploader.files.length >= MAX_FILES;
};

// A file dropped just outside the box would otherwise make the browser leave
// the page to open it (losing the form), so ignore drops elsewhere.
window.addEventListener("dragover", (e) => { if (hasFiles(e)) e.preventDefault(); });
window.addEventListener("drop", (e) => { if (hasFiles(e)) e.preventDefault(); });


// ---------------------------------------------------- address suggestions

// Google Places suggests addresses (in the Philippines) as the visitor types.
// Picking one fills the box and remembers the place (`addressPlace`: its id
// and coordinates), which the admin page uses to open Google Maps directions.
// Typing over a picked address forgets the place. Without a key in
// ../maps-config.js, or if Google can't be reached, it's a plain text box.
const ADDRESS_MIN_CHARS = 3;
const ADDRESS_DELAY_MS = 250;
const mapsReady = Boolean(GOOGLE_MAPS_API_KEY) && !GOOGLE_MAPS_API_KEY.startsWith("YOUR_");
const addressInput = form.querySelector('[name="address"]');
const addressList = form.querySelector(".visit-address-field .visit-address-suggest");
let addressPlace = null;
let mapsPromise = null;
let placesSession = null;

// The Maps JavaScript API, loaded the first time it's needed (for address
// suggestions or the roof map), then the library asked for.
function loadMaps(library) {
    if (!mapsPromise) {
        mapsPromise = new Promise((resolve, reject) => {
            const callback = `hphMapsReady${Date.now()}`;
            window[callback] = () => {
                delete window[callback];
                resolve(window.google.maps);
            };
            const script = document.createElement("script");
            script.src = `https://maps.googleapis.com/maps/api/js?key=${encodeURIComponent(GOOGLE_MAPS_API_KEY)}&v=weekly&loading=async&callback=${callback}`;
            script.async = true;
            script.onerror = () => reject(new Error("Google Maps didn't load"));
            document.head.append(script);
        }).catch((err) => {
            mapsPromise = null;
            throw err;
        });
    }
    return mapsPromise.then((maps) => maps.importLibrary(library));
}

// A Places suggestion list under `input` (address or landmark box): arrow
// keys and Enter work in it, and `onPick(prediction)` runs when one is picked.
function placeSuggestions(input, list, onPick) {
    let timer = 0;
    let query = 0;
    let active = -1;
    let predictions = [];

    function close() {
        list.hidden = true;
        list.replaceChildren();
        predictions = [];
        active = -1;
        input.removeAttribute("aria-activedescendant");
    }

    // index null: nothing highlighted (the list has just opened).
    function mark(index) {
        const options = list.querySelectorAll(".visit-address-option");
        active = options.length && index !== null ? (index + options.length) % options.length : -1;
        options.forEach((option, i) => option.setAttribute("aria-selected", String(i === active)));
        if (active >= 0) input.setAttribute("aria-activedescendant", options[active].id);
    }

    function pick(prediction) {
        close();
        onPick(prediction);
    }

    async function show() {
        const text = input.value.trim();
        const current = ++query;
        if (text.length < ADDRESS_MIN_CHARS) return close();
        try {
            const places = await loadMaps("places");
            placesSession = placesSession || new places.AutocompleteSessionToken();
            const { suggestions } = await places.AutocompleteSuggestion.fetchAutocompleteSuggestions({
                input: text,
                sessionToken: placesSession,
                includedRegionCodes: ["ph"],
            });
            // A newer keystroke has its own request.
            if (current !== query || document.activeElement !== input) return;
            predictions = suggestions.map((s) => s.placePrediction).filter(Boolean).slice(0, 5);
            if (!predictions.length) return close();
            list.replaceChildren(...predictions.map((prediction, i) => {
                const option = document.createElement("li");
                option.className = "visit-address-option";
                option.id = `${list.id}-${i}`;
                option.setAttribute("role", "option");
                const main = document.createElement("span");
                main.className = "visit-address-main";
                main.textContent = prediction.mainText ? prediction.mainText.toString() : prediction.text.toString();
                const sub = document.createElement("span");
                sub.className = "visit-address-sub";
                sub.textContent = prediction.secondaryText ? prediction.secondaryText.toString() : "";
                option.append(main, sub);
                // mousedown, so it's picked before the box loses focus.
                option.addEventListener("mousedown", (e) => {
                    e.preventDefault();
                    pick(prediction);
                });
                return option;
            }), Object.assign(document.createElement("li"), { className: "visit-address-credit", textContent: "Powered by Google" }));
            list.querySelector(".visit-address-credit").setAttribute("aria-hidden", "true");
            list.hidden = false;
            mark(null);
        } catch (err) {
            console.warn("Schedule a Visit: place suggestions unavailable", err);
            close();
        }
    }

    input.setAttribute("autocomplete", "off");
    input.setAttribute("role", "combobox");
    input.setAttribute("aria-autocomplete", "list");
    input.addEventListener("input", () => {
        clearTimeout(timer);
        timer = setTimeout(show, ADDRESS_DELAY_MS);
    });
    input.addEventListener("keydown", (e) => {
        if (list.hidden) return;
        if (e.key === "ArrowDown" || e.key === "ArrowUp") {
            e.preventDefault();
            const down = e.key === "ArrowDown";
            mark(active < 0 ? (down ? 0 : -1) : active + (down ? 1 : -1));
        } else if (e.key === "Enter" && active >= 0) {
            // Picks the suggestion instead of sending the form.
            e.preventDefault();
            pick(predictions[active]);
        } else if (e.key === "Escape") {
            close();
        }
    });
    input.addEventListener("blur", () => setTimeout(close, 150));
    // The first suggestion, for Enter with none highlighted.
    return { first: () => predictions[0] || null, close };
}

// A picked suggestion's place: formatted address and coordinates.
async function placeOf(prediction) {
    const place = prediction.toPlace();
    await place.fetchFields({ fields: ["formattedAddress", "location"] });
    // The next search starts a new session.
    placesSession = null;
    return place;
}

async function pickAddress(prediction) {
    addressInput.value = prediction.text.toString().slice(0, 300);
    try {
        const place = await placeOf(prediction);
        if (place.formattedAddress) addressInput.value = place.formattedAddress.slice(0, 300);
        addressPlace = place.location
            ? { id: String(place.id || "").slice(0, 300), lat: place.location.lat(), lng: place.location.lng() }
            : null;
    } catch (err) {
        console.warn("Schedule a Visit: couldn't look up that address", err);
        addressPlace = null;
    }
    validateField(addressInput);
}

if (mapsReady) {
    placeSuggestions(addressInput, addressList, pickAddress);
    // Typed over a picked address: it's no longer that place.
    addressInput.addEventListener("input", () => { addressPlace = null; });
}




// ---------------------------------------------------------------- roof pin

// Step 3 has the property address, then a live satellite map with a pin fixed
// in its middle: the visitor moves the map (or taps their roof, or uses their
// current location) until the pin is on their roof. The map goes to the
// address: the picked suggestion's spot, else a search for the typed address,
// else the whole Philippines. If Google doesn't suggest their address, the
// landmark box moves the map to a nearby place they can pan from (it's not
// saved). Saved as `roofPin` ({ lat, lng, adjusted }) once they've
// placed it (adjusted: true), or, if they leave it where it opened on their
// address, that spot (adjusted: false). Without a key, or if Google can't be reached, the step is just
// its note and can be skipped.
const ROOF_ZOOM = 20;
const ROOF_SEARCH_ZOOM = 19;
const PH_VIEW = { center: { lat: 12.88, lng: 121.77 }, zoom: 6 };
const roofField = form.querySelector(".visit-roof");
const roofMapEl = roofField.querySelector(".visit-roof-map");
const roofLoading = roofField.querySelector(".visit-roof-loading");
const roofLocate = roofField.querySelector(".visit-roof-locate");
const roofConfirm = roofField.querySelector(".visit-roof-confirm");
const roofStatus = roofField.querySelector(".visit-roof-status");
const landmarkField = form.querySelector(".visit-landmark");
const landmarkInput = landmarkField.querySelector(".visit-landmark-input");
const landmarkToggle = form.querySelector(".visit-landmark-toggle");

// The landmark search stays folded behind "Can't find your address?" until
// it's tapped, or a typed address can't be found on the map.
function openLandmark({ focus = false } = {}) {
    if (!roofMap) return;
    landmarkToggle.hidden = true;
    landmarkToggle.setAttribute("aria-expanded", "true");
    landmarkField.hidden = false;
    if (focus) landmarkInput.focus();
}
landmarkToggle.addEventListener("click", () => openLandmark({ focus: true }));
const LANDMARK_ZOOM = 18;
let roofMap = null;
let roofPinned = false;
// The map was moved to a landmark, so a typed address doesn't move it away.
let roofOnLandmark = false;
// The map is on the visitor's address (not the whole Philippines).
let roofFound = false;
// What the map was last centred on, so going back and changing the address
// moves it (until the roof is pinned).
let roofCentredOn = "";

function setRoofStatus(text, pinned = false) {
    roofStatus.textContent = text;
    roofStatus.classList.toggle("visit-roof-pinned", pinned);
}

function pinRoof(text = "✓ Roof pinned. Move the map again if the pin isn't on your roof.") {
    roofPinned = true;
    setFieldError(roofField, "");
    roofConfirm.hidden = true;
    setRoofStatus(text, true);
}

// The roof step is done once the pin is placed; with no map there's nothing to ask.
const roofFilled = () => roofField.classList.contains("visit-roof-off") || roofPinned;

function roofOff() {
    roofField.classList.add("visit-roof-off");
    landmarkField.hidden = true;
    landmarkToggle.hidden = true;
    form.querySelector(".visit-roof-note").textContent = "The map isn't available right now. You can skip this step: we'll find your roof from your address.";
}

// Where the pin points: the middle of the map.
function roofPinValue() {
    const centre = roofMap.getCenter();
    const round = (n) => Math.round(n * 1e7) / 1e7;
    return { lat: round(centre.lat()), lng: round(centre.lng()), adjusted: roofPinned };
}

function foundAddress() {
    roofFound = true;
    setRoofStatus("The pin is on your address. Move the map if it isn't on your roof.");
}

// Puts the map on the address from step 1 when step 3 opens. If the address
// changed since the map was last placed, it starts over on it, even if the
// old spot was pinned. It only reads the address box, never changes it.
async function centreRoofMap() {
    if (!roofMap) return;
    const text = addressInput.value.trim();
    const key = addressPlace ? `place:${addressPlace.id}:${addressPlace.lat},${addressPlace.lng}` : `text:${text}`;
    if (key === roofCentredOn) return;
    roofCentredOn = key;
    roofPinned = false;
    roofOnLandmark = false;
    // Back on their address: the landmark box no longer follows the pin.
    // A new address: the landmark search folds away again.
    if (landmarkUsed || !landmarkField.hidden) {
        landmarkInput.value = "";
        landmarkMode(false);
        landmarkField.hidden = true;
        landmarkToggle.setAttribute("aria-expanded", "false");
        landmarkToggle.hidden = false;
    }
    landmarkUsed = false;
    pinFollowPending = false;
    roofConfirm.hidden = !roofMap;
    setFieldError(roofField, "");
    if (addressPlace) {
        roofMap.setCenter({ lat: addressPlace.lat, lng: addressPlace.lng });
        roofMap.setZoom(ROOF_ZOOM);
        foundAddress();
        return;
    }
    roofFound = false;
    setRoofStatus(text ? "Finding your address on the map…" : "Find your home on the map, then put the pin on your roof.");
    roofMap.setCenter(PH_VIEW.center);
    roofMap.setZoom(PH_VIEW.zoom);
    if (!text) return;
    try {
        const { Place } = await loadMaps("places");
        const { places } = await Place.searchByText({ textQuery: text, fields: ["location"], region: "ph", maxResultCount: 1 });
        // They've moved the map or changed the address in the meantime.
        if (roofPinned || roofOnLandmark || roofCentredOn !== key) return;
        if (!places.length || !places[0].location) {
            openLandmark();
            setRoofStatus("We couldn't find your address on the map. Search for a landmark near you below, then move the map to your roof.");
            return;
        }
        roofMap.setCenter(places[0].location);
        roofMap.setZoom(ROOF_SEARCH_ZOOM);
        foundAddress();
    } catch (err) {
        console.warn("Schedule a Visit: couldn't find the address on the map", err);
        if (roofCentredOn === key && !roofPinned && !roofOnLandmark) setRoofStatus("Find your home on the map, then put the pin on your roof.");
    }
}

async function showRoofMap() {
    if (!mapsReady) return roofOff();
    try {
        const { Map } = await loadMaps("maps");
        if (!roofMap) {
            roofMap = new Map(roofMapEl, {
                ...PH_VIEW,
                mapTypeId: "satellite",
                tilt: 0,
                disableDefaultUI: true,
                zoomControl: true,
                clickableIcons: false,
                // One finger moves the map on phones; this step is all about the map.
                gestureHandling: "greedy",
            });
            roofMap.addListener("dragend", () => {
                pinRoof();
                followPin();
            });
            roofMap.addListener("click", (e) => {
                roofMap.panTo(e.latLng);
                pinRoof();
                followPin();
            });
            // Once the map has stopped after the visitor moved it.
            roofMap.addListener("idle", () => {
                if (!pinFollowPending) return;
                pinFollowPending = false;
                showPinLocation();
            });
            roofLoading.hidden = true;
            roofConfirm.hidden = false;
            if (landmarkField.hidden) landmarkToggle.hidden = false;
        }
        await centreRoofMap();
    } catch (err) {
        console.warn("Schedule a Visit: the roof map couldn't load", err);
        roofOff();
    }
}

roofConfirm.addEventListener("click", () => pinRoof("✓ Roof pinned."));

// After a landmark is picked, the landmark box follows the pin: each time the
// visitor stops moving the map, it shows the address Google gives for the spot
// under the pin (reverse geocoding), or its coordinates if there's none or the
// Geocoding API isn't enabled for the key. It's only shown, never saved.
const landmarkLabel = landmarkField.querySelector(".visit-label");
const landmarkNote = landmarkField.querySelector(".visit-field-note");
const LANDMARK_LABEL = landmarkLabel.innerHTML;
const LANDMARK_NOTE = landmarkNote.textContent;
let landmarkUsed = false;
let pinFollowPending = false;
let pinLookup = 0;
let geocodeOff = false;

function followPin() {
    if (landmarkUsed) pinFollowPending = true;
}

function landmarkMode(following) {
    if (following) {
        landmarkLabel.textContent = "Your pin's location";
        landmarkNote.textContent = "This follows the pin as you move the map. We'll still save the address you entered in Your details.";
    } else {
        landmarkLabel.innerHTML = LANDMARK_LABEL;
        landmarkNote.textContent = LANDMARK_NOTE;
    }
}

const coordsText = (lat, lng) => `${lat.toFixed(6)}, ${lng.toFixed(6)}`;

async function showPinLocation() {
    if (!landmarkUsed || landmarkField.hidden) return;
    // Don't overwrite a search they're typing.
    if (document.activeElement === landmarkInput) return;
    const centre = roofMap.getCenter();
    const lat = centre.lat();
    const lng = centre.lng();
    const lookup = ++pinLookup;
    landmarkMode(true);
    landmarkInput.value = coordsText(lat, lng);
    if (geocodeOff) return;
    try {
        const { Geocoder } = await loadMaps("geocoding");
        const { results } = await new Geocoder().geocode({ location: { lat, lng } });
        if (lookup !== pinLookup || document.activeElement === landmarkInput) return;
        // A street address rather than a plus code, when there is one.
        const best = results.find((r) => !r.types.includes("plus_code")) || results[0];
        if (best && best.formatted_address) landmarkInput.value = best.formatted_address.slice(0, 200);
    } catch (err) {
        // Most likely the Geocoding API isn't enabled for the key: keep the coordinates.
        console.warn("Schedule a Visit: couldn't look up the pin's address", err);
        if (err && (err.code === "REQUEST_DENIED" || /REQUEST_DENIED|not authorized|not activated/i.test(String(err.message)))) geocodeOff = true;
    }
}

// Typing a new search puts the box back to a landmark search.
landmarkInput.addEventListener("input", () => {
    pinLookup++;
    landmarkMode(false);
});

// The landmark box: picking a place moves the map there (closer out, so the
// visitor can see the streets around it) and they pan to their roof.
async function pickLandmark(prediction) {
    landmarkInput.value = prediction.text.toString().slice(0, 200);
    try {
        const place = await placeOf(prediction);
        if (!roofMap || !place.location) throw new Error("No location for that place");
        roofMap.setCenter(place.location);
        roofMap.setZoom(LANDMARK_ZOOM);
        roofOnLandmark = true;
        landmarkUsed = true;
        pinFollowPending = false;
        landmarkMode(false);
        roofPinned = false;
        roofFound = false;
        roofConfirm.hidden = false;
        setRoofStatus("Now move the map from there to your roof, then tap “The pin is on my roof”.");
        roofMapEl.scrollIntoView({ behavior: "smooth", block: "nearest" });
    } catch (err) {
        console.warn("Schedule a Visit: couldn't find that landmark", err);
        setRoofStatus("We couldn't find that place on the map. Try another landmark nearby.");
    }
}

if (mapsReady) {
    const landmarks = placeSuggestions(landmarkInput, form.querySelector(".visit-landmark-suggest"), pickLandmark);
    // Enter never sends the form here: it picks the first suggestion.
    landmarkInput.addEventListener("keydown", (e) => {
        if (e.key !== "Enter" || e.defaultPrevented) return;
        e.preventDefault();
        const first = landmarks.first();
        if (first) {
            landmarks.close();
            pickLandmark(first);
        }
    });
}

if (!navigator.geolocation) roofLocate.hidden = true;
roofLocate.addEventListener("click", () => {
    if (!roofMap) return;
    roofLocate.disabled = true;
    setRoofStatus("Finding your location…");
    navigator.geolocation.getCurrentPosition((position) => {
        roofLocate.disabled = false;
        roofMap.setCenter({ lat: position.coords.latitude, lng: position.coords.longitude });
        roofMap.setZoom(ROOF_ZOOM);
        roofOnLandmark = false;
        pinRoof("✓ Pinned at your current location. Move the map if the pin isn't on your roof.");
        followPin();
    }, () => {
        roofLocate.disabled = false;
        setRoofStatus(roofPinned ? "We couldn't get your location. Your pin is where you left it." : "We couldn't get your location. Move the map to your roof instead.", roofPinned);
    }, { enableHighAccuracy: true, timeout: 15000, maximumAge: 60000 });
});



// ----------------------------------------------------------------- aircons

// How many aircons (−/+ or typed, 0 to MAX_AIRCONS), then one capacity
// dropdown per aircon. Each row's choice is remembered (`airconChoices`), so
// lowering the count and raising it again brings it back.
const airconField = form.querySelector(".visit-aircons");
const airconCount = airconField.querySelector(".visit-aircon-count");
const airconList = airconField.querySelector(".visit-aircon-list");
const [airconLess, airconMore] = airconField.querySelectorAll(".visit-step");
const noAirconButton = airconField.querySelector(".visit-no-aircon");
const airconChoices = [];

function airconSizes() {
    return Array.from(airconList.querySelectorAll("select"), (select) => select.value);
}

function setAircons(count, { none = false } = {}) {
    const n = Math.max(0, Math.min(MAX_AIRCONS, Number.isFinite(count) ? Math.round(count) : 0));
    airconCount.value = String(n);
    noAirconButton.setAttribute("aria-pressed", String(none && n === 0));
    if (airconField.classList.contains("visit-invalid")) validateField(airconCount);
    airconLess.disabled = n === 0;
    airconMore.disabled = n === MAX_AIRCONS;
    airconList.replaceChildren(...Array.from({ length: n }, (_, i) => {
        const item = document.createElement("li");
        const label = document.createElement("label");
        label.className = "visit-aircon";
        const name = document.createElement("span");
        name.className = "visit-aircon-name";
        name.textContent = `Aircon ${i + 1}`;
        const select = document.createElement("select");
        select.setAttribute("aria-label", `Capacity of aircon ${i + 1}`);
        for (const size of AIRCON_SIZES) select.append(new Option(size, size));
        select.value = airconChoices[i] || AIRCON_SIZES[0];
        select.addEventListener("change", () => { airconChoices[i] = select.value; });
        label.append(name, select);
        item.append(label);
        return item;
    }));
}

airconLess.addEventListener("click", () => setAircons(Number(airconCount.value) - 1));
noAirconButton.addEventListener("click", () => setAircons(0, { none: noAirconButton.getAttribute("aria-pressed") !== "true" }));
airconMore.addEventListener("click", () => setAircons(Number(airconCount.value) + 1));
airconCount.addEventListener("change", () => setAircons(Number(airconCount.value)));
setAircons(0);



// ------------------------------------------------------------------- steps

const panels = Array.from(form.querySelectorAll(".visit-panel"));
const stepItems = Array.from(form.querySelectorAll(".visit-steps-item"));
const backButton = form.querySelector(".visit-back");
const nextButton = form.querySelector(".visit-next");
let step = 1;

// The browser's Back / Forward buttons move between the screens. Each screen
// is a history entry; Forward only goes as far as screens already completed.
let furthestStep = 1;
history.replaceState({ visitStep: 1 }, "");
window.addEventListener("popstate", (e) => {
    const target = e.state && e.state.visitStep ? e.state.visitStep : 1;
    showStep(Math.min(target, furthestStep), { scroll: true, push: false });
    if (target > furthestStep) history.replaceState({ visitStep: step }, "");
});

function showStep(n, { scroll = true, push = false } = {}) {
    const previous = step;
    step = Math.max(1, Math.min(panels.length, n));
    if (push && step !== previous) {
        furthestStep = Math.max(furthestStep, step);
        history.pushState({ visitStep: step }, "");
    }
    panels.forEach((panel) => { panel.hidden = Number(panel.dataset.step) !== step; });
    stepItems.forEach((item) => {
        const k = Number(item.dataset.step);
        item.classList.toggle("visit-steps-done", k < step);
        if (k === step) item.setAttribute("aria-current", "step");
        else item.removeAttribute("aria-current");
    });
    backButton.hidden = step === 1;
    nextButton.hidden = step === panels.length;
    button.hidden = step !== panels.length;
    error.hidden = true;
    updateNext();
    if (step === 3) showRoofMap();
    // Each screen starts like the first: at the top of the page, so the
    // heading and step indicator aren't hidden under the fixed navigation.
    if (scroll) window.scrollTo({ top: 0, behavior: "smooth" });
}

function updateNext() {
    nextButton.textContent = "Next";
}

function goNext() {
    if (validateForm(panels[step - 1])) showStep(step + 1, { push: true });
}

nextButton.addEventListener("click", goNext);

// The step names at the top go to that screen. Going back is always fine;
// going forward checks each screen on the way, like Next, and stops at the
// first one with a problem. The history stays one entry per screen in order
// (forward adds each screen passed, back goes back through them), so the
// Back button and the browser's Back still go to the screen before.
stepItems.forEach((item) => {
    item.querySelector(".visit-steps-btn").addEventListener("click", () => {
        const target = Number(item.dataset.step);
        if (target < step) {
            history.go(target - step);
            return;
        }
        while (step < target) {
            if (!validateForm(panels[step - 1])) return;
            showStep(step + 1, { push: true });
        }
    });
});
// Same as the browser's Back button, so the history stays in step.
backButton.addEventListener("click", () => history.back());
form.addEventListener("change", updateNext);
form.addEventListener("click", (e) => { if (e.target.closest(".visit-file-remove")) setTimeout(updateNext); });



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
    // Enter in a field before the last screen means Next, not send.
    if (step < panels.length) {
        goNext();
        return;
    }
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

    const files = billUploader.files;
    const aircons = airconSizes();
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
                name: tidyName(value("name")),
                phone: value("phone"),
                email: value("email"),
                address: tidyAddress(value("address")),
                // The Google Maps place picked from the suggestions, if any.
                ...(addressPlace ? { addressPlace } : {}),
                propertyType: value("propertyType"),
                // Saved in the `product` field (see /firestore.rules):
                // "Micro Inverter", "Battery", "Micro Inverter + Battery",
                // or "Not sure yet" when neither is ticked.
                product: data.getAll("interest").join(" + ") || "Not sure yet",
                monthlyBill: value("monthlyBill"),
                // "Balanced", "Mostly Day", "Middle of Day", "Mostly Night",
                // or blank for "Not sure".
                usagePattern: value("usagePattern"),
                // No date field any more: HPH arranges the visit date with the
                // client. Kept blank so /firestore.rules stays unchanged.
                preferredDate: "",
                preferredTime: value("preferredTime"),
                message: value("message"),
                // Upper-cased so "juan01" and "JUAN01" group together in the admin page.
                // The official spelling (e.g. "hph mpm01" → "HPH-MPM01"); the
                // form only submits blank or a valid code.
                referralCode: value("referralCode") ? resolveReferrer(value("referralCode")).code : "",
                attachments,
                // Aircon capacities, one per aircon, and the roof's pin; left
                // out when there are none (both optional in the rules).
                ...(aircons.length ? { aircons } : {}),
                ...((roofPinned || roofFound) && roofMap ? { roofPin: roofPinValue() } : {}),
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
    // Greet by first name (textContent only: it's visitor-typed).
    const first = String(form.elements.name?.value || "").trim().split(/\s+/)[0];
    if (first) success.querySelector(".visit-success-title").textContent = `Thank you, ${first}.`;
    form.hidden = true;
    document.querySelector(".visit-hero").hidden = true;
    success.hidden = false;
    window.scrollTo({ top: 0 });
}
