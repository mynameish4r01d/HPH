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
// The encoder account (ENCODER_EMAILS) has no overview dashboard and no
// feedback. It opens on the "Add installation" form, manages installations
// (editing or deleting only its own), and can view, edit and move visit
// requests and waitlist sign-ups through the pipeline, but not delete them.
// Keep it in step with isEncoder() in /firestore.rules and /storage.rules.
// The rules are what actually protect the data; these lists only affect
// what the page displays.

import { firebaseConfig } from "../firebase-config.js";

const FIREBASE_VERSION = "12.3.0";
const ADMIN_EMAILS = [
    "harold.t.hermosa@gmail.com",
    "jeff.hermosa@hphtechsolutions.com",
    "lerin.hermosa@hphtechsolutions.com",
];
const ENCODER_EMAILS = [
    "inquiries@hphtechsolutions.com",
];
const MAX_ROWS = 500;

// Serial number formats (same as portfolio-counters.js and the rules'
// isValidSerial): MX2250 micro inverters "Y" + 15, solar panels "Z" + 18.
const INVERTER_SN = /^Y[0-9A-Z]{15}$/;
const PANEL_SN = /^Z[0-9A-Z]{18}$/;

// The old installation Google Sheet, read once by "Import from Google Sheet".
const INSTALL_SHEET_CSV = "https://docs.google.com/spreadsheets/d/1I7w59tsa54pBLcBUs2T55pb-8lvfLKzCe0in_eY41WY/gviz/tq?tqx=out:csv";

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
const installActions = document.querySelector(".admin-install-actions");
const importButton = document.querySelector(".admin-import-sheet");
const importStatus = document.querySelector(".admin-import-status");
const brandLabel = document.querySelector(".admin-brand-label");

// Desktop layout (sidebar + detail pane); matches the 750px mobile breakpoint
// in styles.css. Phones open entries in place instead.
const desktop = window.matchMedia("(min-width: 751px)");

const emptyData = () => ({ visits: [], waitlist: [], feedback: [], installs: [] });
let data = emptyData();
// "admin" (everything) or "encoder" (installations only); null signed out.
let role = null;
let currentEmail = "";
let activeTab = "visits";
let activeProduct = "all";
// The entry shown in the detail pane (desktop), as { tab, id }.
let selected = null;
// True while the install form (add / edit) is in the detail pane.
let formOpen = false;


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

function isEncoderEmail(email) {
    return Boolean(email) && ENCODER_EMAILS.includes(email.toLowerCase());
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
        data = emptyData();
        role = null;
        currentEmail = "";
        delete document.body.dataset.role;
        brandLabel.textContent = "Admin Overview";
        closeEntry();
        show(loginSection);
        return;
    }

    role = isAdminEmail(user.email) ? "admin" : isEncoderEmail(user.email) ? "encoder" : null;
    if (!role) {
        const email = user.email;
        await authSdk.signOut(auth);
        showLoginError(email ? `${email} doesn't have admin access.` : "This account doesn't have admin access.");
        return;
    }

    loginError.hidden = true;
    currentEmail = user.email.toLowerCase();
    // CSS hides the overview and the other tabs for the encoder.
    document.body.dataset.role = role;
    brandLabel.textContent = role === "encoder" ? "Team Workspace" : "Admin Overview";
    account.querySelector(".admin-account-email").textContent = user.email;
    account.hidden = false;
    show(dashboard);
    if (role === "encoder") {
        selectTab("installs");
        showInstallForm(null);
    }
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
    if (!isAdminEmail(email) && !isEncoderEmail(email)) {
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
        // The encoder can't read feedback.
        const tabs = role === "encoder" ? ["visits", "waitlist", "installs"] : ["visits", "waitlist", "feedback", "installs"];
        const lists = await Promise.all(tabs.map((tab) => fetchCollection(TABS[tab].collection)));
        data = emptyData();
        tabs.forEach((tab, i) => { data[tab] = lists[i]; });
        data.installs.sort(byInstallDate);
        renderStats();
        renderList();
        fillMissingCapacities();
        // Re-show the open entry with the fresh data (or close it if it's
        // gone), unless the install form is open.
        if (selected && !formOpen) showEntry(selected.tab, selected.id);
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
    // Installations (serial numbers) — see the "installs" section below.
    installs: {
        collection: "installs",
        label: "Installation",
        render: (entry) => renderInstall(entry),
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
        const none = activeTab === "installs" ? "No installations yet." : "Nothing submitted yet.";
        list.replaceChildren(el("p", "admin-empty", filtered ? "No matches." : none));
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
// `dateText` replaces the formatted `date` (installs show their install date).
function entryShell(title, meta, date, { dim, badge, stale, dateText } = {}) {
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
    summary.append(el("span", "admin-entry-date", dateText || formatDate(date)));
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
        detailRow("Interested in", v.product),
        detailRow("Monthly bill", v.monthlyBill),
        detailRow("Preferred date", v.preferredDate),
        detailRow("Preferred time", v.preferredTime),
        detailRow("Referral code", referral),
        detailRow("Message", v.message, { wide: true }),
        detailRow("Submitted", formatDate(toDate(v.createdAt))),
        detailRow("Request ID", v.id),
    );
    if (v.editedAt) list.append(editedRow(v));
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
    const actions = el("div", "admin-actions admin-install-entry-actions");
    const error = el("span", "admin-action-error");
    actions.append(error, ...entryTools("feedback", f, error));
    details.append(actions, ticket("feedback", f, list));
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
    if (w.editedAt) list.append(editedRow(w));
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
    // Edit details / Delete, between the error text and the stage buttons.
    error.after(...entryTools(tab, entry, error));
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
        ["Interested in", (v) => v.product],
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
    installs: [
        ["Installation date", (i) => i.installDate],
        ["Client name", (i) => i.clientName],
        ["Email", (i) => i.email],
        ["Contact number", (i) => i.contact],
        ["Address", (i) => i.address],
        ["MX2250 count", (i) => serialList(i.inverterSerials).length],
        ["MX2250 serials", (i) => serialList(i.inverterSerials).join("; ")],
        ["Panel count", (i) => panelCountOf(i)],
        ["Panel serials", (i) => serialList(i.panelSerials).join("; ")],
        ["Battery serials", (i) => serialList(i.batterySerials).join("; ")],
        ["Capacity (kWp)", (i) => (Number.isFinite(i.capacityKwp) ? i.capacityKwp : "")],
        ["Added", (i) => csvDate(toDate(i.createdAt))],
        ["Added by", (i) => i.createdBy],
        ["Source", (i) => (i.source === "sheet" ? "Google Sheet import" : "Admin page")],
        ["Install ID", (i) => i.id],
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

// Cloud Storage, loaded the first time it's needed (attachments).
function loadStorage() {
    if (!storagePromise) {
        storagePromise = import(`${base}/firebase-storage.js`).then((storageSdk) => ({
            storageSdk, storage: storageSdk.getStorage(app),
        }));
        storagePromise.catch(() => { storagePromise = null; });
    }
    return storagePromise;
}

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
        const { storageSdk, storage } = await loadStorage();
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


// --------------------------------------------------------------- installs

// Installations (Firestore `installs`), which replaced the installation
// Google Sheet. Each holds the client's details, the serial numbers
// installed, and `panelCount`: how many panels were installed, including any
// whose serial wasn't recorded (the sheet used all-zero placeholders such as
// Z000000000000000000 for those; they're never stored as serials). In the
// same batch as the install:
//   - `serials/<SN>` ({ type, installId }) for every recorded MX2250 / panel
//     serial, so a serial can't be on two installs (staff-only);
//   - `installCounts/<installId>` ({ inverters, panels }), public, which the
//     portfolio counters (../portfolio-counters.js) add up, so visitors'
//     browsers never see client details.
// Admins can add, edit and delete any install; the encoder account only the
// ones it added (see /firestore.rules).

// A stored list of serials (always an array of strings).
function serialList(value) {
    return Array.isArray(value) ? value.filter((v) => typeof v === "string") : [];
}

// Newest installation date first, then newest added.
function byInstallDate(a, b) {
    return (b.installDate || "").localeCompare(a.installDate || "")
        || (toDate(b.createdAt) || 0) - (toDate(a.createdAt) || 0);
}

// "2025-08-28" -> "Aug 28, 2025".
function formatInstallDate(value) {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value || "");
    if (!m) return value || "";
    return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]))
        .toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

