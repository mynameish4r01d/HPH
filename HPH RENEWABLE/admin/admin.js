// Admin overview of "Schedule a Visit" requests (Firestore: visitRequests),
// "Join the Waitlist" sign-ups (Firestore: waitlist) and feedback
// (Firestore: feedback).
//
// Sign-in uses Firebase Authentication (email + password). Passwords are
// never stored in this repo — admin accounts are created in the Firebase
// console → Authentication → Users → Add user.
//
// Who counts as an admin is hardcoded in three places; keep them in step:
//   - ADMIN_EMAILS below (decides what this page shows)
//   - isAdmin() in /firestore.rules (lets admins read submissions)
//   - isAdmin() in /storage.rules (lets admins open attachments)
// The rules are what actually protect the data; this list only affects
// what the page displays.

import { firebaseConfig } from "../firebase-config.js";

const FIREBASE_VERSION = "12.3.0";
const ADMIN_EMAILS = ["harold.t.hermosa@gmail.com"];
const MAX_ROWS = 500;

const status = document.querySelector(".admin-status");

const base = `https://www.gstatic.com/firebasejs/${FIREBASE_VERSION}`;
let appSdk, authSdk, firestore;
try {
    [appSdk, authSdk, firestore] = await Promise.all([
        import(`${base}/firebase-app.js`),
        import(`${base}/firebase-auth.js`),
        import(`${base}/firebase-firestore.js`),
    ]);
} catch (err) {
    status.textContent = "Couldn't load the admin tools. Check your connection and reload the page.";
    throw err;
}

const app = appSdk.initializeApp(firebaseConfig);
const auth = authSdk.getAuth(app);
const db = firestore.getFirestore(app);

// Signed out when the browser tab is closed.
await authSdk.setPersistence(auth, authSdk.browserSessionPersistence);

const loginSection = document.querySelector(".admin-login");
const loginForm = document.querySelector(".admin-login-form");
const loginError = loginForm.querySelector(".admin-error");
const loginButton = loginForm.querySelector(".admin-button");
const dashboard = document.querySelector(".admin-dashboard");
const account = document.querySelector(".admin-account");
const loadError = document.querySelector(".admin-load-error");
const search = document.querySelector(".admin-search");
const statusFilter = document.querySelector(".admin-status-filter");
const refreshButton = document.querySelector(".admin-refresh");

let data = { visits: [], waitlist: [], feedback: [] };
let activeTab = "visits";


// ---------------------------------------------------------------- helpers

function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined && text !== null) node.textContent = text;
    return node;
}

function toDate(timestamp) {
    return timestamp && typeof timestamp.toDate === "function" ? timestamp.toDate() : null;
}

function formatDate(date) {
    if (!date) return "—";
    return date.toLocaleString(undefined, {
        year: "numeric", month: "short", day: "numeric", hour: "numeric", minute: "2-digit",
    });
}

function isAdminEmail(email) {
    return Boolean(email) && ADMIN_EMAILS.includes(email.toLowerCase());
}

function show(section) {
    status.hidden = section !== status;
    loginSection.hidden = section !== loginSection;
    dashboard.hidden = section !== dashboard;
}


// ------------------------------------------------------------------- auth

authSdk.onAuthStateChanged(auth, async (user) => {
    if (!user) {
        account.hidden = true;
        data = { visits: [], waitlist: [], feedback: [] };
        show(loginSection);
        return;
    }

    if (!isAdminEmail(user.email)) {
        await authSdk.signOut(auth);
        showLoginError("This account doesn't have admin access.");
        return;
    }

    account.querySelector(".admin-account-email").textContent = user.email;
    account.hidden = false;
    show(dashboard);
    loadSubmissions();
});

function showLoginError(message) {
    loginError.textContent = message;
    loginError.hidden = false;
}

loginForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    loginError.hidden = true;

    const email = loginForm.email.value.trim();
    const password = loginForm.password.value;
    if (!email || !password) {
        showLoginError("Enter your email and password.");
        return;
    }
    if (!isAdminEmail(email)) {
        showLoginError("This account doesn't have admin access.");
        return;
    }

    loginButton.disabled = true;
    loginButton.textContent = "Signing in…";
    try {
        await authSdk.signInWithEmailAndPassword(auth, email, password);
        loginForm.reset();
    } catch (err) {
        console.error("Admin: sign-in failed", err);
        showLoginError(signInErrorMessage(err.code));
    } finally {
        loginButton.disabled = false;
        loginButton.textContent = "Sign in";
    }
});

