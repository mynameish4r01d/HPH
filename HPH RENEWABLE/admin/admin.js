// Admin overview of ocular site visit ("Schedule a Visit") requests (Firestore: visitRequests),
// "Join the Waitlist" sign-ups (Firestore: waitlist) and feedback
// (Firestore: feedback).
//
// Sign-in uses Firebase Authentication: email + password, or "Sign in with
// Google". Passwords are never stored in this repo — password accounts are
// created in the Firebase console → Authentication → Users → Add user; Google
// needs no account setup. Either way, only emails in ADMIN_EMAILS get in.
//
// Who counts as an admin is hardcoded in three places; keep them in step:
//   - ADMIN_EMAILS below (decides what this page shows)
//   - isAdmin() in /firestore.rules (lets admins read submissions)
//   - isAdmin() in /storage.rules (lets admins open attachments)
// The rules are what actually protect the data; this list only affects
// what the page displays.

import { firebaseConfig } from "../firebase-config.js";

const FIREBASE_VERSION = "12.3.0";
const ADMIN_EMAILS = [
    "harold.t.hermosa@gmail.com",
    "jeff.hermosa@hphtechsolutions.com",
    "lerin.hermosa@hphtechsolutions.com",
];
const MAX_ROWS = 500;

// Stale alert: an open visit request or waitlist sign-up (not marked done /
// contacted) older than this many hours gets an amber "No contact" tag, and
// past STALE_HOURS a red "Stale" tag.
const STALE_WARN_HOURS = 48;
const STALE_HOURS = 72;

// Waitlist product filter, in this order.
const WAITLIST_PRODUCTS = ["MSU4000 Elite", "MAU5000 Elite", "B4000 Elite", "B5000 Elite"];

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
const staleAlert = document.querySelector(".admin-stale");
const referrals = document.querySelector(".admin-referrals");
const productFilter = document.querySelector(".admin-product-filter");
const listCount = document.querySelector(".admin-list-count");
const exportButton = document.querySelector(".admin-export");
const mainArea = document.querySelector(".admin-main");
const overview = document.querySelector(".admin-overview");
const detailPane = document.querySelector(".admin-detail-pane");

// Desktop layout (sidebar + detail pane); matches the 750px mobile breakpoint
// in styles.css. Phones open entries in place instead.
const desktop = window.matchMedia("(min-width: 751px)");

let data = { visits: [], waitlist: [], feedback: [] };
let activeTab = "visits";
let activeProduct = "all";
// The entry shown in the detail pane (desktop), as { tab, id }.
let selected = null;


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
        closeEntry();
        show(loginSection);
        return;
    }

    if (!isAdminEmail(user.email)) {
        const email = user.email;
        await authSdk.signOut(auth);
        showLoginError(email ? `${email} doesn't have admin access.` : "This account doesn't have admin access.");
        return;
    }

    loginError.hidden = true;
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

// "Sign in with Google": a pop-up, or a full-page redirect if the browser
// blocks pop-ups. Access is then checked in onAuthStateChanged above.
const googleButton = loginSection.querySelector(".admin-google");
const googleProvider = new authSdk.GoogleAuthProvider();
googleProvider.setCustomParameters({ prompt: "select_account" });

googleButton.addEventListener("click", async () => {
    loginError.hidden = true;
    googleButton.disabled = true;
    try {
        await authSdk.signInWithPopup(auth, googleProvider);
    } catch (err) {
        if (err.code === "auth/popup-blocked") {
            await authSdk.signInWithRedirect(auth, googleProvider);
            return;
        }
        if (err.code !== "auth/popup-closed-by-user" && err.code !== "auth/cancelled-popup-request") {
            console.error("Admin: Google sign-in failed", err);
            showLoginError(signInErrorMessage(err.code));
        }
    } finally {
        googleButton.disabled = false;
    }
});