// All-zero stand-ins for a serial that wasn't recorded.
const PLACEHOLDER_SN = /^[YZ]0+$/;

// Serial numbers typed or pasted in any layout (one per line, commas,
// spaces): upper-cased tokens, split into ones matching `pattern` (all of
// them when there's no pattern), ones that don't, repeats, and all-zero
// placeholders (counted in `placeholders`, never stored).
function parseSerials(text, pattern) {
    const valid = [];
    const invalid = [];
    const dupes = [];
    let placeholders = 0;
    for (const token of (text || "").toUpperCase().split(/[^A-Z0-9]+/).filter(Boolean)) {
        if (pattern && !pattern.test(token)) invalid.push(token);
        else if (pattern && PLACEHOLDER_SN.test(token)) placeholders++;
        else if (valid.includes(token)) dupes.push(token);
        else valid.push(token);
    }
    return { valid, invalid, dupes, placeholders };
}

// Solar panel rating (650 W), the same as portfolio-counters.js: an install's
// capacity is its panel count × this.
const PANEL_KWP = 0.65;

// null with no panels, so an install isn't shown as "0 kWp".
function capacityFor(panelCount) {
    return panelCount > 0 ? Math.round(panelCount * PANEL_KWP * 100) / 100 : null;
}

// Panels installed: panelCount, or the recorded serials for older data.
function panelCountOf(install) {
    return Number.isInteger(install.panelCount) ? install.panelCount : serialList(install.panelSerials).length;
}

function canEditInstall(install) {
    return role === "admin"
        || (role === "encoder" && (install.createdBy || "").toLowerCase() === currentEmail);
}

function renderInstall(i) {
    const inverters = serialList(i.inverterSerials);
    const panels = serialList(i.panelSerials);
    const batteries = serialList(i.batterySerials);
    const capacity = Number.isFinite(i.capacityKwp) ? `${i.capacityKwp} kWp` : "";
    const panelCount = panelCountOf(i);
    const meta = [
        plural(inverters.length, ["MX2250", "MX2250s"]),
        plural(panelCount, ["panel", "panels"]),
        capacity,
        i.address,
    ].filter(Boolean).join(" · ");
    const details = entryShell(i.clientName, meta, null, {
        dateText: formatInstallDate(i.installDate) || "No install date",
    });

    const added = `${formatDate(toDate(i.createdAt))}${i.createdBy ? ` by ${i.createdBy}` : ""}`
        + (i.source === "sheet" ? " (imported from the Google Sheet)" : "");
    const list = el("dl", "admin-details");
    list.append(
        detailRow("Installation date", formatInstallDate(i.installDate)),
        detailRow("Capacity", capacity),
        detailRow("Address", i.address, { wide: true }),
        detailRow("Contact number", i.contact, { href: i.contact ? `tel:${i.contact.replace(/[^\d+]/g, "")}` : "" }),
        detailRow("Email", i.email, { href: i.email ? `mailto:${i.email}` : "" }),
        detailRow(`MX2250 serials (${inverters.length})`, inverters.join("\n")),
        detailRow(`Solar panels (${panelCount})`, panels.length
            ? `${panels.join("\n")}${panels.length < panelCount ? `\n+ ${panelCount - panels.length} without a recorded serial` : ""}`
            : `${panelCount} ${panelCount === 1 ? "panel" : "panels"}, serials not recorded`),
        detailRow(`Battery serials (${batteries.length})`, batteries.join("\n"), { wide: true }),
        detailRow("Added", added, { wide: true }),
    );
    if (i.updatedAt) {
        list.append(detailRow("Last edited",
            `${formatDate(toDate(i.updatedAt))}${i.updatedBy ? ` by ${i.updatedBy}` : ""}`, { wide: true }));
    }
    list.append(detailRow("Install ID", i.id));

    // Edit / Delete, above the ticket like the stage stepper, for installs
    // this account may change.
    if (canEditInstall(i)) {
        const actions = el("div", "admin-actions admin-install-entry-actions");
        const error = el("span", "admin-action-error");
        const edit = el("button", "admin-action admin-action-primary");
        edit.type = "button";
        edit.append(el("span", "material-symbols-rounded", "edit"), "Edit");
        edit.addEventListener("click", () => showInstallForm(i));
        const remove = el("button", "admin-action admin-action-danger");
        remove.type = "button";
        remove.append(el("span", "material-symbols-rounded", "delete"), "Delete");
        remove.addEventListener("click", async () => {
            if (!confirm(`Delete the installation for ${i.clientName}? Its ${plural(inverters.length, ["MX2250", "MX2250s"])} and ${plural(panelCount, ["panel", "panels"])} will stop counting toward the portfolio totals. This can't be undone.`)) return;
            remove.disabled = true;
            edit.disabled = true;
            error.textContent = "";
            try {
                await deleteInstall(i);
                selected = null;
                await loadSubmissions();
                closeEntry();
            } catch (err) {
                console.error("Admin: deleting installation failed", err);
                error.textContent = installErrorMessage(err);
                remove.disabled = false;
                edit.disabled = false;
            }
        });
        actions.append(error, edit, remove);
        details.append(actions);
    }
    details.append(ticket("installs", i, list));
    return details;
}