function signInErrorMessage(code) {
    switch (code) {
        case "auth/invalid-credential":
        case "auth/invalid-login-credentials":
        case "auth/wrong-password":
        case "auth/user-not-found":
        case "auth/invalid-email":
            return "Incorrect email or password.";
        case "auth/too-many-requests":
            return "Too many attempts. Please wait a few minutes and try again.";
        case "auth/user-disabled":
            return "This account has been disabled.";
        case "auth/network-request-failed":
            return "Couldn't reach the server. Check your connection and try again.";
        // Setup problems in the Firebase console (Authentication section).
        case "auth/configuration-not-found":
            return "Sign-in isn't set up yet: open Firebase console → Authentication and click Get started.";
        case "auth/operation-not-allowed":
            return "Email/Password sign-in is turned off: enable it in Firebase console → Authentication → Sign-in method.";
        default:
            return `Sign-in failed (${code || "unknown error"}).`;
    }
}

account.querySelector(".admin-signout").addEventListener("click", () => authSdk.signOut(auth));


// ------------------------------------------------------------------- data

async function fetchCollection(name) {
    const q = firestore.query(
        firestore.collection(db, name),
        firestore.orderBy("createdAt", "desc"),
        firestore.limit(MAX_ROWS),
    );
    const snapshot = await firestore.getDocs(q);
    return snapshot.docs.map((doc) => ({ id: doc.id, ...doc.data() }));
}

async function loadSubmissions() {
    loadError.hidden = true;
    refreshButton.disabled = true;
    document.querySelectorAll(".admin-list").forEach((list) => {
        list.replaceChildren(el("p", "admin-empty", "Loading…"));
    });

    try {
        const [visits, waitlist, feedback] = await Promise.all([
            fetchCollection(TABS.visits.collection),
            fetchCollection(TABS.waitlist.collection),
            fetchCollection(TABS.feedback.collection),
        ]);
        data = { visits, waitlist, feedback };
        renderStats();
        renderList();
    } catch (err) {
        console.error("Admin: loading submissions failed", err);
        loadError.textContent = err.code === "permission-denied"
            ? "Permission denied. Publish the latest /firestore.rules in the Firebase console, then refresh."
            : "Couldn't load submissions. Check your connection and try again.";
        loadError.hidden = false;
        document.querySelectorAll(".admin-list").forEach((list) => list.replaceChildren());
    } finally {
        refreshButton.disabled = false;
    }
}

refreshButton.addEventListener("click", loadSubmissions);


// ---------------------------------------------------------------- display

// Per-tab settings. Tabs with `status` get a done/not-done toggle (status,
// completedAt, completedBy — see isValidStatusChange() in /firestore.rules)
// and the status filter.
const TABS = {
    visits: {
        collection: "visitRequests",
        render: (entry) => renderVisit(entry),
        status: { badge: "Complete", openBadge: "Active", mark: "Mark as done", undo: "Mark as not done", marked: "Marked done", open: "Active", done: "Complete", all: "All requests" },
    },
    waitlist: {
        collection: "waitlist",
        render: (entry) => renderWaitlist(entry),
        status: { badge: "Contacted", mark: "Mark as contacted", undo: "Mark as not contacted", marked: "Marked contacted", open: "Not contacted", done: "Contacted", all: "All sign-ups" },
    },
    feedback: {
        collection: "feedback",
        render: (entry) => renderFeedback(entry),
    },
};

function isDone(entry) {
    return entry.status === "done";
}