// Errors from a redirect sign-in arrive here.
authSdk.getRedirectResult(auth).catch((err) => {
    console.error("Admin: Google sign-in failed", err);
    showLoginError(signInErrorMessage(err.code));
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
            return "This sign-in method is turned off: enable it (Email/Password or Google) in Firebase console → Authentication → Sign-in method.";
        case "auth/unauthorized-domain":
            return "This website isn't allowed to use Google sign-in yet: add its domain in Firebase console → Authentication → Settings → Authorized domains.";
        case "auth/account-exists-with-different-credential":
            return "This email already has a password account. Sign in with your email and password instead.";
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
        // Re-show the open entry with the fresh data (or close it if it's gone).
        if (selected) showEntry(selected.tab, selected.id);
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

// Per-tab settings. Tabs with a `pipeline` get stages: a badge on each entry,
// a stepper on the open entry, the stage filter and the overview's Pipeline
// box. A stage change saves stage, stageUpdatedAt and stageUpdatedBy (see
// isValidStageChange() in /firestore.rules, which lists the same stage keys,
// so keep both in step). Entries from before stages existed only have
// `status` ("new"/"done"); stageOf() reads a "done" one as `legacyDone`.
// `offPath` stages (Cancelled) sit off the stepper's line; `closed` ones end
// the pipeline and are dimmed in the list; `won` counts toward conversion.
const TABS = {
    visits: {
        collection: "visitRequests",
        label: "Ocular visit request",
        render: (entry) => renderVisit(entry),
        pipeline: {
            name: "Ocular visits",
            stages: [
                { key: "new", label: "New" },
                { key: "contacted", label: "Contacted" },
                { key: "scheduled", label: "Visit scheduled" },
                { key: "visited", label: "Visited" },
                { key: "quoted", label: "Quote sent" },
                { key: "installed", label: "Installed" },
            ],
            legacyDone: "visited",
            legacyMarked: "Marked done",
            won: "installed",
            closed: ["installed"],
            all: "All requests",
            noun: ["ocular visit request", "ocular visit requests"],
        },
    },
    waitlist: {
        collection: "waitlist",
        label: "Waitlist sign-up",
        render: (entry) => renderWaitlist(entry),
        pipeline: {
            name: "Waitlist",
            stages: [
                { key: "new", label: "New" },
                { key: "contacted", label: "Contacted" },
                { key: "reserved", label: "Reserved" },
                { key: "delivered", label: "Delivered" },
                { key: "cancelled", label: "Cancelled", offPath: true },
            ],
            legacyDone: "contacted",
            legacyMarked: "Marked contacted",
            won: "delivered",
            closed: ["delivered", "cancelled"],
            all: "All sign-ups",
            noun: ["waitlist sign-up", "waitlist sign-ups"],
        },
    },
    feedback: {
        collection: "feedback",
        label: "Feedback",
        render: (entry) => renderFeedback(entry),
    },
};

function stageOf(tab, entry) {
    const { stages, legacyDone } = TABS[tab].pipeline;
    if (stages.some((s) => s.key === entry.stage)) return entry.stage;
    return entry.status === "done" ? legacyDone : "new";
}

function stageInfo(tab, key) {
    return TABS[tab].pipeline.stages.find((s) => s.key === key);
}

function isClosed(tab, entry) {
    return TABS[tab].pipeline.closed.includes(stageOf(tab, entry));
}

// Hours since an entry still at "New" was submitted; null once it has moved
// on (or has no date).
function hoursWaiting(tab, entry) {
    const created = toDate(entry.createdAt);
    if (stageOf(tab, entry) !== "new" || !created) return null;
    return (Date.now() - created.getTime()) / 3600000;
}

function isStale(tab, entry) {
    const hours = hoursWaiting(tab, entry);
    return hours !== null && hours >= STALE_WARN_HOURS;
}

// Amber "No contact · 2d" from 48 h, red "Stale · 3d" from 72 h.
function staleBadge(tab, entry) {
    const hours = hoursWaiting(tab, entry);
    if (hours === null || hours < STALE_WARN_HOURS) return null;
    const days = Math.floor(hours / 24);
    const late = hours >= STALE_HOURS;
    const badge = el("span", late ? "admin-badge admin-badge-stale" : "admin-badge admin-badge-warn",
        `${late ? "Stale" : "No contact"} · ${days}d`);
    badge.title = `No contact for ${Math.floor(hours)} hours`;
    return badge;
}

// Stage tag: green for New, black for the won stage (Installed/Delivered),
// grey for Cancelled, blue for the stages in between.
function stageBadge(tab, entry) {
    const key = stageOf(tab, entry);
    const stage = stageInfo(tab, key);
    let kind = "admin-badge-stage";
    if (key === "new") kind = "admin-badge-active";
    else if (key === TABS[tab].pipeline.won) kind = "";
    else if (stage.offPath) kind = "admin-badge-off";
    return el("span", `admin-badge ${kind}`.trim(), stage.label);
}

function plural(count, [one, many]) {
    return `${count} ${count === 1 ? one : many}`;
}

// Banner above the tabs: how many entries are still at "New" past 48 h, per
// tab, each a link that shows them.
function renderStaleAlert() {
    const parts = ["visits", "waitlist"]
        .map((tab) => ({ tab, entries: data[tab].filter((e) => isStale(tab, e)) }))
        .filter(({ entries }) => entries.length);
    if (!parts.length) {
        staleAlert.hidden = true;
        return;
    }
    const total = parts.reduce((sum, { entries }) => sum + entries.length, 0);
    const late = parts.reduce((sum, { tab, entries }) => sum + entries.filter((e) => hoursWaiting(tab, e) >= STALE_HOURS).length, 0);

    const text = el("span", "admin-stale-text");
    text.append(el("strong", "", `${total} waiting over ${STALE_WARN_HOURS} hours with no contact`));
    if (late) text.append(` (${late} over ${STALE_HOURS} hours)`);
    const links = el("span", "admin-stale-links");
    for (const { tab, entries } of parts) {
        const link = el("button", "admin-stale-link", plural(entries.length, TABS[tab].pipeline.noun));
        link.type = "button";
        link.addEventListener("click", () => showStage(tab, "stale"));
        links.append(link);
    }
    staleAlert.replaceChildren(el("span", "material-symbols-rounded", "schedule"), text, links);
    staleAlert.hidden = false;
}

// Switches the sidebar to `tab`, filtered to one stage (or "stale"/"all").
function showStage(tab, value) {
    selectTab(tab);
    statusFilter.value = value;
    renderList();
}

// Overview "Pipeline" box: how many entries sit at each stage, per tab, with
// a bar for each stage's share. Clicking a stage lists those entries.
function renderPipeline() {
    const groups = ["visits", "waitlist"].map((tab) => {
        const { name, stages, won } = TABS[tab].pipeline;
        const total = data[tab].length;
        const counts = stages.map((stage) => ({
            stage,
            count: data[tab].filter((e) => stageOf(tab, e) === stage.key).length,
        }));
        const wins = counts.find(({ stage }) => stage.key === won).count;

        const head = el("div", "admin-pipeline-head");
        head.append(
            el("span", "admin-pipeline-name", name),
            el("span", "admin-pipeline-sub", total
                ? `${wins} of ${total} ${stageInfo(tab, won).label.toLowerCase()} · ${Math.round((wins / total) * 100)}%`
                : "Nothing yet"),
        );

        const row = el("div", "admin-pipeline-stages");
        row.style.setProperty("--stages", stages.length);
        for (const { stage, count } of counts) {
            const cell = el("button", stage.offPath ? "admin-pipeline-stage admin-pipeline-off" : "admin-pipeline-stage");
            cell.type = "button";
            cell.title = `List ${stage.label.toLowerCase()} ${TABS[tab].pipeline.noun[1]}`;
            const bar = el("span", "admin-pipeline-bar");
            bar.style.setProperty("--share", total ? count / total : 0);
            cell.append(
                el("span", "admin-pipeline-count", String(count)),
                el("span", "admin-pipeline-label", stage.label),
                bar,
            );
            cell.addEventListener("click", () => showStage(tab, stage.key));
            row.append(cell);
        }

        const group = el("div", "admin-pipeline-group");
        group.append(head, row);
        return group;
    });
    document.querySelector(".admin-pipeline-groups").replaceChildren(...groups);
}

// Referral leaderboard: visit requests grouped by referral code, ranked by how
// many reached the won stage (Installed), then by how many were referred.
function renderReferrals() {
    const groups = new Map();
    for (const v of data.visits) {
        const code = (v.referralCode || "").trim().toUpperCase();
        if (!code) continue;
        if (!groups.has(code)) groups.set(code, []);
        groups.get(code).push(v);
    }
    referrals.hidden = !groups.size;
    if (!groups.size) return;

    const won = TABS.visits.pipeline.won;
    const board = [...groups.entries()]
        .map(([code, list]) => ({ code, list, wins: list.filter((v) => stageOf("visits", v) === won).length }))
        .sort((a, b) => b.wins - a.wins || b.list.length - a.list.length || a.code.localeCompare(b.code));

    const referred = board.reduce((sum, { list }) => sum + list.length, 0);
    const installs = board.reduce((sum, { wins }) => sum + wins, 0);
    referrals.querySelector(".admin-referrals-count").textContent =
        `${plural(board.length, ["code", "codes"])} · ${plural(referred, ["referred visit", "referred visits"])} · ${installs} installed`;

    const rows = board.map(({ code, list, wins }, i) => {
        const row = el("div", "admin-referral");
        const rank = el("span", i < 3 && wins ? `admin-referral-rank admin-referral-top` : "admin-referral-rank", String(i + 1));
        rank.setAttribute("aria-label", `Rank ${i + 1}`);
        const codeButton = el("button", "admin-referral-code", code);
        codeButton.type = "button";
        codeButton.title = `Show visit requests referred by ${code}`;
        codeButton.addEventListener("click", () => {
            search.value = code;
            showStage("visits", "all");
        });
        const stats = el("span", "admin-referral-stats");
        stats.append(
            el("strong", "", `${wins} installed`),
            ` · ${plural(list.length, ["referral", "referrals"])} · ${Math.round((wins / list.length) * 100)}% converted`,
        );
        const people = el("ul", "admin-referral-people");
        people.append(...list.map((v) => {
            const item = el("li");
            item.append(el("span", "", v.name || "(no name)"));
            item.append(el("span", "admin-muted", ` · ${formatDate(toDate(v.createdAt))} · ${stageInfo("visits", stageOf("visits", v)).label}`));
            return item;
        }));
        row.append(rank, codeButton, stats, people);
        return row;
    });
    referrals.querySelector(".admin-referrals-list").replaceChildren(...rows);
}

// Product names in a waitlist sign-up (from `quantities`, or early test ones'
// `products` / `product`).
function waitlistProducts(w) {
    if (w.quantities && typeof w.quantities === "object") return Object.keys(w.quantities);
    return Array.isArray(w.products) ? w.products : [w.product].filter(Boolean);
}

// Chips above the waitlist: All, then each product with its sign-ups and
// units requested. Clicking one shows only sign-ups that include it.
function renderProductFilter() {
    const chip = (value, label, sub) => {
        const button = el("button", "admin-product-chip");
        button.type = "button";
        button.setAttribute("aria-pressed", String(activeProduct === value));
        button.append(el("span", "admin-product-name", label));
        if (sub) button.append(el("span", "admin-product-sub", sub));
        button.addEventListener("click", () => {
            activeProduct = value;
            renderProductFilter();
            renderList();
        });
        return button;
    };
    const chips = [chip("all", "All products", plural(data.waitlist.length, ["sign-up", "sign-ups"]))];
    for (const name of WAITLIST_PRODUCTS) {
        const signups = data.waitlist.filter((w) => waitlistProducts(w).includes(name));
        const units = signups.reduce((sum, w) => sum + (w.quantities && Number.isFinite(w.quantities[name]) ? w.quantities[name] : 0), 0);
        chips.push(chip(name, name, `${plural(signups.length, ["sign-up", "sign-ups"])} · ${units} units`));
    }
    productFilter.replaceChildren(...chips);
}

function renderStats() {
    const openVisits = data.visits.filter((v) => !isClosed("visits", v)).length;
    const ratings = data.feedback.map((f) => f.rating).filter((r) => typeof r === "number");
    const average = ratings.length ? (ratings.reduce((a, b) => a + b, 0) / ratings.length).toFixed(1) : "–";

    const set = (key, value) => { document.querySelector(`[data-stat="${key}"]`).textContent = value; };
    set("visits-open", openVisits);
    set("referrals", data.visits.filter((v) => (v.referralCode || "").trim()).length);
    set("waitlist", data.waitlist.length);
    set("feedback", data.feedback.length);
    const rating = document.querySelector('[data-stat="rating"]');
    rating.textContent = ratings.length ? `${average} ` : "–";
    if (ratings.length) rating.append(el("span", "admin-star-filled", "★"));

    for (const key of Object.keys(TABS)) {
        document.querySelector(`[data-count="${key}"]`).textContent = data[key].length;
    }
    renderStaleAlert();
    renderPipeline();
    renderReferrals();
    renderProductFilter();
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

// The active tab's entries that match the search, stage filter and (waitlist)
// product chip: what the list shows, and what Export CSV downloads.
function filteredEntries() {
    const term = search.value.trim().toLowerCase();
    const wanted = TABS[activeTab].pipeline ? statusFilter.value : "all";
    const product = activeTab === "waitlist" ? activeProduct : "all";
    const entries = data[activeTab].filter((entry) => matches(entry, term)
        && (wanted === "all"
            || (wanted === "stale" ? isStale(activeTab, entry)
                : wanted === "open" ? !isClosed(activeTab, entry)
                : stageOf(activeTab, entry) === wanted))
        && (product === "all" || waitlistProducts(entry).includes(product)));
    return { entries, filtered: Boolean(term) || wanted !== "all" || product !== "all" };
}

function renderList() {
    const list = document.querySelector(`[data-list="${activeTab}"]`);
    const { entries, filtered } = filteredEntries();
    const total = data[activeTab].length;
    listCount.textContent = filtered ? `${entries.length} of ${total} shown` : plural(total, ["entry", "entries"]);
    exportButton.disabled = !entries.length;
    if (!entries.length) {
        list.replaceChildren(el("p", "admin-empty", filtered ? "No matches." : "Nothing submitted yet."));
        return;
    }
    list.replaceChildren(...entries.map((entry) => renderEntry(activeTab, entry)));
    markSelected();
}

// An entry's <details>, tagged with its id so the sidebar can find it.
function renderEntry(tab, entry) {
    const details = TABS[tab].render(entry);
    details.dataset.id = entry.id;
    return details;
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
    if (value !== "" && value !== undefined && value !== null) makeCopyable(row, label, String(value));
    return row;
}

// Click a detail (or its copy icon) to copy its value. Clicking a phone/email
// link still calls/emails; the icon copies it. A drag-selection is left alone
// so part of a value can still be copied by hand.
function makeCopyable(row, label, text) {
    row.classList.add("admin-detail-copy");
    const button = el("button", "admin-copy");
    button.type = "button";
    button.title = `Copy ${label.toLowerCase()}`;
    button.setAttribute("aria-label", `Copy ${label.toLowerCase()}`);
    const icon = el("span", "material-symbols-rounded", "content_copy");
    button.append(icon, el("span", "admin-copy-done", "Copied"));
    row.querySelector("dd").append(button);

    let timer;
    row.addEventListener("click", async (e) => {
        if (e.target.closest("a")) return;
        if (!button.contains(e.target) && String(window.getSelection())) return;
        try {
            await copyText(text);
        } catch (err) {
            console.error("Admin: copy failed", err);
            return;
        }
        row.classList.add("copied");
        icon.textContent = "check";
        clearTimeout(timer);
        timer = setTimeout(() => {
            row.classList.remove("copied");
            icon.textContent = "content_copy";
        }, 1400);
    });
}

async function copyText(text) {
    if (navigator.clipboard && window.isSecureContext) {
        await navigator.clipboard.writeText(text);
        return;
    }
    // Fallback for plain-http pages, where the Clipboard API isn't available.
    const area = el("textarea");
    area.value = text;
    area.setAttribute("readonly", "");
    area.style.position = "fixed";
    area.style.opacity = "0";
    document.body.append(area);
    area.select();
    const ok = document.execCommand("copy");
    area.remove();
    if (!ok) throw new Error("execCommand copy failed");
}

// `meta` is text or a node (e.g. the feedback stars). `badge` is the stage
// tag from stageBadge(); `stale` the amber/red no-contact tag from
// staleBadge(), if any. `dim` (closed entries) fades the row in the list.
function entryShell(title, meta, date, { dim, badge, stale } = {}) {
    const details = el("details", dim ? "admin-entry admin-entry-done" : "admin-entry");
    const summary = el("summary");
    const main = el("div", "admin-entry-main");
    const heading = el("span", "admin-entry-heading");
    heading.append(el("span", "admin-entry-title", title || "(no name)"));
    if (badge) heading.append(badge);
    if (stale) heading.append(stale);
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
    const referral = (v.referralCode || "").trim();
    const meta = [v.product, v.propertyType, v.phone, referral && `Referred by ${referral}`].filter(Boolean).join(" · ");
    const paths = Array.isArray(v.attachments) ? v.attachments : [];
    const details = entryShell(v.name, meta, toDate(v.createdAt), {
        dim: isClosed("visits", v), badge: stageBadge("visits", v), stale: staleBadge("visits", v),
    });
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
        detailRow("Address", v.address),
        detailRow("Property type", v.propertyType),
        detailRow("Product", v.product),
        detailRow("Monthly bill", v.monthlyBill),
        detailRow("Preferred date", v.preferredDate),
        detailRow("Preferred time", v.preferredTime),
        detailRow("Referral code", referral),
        detailRow("Message", v.message, { wide: true }),
        detailRow("Submitted", formatDate(toDate(v.createdAt))),
        detailRow("Request ID", v.id),
    );
    appendStage("visits", v, list, details);

    if (paths.length) {
        const files = el("div", "admin-attachments");
        files.append(el("span", "admin-attachments-label", `Attachments (${paths.length})`));
        const fileList = el("ul", "admin-attachment-grid");
        files.append(fileList);
        details.append(files);

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
    details.append(ticket("feedback", f, list));
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
    // Sign-ups store a full `address`; early test ones had `location` (city).
    const address = w.address || w.location || "";
    const estimate = Number.isFinite(w.estimatedTotal) ? `₱${w.estimatedTotal.toLocaleString("en-PH")}` : "";
    const meta = [products, estimate, w.phone].filter(Boolean).join(" · ");
    const details = entryShell(w.name, meta, toDate(w.createdAt), {
        dim: isClosed("waitlist", w), badge: stageBadge("waitlist", w), stale: staleBadge("waitlist", w),
    });

    const list = el("dl", "admin-details");
    list.append(
        // One product per line (the summary line above keeps them comma-separated).
        detailRow("Order", waitlistItems(w).join("\n")),
        detailRow("Estimated total", estimate ? `${estimate}\nFrom starting prices; not a quotation` : ""),
        detailRow("System", w.system ? `${w.system} system` : ""),
        detailRow("Home / delivery address", address),
        detailRow("Phone", w.phone, { href: w.phone ? `tel:${w.phone.replace(/[^\d+]/g, "")}` : "" }),
        detailRow("Email", w.email, { href: w.email ? `mailto:${w.email}` : "" }),
        detailRow("Note", w.message, { wide: true }),
        detailRow("Submitted", formatDate(toDate(w.createdAt))),
    );
    appendStage("waitlist", w, list, details);
    return details;
}

// An entry's details laid out as a ticket: a stub with the kind of entry and
// a short ticket number (start of the Firestore id), a perforation with a
// notch on each side, then the details. The notches are cut by a CSS mask on
// .admin-ticket-paper; the outline and shadow come from a filter on the outer
// .admin-ticket, so they follow the notches.
function ticket(tab, entry, list) {
    const outer = el("div", "admin-ticket");
    const paper = el("div", "admin-ticket-paper");
    const stub = el("div", "admin-ticket-stub");
    const kind = el("span", "admin-ticket-kind");
    kind.append(el("span", "material-symbols-rounded", "confirmation_number"), TABS[tab].label);
    stub.append(kind);
    if (entry.id) stub.append(el("span", "admin-ticket-no", `No. ${entry.id.slice(0, 6).toUpperCase()}`));
    paper.append(stub, list);
    outer.append(paper);
    return outer;
}

// Adds the stage stepper (click any stage to set it), a blue "Move to <next
// stage>" button and, for pipelines with an off-path stage (waitlist:
// Cancelled), a button to set or undo it; then the ticket, with its "Stage
// updated" row.
function appendStage(tab, entry, list, details) {
    const pipeline = TABS[tab].pipeline;
    const current = stageOf(tab, entry);
    if (entry.stageUpdatedAt) {
        const by = entry.stageUpdatedBy ? ` by ${entry.stageUpdatedBy}` : "";
        list.append(detailRow("Stage updated", `${formatDate(toDate(entry.stageUpdatedAt))}${by}`, { wide: true }));
    } else if (entry.status === "done") {
        // Marked done/contacted before stages existed.
        const by = entry.completedBy ? ` by ${entry.completedBy}` : "";
        list.append(detailRow(pipeline.legacyMarked, `${formatDate(toDate(entry.completedAt))}${by}`, { wide: true }));
    }
    const actions = el("div", "admin-actions admin-stage-actions");
    const error = el("span", "admin-action-error");
    const save = (key) => setStage(tab, entry, key, details, actions, error);

    const path = pipeline.stages.filter((s) => !s.offPath);
    const at = path.findIndex((s) => s.key === current); // -1 when off the path (Cancelled)
    const stepper = el("ol", at === -1 ? "admin-stages admin-stages-off" : "admin-stages");
    stepper.setAttribute("aria-label", "Stage");
    // How far the blue line runs: 0 at the first stage, 1 at the last.
    stepper.style.setProperty("--progress", at > 0 ? at / (path.length - 1) : 0);
    path.forEach((stage, i) => {
        const item = el("li", i <= at ? "reached" : "");
        const button = el("button", "admin-stage");
        button.type = "button";
        button.append(el("span", "admin-stage-dot"), el("span", "admin-stage-label", stage.label));
        if (stage.key === current) {
            button.setAttribute("aria-current", "step");
            button.title = `Current stage: ${stage.label}`;
        } else {
            button.title = `Set stage to ${stage.label}`;
            button.addEventListener("click", () => save(stage.key));
        }
        item.append(button);
        stepper.append(item);
    });

    const buttons = el("div", "admin-stage-buttons");
    const next = at === -1 ? null : path[at + 1];
    if (next) {
        const move = el("button", "admin-action admin-action-primary");
        move.type = "button";
        move.append(el("span", "material-symbols-rounded", "arrow_forward"), `Move to ${next.label}`);
        move.addEventListener("click", () => save(next.key));
        buttons.append(move);
    }
    for (const stage of pipeline.stages.filter((s) => s.offPath)) {
        const on = current === stage.key;
        const button = el("button", "admin-action");
        button.type = "button";
        button.append(
            el("span", "material-symbols-rounded", on ? "undo" : "block"),
            on ? "Reopen as New" : `Mark as ${stage.label.toLowerCase()}`,
        );
        button.addEventListener("click", () => save(on ? "new" : stage.key));
        buttons.append(button);
    }
    buttons.prepend(error);
    actions.append(stepper, buttons);
    details.append(actions, ticket(tab, entry, list));
}

// Only stage, stageUpdatedAt and stageUpdatedBy may change — see
// isValidStageChange() in /firestore.rules.
async function setStage(tab, entry, stage, details, actions, errorText) {
    const buttons = actions.querySelectorAll("button");
    buttons.forEach((b) => { b.disabled = true; });
    errorText.textContent = "";
    const email = auth.currentUser ? auth.currentUser.email : null;
    try {
        await firestore.updateDoc(firestore.doc(db, TABS[tab].collection, entry.id), {
            stage,
            stageUpdatedAt: firestore.serverTimestamp(),
            stageUpdatedBy: email,
        });
        entry.stage = stage;
        entry.stageUpdatedAt = firestore.Timestamp.now();
        entry.stageUpdatedBy = email;

        renderStats();
        if (detailPane.contains(details)) {
            // Desktop: refresh the sidebar row's tags and the open entry.
            renderList();
            showEntry(tab, entry.id);
        } else if (statusFilter.value === "all") {
            const updated = renderEntry(tab, entry);
            updated.open = true;
            details.replaceWith(updated);
        } else {
            renderList();
        }
    } catch (err) {
        console.error("Admin: stage update failed", err);
        errorText.textContent = err.code === "permission-denied"
            ? "Permission denied. Publish the latest /firestore.rules in the Firebase console."
            : "Couldn't save. Check your connection and try again.";
        buttons.forEach((b) => { b.disabled = false; });
    }
}


// ------------------------------------------------------------------ export

// Export CSV: what the list shows (active tab, search, stage filter, product
// chip), for Excel or Google Sheets. Starts with a byte-order mark so Excel
// reads ₱ and ñ correctly.
const CSV_COLUMNS = {
    visits: [
        ["Submitted", (v) => csvDate(toDate(v.createdAt))],
        ["Name", (v) => v.name],
        ["Phone", (v) => v.phone],
        ["Email", (v) => v.email],
        ["Address", (v) => v.address],
        ["Property type", (v) => v.propertyType],
        ["Product", (v) => v.product],
        ["Monthly bill", (v) => v.monthlyBill],
        ["Preferred date", (v) => v.preferredDate],
        ["Preferred time", (v) => v.preferredTime],
        ["Referral code", (v) => (v.referralCode || "").trim().toUpperCase()],
        ["Message", (v) => v.message],
        ["Stage", (v) => stageInfo("visits", stageOf("visits", v)).label],
        ["Stage updated", (v) => csvDate(toDate(v.stageUpdatedAt || v.completedAt))],
        ["Updated by", (v) => v.stageUpdatedBy || v.completedBy],
        ["Attachments", (v) => (Array.isArray(v.attachments) ? v.attachments.length : 0)],
        ["Request ID", (v) => v.id],
    ],
    waitlist: [
        ["Submitted", (w) => csvDate(toDate(w.createdAt))],
        ["Name", (w) => w.name],
        ["Phone", (w) => w.phone],
        ["Email", (w) => w.email],
        ["Home / delivery address", (w) => w.address || w.location],
        ["System", (w) => w.system],
        ["Order", (w) => waitlistItems(w).join("; ")],
        ["Estimated total (PHP)", (w) => (Number.isFinite(w.estimatedTotal) ? w.estimatedTotal : "")],
        ["Note", (w) => w.message],
        ["Stage", (w) => stageInfo("waitlist", stageOf("waitlist", w)).label],
        ["Stage updated", (w) => csvDate(toDate(w.stageUpdatedAt || w.completedAt))],
        ["Updated by", (w) => w.stageUpdatedBy || w.completedBy],
        ["Sign-up ID", (w) => w.id],
    ],
    feedback: [
        ["Submitted", (f) => csvDate(toDate(f.createdAt))],
        ["Name", (f) => f.name],
        ["Rating", (f) => f.rating],
        ["Feedback", (f) => f.message],
        ["Contact", (f) => f.contact],
        ["OK to publish", (f) => (f.allowPublish ? "Yes" : "No")],
        ["Feedback ID", (f) => f.id],
    ],
};

// "2026-10-02 14:05": sorts correctly and spreadsheets read it as a date.
function csvDate(date) {
    if (!date) return "";
    const pad = (n) => String(n).padStart(2, "0");
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

// Quotes a value if needed. Text from the public forms that starts with
// = + - @ gets a leading ' so a spreadsheet shows it instead of running it
// as a formula.
function csvCell(value) {
    let text = value === undefined || value === null ? "" : String(value);
    if (typeof value === "string" && /^[=+\-@\t\r]/.test(text)) text = `'${text}`;
    return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

exportButton.addEventListener("click", () => {
    const { entries } = filteredEntries();
    const columns = CSV_COLUMNS[activeTab];
    const rows = [
        columns.map(([heading]) => csvCell(heading)),
        ...entries.map((entry) => columns.map(([, get]) => csvCell(get(entry)))),
    ];
    const csv = "﻿" + rows.map((row) => row.join(",")).join("\r\n");
    const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
    const link = el("a");
    link.href = url;
    link.download = `hph-${activeTab}-${csvDate(new Date()).slice(0, 10)}.csv`;
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
});

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


// ------------------------------------------------------------ detail pane

// Desktop: a clicked sidebar entry opens in the right-hand pane in place of
// the overview. It's a fresh render of the same <details>, kept open, so the
// done/contacted toggle and attachments work just as they do inline.
function showEntry(tab, id) {
    const entry = data[tab].find((e) => e.id === id);
    if (!entry) {
        closeEntry();
        return;
    }
    const sameEntry = selected && selected.tab === tab && selected.id === id;
    selected = { tab, id };

    const details = renderEntry(tab, entry);
    details.classList.add("admin-entry-full");
    details.open = true;
    detailPane.querySelector(".admin-detail-kind").textContent = TABS[tab].label;
    // The pinned header shows the summary line (name, tags, details, date);
    // the entry's own summary is hidden in the pane.
    detailPane.querySelector(".admin-detail-title").replaceChildren(
        ...[...details.querySelector("summary").children]
            .filter((child) => !child.classList.contains("admin-chevron"))
            .map((child) => child.cloneNode(true)),
    );
    detailPane.querySelector(".admin-detail-body").replaceChildren(details);
    overview.hidden = true;
    detailPane.hidden = false;
    // A different entry starts at the top; a refresh of the same one stays put.
    if (!sameEntry) mainArea.scrollTop = 0;
    markSelected();
}

function closeEntry() {
    selected = null;
    detailPane.hidden = true;
    detailPane.querySelector(".admin-detail-body").replaceChildren();
    detailPane.querySelector(".admin-detail-title").replaceChildren();
    overview.hidden = false;
    markSelected();
}

// Highlights the open entry in the sidebar list.
function markSelected() {
    document.querySelectorAll(".admin-list .admin-entry").forEach((entry) => {
        const on = Boolean(selected) && entry.closest(".admin-list").dataset.list === selected.tab
            && entry.dataset.id === selected.id;
        entry.classList.toggle("admin-entry-selected", on);
        entry.querySelector("summary").setAttribute("aria-current", String(on));
    });
}

// On desktop a sidebar entry opens in the pane instead of expanding in place.
document.querySelectorAll(".admin-list").forEach((list) => {
    list.addEventListener("click", (e) => {
        if (!desktop.matches) return;
        const summary = e.target.closest("summary");
        if (!summary || !list.contains(summary)) return;
        e.preventDefault();
        showEntry(list.dataset.list, summary.parentElement.dataset.id);
    });
});

// The open entry in the pane can't be collapsed.
detailPane.addEventListener("click", (e) => {
    if (e.target.closest("summary")) e.preventDefault();
});

detailPane.querySelector(".admin-back").addEventListener("click", closeEntry);

// Shrinking to the phone layout: back to entries opening in place.
desktop.addEventListener("change", () => {
    if (!desktop.matches && selected) closeEntry();
});


// ------------------------------------------------------------------- tabs

// The stage filter, rebuilt with the active tab's stages (hidden on tabs
// without a pipeline). Keeps the choice when the new tab has it.
function updateStatusFilter() {
    const pipeline = TABS[activeTab].pipeline;
    statusFilter.hidden = !pipeline;
    if (!pipeline) return;
    const previous = statusFilter.value;
    const option = (value, label) => {
        const node = el("option", "", label);
        node.value = value;
        return node;
    };
    statusFilter.replaceChildren(
        option("all", pipeline.all),
        option("open", "Open (not closed)"),
        ...pipeline.stages.map((stage) => option(stage.key, stage.label)),
        option("stale", `No contact ${STALE_WARN_HOURS}h+`),
    );
    statusFilter.value = [...statusFilter.options].some((o) => o.value === previous) ? previous : "all";
}

function selectTab(name) {
    activeTab = name;
    document.querySelectorAll(".admin-tab").forEach((t) => {
        const active = t.dataset.tab === name;
        t.classList.toggle("active", active);
        t.setAttribute("aria-selected", String(active));
    });
    document.querySelectorAll(".admin-list").forEach((list) => {
        list.hidden = list.dataset.list !== name;
    });
    productFilter.hidden = name !== "waitlist";
    updateStatusFilter();
    renderList();
}

updateStatusFilter();

document.querySelectorAll(".admin-tab").forEach((tab) => {
    tab.addEventListener("click", () => selectTab(tab.dataset.tab));
});

search.addEventListener("input", renderList);
statusFilter.addEventListener("change", renderList);