// The add / edit form, shown in the detail pane (on phones, at the top of
// the page). `install` is null for a new one.
function showInstallForm(install) {
    formOpen = true;
    selected = install ? { tab: "installs", id: install.id } : null;
    // The encoder's new-install form is its home page: no back button there.
    setBackButton({ hidden: role === "encoder" && !install });
    detailPane.querySelector(".admin-detail-kind").textContent = install ? "Edit installation" : "New installation";
    const main = el("div", "admin-entry-main");
    main.append(
        el("span", "admin-entry-title", install ? install.clientName : "Add an installation"),
        el("span", "admin-entry-meta", install
            ? "Change the details or serial numbers, then save."
            : "Enter the client's details and the serial numbers that were installed."),
    );
    detailPane.querySelector(".admin-detail-title").replaceChildren(main);
    detailPane.querySelector(".admin-detail-body").replaceChildren(installForm(install));
    overview.hidden = true;
    detailPane.hidden = false;
    mainArea.scrollTop = 0;
    if (!desktop.matches && install) detailPane.scrollIntoView({ block: "start" });
    markSelected();
}

function installForm(install) {
    const v = install || {};
    const form = el("form", "admin-install-form");
    form.noValidate = true;
    const grid = el("div", "admin-install-grid");

    const field = (label, tag, { name, type = "text", value = "", required, wide, placeholder, rows, attrs = {} }) => {
        const wrap = el("label", wide ? "admin-field admin-install-wide" : "admin-field");
        const input = el(tag);
        input.name = name;
        if (tag === "input") input.type = type;
        if (rows) input.rows = rows;
        if (placeholder) input.placeholder = placeholder;
        input.value = value === null || value === undefined ? "" : value;
        Object.entries(attrs).forEach(([key, val]) => input.setAttribute(key, val));
        wrap.append(el("span", "admin-label", required ? `${label} *` : label), input);
        grid.append(wrap);
        return { wrap, input };
    };

    const name = field("Client name", "input", { name: "clientName", value: v.clientName, required: true, attrs: { maxlength: 150, autocomplete: "off" } });
    const date = field("Installation date", "input", { name: "installDate", type: "date", value: v.installDate, required: true });
    const contact = field("Contact number", "input", { name: "contact", type: "tel", value: v.contact, attrs: { maxlength: 100 } });
    const email = field("Email", "input", { name: "email", type: "email", value: v.email, attrs: { maxlength: 200 } });
    const address = field("Address", "input", { name: "address", value: v.address, wide: true, attrs: { maxlength: 300 } });
    const inverters = field("MX2250 serial numbers", "textarea", {
        name: "inverterSerials", value: serialList(v.inverterSerials).join("\n"), wide: true, rows: 4,
        placeholder: "One per line, e.g. Y0019A57121D00D2",
    });
    const panels = field("Solar panel serial numbers", "textarea", {
        name: "panelSerials", value: serialList(v.panelSerials).join("\n"), wide: true, rows: 6,
        placeholder: "One per line, e.g. Z2026300G1210029683",
    });
    const batteries = field("Battery serial numbers (if any)", "textarea", {
        name: "batterySerials", value: serialList(v.batterySerials).join("\n"), wide: true, rows: 2,
    });
    const panelCount = field("Number of solar panels", "input", {
        name: "panelCount", type: "number", value: install ? panelCountOf(install) : "", required: true,
        attrs: { min: 0, max: 2000, step: 1, inputmode: "numeric" },
    });
    // Capacity isn't typed in: it's the panel count × 0.65 kWp, shown here
    // and saved with the install. An install that already has a capacity
    // (e.g. from the sheet) keeps it unless its panel count changes.
    const capacityWrap = el("div", "admin-field");
    const capacityValue = el("span", "admin-capacity-value");
    capacityWrap.append(el("span", "admin-label", "Capacity (calculated)"), capacityValue);
    grid.append(capacityWrap);
    const capacityOf = (count) => (install && Number.isFinite(install.capacityKwp) && count === panelCountOf(install)
        ? install.capacityKwp
        : capacityFor(count));

    // Live check under each serial box: how many were read, and any that
    // don't look like a serial of that kind.
    const summary = (box, pattern, noun) => {
        const out = el("span", "admin-serial-summary");
        box.wrap.append(out);
        const update = () => {
            const parsed = parseSerials(box.input.value, pattern);
            out.classList.toggle("bad", parsed.invalid.length > 0);
            box.input.classList.toggle("invalid", parsed.invalid.length > 0);
            out.replaceChildren(plural(parsed.valid.length, noun));
            if (parsed.placeholders) out.append(` · ${parsed.placeholders} all-zero ${parsed.placeholders === 1 ? "placeholder" : "placeholders"} skipped (use the panel count for panels without a serial)`);
            if (parsed.invalid.length) out.append(` · not recognised: ${parsed.invalid.join(", ")}`);
            if (parsed.dupes.length) out.append(` · repeats ignored: ${parsed.dupes.join(", ")}`);
            return parsed;
        };
        box.input.addEventListener("input", update);
        update();
        return update;
    };
    const readInverters = summary(inverters, INVERTER_SN, ["MX2250 serial", "MX2250 serials"]);
    const readPanels = summary(panels, PANEL_SN, ["panel serial", "panel serials"]);
    const readBatteries = summary(batteries, null, ["battery serial", "battery serials"]);

    // Panel count follows the panel serials until it's typed in by hand
    // (it can be higher: panels without a recorded serial).
    let countTouched = Boolean(install);
    panelCount.input.addEventListener("input", () => { countTouched = true; });
    panels.input.addEventListener("input", () => {
        if (!countTouched) panelCount.input.value = readPanels().valid.length || "";
    });

    // "5.2 kWp · 8 panels × 650 W", updated as the panel count changes.
    const updateCapacity = () => {
        const count = Number(panelCount.input.value) || 0;
        const kwp = capacityOf(count);
        capacityValue.replaceChildren(el("strong", "", kwp === null ? "—" : `${kwp} kWp`));
        const kept = install && Number.isFinite(install.capacityKwp) && count === panelCountOf(install)
            && install.capacityKwp !== capacityFor(count);
        capacityValue.append(kept
            ? ` · as recorded (${count} × 650 W would be ${capacityFor(count)} kWp)`
            : ` · ${plural(count, ["panel", "panels"])} × 650 W`);
    };
    panels.input.addEventListener("input", updateCapacity);
    panelCount.input.addEventListener("input", updateCapacity);
    updateCapacity();

    const actions = el("div", "admin-install-form-actions");
    const error = el("p", "admin-action-error admin-install-error");
    error.setAttribute("role", "alert");
    const save = el("button", "admin-action admin-action-primary");
    save.type = "submit";
    const saveLabel = install ? "Save changes" : "Add installation";
    save.append(el("span", "material-symbols-rounded", "check_circle"), saveLabel);
    actions.append(error);
    if (install) {
        const cancel = el("button", "admin-action");
        cancel.type = "button";
        cancel.textContent = "Cancel";
        cancel.addEventListener("click", () => showEntry("installs", install.id));
        actions.append(cancel);
    }
    actions.append(save);
    form.append(grid, actions);

    const fail = (message, input) => {
        error.textContent = message;
        if (input) input.focus();
    };

    form.addEventListener("submit", async (e) => {
        e.preventDefault();
        error.textContent = "";
        const inv = readInverters();
        const pan = readPanels();
        const values = {
            clientName: name.input.value.trim(),
            installDate: date.input.value,
            contact: contact.input.value.trim(),
            email: email.input.value.trim(),
            address: address.input.value.trim(),
            inverterSerials: inv.valid,
            panelSerials: pan.valid,
            panelCount: panelCount.input.value === "" ? pan.valid.length : Number(panelCount.input.value),
            batterySerials: readBatteries().valid,
        };
        if (!values.clientName) return fail("Enter the client's name.", name.input);
        if (!/^\d{4}-\d{2}-\d{2}$/.test(values.installDate)) return fail("Enter the installation date.", date.input);
        if (inv.invalid.length) return fail("Some MX2250 serial numbers aren't recognised (shown in red). They start with Y and have 16 characters.", inverters.input);
        if (pan.invalid.length) return fail("Some solar panel serial numbers aren't recognised (shown in red). They start with Z and have 19 characters.", panels.input);
        if (!inv.valid.length && !values.panelCount) return fail("Add at least one MX2250 serial number or a number of panels.", inverters.input);
        if (!Number.isInteger(values.panelCount) || values.panelCount < 0 || values.panelCount > 2000) return fail("Enter the number of solar panels as a whole number.", panelCount.input);
        if (values.panelCount < pan.valid.length) return fail(`The number of panels can't be less than the ${pan.valid.length} panel serials entered.`, panelCount.input);
        if (inv.valid.length > 100 || pan.valid.length > 400) return fail("That's more serials than one installation can hold (100 MX2250s, 400 panels). Split it into several installations.");
        values.capacityKwp = capacityOf(values.panelCount);

        save.disabled = true;
        save.replaceChildren(el("span", "material-symbols-rounded", "hourglass_top"), "Saving…");
        try {
            const id = await saveInstall(install, values);
            // Reload, then show the saved installation.
            formOpen = false;
            selected = { tab: "installs", id };
            await loadSubmissions();
        } catch (err) {
            console.error("Admin: saving installation failed", err);
            error.textContent = installErrorMessage(err);
            save.disabled = false;
            save.replaceChildren(el("span", "material-symbols-rounded", "check_circle"), saveLabel);
        }
    });
    return form;
}