function renderStats() {
    const openVisits = data.visits.filter((v) => !isDone(v)).length;
    const ratings = data.feedback.map((f) => f.rating).filter((r) => typeof r === "number");
    const average = ratings.length ? (ratings.reduce((a, b) => a + b, 0) / ratings.length).toFixed(1) : "–";

    const set = (key, value) => { document.querySelector(`[data-stat="${key}"]`).textContent = value; };
    set("visits", data.visits.length);
    set("visits-open", openVisits);
    set("waitlist", data.waitlist.length);
    set("feedback", data.feedback.length);
    const rating = document.querySelector('[data-stat="rating"]');
    rating.textContent = ratings.length ? `${average} ` : "–";
    if (ratings.length) rating.append(el("span", "admin-star-filled", "★"));

    for (const key of Object.keys(TABS)) {
        document.querySelector(`[data-count="${key}"]`).textContent = data[key].length;
    }
}

// Every string in an entry, including those inside lists and maps (both
// keys and values), e.g. the product names in a waitlist sign-up.
function searchableText(value) {
    if (typeof value === "string") return [value];
    if (Array.isArray(value)) return value.flatMap(searchableText);
    if (value && typeof value === "object" && typeof value.toDate !== "function") {
        return Object.entries(value).flatMap(([key, v]) => [key, ...searchableText(v)]);
    }
    return [];
}

function matches(entry, term) {
    if (!term) return true;
    return Object.values(entry).flatMap(searchableText).some((text) => text.toLowerCase().includes(term));
}

function renderList() {
    const term = search.value.trim().toLowerCase();
    const list = document.querySelector(`[data-list="${activeTab}"]`);
    const wanted = TABS[activeTab].status ? statusFilter.value : "all";
    const entries = data[activeTab].filter((entry) => matches(entry, term)
        && (wanted === "all" || (wanted === "done") === isDone(entry)));
    const render = TABS[activeTab].render;

    if (!entries.length) {
        list.replaceChildren(el("p", "admin-empty", term || wanted !== "all" ? "No matches." : "Nothing submitted yet."));
        return;
    }
    list.replaceChildren(...entries.map(render));
}

function detailRow(label, value, { href, wide } = {}) {
    const row = el("div", wide ? "admin-detail admin-detail-wide" : "admin-detail");
    row.append(el("dt", "", label));
    const dd = el("dd");
    if (href && value) {
        const link = el("a", "", value);
        link.href = href;
        dd.append(link);
    } else {
        dd.textContent = value === "" || value === undefined || value === null ? "—" : value;
    }
    row.append(dd);
    return row;
}

// `meta` is text or a node (e.g. the feedback stars). `badge` shows when
// done; `openBadge` (visit requests' green "Active" tag) when not.
function entryShell(title, meta, date, { done, badge, openBadge } = {}) {
    const details = el("details", done ? "admin-entry admin-entry-done" : "admin-entry");
    const summary = el("summary");
    const main = el("div", "admin-entry-main");
    const heading = el("span", "admin-entry-heading");
    heading.append(el("span", "admin-entry-title", title || "(no name)"));
    if (done && badge) heading.append(el("span", "admin-badge", badge));
    if (!done && openBadge) heading.append(el("span", "admin-badge admin-badge-active", openBadge));
    main.append(heading);
    const metaLine = el("span", "admin-entry-meta");
    metaLine.append(meta);
    main.append(metaLine);
    summary.append(main);
    summary.append(el("span", "admin-entry-date", formatDate(date)));
    summary.append(el("span", "material-symbols-rounded admin-chevron", "expand_more"));
    details.append(summary);
    return details;
}