function installErrorMessage(err) {
    if (err && err.userMessage) return err.userMessage;
    if (err && err.code === "permission-denied") {
        return "Permission denied. Publish the latest /firestore.rules in the Firebase console, or ask an admin (this account can only change installations it added).";
    }
    return "Couldn't save. Check your connection and try again.";
}

function userError(message) {
    return Object.assign(new Error(message), { userMessage: message });
}

const serialDoc = (sn) => firestore.doc(db, "serials", sn);
const countDoc = (installId) => firestore.doc(db, "installCounts", installId);

// Saves a new or edited install and its serial documents in one batch. A
// serial already recorded on a different install stops the save.
async function saveInstall(existing, values) {
    const email = auth.currentUser.email;
    const ref = existing
        ? firestore.doc(db, "installs", existing.id)
        : firestore.doc(firestore.collection(db, "installs"));
    const before = {
        inverter: existing ? serialList(existing.inverterSerials) : [],
        panel: existing ? serialList(existing.panelSerials) : [],
    };
    const after = { inverter: values.inverterSerials, panel: values.panelSerials };
    const added = [];
    const removed = [];
    for (const type of ["inverter", "panel"]) {
        after[type].filter((sn) => !before[type].includes(sn)).forEach((sn) => added.push({ sn, type }));
        before[type].filter((sn) => !after[type].includes(sn)).forEach((sn) => removed.push(sn));
    }

    const [addedSnaps, removedSnaps] = await Promise.all([
        Promise.all(added.map(({ sn }) => firestore.getDoc(serialDoc(sn)))),
        Promise.all(removed.map((sn) => firestore.getDoc(serialDoc(sn)))),
    ]);
    const taken = added.filter((a, i) => addedSnaps[i].exists() && addedSnaps[i].data().installId !== ref.id);
    if (taken.length) {
        throw userError(`Already recorded on another installation: ${taken.map((a) => a.sn).join(", ")}. A serial number can only be on one installation.`);
    }
    const toCreate = added.filter((a, i) => !addedSnaps[i].exists());
    const toDelete = removed.filter((sn, i) => removedSnaps[i].exists() && removedSnaps[i].data().installId === ref.id);
    if (toCreate.length + toDelete.length + 1 > 500) {
        throw userError("Too many serial number changes at once. Save in smaller steps.");
    }

    const fields = {
        clientName: values.clientName,
        email: values.email,
        contact: values.contact,
        address: values.address,
        installDate: values.installDate,
        capacityKwp: values.capacityKwp,
        inverterSerials: values.inverterSerials,
        panelSerials: values.panelSerials,
        panelCount: values.panelCount,
        batterySerials: values.batterySerials,
    };
    const batch = firestore.writeBatch(db);
    if (existing) {
        batch.update(ref, { ...fields, updatedAt: firestore.serverTimestamp(), updatedBy: email });
    } else {
        batch.set(ref, {
            ...fields,
            source: "admin",
            sheetTimestamp: "",
            createdAt: firestore.serverTimestamp(),
            createdBy: email,
            updatedAt: null,
            updatedBy: null,
        });
    }
    toDelete.forEach((sn) => batch.delete(serialDoc(sn)));
    toCreate.forEach(({ sn, type }) => batch.set(serialDoc(sn), { type, installId: ref.id }));
    batch.set(countDoc(ref.id), { inverters: values.inverterSerials.length, panels: values.panelCount });
    await batch.commit();
    return ref.id;
}

// Installs saved without a capacity (blank in the old sheet) get panels ×
// 0.65 kWp filled in, once, the first time an admin opens the page after
// they're loaded. Installs that have a capacity are left as they are.
async function fillMissingCapacities() {
    if (role !== "admin") return;
    const missing = data.installs.filter((i) => !Number.isFinite(i.capacityKwp) && panelCountOf(i) > 0).slice(0, 450);
    if (!missing.length) return;
    const email = auth.currentUser.email;
    const batch = firestore.writeBatch(db);
    missing.forEach((i) => {
        batch.update(firestore.doc(db, "installs", i.id), {
            capacityKwp: capacityFor(panelCountOf(i)),
            updatedAt: firestore.serverTimestamp(),
            updatedBy: email,
        });
    });
    try {
        await batch.commit();
        missing.forEach((i) => {
            i.capacityKwp = capacityFor(panelCountOf(i));
            i.updatedAt = firestore.Timestamp.now();
            i.updatedBy = email;
        });
        renderList();
        if (selected && !formOpen) showEntry(selected.tab, selected.id);
    } catch (err) {
        console.warn("Admin: filling in missing capacities failed", err);
    }
}

// Deletes an install and the serial documents that belong to it.
async function deleteInstall(install) {
    const serials = [...serialList(install.inverterSerials), ...serialList(install.panelSerials)];
    const snaps = await Promise.all(serials.map((sn) => firestore.getDoc(serialDoc(sn))));
    const batch = firestore.writeBatch(db);
    batch.delete(firestore.doc(db, "installs", install.id));
    batch.delete(countDoc(install.id));
    serials.forEach((sn, i) => {
        if (snaps[i].exists() && snaps[i].data().installId === install.id) batch.delete(serialDoc(sn));
    });
    await batch.commit();
}

// ----- one-time import from the old Google Sheet (admins only)

function parseCSV(text) {
    const rows = [];
    let row = [];
    let field = "";
    let inQuotes = false;
    for (let i = 0; i < text.length; i++) {
        const char = text[i];
        if (inQuotes) {
            if (char === '"' && text[i + 1] === '"') { field += '"'; i++; }
            else if (char === '"') inQuotes = false;
            else field += char;
        } else if (char === '"') inQuotes = true;
        else if (char === ",") { row.push(field); field = ""; }
        else if (char === "\n" || char === "\r") {
            if (char === "\r" && text[i + 1] === "\n") i++;
            row.push(field);
            rows.push(row);
            row = [];
            field = "";
        } else field += char;
    }
    if (field || row.length) { row.push(field); rows.push(row); }
    return rows.filter((r) => r.some((cell) => cell.trim()));
}

// The sheet writes dates as DD/MM/YYYY; installs store YYYY-MM-DD.
function sheetDate(text) {
    let m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})/.exec(text);
    if (m) return `${m[3]}-${m[2].padStart(2, "0")}-${m[1].padStart(2, "0")}`;
    m = /^(\d{4})-(\d{2})-(\d{2})/.exec(text);
    return m ? m[0] : "";
}

function sheetNumber(text) {
    const value = parseFloat((text || "").replace(/[^0-9.]/g, ""));
    return Number.isFinite(value) ? Math.round(value * 100) / 100 : null;
}

function setImportStatus(text) {
    importStatus.textContent = text;
    importStatus.hidden = !text;
}

async function importFromSheet() {
    if (role !== "admin") return;
    if (!confirm("Copy every installation from the Google Sheet into Firebase?\n\nRows already imported are skipped, so it's safe to run again. After this, the portfolio counters read from Firebase, and new installations are added here instead of in the sheet.")) return;

    importButton.disabled = true;
    setImportStatus("Reading the Google Sheet…");
    try {
        const res = await fetch(`${INSTALL_SHEET_CSV}&_=${Date.now()}`, { cache: "no-store" });
        if (!res.ok) throw userError(`Couldn't read the Google Sheet (HTTP ${res.status}).`);
        const rows = parseCSV(await res.text());
        const header = (rows[0] || []).map((h) => h.trim().toLowerCase());
        const col = (start) => header.findIndex((h) => h.startsWith(start));
        const c = {
            timestamp: col("timestamp"), name: col("client name"), email: col("email"),
            contact: col("contact"), address: col("address"), inverters: col("micro inverter"),
            batteries: col("battery"), panels: col("solar panel"), capacity: col("capacity"),
            date: col("installation date"),
        };
        if (c.name === -1 || c.inverters === -1 || c.panels === -1) {
            throw userError("The Google Sheet's columns have changed, so it can't be imported automatically.");
        }

        // Serials already in Firebase, and sheet rows already imported.
        const taken = new Set((await firestore.getDocs(firestore.collection(db, "serials"))).docs.map((d) => d.id));
        const imported = new Set(data.installs
            .filter((i) => i.source === "sheet")
            .map((i) => `${i.sheetTimestamp}|${i.clientName}`));

        const email = auth.currentUser.email;
        const body = rows.slice(1);
        let added = 0;
        let skipped = 0;
        const repeats = [];
        const failed = [];
        for (const [n, r] of body.entries()) {
            setImportStatus(`Importing ${n + 1} of ${body.length}…`);
            const cell = (i) => (i >= 0 && r[i] ? r[i].trim() : "");
            const clientName = cell(c.name).slice(0, 150) || "Unnamed client";
            const sheetTimestamp = cell(c.timestamp).slice(0, 40);
            if (imported.has(`${sheetTimestamp}|${clientName}`)) {
                skipped++;
                continue;
            }
            // A serial that's already on another install is left off this one.
            const fresh = (list) => list.filter((sn) => {
                if (!taken.has(sn)) return true;
                repeats.push(sn);
                return false;
            });
            const inverterParse = parseSerials(cell(c.inverters), INVERTER_SN);
            const panelParse = parseSerials(cell(c.panels), PANEL_SN);
            const inverterSerials = fresh(inverterParse.valid).slice(0, 100);
            const panelSerials = fresh(panelParse.valid).slice(0, 400);
            // Every panel entry counts, placeholders included, as the sheet did.
            const panelCount = Math.min(2000, panelParse.valid.length + panelParse.dupes.length + panelParse.placeholders);

            const ref = firestore.doc(firestore.collection(db, "installs"));
            const batch = firestore.writeBatch(db);
            batch.set(ref, {
                clientName,
                email: cell(c.email).slice(0, 200),
                contact: cell(c.contact).slice(0, 100),
                address: cell(c.address).slice(0, 300),
                installDate: sheetDate(cell(c.date)),
                // The sheet's capacity, or panels × 0.65 kWp where it's blank.
                capacityKwp: sheetNumber(cell(c.capacity)) ?? capacityFor(Math.max(panelCount, panelSerials.length)),
                inverterSerials,
                panelSerials,
                panelCount: Math.max(panelCount, panelSerials.length),
                batterySerials: parseSerials(cell(c.batteries)).valid.slice(0, 50),
                source: "sheet",
                sheetTimestamp,
                createdAt: firestore.serverTimestamp(),
                createdBy: email,
                updatedAt: null,
                updatedBy: null,
            });
            inverterSerials.forEach((sn) => batch.set(serialDoc(sn), { type: "inverter", installId: ref.id }));
            panelSerials.forEach((sn) => batch.set(serialDoc(sn), { type: "panel", installId: ref.id }));
            batch.set(countDoc(ref.id), { inverters: inverterSerials.length, panels: Math.max(panelCount, panelSerials.length) });
            try {
                await batch.commit();
                added++;
                [...inverterSerials, ...panelSerials].forEach((sn) => taken.add(sn));
            } catch (err) {
                console.error("Admin: importing sheet row failed", clientName, err);
                failed.push(clientName);
                if (err.code === "permission-denied") {
                    throw userError("Permission denied. Publish the latest /firestore.rules in the Firebase console, then try again.");
                }
            }
        }

        const parts = [`Imported ${plural(added, ["installation", "installations"])}`];
        if (skipped) parts.push(`${skipped} already imported`);
        if (repeats.length) parts.push(`serials already recorded elsewhere left off: ${repeats.join(", ")}`);
        if (failed.length) parts.push(`couldn't import: ${failed.join(", ")}`);
        setImportStatus(`${parts.join(" · ")}.`);
        await loadSubmissions();
    } catch (err) {
        console.error("Admin: sheet import failed", err);
        setImportStatus(err.userMessage || "The import stopped. Check your connection and try again.");
    } finally {
        importButton.disabled = false;
    }
}