function renderVisit(v) {
    const meta = [v.product, v.propertyType, v.phone].filter(Boolean).join(" · ");
    const done = isDone(v);
    const { badge, openBadge } = TABS.visits.status;
    const paths = Array.isArray(v.attachments) ? v.attachments : [];
    const details = entryShell(v.name, meta, toDate(v.createdAt), { done, badge, openBadge });
    if (paths.length) {
        // Paperclip + count on the collapsed entry, so bills are easy to spot.
        const clip = el("span", "admin-entry-files");
        clip.title = `${paths.length} attachment${paths.length === 1 ? "" : "s"}`;
        clip.append(el("span", "material-symbols-rounded", "attach_file"), String(paths.length));
        details.querySelector(".admin-entry-heading").append(clip);
    }

    const list = el("dl", "admin-details");
    list.append(
        detailRow("Phone", v.phone, { href: v.phone ? `tel:${v.phone.replace(/[^\d+]/g, "")}` : "" }),
        detailRow("Email", v.email, { href: v.email ? `mailto:${v.email}` : "" }),
        detailRow("Address", v.address, { wide: true }),
        detailRow("Property type", v.propertyType),
        detailRow("Product", v.product),
        detailRow("Monthly bill", v.monthlyBill),
        detailRow("Preferred date", v.preferredDate),
        detailRow("Preferred time", v.preferredTime),
        detailRow("Message", v.message, { wide: true }),
        detailRow("Submitted", formatDate(toDate(v.createdAt))),
        detailRow("Request ID", v.id),
    );
    appendStatus("visits", v, list, details);

    if (paths.length) {
        const files = el("div", "admin-attachments");
        files.append(el("span", "admin-attachments-label", `Attachments (${paths.length})`));
        const fileList = el("ul", "admin-attachment-grid");
        files.append(fileList);
        details.insertBefore(files, details.querySelector(".admin-actions"));

        // Files are only fetched the first time the entry is opened.
        details.addEventListener("toggle", () => {
            if (details.open && !fileList.childElementCount) loadAttachments(paths, fileList);
        });
    }
    return details;
}

function renderFeedback(f) {
    const rating = typeof f.rating === "number" ? f.rating : 0;
    const stars = el("span", "admin-stars");
    stars.setAttribute("aria-label", `${rating} out of 5 stars`);
    stars.append(
        el("span", "admin-star-filled", "★".repeat(rating)),
        el("span", "admin-star-empty", "★".repeat(Math.max(0, 5 - rating))),
    );
    const details = entryShell(f.name || "Anonymous", stars, toDate(f.createdAt));

    const list = el("dl", "admin-details");
    const contact = f.contact || "";
    list.append(
        detailRow("Rating", rating ? `${rating} / 5` : ""),
        detailRow("Feedback", f.message, { wide: true }),
        detailRow("Contact", contact, { href: contact.includes("@") ? `mailto:${contact}` : "" }),
        detailRow("OK to publish", f.allowPublish ? "Yes" : "No"),
        detailRow("Submitted", formatDate(toDate(f.createdAt))),
    );
    details.append(list);
    return details;
}

// "1 × MAU5000 Elite", "2 × B5000 Elite": units (MSU/MAU) before batteries.
// Sign-ups store `quantities`; early test ones had a `products` list or a
// single `product`, shown without counts.
function waitlistItems(w) {
    if (w.quantities && typeof w.quantities === "object") {
        return Object.entries(w.quantities)
            .sort(([a], [b]) => a.startsWith("B") - b.startsWith("B") || a.localeCompare(b))
            .map(([name, count]) => `${count} × ${name}`);
    }
    return Array.isArray(w.products) ? w.products : [w.product].filter(Boolean);
}

function renderWaitlist(w) {
    const products = waitlistItems(w).join(", ");
    const meta = [products, w.phone, w.location].filter(Boolean).join(" · ");
    const done = isDone(w);
    const details = entryShell(w.name, meta, toDate(w.createdAt), { done, badge: TABS.waitlist.status.badge });

    const list = el("dl", "admin-details");
    list.append(
        // One product per line (the summary line above keeps them comma-separated).
        detailRow("Order", waitlistItems(w).join("\n")),
        detailRow("System", w.system ? `${w.system} system` : ""),
        detailRow("City / Province", w.location),
        detailRow("Phone", w.phone, { href: w.phone ? `tel:${w.phone.replace(/[^\d+]/g, "")}` : "" }),
        detailRow("Email", w.email, { href: w.email ? `mailto:${w.email}` : "" }),
        detailRow("Note", w.message, { wide: true }),
        detailRow("Submitted", formatDate(toDate(w.createdAt))),
    );
    appendStatus("waitlist", w, list, details);
    return details;
}

// Adds the "Marked done/contacted" row and the toggle button to an entry.
function appendStatus(tab, entry, list, details) {
    const labels = TABS[tab].status;
    const done = isDone(entry);
    if (done) {
        const by = entry.completedBy ? ` by ${entry.completedBy}` : "";
        list.append(detailRow(labels.marked, `${formatDate(toDate(entry.completedAt))}${by}`, { wide: true }));
    }
    details.append(list);

    const actions = el("div", "admin-actions");
    const toggle = el("button", done ? "admin-action" : "admin-action admin-action-primary");
    toggle.type = "button";
    toggle.append(
        el("span", "material-symbols-rounded", done ? "undo" : "check_circle"),
        done ? labels.undo : labels.mark,
    );
    const actionError = el("span", "admin-action-error");
    toggle.addEventListener("click", () => setDone(tab, entry, !done, details, toggle, actionError));
    actions.append(toggle, actionError);
    details.append(actions);
}