document.querySelector(".admin-add-install").addEventListener("click", () => showInstallForm(null));
importButton.addEventListener("click", importFromSheet);


// ------------------------------------------------------- edit and delete

// Admins can correct a visit request's or waitlist sign-up's details (and a
// visit request's attachments, e.g. adding the client's electricity bills),
// and delete visit requests, waitlist sign-ups and feedback. Checked by
// isValidVisitEdit / isValidWaitlistEdit and the delete rules in
// /firestore.rules, and /storage.rules for the files.

// Uploads: same limits as the public form (visit-form.js), but up to 10
// files on a request, since admins may add bills for the client.
const MAX_ATTACHMENTS = 10;
const MAX_FILE_BYTES = 10 * 1024 * 1024;
const ACCEPTED_TYPE = /^(image\/.+|application\/pdf)$/;
const SHRINK_OVER_BYTES = 2 * 1024 * 1024;
const SHRINK_MAX_EDGE = 2400;
const SHRINKABLE_TYPE = /^image\/(jpeg|png|webp)$/;
const TYPE_BY_EXTENSION = {
    jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", webp: "image/webp", gif: "image/gif",
    heic: "image/heic", heif: "image/heif", pdf: "application/pdf",
};

// The edit form's fields, per tab. `options` makes a select (the public
// form's choices; an older value not in the list is kept as an extra
// option). Keep in step with schedule-a-visit/index.html and the rules.
const EDIT_FIELDS = {
    visits: [
        { name: "name", label: "Name", required: true, max: 100 },
        { name: "phone", label: "Phone", type: "tel", required: true, min: 7, max: 30 },
        { name: "email", label: "Email", type: "email", max: 200 },
        { name: "propertyType", label: "Property type", required: true, options: ["Residential", "Commercial", "Industrial"] },
        { name: "address", label: "Address", required: true, min: 3, max: 300, wide: true },
        // Saved as `product`; older requests named a specific product, which
        // stays selectable for them (see the extra-option rule above).
        { name: "product", label: "Interested in", options: ["Not sure yet", "Micro Inverter", "Battery", "Micro Inverter + Battery"] },
        { name: "monthlyBill", label: "Monthly bill", options: ["", "Below ₱3,000", "₱3,000 – ₱6,000", "₱6,000 – ₱10,000", "Above ₱10,000"], blank: "Prefer not to say" },
        { name: "preferredDate", label: "Preferred date", type: "date" },
        { name: "preferredTime", label: "Preferred time", options: ["Any time", "Morning (9AM – 12PM)", "Afternoon (1PM – 5PM)"] },
        { name: "referralCode", label: "Referral code", max: 50, upper: true },
        { name: "message", label: "Message", textarea: true, max: 2000, wide: true },
    ],
    waitlist: [
        { name: "name", label: "Name", required: true, max: 100 },
        { name: "phone", label: "Phone", type: "tel", required: true, min: 7, max: 30 },
        { name: "email", label: "Email", type: "email", max: 200 },
        { name: "address", label: "Home / delivery address", required: true, min: 5, max: 300, wide: true },
        { name: "message", label: "Note", textarea: true, max: 2000, wide: true },
    ],
};

function fileType(file) {
    if (file.type) return file.type;
    const ext = (file.name.split(".").pop() || "").toLowerCase();
    return TYPE_BY_EXTENSION[ext] || "";
}

function safeFileName(name) {
    return name.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(-80) || "file";
}

function formatSize(bytes) {
    return bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

// Large JPEG/PNG/WebP photos -> JPEG at most SHRINK_MAX_EDGE px, as on the
// public form. Anything else, or anything that fails to shrink, is unchanged.
async function shrinkImage(file) {
    if (!SHRINKABLE_TYPE.test(fileType(file)) || file.size <= SHRINK_OVER_BYTES) return file;
    try {
        const bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
        const scale = Math.min(1, SHRINK_MAX_EDGE / Math.max(bitmap.width, bitmap.height));
        const canvas = document.createElement("canvas");
        canvas.width = Math.round(bitmap.width * scale);
        canvas.height = Math.round(bitmap.height * scale);
        const context = canvas.getContext("2d");
        context.fillStyle = "#FFFFFF";
        context.fillRect(0, 0, canvas.width, canvas.height);
        context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
        bitmap.close();
        const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.85));
        if (!blob || blob.size >= file.size) return file;
        return new File([blob], file.name.replace(/\.[^.]+$/, "") + ".jpg", { type: "image/jpeg", lastModified: file.lastModified });
    } catch (err) {
        console.warn("Admin: couldn't shrink image, uploading as is", err);
        return file;
    }
}

// "Edit details" and "Delete" for an entry, next to its stage buttons (or
// above the ticket for feedback). Feedback can only be deleted, and only
// admins can delete.
function entryTools(tab, entry, errorText) {
    const tools = [];
    if (role === "admin") tools.push(deleteButton(tab, entry, errorText));
    if (EDIT_FIELDS[tab]) {
        const edit = el("button", "admin-action");
        edit.type = "button";
        edit.append(el("span", "material-symbols-rounded", "edit"), "Edit details");
        edit.addEventListener("click", () => showEditForm(tab, entry));
        tools.push(edit);
    }
    return tools;
}

function deleteButton(tab, entry, errorText) {
    const remove = el("button", "admin-action admin-action-danger");
    remove.type = "button";
    remove.append(el("span", "material-symbols-rounded", "delete"), "Delete");
    remove.addEventListener("click", async () => {
        const files = tab === "visits" ? serialList(entry.attachments).length : 0;
        const what = `${TABS[tab].label.toLowerCase()} from ${entry.name || "this client"}`;
        if (!confirm(`Delete this ${what}?${files ? ` Its ${plural(files, ["attachment", "attachments"])} will be deleted too.` : ""} It's removed from Firebase for good and can't be undone.`)) return;
        remove.disabled = true;
        errorText.textContent = "";
        try {
            await deleteEntry(tab, entry);
            selected = null;
            await loadSubmissions();
            closeEntry();
        } catch (err) {
            console.error("Admin: delete failed", err);
            errorText.textContent = err.code === "permission-denied"
                ? "Permission denied. Publish the latest /firestore.rules in the Firebase console."
                : "Couldn't delete. Check your connection and try again.";
            remove.disabled = false;
        }
    });
    return remove;
}