// Only status, completedAt and completedBy may change — see /firestore.rules.
async function setDone(tab, entry, done, details, button, errorText) {
    button.disabled = true;
    errorText.textContent = "";
    const email = auth.currentUser ? auth.currentUser.email : null;
    try {
        await firestore.updateDoc(firestore.doc(db, TABS[tab].collection, entry.id), {
            status: done ? "done" : "new",
            completedAt: done ? firestore.serverTimestamp() : null,
            completedBy: done ? email : null,
        });
        entry.status = done ? "done" : "new";
        entry.completedAt = done ? firestore.Timestamp.now() : null;
        entry.completedBy = done ? email : null;

        renderStats();
        if (statusFilter.value === "all") {
            const updated = TABS[tab].render(entry);
            updated.open = true;
            details.replaceWith(updated);
        } else {
            renderList();
        }
    } catch (err) {
        console.error("Admin: status update failed", err);
        errorText.textContent = err.code === "permission-denied"
            ? "Permission denied. Publish the latest /firestore.rules in the Firebase console."
            : "Couldn't save. Check your connection and try again.";
        button.disabled = false;
    }
}

let storagePromise = null;

// Browsers can't show HEIC/HEIF photos (iPhone default), so those open as files.
function attachmentKind(contentType, name) {
    if (/^image\/(heic|heif)/i.test(contentType) || /\.(heic|heif)$/i.test(name)) return "file";
    if (/^image\//i.test(contentType) || /\.(jpe?g|png|gif|webp|avif|bmp)$/i.test(name)) return "image";
    if (contentType === "application/pdf" || /\.pdf$/i.test(name)) return "pdf";
    return "file";
}

// Images become thumbnails that open in the viewer; PDFs and other files
// become cards that open in a new tab.
async function loadAttachments(paths, fileList) {
    fileList.replaceChildren(el("li", "admin-empty", "Loading…"));
    try {
        if (!storagePromise) {
            storagePromise = import(`${base}/firebase-storage.js`).then((storageSdk) => ({
                storageSdk, storage: storageSdk.getStorage(app),
            }));
        }
        const { storageSdk, storage } = await storagePromise;
        const files = await Promise.all(paths.map(async (path) => {
            const name = path.split("/").pop();
            const fileRef = storageSdk.ref(storage, path);
            try {
                const [url, metadata] = await Promise.all([
                    storageSdk.getDownloadURL(fileRef),
                    storageSdk.getMetadata(fileRef).catch(() => null),
                ]);
                return { name, url, kind: attachmentKind(metadata ? metadata.contentType || "" : "", name) };
            } catch (err) {
                console.error("Admin: attachment link failed", path, err);
                return { name, error: true };
            }
        }));

        const images = files.filter((f) => f.kind === "image");
        fileList.replaceChildren(...files.map((file) => {
            const item = el("li");
            if (file.error) {
                item.append(el("span", "admin-muted", `${file.name} (couldn't open — check /storage.rules)`));
            } else if (file.kind === "image") {
                const thumb = el("button", "admin-thumb");
                thumb.type = "button";
                thumb.title = `View ${file.name}`;
                const img = el("img");
                img.src = file.url;
                img.alt = file.name;
                img.loading = "lazy";
                thumb.append(img);
                thumb.addEventListener("click", () => openViewer(images, images.indexOf(file)));
                item.append(thumb);
            } else {
                const card = el("a", "admin-file-card");
                card.href = file.url;
                card.target = "_blank";
                card.rel = "noopener";
                card.title = `Open ${file.name}`;
                card.append(
                    el("span", "material-symbols-rounded", file.kind === "pdf" ? "picture_as_pdf" : "draft"),
                    el("span", "admin-file-name", file.name),
                    el("span", "admin-file-type", file.kind === "pdf" ? "PDF · opens in a new tab" : "File · opens in a new tab"),
                );
                item.append(card);
            }
            return item;
        }));
    } catch (err) {
        console.error("Admin: loading attachments failed", err);
        storagePromise = null;
        fileList.replaceChildren(el("li", "admin-muted", "Couldn't load attachments."));
    }
}


// ------------------------------------------------------------ image viewer

let viewer = null;

// One shared full-size viewer (<dialog>): previous/next between a request's
// images (also ← / →), Esc or a click outside the image to close.
function getViewer() {
    if (viewer) return viewer;
    const dialog = el("dialog", "admin-viewer");
    dialog.setAttribute("aria-label", "Attachment viewer");

    const bar = el("div", "admin-viewer-bar");
    const caption = el("span", "admin-viewer-caption");
    const original = el("a", "admin-viewer-original");
    original.target = "_blank";
    original.rel = "noopener";
    original.append(el("span", "material-symbols-rounded", "open_in_new"), "Open original");
    const close = el("button", "admin-viewer-close");
    close.type = "button";
    close.setAttribute("aria-label", "Close");
    close.append(el("span", "material-symbols-rounded", "close"));
    bar.append(caption, original, close);

    const stage = el("div", "admin-viewer-stage");
    const img = el("img", "admin-viewer-img");
    const prev = el("button", "admin-viewer-nav admin-viewer-prev");
    prev.type = "button";
    prev.setAttribute("aria-label", "Previous image");
    prev.append(el("span", "material-symbols-rounded", "chevron_left"));
    const next = el("button", "admin-viewer-nav admin-viewer-next");
    next.type = "button";
    next.setAttribute("aria-label", "Next image");
    next.append(el("span", "material-symbols-rounded", "chevron_right"));
    stage.append(prev, img, next);

    dialog.append(bar, stage);
    document.body.append(dialog);

    viewer = { dialog, caption, original, img, prev, next, images: [], index: 0 };
    const step = (delta) => showImage(viewer.index + delta);
    prev.addEventListener("click", () => step(-1));
    next.addEventListener("click", () => step(1));
    close.addEventListener("click", () => dialog.close());
    // Clicks on the dark area around the image close the viewer.
    dialog.addEventListener("click", (e) => {
        if (e.target === dialog || e.target === stage) dialog.close();
    });
    dialog.addEventListener("keydown", (e) => {
        if (e.key === "ArrowLeft") step(-1);
        if (e.key === "ArrowRight") step(1);
    });
    dialog.addEventListener("close", () => { img.removeAttribute("src"); });
    return viewer;
}

function showImage(index) {
    const { images } = viewer;
    viewer.index = (index + images.length) % images.length;
    const file = images[viewer.index];
    viewer.img.src = file.url;
    viewer.img.alt = file.name;
    viewer.original.href = file.url;
    viewer.caption.textContent = images.length > 1 ? `${file.name} · ${viewer.index + 1} of ${images.length}` : file.name;
    viewer.prev.hidden = viewer.next.hidden = images.length < 2;
}

function openViewer(images, index) {
    getViewer();
    viewer.images = images;
    showImage(index);
    if (!viewer.dialog.open) viewer.dialog.showModal();
}


// ------------------------------------------------------------------- tabs

// Shows the status filter on tabs that have one, with that tab's wording.
function updateStatusFilter() {
    const labels = TABS[activeTab].status;
    statusFilter.hidden = !labels;
    if (!labels) return;
    for (const option of statusFilter.options) {
        option.textContent = labels[option.value === "new" ? "open" : option.value];
    }
}

updateStatusFilter();

document.querySelectorAll(".admin-tab").forEach((tab) => {
    tab.addEventListener("click", () => {
        activeTab = tab.dataset.tab;
        document.querySelectorAll(".admin-tab").forEach((t) => {
            const active = t === tab;
            t.classList.toggle("active", active);
            t.setAttribute("aria-selected", String(active));
        });
        document.querySelectorAll(".admin-list").forEach((list) => {
            list.hidden = list.dataset.list !== activeTab;
        });
        updateStatusFilter();
        renderList();
    });
});

search.addEventListener("input", renderList);
statusFilter.addEventListener("change", renderList);