// Deletes the entry, then (visit requests) its uploaded files. A file that's
// already gone is fine.
async function deleteEntry(tab, entry) {
    await firestore.deleteDoc(firestore.doc(db, TABS[tab].collection, entry.id));
    const paths = tab === "visits" ? serialList(entry.attachments) : [];
    if (paths.length) {
        const { storageSdk, storage } = await loadStorage();
        await Promise.all(paths.map((path) => storageSdk.deleteObject(storageSdk.ref(storage, path)).catch((err) => {
            if (err.code !== "storage/object-not-found") console.warn("Admin: couldn't delete attachment", path, err);
        })));
    }
}

// The edit form in the detail pane (top of the page on phones), like the
// install form.
function showEditForm(tab, entry) {
    formOpen = true;
    selected = { tab, id: entry.id };
    setBackButton();
    detailPane.querySelector(".admin-detail-kind").textContent = `Edit ${TABS[tab].label.toLowerCase()}`;
    const main = el("div", "admin-entry-main");
    main.append(
        el("span", "admin-entry-title", entry.name || "(no name)"),
        el("span", "admin-entry-meta", tab === "visits"
            ? "Correct the client's details, or add their electricity bills, then save."
            : "Correct the contact details, then save. The order and estimate stay as submitted."),
    );
    detailPane.querySelector(".admin-detail-title").replaceChildren(main);
    detailPane.querySelector(".admin-detail-body").replaceChildren(editForm(tab, entry));
    overview.hidden = true;
    detailPane.hidden = false;
    mainArea.scrollTop = 0;
    if (!desktop.matches) detailPane.scrollIntoView({ block: "start" });
    markSelected();
}

// A file dropped anywhere but the attachments area would make the browser
// open it and leave the page (losing unsaved edits), so ignore those drops.
for (const type of ["dragover", "drop"]) {
    window.addEventListener(type, (e) => {
        if (e.dataTransfer && [...e.dataTransfer.types].includes("Files") && !e.target.closest(".admin-edit-files")) {
            e.preventDefault();
            if (type === "dragover") e.dataTransfer.dropEffect = "none";
        }
    });
}

function editForm(tab, entry) {
    const form = el("form", "admin-install-form admin-edit-form");
    form.noValidate = true;
    const grid = el("div", "admin-install-grid");
    const inputs = {};

    for (const spec of EDIT_FIELDS[tab]) {
        const wrap = el("label", spec.wide ? "admin-field admin-install-wide" : "admin-field");
        const current = typeof entry[spec.name] === "string" ? entry[spec.name] : "";
        let input;
        if (spec.options) {
            input = el("select", "admin-select");
            const values = spec.options.includes(current) ? spec.options : [...spec.options, current];
            for (const value of values) {
                const option = el("option", "", value || spec.blank || "—");
                option.value = value;
                input.append(option);
            }
            input.value = current || spec.options[0];
        } else if (spec.textarea) {
            input = el("textarea");
            input.rows = 4;
            input.value = current;
        } else {
            input = el("input");
            input.type = spec.type || "text";
            input.value = current;
        }
        input.name = spec.name;
        if (spec.max) input.maxLength = spec.max;
        wrap.append(el("span", "admin-label", spec.required ? `${spec.label} *` : spec.label), input);
        grid.append(wrap);
        inputs[spec.name] = input;
    }

    // Attachments (visit requests): keep / remove the current files, add new
    // ones (images or PDFs, up to MAX_ATTACHMENTS in all).
    const kept = tab === "visits" ? [...serialList(entry.attachments)] : null;
    const added = [];
    let refreshFiles = () => {};
    if (kept) {
        const box = el("div", "admin-field admin-install-wide admin-edit-files");
        const list = el("ul", "admin-edit-file-list");
        const picker = el("input");
        picker.type = "file";
        picker.multiple = true;
        picker.accept = "image/*,application/pdf";
        picker.hidden = true;
        const add = el("button", "admin-action");
        add.type = "button";
        add.append(el("span", "material-symbols-rounded", "upload_file"), "Add files");
        add.addEventListener("click", () => picker.click());
        const note = el("span", "admin-serial-summary");

        const row = (name, detail, onRemove, isNew) => {
            const item = el("li", isNew ? "admin-edit-file is-new" : "admin-edit-file");
            item.append(
                el("span", "material-symbols-rounded", /\.pdf$/i.test(name) ? "picture_as_pdf" : "image"),
                el("span", "admin-edit-file-name", name),
                el("span", "admin-edit-file-detail", detail),
            );
            const x = el("button", "admin-edit-file-remove");
            x.type = "button";
            x.setAttribute("aria-label", `Remove ${name}`);
            x.append(el("span", "material-symbols-rounded", "close"));
            x.addEventListener("click", onRemove);
            item.append(x);
            return item;
        };
        refreshFiles = () => {
            list.replaceChildren(
                ...kept.map((path, i) => row(path.split("/").pop(), "Saved", () => { kept.splice(i, 1); refreshFiles(); })),
                ...added.map((file, i) => row(file.name, `New · ${formatSize(file.size)}`, () => { added.splice(i, 1); refreshFiles(); }, true)),
            );
            const total = kept.length + added.length;
            const removed = serialList(entry.attachments).length - kept.length;
            note.textContent = `${plural(total, ["file", "files"])} (up to ${MAX_ATTACHMENTS})`
                + (added.length ? ` · ${added.length} to upload` : "")
                + (removed ? ` · ${removed} to delete when you save` : "");
            add.disabled = total >= MAX_ATTACHMENTS;
        };
        // Picked or dropped files: checked, large photos shrunk, then listed.
        const addFiles = async (files) => {
            error.textContent = "";
            const room = MAX_ATTACHMENTS - kept.length - added.length;
            if (files.length > room) error.textContent = `Only ${room} more ${room === 1 ? "file fits" : "files fit"}; the rest were left out.`;
            for (const file of files.slice(0, Math.max(0, room))) {
                if (!ACCEPTED_TYPE.test(fileType(file))) { error.textContent = `${file.name}: only images or PDF files can be added.`; continue; }
                const prepared = await shrinkImage(file);
                if (prepared.size > MAX_FILE_BYTES) { error.textContent = `${file.name} is over 10 MB.`; continue; }
                added.push(prepared);
            }
            refreshFiles();
        };
        picker.addEventListener("change", () => {
            const files = [...picker.files];
            picker.value = "";
            addFiles(files);
        });

        // Drag and drop onto the attachments area.
        const drop = el("div", "admin-edit-drop");
        drop.append(
            el("span", "material-symbols-rounded", "cloud_upload"),
            el("span", "admin-edit-drop-text", "Drag images or PDFs here, or"),
            add,
        );
        let depth = 0;
        box.addEventListener("dragenter", (e) => {
            if (![...e.dataTransfer.types].includes("Files")) return;
            e.preventDefault();
            depth++;
            box.classList.add("dragging");
        });
        box.addEventListener("dragover", (e) => {
            if (![...e.dataTransfer.types].includes("Files")) return;
            e.preventDefault();
            e.dataTransfer.dropEffect = add.disabled ? "none" : "copy";
        });
        box.addEventListener("dragleave", () => {
            depth = Math.max(0, depth - 1);
            if (!depth) box.classList.remove("dragging");
        });
        box.addEventListener("drop", (e) => {
            e.preventDefault();
            depth = 0;
            box.classList.remove("dragging");
            if (add.disabled) {
                error.textContent = `This request already has ${MAX_ATTACHMENTS} files. Remove one to add another.`;
                return;
            }
            addFiles([...e.dataTransfer.files]);
        });
        box.append(el("span", "admin-label", "Attachments (e.g. the last 3 electricity bills)"), list, drop, picker, note);
        grid.append(box);
    }

    const actions = el("div", "admin-install-form-actions");
    const error = el("p", "admin-action-error admin-install-error");
    error.setAttribute("role", "alert");
    const cancel = el("button", "admin-action");
    cancel.type = "button";
    cancel.textContent = "Cancel";
    cancel.addEventListener("click", () => showEntry(tab, entry.id));
    const save = el("button", "admin-action admin-action-primary");
    save.type = "submit";
    save.append(el("span", "material-symbols-rounded", "check_circle"), "Save changes");
    actions.append(error, cancel, save);
    form.append(grid, actions);
    refreshFiles();

    form.addEventListener("submit", async (e) => {
        e.preventDefault();
        error.textContent = "";
        const values = {};
        for (const spec of EDIT_FIELDS[tab]) {
            let value = inputs[spec.name].value.trim();
            if (spec.upper) value = value.toUpperCase();
            if (spec.required && !value) {
                error.textContent = `Enter the ${spec.label.toLowerCase()}.`;
                inputs[spec.name].focus();
                return;
            }
            if (value && spec.min && value.length < spec.min) {
                error.textContent = `The ${spec.label.toLowerCase()} looks too short.`;
                inputs[spec.name].focus();
                return;
            }
            if (spec.name === "phone" && !/^[0-9+()\-\s]{7,30}$/.test(value)) {
                error.textContent = "Enter a valid phone number.";
                inputs.phone.focus();
                return;
            }
            values[spec.name] = value;
        }
        if (tab === "visits" && !values.product) values.product = "Not sure yet";
        if (tab === "visits" && !values.preferredTime) values.preferredTime = "Any time";

        save.disabled = true;
        cancel.disabled = true;
        save.replaceChildren(el("span", "material-symbols-rounded", "hourglass_top"), added.length ? "Uploading…" : "Saving…");
        try {
            await saveEdit(tab, entry, values, kept, added);
            formOpen = false;
            selected = { tab, id: entry.id };
            await loadSubmissions();
        } catch (err) {
            console.error("Admin: saving edit failed", err);
            error.textContent = err.code === "permission-denied" || (err.code || "").startsWith("storage/unauthorized")
                ? "Permission denied. Publish the latest /firestore.rules and /storage.rules in the Firebase console."
                : "Couldn't save. Check your connection and try again.";
            save.disabled = false;
            cancel.disabled = false;
            save.replaceChildren(el("span", "material-symbols-rounded", "check_circle"), "Save changes");
        }
    });
    return form;
}

// Uploads new files, saves the entry, then deletes the files that were
// removed (only once the entry no longer lists them).
async function saveEdit(tab, entry, values, kept, added) {
    const update = { ...values, editedAt: firestore.serverTimestamp(), editedBy: auth.currentUser.email };
    let removed = [];
    if (tab === "visits") {
        const uploaded = [];
        if (added.length) {
            const { storageSdk, storage } = await loadStorage();
            const stamp = Date.now();
            for (const [i, file] of added.entries()) {
                const path = `${TABS.visits.collection}/${entry.id}/admin-${stamp}-${i + 1}-${safeFileName(file.name)}`;
                await storageSdk.uploadBytes(storageSdk.ref(storage, path), file, { contentType: fileType(file) });
                uploaded.push(path);
            }
        }
        update.attachments = [...kept, ...uploaded];
        removed = serialList(entry.attachments).filter((path) => !kept.includes(path));
    }
    await firestore.updateDoc(firestore.doc(db, TABS[tab].collection, entry.id), update);
    if (removed.length) {
        const { storageSdk, storage } = await loadStorage();
        await Promise.all(removed.map((path) => storageSdk.deleteObject(storageSdk.ref(storage, path)).catch((err) => {
            if (err.code !== "storage/object-not-found") console.warn("Admin: couldn't delete removed attachment", path, err);
        })));
    }
}


// "Details edited Oct 4, 2026, 2:05 PM by …", on entries an admin corrected.
function editedRow(entry) {
    return detailRow("Details edited", `${formatDate(toDate(entry.editedAt))}${entry.editedBy ? ` by ${entry.editedBy}` : ""}`, { wide: true });
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
    const sameEntry = selected && selected.tab === tab && selected.id === id && !formOpen;
    selected = { tab, id };
    formOpen = false;
    setBackButton();

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
    // The encoder has no overview: its home is the "Add installation" form.
    if (role === "encoder") {
        showInstallForm(null);
        return;
    }
    selected = null;
    formOpen = false;
    detailPane.hidden = true;
    detailPane.querySelector(".admin-detail-body").replaceChildren();
    detailPane.querySelector(".admin-detail-title").replaceChildren();
    overview.hidden = false;
    markSelected();
}

// The pane's back button: back to the overview for admins, to a new
// "Add installation" form for the encoder (and hidden on that form).
function setBackButton({ hidden = false } = {}) {
    const back = detailPane.querySelector(".admin-back");
    back.hidden = hidden;
    back.replaceChildren(
        el("span", "material-symbols-rounded", role === "encoder" ? "add" : "arrow_back"),
        role === "encoder" ? "New installation" : "Back to overview",
    );
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
    installActions.hidden = name !== "installs";
    updateStatusFilter();
    renderList();
}

updateStatusFilter();

document.querySelectorAll(".admin-tab").forEach((tab) => {
    tab.addEventListener("click", () => selectTab(tab.dataset.tab));
});

search.addEventListener("input", renderList);
statusFilter.addEventListener("change", renderList);
