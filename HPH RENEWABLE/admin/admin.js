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
// The installer account (INSTALLER_EMAILS) opens on a workspace with just the
// two checklist tabs (Site visit inspection, Installation and commissioning)
// and Inventory: it can read visit requests, to pick a client, start and fill
// in checklists, and keep the inventory, but nothing else. Keep it in step with isInstaller() in
// /firestore.rules and /storage.rules. See the "installer checklists" section
// below and checklist-templates.js (the checklist content).
// The rules are what actually protect the data; these lists only affect
// what the page displays.

import { firebaseConfig } from "../firebase-config.js";
import { CHECKLISTS, CHECKLIST_VERSION } from "./checklist-templates.js";

const FIREBASE_VERSION = "12.3.0";
const ADMIN_EMAILS = [
    "harold.t.hermosa@gmail.com",
    "jeff.hermosa@hphtechsolutions.com",
    "lerin.hermosa@hphtechsolutions.com",
];
const ENCODER_EMAILS = [
    "inquiries@hphtechsolutions.com",
];
const INSTALLER_EMAILS = [
    "hphrenewable@gmail.com",
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
const sourceFilter = document.querySelector(".admin-source-filter");
const productFilter = document.querySelector(".admin-product-filter");
const listCount = document.querySelector(".admin-list-count");
const exportButton = document.querySelector(".admin-export");
const mainArea = document.querySelector(".admin-main");
const overview = document.querySelector(".admin-overview");
const detailPane = document.querySelector(".admin-detail-pane");
const installActions = document.querySelector(".admin-install-actions");
const checklistActions = document.querySelector(".admin-checklist-actions");
const importButton = document.querySelector(".admin-import-sheet");
const importStatus = document.querySelector(".admin-import-status");
const visitActions = document.querySelector(".admin-visit-actions");
const openSolarButton = document.querySelector(".admin-opensolar-import");
const openSolarFile = document.querySelector(".admin-opensolar-file");
const openSolarStatus = document.querySelector(".admin-opensolar-status");

// Desktop layout (sidebar + detail pane); matches the 750px mobile breakpoint
// in styles.css. Phones open entries in place instead.
const desktop = window.matchMedia("(min-width: 751px)");

const emptyData = () => ({ visits: [], waitlist: [], feedback: [], installs: [], nda: [], inspection: [], installation: [], inventory: [] });
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
// Installer checklists (see the "installer checklists" section): the two
// checklist types, a hook that saves a checklist being filled in before a
// reload, and a flag while a new checklist is being created.
const CHECKLIST_TYPES = ["inspection", "installation"];
let flushChecklist = null;
let checklistStartBusy = false;


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

function isInstallerEmail(email) {
    return Boolean(email) && INSTALLER_EMAILS.includes(email.toLowerCase());
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
        delete document.body.dataset.view;
        setMenu(false);
        closeEntry();
        show(loginSection);
        return;
    }

    role = isAdminEmail(user.email) ? "admin" : isEncoderEmail(user.email) ? "encoder" : isInstallerEmail(user.email) ? "installer" : null;
    if (!role) {
        const email = user.email;
        await authSdk.signOut(auth);
        showLoginError(email ? `${email} doesn't have admin access.` : "This account doesn't have admin access.");
        return;
    }

    loginError.hidden = true;
    currentEmail = user.email.toLowerCase();
    // CSS hides the overview and the other tabs for the encoder and installer.
    document.body.dataset.role = role;
    account.querySelector(".admin-account-email").textContent = user.email;
    account.hidden = false;
    buildMenu();
    show(dashboard);
    if (role === "encoder") {
        selectTab("installs");
        showInstallForm(null);
    } else if (role === "installer") {
        selectTab("inspection"); // shows the "start a checklist" picker
    } else {
        selectTab(activeTab);
        // Admins start on the overview (desktop: the list column hides).
        setView("overview");
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
    if (!isAdminEmail(email) && !isEncoderEmail(email) && !isInstallerEmail(email)) {
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

// ---- phone menu: the signed-in account's tabs and sign out
const menu = document.querySelector(".admin-menu");
const menuTabs = menu.querySelector(".admin-menu-tabs");
const burger = account.querySelector(".admin-burger");
const MENU_TABS = {
    installer: [["inspection", "Site Visit"], ["installation", "Installation"], ["inventory", "Inventory"]],
    encoder: [["visits", "Ocular Visits"], ["waitlist", "Waitlist"], ["installs", "Installs"]],
    admin: [["visits", "Ocular Visits"], ["waitlist", "Waitlist"], ["feedback", "Feedback"], ["installs", "Installs"],
            ["inspection", "Inspection"], ["installation", "Commissioning"], ["inventory", "Inventory"], ["nda", "NDA"]],
};

function setMenu(open) {
    if (open) {
        // Counts as the tab bar shows them, once the lists have loaded.
        for (const button of menuTabs.children) {
            const count = document.querySelector(`.admin-tab-count[data-count="${button.dataset.tab}"]`);
            button.querySelector(".admin-menu-count").textContent = count ? count.textContent : "";
        }
    }
    menu.classList.toggle("open", open);
    burger.classList.toggle("active", open);
    burger.setAttribute("aria-label", open ? "Close menu" : "Open menu");
    burger.setAttribute("aria-expanded", String(open));
    document.body.classList.toggle("admin-menu-open", open);
}

// ---- desktop navigation column (.admin-nav)
// body[data-view] is "overview" (admins: the overview fills the right; the
// list column hides) or "list" (a tab's list, with the open entry on the
// right, or "Select an entry" when nothing is open).
const navOverview = document.querySelector(".admin-nav-overview");
const listTitle = document.querySelector(".admin-list-title");

function setView(view) {
    document.body.dataset.view = view;
    navOverview.classList.toggle("active", view === "overview");
    navOverview.setAttribute("aria-current", String(view === "overview"));
    if (view === "overview" && role === "admin") {
        // Close any open entry and show the overview.
        selected = null;
        formOpen = false;
        itemFormOpen = false;
        detailPane.hidden = true;
        detailPane.querySelector(".admin-detail-body").replaceChildren();
        detailPane.querySelector(".admin-detail-title").replaceChildren();
        overview.hidden = false;
        markSelected();
        mainArea.scrollTop = 0;
    }
}

navOverview.addEventListener("click", () => setView("overview"));

// The account at the bottom of the navigation: initials, role and email.
function fillNavAccount() {
    const local = currentEmail.split("@")[0] || "";
    const parts = local.split(/[._-]+/).filter(Boolean);
    const initials = parts.length > 1 ? parts[0][0] + parts[parts.length - 1][0] : local.slice(0, 2);
    document.querySelector(".admin-nav-avatar").textContent = initials.toUpperCase();
    document.querySelector(".admin-nav-role").textContent = role === "encoder" ? "Team Workspace"
        : role === "installer" ? "Installer" : "Admin";
    document.querySelector(".admin-nav-email").textContent = currentEmail;
}

document.querySelector(".admin-nav-signout").addEventListener("click", () => authSdk.signOut(auth));

// The tab's name as this account sees it (installer: Site Visit / Installation).
function tabLabel(key) {
    const found = (MENU_TABS[role] || MENU_TABS.admin).find(([k]) => k === key);
    return found ? found[1] : TABS[key].label;
}

function buildMenu() {
    fillNavAccount();
    // Names as tooltips, for the icon-only navigation on narrow screens.
    for (const tab of document.querySelectorAll(".admin-nav .admin-tab")) tab.title = tabLabel(tab.dataset.tab);
    navOverview.title = "Overview";
    const tabs = MENU_TABS[role] || [];
    // The phone menu's small heading names the workspace.
    menu.querySelector(".admin-menu-title").textContent = role === "encoder" ? "Team Workspace"
        : role === "installer" ? "Installer Checklists" : "Admin Overview";
    menu.querySelector(".admin-menu-email").textContent = currentEmail;
    menuTabs.replaceChildren(...tabs.map(([key, label]) => {
        const button = el("button", "admin-menu-tab");
        button.type = "button";
        button.setAttribute("role", "tab");
        button.dataset.tab = key;
        button.append(el("span", "admin-menu-label", label), el("span", "admin-menu-count"), el("span", "admin-menu-dot"));
        button.addEventListener("click", () => {
            setMenu(false);
            document.querySelector(`.admin-tab[data-tab="${key}"]`).click();
        });
        return button;
    }));
    markMenuTab();
}

function markMenuTab() {
    for (const button of menuTabs.children) {
        const active = button.dataset.tab === activeTab;
        button.classList.toggle("active", active);
        button.setAttribute("aria-selected", String(active));
    }
}

burger.addEventListener("click", () => setMenu(!menu.classList.contains("open")));
menu.querySelector(".admin-menu-signout").addEventListener("click", () => { setMenu(false); authSdk.signOut(auth); });
document.addEventListener("keydown", (e) => { if (e.key === "Escape" && menu.classList.contains("open")) setMenu(false); });
// Leaving the phone layout (e.g. rotating) closes it.
window.matchMedia("(min-width: 751px)").addEventListener("change", (e) => { if (e.matches) setMenu(false); });


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
        // Let a checklist being filled in save what's pending first, so the
        // reload below doesn't lose it.
        if (flushChecklist) await flushChecklist();
        // The encoder can't read feedback, NDA responses or the inventory; the
        // installer only needs the visit requests (to pick a client), the
        // checklists and the inventory.
        const tabs = role === "encoder" ? ["visits", "waitlist", "installs"]
            : role === "installer" ? ["visits", "inventory"]
            : ["visits", "waitlist", "feedback", "installs", "nda", "inventory"];
        const [lists, checklists] = await Promise.all([
            Promise.all(tabs.map((tab) => fetchCollection(TABS[tab].collection))),
            role === "encoder" ? [] : fetchCollection("jobChecklists"),
        ]);
        data = emptyData();
        tabs.forEach((tab, i) => { data[tab] = lists[i]; });
        // The checklists tabs are one collection split by type.
        for (const type of CHECKLIST_TYPES) data[type] = checklists.filter((c) => c.type === type);
        data.installs.sort(byInstallDate);
        data.inventory.sort(byStock);
        renderStats();
        renderList();
        fillMissingCapacities();
        syncInstallsToVisits();
        // Re-show the open entry with the fresh data (or close it if it's
        // gone), unless the install form is open.
        if (selected && !formOpen) showEntry(selected.tab, selected.id);
        // The installer's home is the "start a checklist" picker (or, on the
        // Inventory tab, the stock summary); refresh it, unless the add-item
        // form is open.
        else if (role === "admin" && inventoryHomeShown()) showInventoryHome();
        else if (role === "installer" && formOpen && !selected && !checklistStartBusy && !itemFormOpen) {
            if (activeTab === "inventory") showInventoryHome();
            else showChecklistStart(activeTab);
        }
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
                // Quote accepted, installation under way.
                { key: "installing", label: "Installing" },
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
    // Confidentiality Agreement (NDA) responses from
    // legal-policies/confidentiality-agreement/ (admins only).
    nda: {
        collection: "ndaResponses",
        label: "NDA response",
        render: (entry) => renderNda(entry),
    },
    // Installer checklists: one collection (jobChecklists), shown on two tabs
    // by type. See the "installer checklists" section below.
    inspection: {
        collection: "jobChecklists",
        label: "Site visit inspection",
        render: (entry) => renderChecklist(entry),
    },
    installation: {
        collection: "jobChecklists",
        label: "Installation and commissioning",
        render: (entry) => renderChecklist(entry),
    },
    // Stock on hand (installer and admins). See the "inventory" section below.
    inventory: {
        collection: "inventory",
        label: "Inventory item",
        render: (entry) => renderInventoryItem(entry),
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

// Installs in the Installs tab that aren't the same client as a visit
// request already at Installed (same phone, last 10 digits, or else the same
// name), so they aren't counted twice. These are past installs that never
// went through the visit pipeline.
function pastInstallsNotInVisits() {
    const digits = (text) => (text || "").replace(/\D/g, "").slice(-10);
    const nameKey = (text) => (text || "").toLowerCase().replace(/[^a-z0-9]/g, "");
    const installedVisits = data.visits.filter((v) => stageOf("visits", v) === TABS.visits.pipeline.won);
    const phones = new Set(installedVisits.map((v) => digits(v.phone)).filter((d) => d.length >= 7));
    const names = new Set(installedVisits.map((v) => nameKey(v.name)).filter(Boolean));
    // Installs copied into Ocular Visits ("Copy to Ocular Visits") are counted
    // there, at whatever stage they were given.
    const linked = new Set(data.visits.map((v) => v.installId).filter(Boolean));
    return data.installs.filter((i) => {
        if (linked.has(i.id)) return false;
        const phone = digits(i.contact);
        if (phone.length >= 7) return !phones.has(phone);
        return !names.has(nameKey(i.clientName));
    });
}

// Overview "Pipeline" box: how many entries sit at each stage, per tab, with
// a bar for each stage's share. Clicking a stage lists those entries.
// The visits row's Installed box also counts past installs from the Installs
// tab (pastInstallsNotInVisits()); its conversion line stays visits only.
function renderPipeline() {
    const groups = ["visits", "waitlist"].map((tab) => {
        const { name, stages, won } = TABS[tab].pipeline;
        const total = data[tab].length;
        const counts = stages.map((stage) => ({
            stage,
            count: data[tab].filter((e) => stageOf(tab, e) === stage.key).length,
        }));
        const wins = counts.find(({ stage }) => stage.key === won).count;
        const past = tab === "visits" ? pastInstallsNotInVisits().length : 0;
        // Bar shares are out of everything in the row, past installs included.
        const barTotal = total + past;

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
            const extra = stage.key === won ? past : 0;
            const shown = count + extra;
            const bar = el("span", "admin-pipeline-bar");
            bar.style.setProperty("--share", barTotal ? shown / barTotal : 0);
            cell.append(
                el("span", "admin-pipeline-count", String(shown)),
                el("span", "admin-pipeline-label", stage.label),
            );
            if (extra) {
                // "3 visits + 20 past installs"; clicking still lists the visits.
                cell.append(el("span", "admin-pipeline-note", `${plural(count, ["visit", "visits"])} + ${extra} past ${extra === 1 ? "install" : "installs"}`));
                cell.title = `${plural(count, ["visit request", "visit requests"])} at Installed, plus ${extra} past ${extra === 1 ? "install" : "installs"} from the Installs tab. Click to list the visit requests.`;
            }
            cell.append(bar);
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
    set("nda", data.nda.filter((n) => n.response === "agree").length);
    const rating = document.querySelector('[data-stat="rating"]');
    rating.textContent = ratings.length ? `${average} ` : "–";
    if (ratings.length) rating.append(el("span", "admin-star-filled", "★"));

    for (const key of Object.keys(TABS)) {
        document.querySelector(`[data-count="${key}"]`).textContent = data[key].length;
    }
    renderStaleAlert();
    renderPipeline();
    renderChecklistOverview();
    renderReferrals();
    renderProductFilter();
    renderLowFilter();
    renderCategoryFilter();
    renderInventoryOverview();
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
// Where a visit request came from. Entries linked to an OpenSolar project count
// as OpenSolar, and also as Website when they began as a website request.
function fromOpenSolar(entry) {
    return entry.source === "opensolar" || serialList(entry.openSolarIds).length > 0;
}

function fromWebsite(entry) {
    return entry.source !== "opensolar" && entry.source !== "install";
}

function filteredEntries() {
    const term = search.value.trim().toLowerCase();
    const wanted = TABS[activeTab].pipeline ? statusFilter.value : "all";
    const product = activeTab === "waitlist" ? activeProduct : "all";
    const source = activeTab === "visits" ? sourceFilter.value : "all";
    const entries = data[activeTab].filter((entry) => matches(entry, term)
        && (wanted === "all"
            || (wanted === "stale" ? isStale(activeTab, entry)
                : wanted === "open" ? !isClosed(activeTab, entry)
                : stageOf(activeTab, entry) === wanted))
        && (product === "all" || waitlistProducts(entry).includes(product))
        && (source === "all" || (source === "opensolar" ? fromOpenSolar(entry) : fromWebsite(entry)))
        && (activeTab !== "inventory" || !lowOnly || needsRestock(entry))
        && (activeTab !== "inventory" || activeCategory === "all" || (entry.category || "") === activeCategory));
    const inventoryFilter = activeTab === "inventory" && (lowOnly || activeCategory !== "all");
    return { entries, filtered: Boolean(term) || wanted !== "all" || product !== "all" || source !== "all" || inventoryFilter };
}

function renderList() {
    const list = document.querySelector(`[data-list="${activeTab}"]`);
    const { entries, filtered } = filteredEntries();
    const total = data[activeTab].length;
    listCount.textContent = filtered ? `${entries.length} of ${total} shown` : plural(total, ["entry", "entries"]);
    exportButton.disabled = !entries.length;
    if (!entries.length) {
        const none = activeTab === "installs" ? "No installations yet."
            : activeTab === "inventory" ? "No items yet. Add the first one with “Add item”."
            : "Nothing submitted yet.";
        list.replaceChildren(el("p", "admin-empty", filtered ? "No matches." : none));
        return;
    }
    list.replaceChildren(...(activeTab === "inventory" && activeCategory === "all"
        ? groupedInventory(entries)
        : entries.map((entry) => renderEntry(activeTab, entry))));
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
    if (v.source === "install") list.append(detailRow("Source", "Added automatically from the Installs tab", { wide: true }));
    if (v.source === "opensolar") list.append(detailRow("Source", "Imported from OpenSolar", { wide: true }));
    const openSolarIds = serialList(v.openSolarIds);
    if (openSolarIds.length) {
        list.append(
            detailRow(`OpenSolar ${openSolarIds.length === 1 ? "project" : "projects"}`, openSolarIds.map((id) => `#${id}`).join("\n")),
            detailRow("OpenSolar stage", `${v.openSolarStage || "—"} · imported ${formatDate(toDate(v.openSolarSyncedAt))}`),
        );
    }
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

// An NDA response: who, whether they agreed (green Agreed / red Declined tag),
// and the quotation it's for.
function renderNda(n) {
    const agreed = n.response === "agree";
    const badge = el("span", `admin-badge ${agreed ? "admin-badge-active" : "admin-badge-stale"}`, agreed ? "Agreed" : "Declined");
    const meta = [n.email, n.reference].filter(Boolean).join(" · ");
    const details = entryShell(n.fullName, meta, toDate(n.createdAt), { badge, dim: !agreed });

    const list = el("dl", "admin-details");
    list.append(
        detailRow("Response", agreed ? "I Agree" : "I Do Not Agree"),
        detailRow("Email", n.email, { href: n.email ? `mailto:${n.email}` : "" }),
        detailRow("Mobile", n.phone, { href: n.phone ? `tel:${n.phone.replace(/[^\d+]/g, "")}` : "" }),
        detailRow("Quotation reference", n.reference),
        detailRow("Agreement date", n.agreementDate),
        detailRow("Wording version", n.statementVersion),
        detailRow("Submitted", formatDate(toDate(n.createdAt))),
        detailRow("Response ID", n.id),
    );
    const actions = el("div", "admin-actions admin-install-entry-actions");
    const error = el("span", "admin-action-error");
    actions.append(error, ...entryTools("nda", n, error));
    details.append(actions, ticket("nda", n, list));
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
const CHECKLIST_CSV = [
    ["Started", (c) => csvDate(toDate(c.createdAt))],
    ["Client", (c) => c.clientName],
    ["Address", (c) => c.address],
    ["Checklist", (c) => (CHECKLISTS[c.type] ? CHECKLISTS[c.type].title : c.type)],
    ["Status", (c) => (c.status === "submitted" ? "Submitted" : "In progress")],
    ["Answered", (c) => c.answered],
    ["Items", (c) => c.total],
    ["Passed", (c) => c.passed],
    ["Need fixing", (c) => c.fixes],
    ["N/A", (c) => c.na],
    ["Items needing a fix", (c) => checklistFixList(c).join("; ")],
    ["Started by", (c) => c.createdBy],
    ["Signed off by", (c) => c.signedOffBy],
    ["Submitted", (c) => csvDate(toDate(c.submittedAt))],
    ["Last updated", (c) => csvDate(toDate(c.updatedAt))],
    ["Checklist ID", (c) => c.id],
];

const CSV_COLUMNS = {
    inspection: CHECKLIST_CSV,
    installation: CHECKLIST_CSV,
    inventory: [
        ["Item", (i) => i.name],
        ["Category", (i) => i.category],
        ["Count", (i) => qtyOf(i)],
        ["Unit", (i) => unitOf(i)],
        ["Restock at or below", (i) => (i.lowAt > 0 ? i.lowAt : "")],
        ["Status", (i) => ({ out: "Out of stock", low: "Restock needed", ok: "In stock" })[stockState(i)]],
        ["Note", (i) => i.note],
        ["Photos", (i) => serialList(i.photos).length],
        ["Last updated", (i) => csvDate(toDate(i.updatedAt))],
        ["Updated by", (i) => i.updatedBy],
        ["Item ID", (i) => i.id],
    ],
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
    nda: [
        ["Submitted", (n) => csvDate(toDate(n.createdAt))],
        ["Full name", (n) => n.fullName],
        ["Email", (n) => n.email],
        ["Mobile", (n) => n.phone],
        ["Quotation reference", (n) => n.reference],
        ["Response", (n) => (n.response === "agree" ? "I Agree" : "I Do Not Agree")],
        ["Agreement date", (n) => n.agreementDate],
        ["Wording version", (n) => n.statementVersion],
        ["Response ID", (n) => n.id],
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

// Admins and the encoder can edit any install; admins can delete any, the
// encoder only the ones it added (see /firestore.rules).
function canEditInstall() {
    return role === "admin" || role === "encoder";
}

function canDeleteInstall(install) {
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
    if (canEditInstall()) {
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
        actions.append(error, edit);
        if (canDeleteInstall(i)) actions.append(remove);
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

// Serial number quick entry ------------------------------------------------

// The batch prefix (everything but the last 4 characters) shared by most
// recorded serials of a type, or the usual one before there are any.
const SERIAL_PREFIX_DEFAULT = { inverter: "Y0019A57121D", panel: "Z2026300G161002" };
const SERIAL_LENGTH = { inverter: 16, panel: 19 };

function usualSerialPrefix(type) {
    const field = type === "inverter" ? "inverterSerials" : "panelSerials";
    const counts = new Map();
    for (const install of data.installs) {
        for (const sn of serialList(install[field])) {
            if (sn.length !== SERIAL_LENGTH[type]) continue;
            const prefix = sn.slice(0, -4);
            counts.set(prefix, (counts.get(prefix) || 0) + 1);
        }
    }
    let best = SERIAL_PREFIX_DEFAULT[type];
    let most = 0;
    for (const [prefix, count] of counts) if (count > most) { best = prefix; most = count; }
    return best;
}

// Turns a serial box (`box` from installForm's field()) into rows: each row
// is either the shared batch prefix + its last 4 characters, or a full serial
// (one from another batch). The rows write their serials into the box, which
// stays the form's source of truth; "Paste full serials" shows the box for
// pasting, and what's pasted becomes rows again.
function serialPicker(box, type, { add, addMany = 0, startWith = 0 }) {
    const textarea = box.input;
    // The field's <label> would send clicks anywhere in it to its first
    // input, so it becomes a plain container (keeping its contents).
    const wrap = el("div", box.wrap.className);
    wrap.append(...box.wrap.childNodes);
    box.wrap.replaceWith(wrap);
    box.wrap = wrap;
    let prefix = usualSerialPrefix(type);
    const lastLength = SERIAL_LENGTH[type] - prefix.length;
    let rows = [];

    const toRows = (text) => (text || "").toUpperCase().split(/[^A-Z0-9]+/).filter(Boolean).map((sn) => (
        sn.length === prefix.length + 4 && sn.startsWith(prefix) ? { last: sn.slice(prefix.length) } : { full: sn }
    ));
    const serialOf = (row) => (row.full !== undefined ? row.full : row.last ? prefix + row.last : "");

    const editor = el("div", "admin-sn");
    const head = el("div", "admin-sn-head");
    const prefixInput = el("input", "admin-sn-prefix");
    prefixInput.value = prefix;
    prefixInput.maxLength = SERIAL_LENGTH[type] - 4;
    prefixInput.spellcheck = false;
    prefixInput.setAttribute("aria-label", "Batch prefix (all but the last 4 characters)");
    head.append(el("span", "admin-sn-head-label", "Batch prefix"), prefixInput);
    const list = el("ol", "admin-sn-rows");
    const buttons = el("div", "admin-sn-actions");
    editor.append(head, list, buttons);
    box.wrap.insertBefore(editor, textarea);
    textarea.classList.add("admin-sn-paste");
    textarea.hidden = true;

    let syncing = false;
    const sync = () => {
        syncing = true;
        textarea.value = rows.map(serialOf).filter(Boolean).join("\n");
        textarea.dispatchEvent(new Event("input", { bubbles: true }));
        syncing = false;
    };

    const render = (focus) => {
        list.replaceChildren(...rows.map((row, i) => {
            const item = el("li", "admin-sn-row");
            item.append(el("span", "admin-sn-num", String(i + 1)));
            let input;
            if (row.full !== undefined) {
                input = el("input", "admin-sn-full");
                input.value = row.full;
                input.maxLength = 40;
                input.setAttribute("aria-label", `Serial ${i + 1}`);
                input.addEventListener("input", () => {
                    row.full = input.value.toUpperCase().replace(/[^A-Z0-9]/g, "");
                    input.value = row.full;
                    sync();
                });
                item.append(input);
            } else {
                item.append(el("span", "admin-sn-fixed", prefix));
                input = el("input", "admin-sn-last");
                input.value = row.last || "";
                input.maxLength = 4;
                input.placeholder = "····";
                input.setAttribute("aria-label", `Last 4 characters of serial ${i + 1}`);
                input.addEventListener("input", () => {
                    row.last = input.value.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 4);
                    input.value = row.last;
                    input.classList.toggle("short", row.last.length > 0 && row.last.length < 4);
                    sync();
                });
                item.append(input);
            }
            // Enter: next row (a new one at the end), so serials can be typed in a run.
            input.spellcheck = false;
            input.autocomplete = "off";
            input.addEventListener("keydown", (e) => {
                if (e.key !== "Enter") return;
                e.preventDefault();
                if (i === rows.length - 1) addRows(1);
                else list.children[i + 1].querySelector("input").focus();
            });
            const remove = el("button", "admin-sn-remove");
            remove.type = "button";
            remove.setAttribute("aria-label", `Remove serial ${i + 1}`);
            remove.append(el("span", "material-symbols-rounded", "close"));
            remove.addEventListener("click", () => {
                rows.splice(i, 1);
                render();
                sync();
            });
            item.append(remove);
            return item;
        }));
        if (focus !== undefined && list.children[focus]) list.children[focus].querySelector("input").focus();
    };

    const addRows = (count) => {
        const first = rows.length;
        for (let n = 0; n < count; n++) rows.push({ last: "" });
        render(first);
    };

    const addButton = (label, count) => {
        const button = el("button", "admin-action");
        button.type = "button";
        button.append(el("span", "material-symbols-rounded", "add"), label);
        button.addEventListener("click", () => addRows(count));
        buttons.append(button);
    };
    addButton(add, 1);
    if (addMany) addButton(`Add ${addMany}`, addMany);
    const paste = el("button", "admin-link-button admin-sn-toggle");
    paste.type = "button";
    paste.textContent = "Paste full serials";
    paste.addEventListener("click", () => {
        textarea.hidden = !textarea.hidden;
        paste.textContent = textarea.hidden ? "Paste full serials" : "Hide full serials";
        if (!textarea.hidden) textarea.focus();
    });
    buttons.append(paste);

    // Typing or pasting in the box rebuilds the rows.
    textarea.addEventListener("input", () => {
        if (syncing) return;
        rows = toRows(textarea.value);
        render();
    });

    // A new batch prefix applies to every short row.
    prefixInput.addEventListener("input", () => {
        prefixInput.value = prefixInput.value.toUpperCase().replace(/[^A-Z0-9]/g, "");
        prefix = prefixInput.value;
        render();
        sync();
    });

    rows = toRows(textarea.value);
    if (!rows.length && startWith) rows = Array.from({ length: startWith }, () => ({ last: "" }));
    render();
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
    // Number of panels isn't typed in: it's the number of panel serials.
    // Older installs (from the sheet) may also have panels with no recorded
    // serial; those are kept on top, so editing them never drops panels.
    const unserialised = install ? Math.max(0, panelCountOf(install) - serialList(install.panelSerials).length) : 0;
    const countWrap = el("div", "admin-field");
    const countValue = el("span", "admin-capacity-value");
    countWrap.append(el("span", "admin-label", "Number of solar panels (from serials)"), countValue);
    grid.append(countWrap);
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
            if (parsed.placeholders) out.append(` · ${parsed.placeholders} all-zero ${parsed.placeholders === 1 ? "placeholder" : "placeholders"} skipped (not real serials)`);
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

    // Quick entry: a row per unit with the batch prefix filled in, so only the
    // last 4 characters are typed. Writes into the serial boxes above (now
    // hidden behind "Paste full serials"), so the checks below still apply.
    serialPicker(inverters, "inverter", { add: "Add MX2250", startWith: install ? 0 : 1 });
    serialPicker(panels, "panel", { add: "Add panel", addMany: 4 });

    // Panels = panel serials (+ an older install's panels without serials).
    const currentPanelCount = () => readPanels().valid.length + unserialised;

    // "8 panels · from 8 serials", and "5.2 kWp · 8 panels × 650 W", updated
    // as panel serials are added or removed.
    const updateCapacity = () => {
        const count = currentPanelCount();
        countValue.replaceChildren(el("strong", "", plural(count, ["panel", "panels"])));
        countValue.append(unserialised
            ? ` · ${count - unserialised} from serials + ${unserialised} recorded without serials`
            : ` · from ${plural(count, ["serial", "serials"])}`);
        const kwp = capacityOf(count);
        capacityValue.replaceChildren(el("strong", "", kwp === null ? "—" : `${kwp} kWp`));
        const kept = install && Number.isFinite(install.capacityKwp) && count === panelCountOf(install)
            && install.capacityKwp !== capacityFor(count);
        capacityValue.append(kept
            ? ` · as recorded (${count} × 650 W would be ${capacityFor(count)} kWp)`
            : ` · ${plural(count, ["panel", "panels"])} × 650 W`);
    };
    panels.input.addEventListener("input", updateCapacity);
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
            panelCount: currentPanelCount(),
            batterySerials: readBatteries().valid,
        };
        if (!values.clientName) return fail("Enter the client's name.", name.input);
        if (!/^\d{4}-\d{2}-\d{2}$/.test(values.installDate)) return fail("Enter the installation date.", date.input);
        if (inv.invalid.length) return fail("Some MX2250 serial numbers aren't recognised (shown in red). They start with Y and have 16 characters.", inverters.input);
        if (pan.invalid.length) return fail("Some solar panel serial numbers aren't recognised (shown in red). They start with Z and have 19 characters.", panels.input);
        if (!inv.valid.length && !values.panelCount) return fail("Add at least one MX2250 or solar panel serial number.", inverters.input);
        if (values.panelCount > 2000) return fail("That's more panels than one installation can hold (2,000). Split it into several installations.");
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
    // A new install goes into Ocular Visits at Quote sent (unless that client
    // is already a visit request).
    const install = { ...fields, id: existing ? existing.id : null };
    if (!existing && !installHasVisit(install)) {
        batch.set(installVisitDoc(ref.id), installVisit(install, ref.id, "quoted"));
    }
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


// ----- installs -> Ocular Visits (automatic)

// Every install has an Ocular Visits entry, so it goes through the pipeline:
//   - a new install (installForm) gets one at Quote sent, in the same batch;
//   - installs that had none (from before this, or the sheet import) get one
//     at Installed the next time staff open the page (syncInstallsToVisits).
// The entry's ID is "install-<installId>", so it's only ever created once,
// and it points back to its install (installId). An install whose client is
// already a visit request (same phone, last 10 digits, or else same name)
// gets no second entry. Checked by isValidCopiedVisit() in /firestore.rules.

// One-time exception for the first sync: SHA-256 of the normalised client
// name (lower-case letters/digits only) of installs that were still ongoing
// then, which start at Quote sent instead of Installed. Hashed so no client
// name sits in this public file.
const LEGACY_QUOTED = new Set(["9f276b137abe9f05416462ad5c314a70961d4443b96772255f1d2149ed1b51ce"]);

const digitsKey = (text) => (text || "").replace(/\D/g, "").slice(-10);
const nameKey = (text) => (text || "").toLowerCase().replace(/[^a-z0-9]/g, "");

async function nameFingerprint(name) {
    const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(nameKey(name)));
    return [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// True when this install already has an Ocular Visits entry (linked, or the
// same client by phone or name).
function installHasVisit(install) {
    if (install.id && data.visits.some((v) => v.installId === install.id)) return true;
    const phone = digitsKey(install.contact);
    if (phone.length >= 7) return data.visits.some((v) => digitsKey(v.phone) === phone);
    const name = nameKey(install.clientName);
    return Boolean(name) && data.visits.some((v) => nameKey(v.name) === name);
}

const installVisitDoc = (installId) => firestore.doc(db, TABS.visits.collection, `install-${installId}`);

// The visit request fields for an install, at `stage`.
function installVisit(install, installId, stage) {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(install.installDate || "");
    const dated = m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 12) : (toDate(install.createdAt) || new Date());
    return {
        name: (install.clientName || "Unnamed client").slice(0, 100),
        phone: (install.contact || "").slice(0, 30),
        email: (install.email || "").slice(0, 200),
        address: (install.address || "").slice(0, 300),
        propertyType: "Residential",
        product: serialList(install.batterySerials).length ? "Micro Inverter + Battery" : "Micro Inverter",
        monthlyBill: "",
        preferredDate: "",
        preferredTime: "Any time",
        message: "",
        attachments: [],
        consent: false,
        sourcePage: "",
        status: "new",
        createdAt: firestore.Timestamp.fromDate(dated),
        stage,
        stageUpdatedAt: firestore.serverTimestamp(),
        stageUpdatedBy: auth.currentUser.email,
        installId,
        source: "install",
    };
}

// Gives installs without an Ocular Visits entry one at Installed (Quote sent
// for LEGACY_QUOTED), then reloads if any were added. Each is its own write,
// so one that already exists (another admin got there first) is just skipped.
let syncingInstalls = false;
async function syncInstallsToVisits() {
    if (!role || role === "installer" || syncingInstalls) return;
    const missing = data.installs.filter((install) => !installHasVisit(install));
    if (!missing.length) return;
    syncingInstalls = true;
    let added = 0;
    try {
        for (const install of missing) {
            const stage = LEGACY_QUOTED.has(await nameFingerprint(install.clientName)) ? "quoted" : TABS.visits.pipeline.won;
            try {
                await firestore.setDoc(installVisitDoc(install.id), installVisit(install, install.id, stage));
                added++;
            } catch (err) {
                console.warn("Admin: adding an install to Ocular Visits failed", install.id, err);
                // Rules not published yet: stop, and try again next time.
                if (err.code === "permission-denied" && !added) break;
            }
        }
    } finally {
        syncingInstalls = false;
    }
    if (added) await loadSubmissions();
}


// ----- import from OpenSolar (admins only)

// Reads an OpenSolar project export (CSV) into Ocular Visits. Safe to repeat
// with every new export: each entry stores its OpenSolar project ids
// (openSolarIds), so a project already on the dashboard updates its entry
// instead of adding another, and new entries get the ID
// "opensolar-<first project id>", so Firebase can't hold two copies.
//   - Projects for the same client at the same address (alternative designs)
//     are grouped into one entry, at the furthest stage among them.
//   - OpenSolar's stage only ever moves ours forward (OPENSOLAR_STAGES).
//   - Name, phone, email and address: each entry keeps what OpenSolar last
//     said (openSolarLast). A value is updated when OpenSolar's changed since
//     the last import (so a change made in OpenSolar comes through, but an
//     edit made on the dashboard isn't undone by an old OpenSolar value), or
//     when ours is empty. A blank in OpenSolar never clears ours, and the
//     address used as a stand-in name never replaces a real name. Details
//     come from the group's most advanced project (detailChanges()).
//   - The first time, each client is compared with existing entries not yet
//     linked to OpenSolar (clientScore(): phone, name allowing middle names /
//     initials / titles, address). A strong match is proposed; on the review
//     screen every match and new client has a "Same client as…" picker.
// Checked by isValidOpenSolarVisit / isValidOpenSolarSync in /firestore.rules.

// OpenSolar stage -> our Ocular Visits stage. "project_installed" -> Installed.
// Clients only get an OpenSolar project once they've been visited, so
// OpenSolar's New is at least Visited here.
const OPENSOLAR_STAGES = {
    new: "visited",
    designing: "visited",
    selling: "quoted",
    installing: "installing",
};

const visitRank = (key) => TABS.visits.pipeline.stages.findIndex((s) => s.key === key);

// "Mr. Jeffrey Co" -> "Jeffrey Co" (titles left off names).
function cleanPersonName(first, family) {
    let name = (first || "").replace(/^\s*(mr|ms|mrs|miss|engr|dr|atty|arch)\s*\.?\s+/i, "").replace(/\s+/g, " ").trim();
    const last = (family || "").trim();
    if (last && last.length > 1 && !name.toLowerCase().endsWith(last.toLowerCase())) name = `${name} ${last}`.trim();
    return name;
}

// "(63)09175194725" / "(63)9178652363" -> "09175194725" / "09178652363";
// "(63)" alone -> "".
function cleanOpenSolarPhone(text) {
    let digits = (text || "").replace(/\D/g, "");
    if (digits.startsWith("63")) digits = digits.slice(2);
    if (digits.length === 10 && digits.startsWith("9")) digits = `0${digits}`;
    return digits.length >= 7 ? digits : "";
}

// OpenSolar fills in "<id>@os.code" when there's no real email.
const cleanOpenSolarEmail = (text) => (/@os\.code$/i.test(text || "") ? "" : (text || "").trim());

// The export as projects, then grouped per client and address.
function openSolarGroups(text) {
    const rows = parseCSV(text);
    const header = (rows[0] || []).map((h) => h.trim().toLowerCase());
    const col = (name) => header.indexOf(name);
    const c = {
        id: col("id"), address: col("address"), business: col("business_name"), first: col("contact_first_name"),
        family: col("contact_family_name"), email: col("contact_email"), phone: col("contact_phone"),
        stage: col("stage"), residential: col("is_residential"), sold: col("project_sold"), installed: col("project_installed"),
    };
    if (c.id === -1 || c.stage === -1) throw userError("This doesn't look like an OpenSolar project export (no id / stage columns).");

    const projects = rows.slice(1).map((r) => {
        const cell = (i) => (i >= 0 && r[i] ? r[i].trim() : "");
        const installed = /^(1|true|yes)$/i.test(cell(c.installed));
        const raw = cell(c.stage);
        return {
            id: cell(c.id),
            name: cell(c.business) || cleanPersonName(cell(c.first), cell(c.family)),
            address: cell(c.address),
            phone: cleanOpenSolarPhone(cell(c.phone)),
            email: cleanOpenSolarEmail(cell(c.email)),
            residential: !/^false$/i.test(cell(c.residential)),
            openSolarStage: installed ? "Installed" : raw,
            stage: installed ? TABS.visits.pipeline.won : (OPENSOLAR_STAGES[raw.toLowerCase()] || "new"),
        };
    }).filter((p) => /^\d+$/.test(p.id));

    // Group: same address and same client name; a project with no name joins
    // the address's only named client, if there's exactly one.
    const byAddress = new Map();
    for (const p of projects) {
        const key = nameKey(p.address) || `#${p.id}`;
        if (!byAddress.has(key)) byAddress.set(key, []);
        byAddress.get(key).push(p);
    }
    const groups = [];
    for (const list of byAddress.values()) {
        const names = [...new Set(list.map((p) => nameKey(p.name)).filter(Boolean))];
        const byName = new Map();
        for (const p of list) {
            const key = nameKey(p.name) || (names.length === 1 ? names[0] : "");
            if (!byName.has(key)) byName.set(key, []);
            byName.get(key).push(p);
        }
        groups.push(...byName.values());
    }
    return groups.map((list) => {
        list.sort((a, b) => Number(a.id) - Number(b.id));
        // Details come from the most advanced project (the earliest, on a
        // tie), falling back to the group's other projects for blanks.
        const furthest = list.reduce((best, p) => (visitRank(p.stage) > visitRank(best.stage) ? p : best), list[0]);
        const from = (field) => furthest[field] || (list.find((p) => p[field]) || {})[field] || "";
        const last = {
            name: from("name").slice(0, 100),
            phone: from("phone").slice(0, 30),
            email: from("email").slice(0, 200),
            address: from("address").slice(0, 300),
        };
        return {
            ids: list.map((p) => p.id),
            // No client name in OpenSolar: the address, else the project id
            // (only for a new entry's name; never replaces a real one).
            name: (last.name || last.address || `OpenSolar project ${list[0].id}`).slice(0, 100),
            address: last.address,
            phone: last.phone,
            email: last.email,
            last,
            residential: list.every((p) => p.residential),
            stage: furthest.stage,
            openSolarStage: furthest.openSolarStage.slice(0, 30),
        };
    });
}

// What the import would do: for each group, the entry it updates (by a
// linked project id), a proposed match (same name or phone, no OpenSolar
// link yet), or a new entry.
// Name and contact details to update on an entry from OpenSolar: filled in
// where ours is empty; replaced where OpenSolar's value changed since the
// last import (openSolarLast). On a first link (a match) only blanks are
// filled. Blank OpenSolar values are skipped.
const OPENSOLAR_FIELDS = ["name", "phone", "email", "address"];
const OPENSOLAR_FIELD_LABELS = { name: "Name", phone: "Phone", email: "Email", address: "Address" };

function detailChanges(visit, group, firstLink) {
    const last = visit.openSolarLast && typeof visit.openSolarLast === "object" ? visit.openSolarLast : null;
    const changes = [];
    for (const field of OPENSOLAR_FIELDS) {
        const theirs = group.last[field];
        const ours = visit[field] || "";
        if (!theirs || theirs === ours) continue;
        if (!ours) changes.push({ field, from: "", to: theirs });
        else if (!firstLink && last && typeof last[field] === "string" && theirs !== last[field]) changes.push({ field, from: ours, to: theirs });
    }
    return changes;
}

const sameLast = (a, b) => Boolean(a) && OPENSOLAR_FIELDS.every((f) => (a[f] || "") === (b[f] || ""));

// Looser client matching, for linking an OpenSolar client to an existing
// entry (e.g. a website lead) the first time.
const NAME_TITLES = new Set(["mr", "ms", "mrs", "miss", "engr", "dr", "atty", "arch", "jr", "sr"]);
const ADDRESS_FILLER = new Set(["st", "street", "ave", "avenue", "rd", "road", "blvd", "dr", "drive", "ext", "extension",
    "city", "brgy", "barangay", "village", "subd", "subdivision", "lot", "blk", "block", "phase", "the", "of", "metro", "manila"]);

const nameTokens = (name) => (name || "").toLowerCase().replace(/[^a-z0-9\s]/g, " ").split(/\s+/)
    .filter((t) => t.length > 1 && !NAME_TITLES.has(t));
const addressTokens = (address) => (address || "").toLowerCase().replace(/[^a-z0-9\s]/g, " ").split(/\s+/)
    .filter((t) => t && !ADDRESS_FILLER.has(t));

function tokenOverlap(a, b) {
    const A = new Set(a);
    const B = new Set(b);
    let shared = 0;
    for (const t of A) if (B.has(t)) shared++;
    return { shared, smaller: Math.min(A.size, B.size), larger: Math.max(A.size, B.size) };
}

// How alike an OpenSolar client and an entry are, with the reasons:
// same phone +3; same name (every word of the shorter name in the longer,
// at least 2 words, or identical) +3; similar name (2+ shared words, or
// shared surname-length word) +1.5; same address +2; similar address +1.
// 3 or more is proposed as a match.
function clientScore(group, visit) {
    let score = 0;
    const reasons = [];
    const phone = digitsKey(group.phone);
    if (phone.length >= 7 && digitsKey(visit.phone) === phone) {
        score += 3;
        reasons.push("same phone");
    }
    const names = tokenOverlap(nameTokens(group.last.name), nameTokens(visit.name));
    if (names.smaller && names.shared === names.smaller && (names.smaller >= 2 || names.larger === 1)) {
        score += 3;
        reasons.push("same name");
    } else if (names.shared >= 2 || (names.shared === 1 && names.smaller >= 2)) {
        score += 1.5;
        reasons.push("similar name");
    }
    const addresses = tokenOverlap(addressTokens(group.address), addressTokens(visit.address));
    if (addresses.smaller >= 2 && addresses.shared / addresses.smaller >= 0.6) {
        score += 2;
        reasons.push("same address");
    } else if (addresses.shared >= 2) {
        score += 1;
        reasons.push("similar address");
    }
    return { score, reasons };
}

// Entries an OpenSolar client could be, best first (score > 0): visit
// requests not yet linked to OpenSolar.
function clientCandidates(group) {
    return data.visits
        .filter((v) => !serialList(v.openSolarIds).length)
        .map((visit) => ({ visit, ...clientScore(group, visit) }))
        .filter((c) => c.score > 0)
        .sort((a, b) => b.score - a.score);
}

function openSolarPlan(groups) {
    const linked = new Map();
    for (const v of data.visits) for (const id of serialList(v.openSolarIds)) linked.set(id, v);
    return groups.map((group) => {
        const visit = group.ids.map((id) => linked.get(id)).find(Boolean);
        if (visit) {
            const newIds = group.ids.filter((id) => !serialList(visit.openSolarIds).includes(id));
            const forward = visitRank(group.stage) > visitRank(stageOf("visits", visit));
            const changes = detailChanges(visit, group, false);
            const recordsDetails = !sameLast(visit.openSolarLast, group.last);
            const changed = newIds.length || forward || changes.length || recordsDetails || visit.openSolarStage !== group.openSolarStage;
            return { group, visit, kind: changed ? "update" : "same", newIds, forward, changes, recordsDetails };
        }
        const candidates = clientCandidates(group);
        const best = candidates[0];
        return best && best.score >= 3
            ? { group, visit: best.visit, kind: "match", changes: detailChanges(best.visit, group, true), candidates }
            : { group, kind: "new", candidates };
    });
}

function showOpenSolarReview(plan, fileName) {
    formOpen = true;
    selected = null;
    setBackButton();
    const count = (kind) => plan.filter((p) => p.kind === kind).length;
    detailPane.querySelector(".admin-detail-kind").textContent = "Import from OpenSolar";
    const main = el("div", "admin-entry-main");
    main.append(
        el("span", "admin-entry-title", "Review the OpenSolar import"),
        el("span", "admin-entry-meta", `${fileName} · ${plural(plan.reduce((n, p) => n + p.group.ids.length, 0), ["project", "projects"])} in ${plural(plan.length, ["client", "clients"])}. Nothing is saved until you click Import.`),
    );
    detailPane.querySelector(".admin-detail-title").replaceChildren(main);

    const form = el("form", "admin-install-form admin-os-review");
    form.noValidate = true;
    const summary = el("div", "admin-os-summary");
    for (const [kind, label] of [["new", "new"], ["match", "likely existing"], ["update", "to update"], ["same", "unchanged"]]) {
        const chip = el("span", `admin-os-chip admin-os-${kind}`);
        chip.append(el("strong", "", String(count(kind))), ` ${label}`);
        summary.append(chip);
    }
    form.append(summary);

    const stageLabel = (key) => stageInfo("visits", key).label;
    // "Phone: 0917 111 2222 → 0918 333 4444", "adds email".
    const describeChanges = (changes) => changes.map((c) => (c.from
        ? `${OPENSOLAR_FIELD_LABELS[c.field]}: ${c.from} → ${c.to}`
        : `adds ${OPENSOLAR_FIELD_LABELS[c.field].toLowerCase()}`));

    // "Same client as…": suggestions first (with why), then every other entry
    // not yet linked to OpenSolar, or "Add as a new client".
    const unlinked = data.visits
        .filter((v) => !serialList(v.openSolarIds).length)
        .sort((a, b) => (a.name || "").localeCompare(b.name || ""));
    const pickers = new Map();
    const picker = (item) => {
        const select = el("select", "admin-select admin-os-pick");
        select.setAttribute("aria-label", `Same client as… (${item.group.name})`);
        const none = el("option", "", "Add as a new client");
        none.value = "";
        select.append(none);
        const label = (v, why) => [v.name || "(no name)", stageLabel(stageOf("visits", v)), v.phone || v.address, why].filter(Boolean).join(" · ");
        const suggested = el("optgroup");
        suggested.label = "Suggested";
        for (const c of item.candidates.slice(0, 6)) {
            const option = el("option", "", `Same as ${label(c.visit, c.reasons.join(", "))}`);
            option.value = c.visit.id;
            suggested.append(option);
        }
        if (suggested.children.length) select.append(suggested);
        const others = el("optgroup");
        others.label = "All other clients";
        const shown = new Set(item.candidates.slice(0, 6).map((c) => c.visit.id));
        for (const v of unlinked) {
            if (shown.has(v.id)) continue;
            const option = el("option", "", `Same as ${label(v)}`);
            option.value = v.id;
            others.append(option);
        }
        if (others.children.length) select.append(others);
        select.value = item.kind === "match" ? item.visit.id : "";
        pickers.set(item, select);
        return select;
    };

    const section = (kind, title, describe) => {
        const items = plan.filter((p) => p.kind === kind);
        if (!items.length) return;
        form.append(el("h3", "admin-os-heading", `${title} (${items.length})`));
        const list = el("ul", "admin-os-list");
        for (const item of items) {
            const row = el("li", "admin-os-row");
            const text = el("span", "admin-os-name", item.group.name);
            text.append(el("span", "admin-os-meta", describe(item)));
            if (kind === "match" || kind === "new") {
                row.classList.add("admin-os-row-pick");
                row.append(text, picker(item));
            } else {
                row.append(text);
            }
            list.append(row);
        }
        form.append(list);
    };
    const projects = (g) => `${plural(g.ids.length, ["project", "projects"])} #${g.ids.join(", #")}`;
    section("match", "Likely existing clients", (p) => [p.group.address, projects(p.group), `OpenSolar: ${p.group.openSolarStage || "—"}`, ...describeChanges(p.changes), "change the choice if it's a different client"].filter(Boolean).join(" · "));
    section("new", "New clients", (p) => [p.group.address, `${stageLabel(p.group.stage)} (OpenSolar: ${p.group.openSolarStage || "—"})`, projects(p.group),
        p.candidates.length ? "possible matches in the list" : ""].filter(Boolean).join(" · "));
    section("update", "Updates", (p) => [
        p.forward ? `${stageLabel(stageOf("visits", p.visit))} → ${stageLabel(p.group.stage)}` : "",
        p.newIds.length ? `+ ${plural(p.newIds.length, ["project", "projects"])}` : "",
        ...describeChanges(p.changes),
        !p.forward && !p.newIds.length && !p.changes.length
            ? (p.visit.openSolarStage !== p.group.openSolarStage ? `OpenSolar now: ${p.group.openSolarStage}` : "saves OpenSolar's details to track future changes")
            : "",
    ].filter(Boolean).join(" · "));
    if (count("same")) form.append(el("p", "admin-os-note", `${plural(count("same"), ["client", "clients"])} already up to date, left as they are.`));

    const actions = el("div", "admin-install-form-actions");
    const error = el("p", "admin-action-error admin-install-error");
    error.setAttribute("role", "alert");
    const cancel = el("button", "admin-action");
    cancel.type = "button";
    cancel.textContent = "Cancel";
    cancel.addEventListener("click", closeEntry);
    const go = el("button", "admin-action admin-action-primary");
    go.type = "submit";
    const work = plan.filter((p) => p.kind !== "same").length;
    go.disabled = !work;
    go.append(el("span", "material-symbols-rounded", "cloud_download"), work ? "Import" : "Nothing to import");
    actions.append(error, cancel, go);
    form.append(actions);

    form.addEventListener("submit", async (e) => {
        e.preventDefault();
        error.textContent = "";
        go.disabled = true;
        cancel.disabled = true;
        go.replaceChildren(el("span", "material-symbols-rounded", "hourglass_top"), "Importing…");
        // Each match / new client goes by its "Same client as…" choice.
        const final = plan.map((p) => {
            if (!pickers.has(p)) return p;
            const visit = data.visits.find((v) => v.id === pickers.get(p).value);
            return visit
                ? { group: p.group, kind: "match", visit, changes: detailChanges(visit, p.group, true) }
                : { group: p.group, kind: "new" };
        });
        try {
            const result = await runOpenSolarImport(final);
            formOpen = false;
            await loadSubmissions();
            closeEntry();
            setOpenSolarStatus(`OpenSolar import: ${result.created} new, ${result.updated} updated${result.skipped ? `, ${result.skipped} already there` : ""}.`);
        } catch (err) {
            console.error("Admin: OpenSolar import failed", err);
            error.textContent = err.code === "permission-denied"
                ? "Permission denied. Publish the latest /firestore.rules in the Firebase console, then try again."
                : "The import stopped. Check your connection and try again (what was saved stays, and re-importing won't duplicate it).";
            go.disabled = false;
            cancel.disabled = false;
            go.replaceChildren(el("span", "material-symbols-rounded", "cloud_download"), "Import");
        }
    });
    detailPane.querySelector(".admin-detail-body").replaceChildren(form);
    overview.hidden = true;
    detailPane.hidden = false;
    mainArea.scrollTop = 0;
    if (!desktop.matches) detailPane.scrollIntoView({ block: "start" });
    markSelected();
}

async function runOpenSolarImport(plan) {
    const email = auth.currentUser.email;
    let created = 0;
    let updated = 0;
    let skipped = 0;
    for (const item of plan) {
        const { group } = item;
        if (item.kind === "new") {
            try {
                await firestore.setDoc(firestore.doc(db, TABS.visits.collection, `opensolar-${group.ids[0]}`), {
                    name: group.name,
                    phone: group.phone,
                    email: group.email,
                    address: group.address,
                    propertyType: group.residential ? "Residential" : "Commercial",
                    product: "Not sure yet",
                    monthlyBill: "",
                    preferredDate: "",
                    preferredTime: "Any time",
                    message: "",
                    attachments: [],
                    consent: false,
                    sourcePage: "",
                    status: "new",
                    createdAt: firestore.serverTimestamp(),
                    stage: group.stage,
                    stageUpdatedAt: firestore.serverTimestamp(),
                    stageUpdatedBy: email,
                    source: "opensolar",
                    openSolarIds: group.ids.slice(0, 50),
                    openSolarStage: group.openSolarStage,
                    openSolarSyncedAt: firestore.serverTimestamp(),
                    openSolarLast: group.last,
                });
                created++;
            } catch (err) {
                // Already there (another import got to it first): not an error.
                if (err.code === "permission-denied" && created + updated === 0 && skipped === 0) throw err;
                skipped++;
            }
        } else if (item.kind === "update" || item.kind === "match") {
            const visit = item.visit;
            const update = {
                openSolarIds: [...new Set([...serialList(visit.openSolarIds), ...group.ids])].slice(0, 50),
                openSolarStage: group.openSolarStage,
                openSolarSyncedAt: firestore.serverTimestamp(),
                openSolarLast: group.last,
            };
            if (visitRank(group.stage) > visitRank(stageOf("visits", visit))) {
                update.stage = group.stage;
                update.stageUpdatedAt = firestore.serverTimestamp();
                update.stageUpdatedBy = email;
            }
            for (const change of item.changes || []) update[change.field] = change.to;
            await firestore.updateDoc(firestore.doc(db, TABS.visits.collection, visit.id), update);
            // Keep the local copy in step, in case another group in this file
            // matches the same entry.
            visit.openSolarIds = update.openSolarIds;
            visit.openSolarLast = update.openSolarLast;
            if (update.stage) visit.stage = update.stage;
            for (const field of OPENSOLAR_FIELDS) if (update[field]) visit[field] = update[field];
            updated++;
        }
    }
    return { created, updated, skipped };
}

function setOpenSolarStatus(text) {
    openSolarStatus.textContent = text;
    openSolarStatus.hidden = !text;
}

openSolarButton.addEventListener("click", () => openSolarFile.click());
openSolarFile.addEventListener("change", async () => {
    const file = openSolarFile.files[0];
    openSolarFile.value = "";
    if (!file || role !== "admin") return;
    setOpenSolarStatus("");
    try {
        const plan = openSolarPlan(openSolarGroups(await file.text()));
        if (!plan.length) throw userError("No OpenSolar projects found in that file.");
        showOpenSolarReview(plan, file.name);
    } catch (err) {
        console.error("Admin: reading OpenSolar export failed", err);
        setOpenSolarStatus(err.userMessage || "Couldn't read that file. Export the projects from OpenSolar as CSV and try again.");
    }
});


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
        const what = `${TABS[tab].label.toLowerCase()} from ${entry.name || entry.clientName || entry.fullName || "this client"}`;
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
    const paths = tab === "visits" ? serialList(entry.attachments) : CHECKLIST_TYPES.includes(tab) ? checklistPhotoPaths(entry) : [];
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
    itemFormOpen = false;
    setBackButton();

    const details = renderEntry(tab, entry);
    details.classList.add("admin-entry-full");
    details.open = true;
    detailPane.querySelector(".admin-detail-kind").textContent = TABS[tab].label;
    // The pinned header shows the summary line (name, tags, details, date);
    // the entry's own summary is hidden in the pane.
    detailPane.querySelector(".admin-detail-title").replaceChildren(
        ...[...details.querySelector("summary").children]
            // The quick − / + stays in the list (a copy wouldn't work).
            .filter((child) => !child.classList.contains("admin-chevron") && !child.classList.contains("admin-inv-quick"))
            .map((child) => child.cloneNode(true)),
    );
    detailPane.querySelector(".admin-detail-body").replaceChildren(details);
    hydrateThumbs(detailPane.querySelector(".admin-detail-title"));
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
    // The installer's home is the "start a checklist" picker, or the stock
    // summary on the Inventory tab.
    if (role === "installer") {
        if (activeTab === "inventory") showInventoryHome();
        else showChecklistStart(CHECKLIST_TYPES.includes(activeTab) ? activeTab : "inspection");
        return;
    }
    selected = null;
    formOpen = false;
    itemFormOpen = false;
    detailPane.hidden = true;
    detailPane.querySelector(".admin-detail-body").replaceChildren();
    detailPane.querySelector(".admin-detail-title").replaceChildren();
    // Desktop list view: "Select an entry" instead of the overview, or, on the
    // Inventory tab, "Stock on hand".
    overview.hidden = desktop.matches && document.body.dataset.view === "list";
    markSelected();
    if (role === "admin" && desktop.matches && document.body.dataset.view === "list" && activeTab === "inventory") showInventoryHome();
}

// The pane's back button: back to the overview for admins, to a new
// "Add installation" form for the encoder (and hidden on that form).
function setBackButton({ hidden = false } = {}) {
    const back = detailPane.querySelector(".admin-back");
    back.hidden = hidden;
    const inventoryHome = role === "installer" && activeTab === "inventory";
    back.replaceChildren(
        el("span", "material-symbols-rounded", role === "encoder" ? "add" : inventoryHome ? "inventory_2" : role === "installer" ? "add_task" : "close"),
        role === "encoder" ? "New installation" : inventoryHome ? "Stock on hand" : role === "installer" ? "New checklist" : "Close",
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
    // Phones always show admins the overview above the list.
    else if (role === "admin" && !selected && !formOpen) {
        overview.hidden = desktop.matches && document.body.dataset.view === "list";
    }
});


// ------------------------------------------------------ installer checklists
//
// The installer account (and admins, to try it out) start a checklist for a job
// and answer each item Pass / Needs fix / N/A, with an optional note and
// photos. Two kinds, shown as two tabs: "inspection" (Site visit inspection)
// and "installation" (Installation and commissioning). The content is in
// checklist-templates.js. One Firestore document per job and kind
// (jobChecklists, id "<kind>-<visit request id>" for a client from the Ocular
// Visits list, or an automatic id for a job typed in by hand). It saves as the
// installer goes; submitting needs every item answered and a name, and locks it
// until an admin reopens it. Each document keeps counters (answered, passed,
// fixes, n/a) so the overview needn't read every answer. Photos are in Storage
// under jobChecklists/<id>/. Security rules: /firestore.rules, /storage.rules.

const CK_MAX_PHOTOS = 6;
const CK_SAVE_DELAY_MS = 700;
// The clients the picker lists by default, by their visit request's stage.
// Searching, or "Show all clients", ignores this.
const CK_START_STAGES = {
    inspection: ["new", "contacted", "scheduled", "visited"],
    installation: ["quoted", "installing"],
};
const CK_RESULTS = {
    pass: { label: "Pass", icon: "check_circle" },
    fix: { label: "Needs fix", icon: "warning" },
    na: { label: "N/A", icon: "do_not_disturb_on" },
    open: { label: "Not answered", icon: "radio_button_unchecked" },
};

const checklistItems = (type) => CHECKLISTS[type].sections.flatMap((section) => section.items);

// The counters saved with a checklist, worked out from its answers against
// the current checklist content.
// An item's result: pass, fix, na, or "" while unanswered. A normal item stores
// it as `r`. A question with set answers stores the chosen answer as `v`, and
// it's a fix when that answer is in the item's `flagged` list. A photo item is
// a pass once it has a photo (and its note, if one is required), or N/A.
function itemResult(item, answer) {
    answer = answer || {};
    if (item.options) {
        if (!item.options.includes(answer.v)) return "";
        return (item.flagged || []).includes(answer.v) ? "fix" : "pass";
    }
    if (item.type === "photo") {
        if (answer.r === "na") return "na";
        const hasPhoto = Array.isArray(answer.photos) && answer.photos.length > 0;
        const hasNote = Boolean(answer.note && answer.note.trim());
        return hasPhoto && (!item.noteRequired || hasNote) ? "pass" : "";
    }
    return answer.r === "pass" || answer.r === "fix" || answer.r === "na" ? answer.r : "";
}

function checklistCounts(type, items) {
    let passed = 0, fixes = 0, na = 0;
    const all = checklistItems(type);
    for (const item of all) {
        const r = itemResult(item, items[item.id]);
        if (r === "pass") passed++;
        else if (r === "fix") fixes++;
        else if (r === "na") na++;
    }
    return { total: all.length, answered: passed + fixes + na, passed, fixes, na };
}

function checklistPhotoPaths(c) {
    return Object.values(c.items || {}).flatMap((answer) => (Array.isArray(answer.photos) ? answer.photos : []));
}

// The text of each item marked "Needs fix" (for the CSV).
function checklistFixList(c) {
    const items = c.items || {};
    if (!CHECKLISTS[c.type]) return [];
    return checklistItems(c.type).filter((item) => itemResult(item, items[item.id]) === "fix").map((item) => item.options ? `${item.text}: ${items[item.id].v}` : item.text);
}

const checklistPercent = (c) => (c.total ? Math.round(((c.answered || 0) / c.total) * 100) : 0);

// The progress line under an entry's name: a small bar and the counts.
function checklistMeta(c) {
    const meta = el("span", "admin-ck-meta");
    const bar = el("span", "admin-ck-minibar");
    const fill = el("i");
    fill.style.width = `${checklistPercent(c)}%`;
    bar.append(fill);
    const bits = [`${c.answered || 0} of ${c.total || 0} answered`];
    if (c.fixes) bits.push(`${c.fixes} need fixing`);
    meta.append(bar, el("span", "", bits.join(" · ")));
    return meta;
}

// Keeps the list entry and the pane header current as answers change.
function refreshChecklistMeta(c) {
    const targets = [...document.querySelectorAll(`.admin-list [data-id="${CSS.escape(c.id)}"] .admin-entry-meta`)];
    const pane = detailPane.querySelector(".admin-detail-title .admin-entry-meta");
    if (pane && selected && selected.id === c.id) targets.push(pane);
    for (const target of targets) target.replaceChildren(checklistMeta(c));
}

// The big progress bar and count at the top of an open checklist.
function checklistProgress(c) {
    const node = el("div", "admin-ck-progress");
    const bar = el("div", "admin-ck-bar");
    const fill = el("i");
    bar.append(fill);
    const text = el("span", "admin-ck-count");
    node.append(bar, text);
    const update = (x) => {
        fill.style.width = `${checklistPercent(x)}%`;
        const bits = [`${x.answered || 0} of ${x.total || 0} answered`];
        if (x.fixes) bits.push(`${x.fixes} need fixing`);
        if (x.na) bits.push(`${x.na} N/A`);
        text.textContent = bits.join(" · ");
    };
    update(c);
    return { node, update };
}

function checklistHead(c) {
    const tpl = CHECKLISTS[c.type];
    const head = el("div", "admin-ck-head");
    // The client's name is already in the line above (the pane header or the
    // list row), so this shows just the address.
    const job = el("div", "admin-ck-job");
    job.append(el("span", "", c.address || "No address"));
    const kind = el("div", "admin-ck-kind");
    kind.append(el("span", "material-symbols-rounded", "checklist"), el("span", "", tpl.title));
    if (tpl.sample) kind.append(el("span", "admin-ck-sample", "Sample content"));
    head.append(job, kind);
    return head;
}

// One checklist as a list entry. Its body is built the first time it's opened:
// the form for its creator while it's in progress, the read-only report for
// everyone else (and once submitted).
function renderChecklist(c) {
    const submitted = c.status === "submitted";
    const badge = el("span", `admin-badge ${submitted ? "" : "admin-badge-stage"}`.trim(), submitted ? "Submitted" : "In progress");
    const details = entryShell(c.clientName, checklistMeta(c), toDate(c.updatedAt) || toDate(c.createdAt), { badge });
    const mine = (c.createdBy || "").toLowerCase() === currentEmail;
    const editable = !submitted && mine && (role === "installer" || role === "admin");

    if (role === "admin") {
        const actions = el("div", "admin-actions admin-install-entry-actions");
        const error = el("span", "admin-action-error");
        actions.append(error);
        if (submitted) actions.append(reopenButton(c, error));
        actions.append(...entryTools(c.type, c, error));
        details.append(actions);
    }

    const body = el("div", "admin-ck-body");
    details.append(body);
    let built = false;
    details.addEventListener("toggle", () => {
        if (!details.open || built) return;
        built = true;
        body.replaceChildren(editable ? checklistForm(c) : checklistReport(c));
    });
    return details;
}

function reopenButton(c, errorText) {
    const button = el("button", "admin-action");
    button.type = "button";
    button.append(el("span", "material-symbols-rounded", "lock_open"), "Reopen for the installer");
    button.addEventListener("click", async () => {
        if (!confirm("Reopen this checklist so the installer can change it? Their sign-off is removed.")) return;
        button.disabled = true;
        errorText.textContent = "";
        try {
            await firestore.updateDoc(firestore.doc(db, "jobChecklists", c.id), {
                status: "in_progress",
                signedOffBy: firestore.deleteField(),
                submittedAt: firestore.deleteField(),
                updatedAt: firestore.serverTimestamp(),
                updatedBy: currentEmail,
            });
            await loadSubmissions();
        } catch (err) {
            console.error("Admin: reopening checklist failed", err);
            errorText.textContent = err.code === "permission-denied"
                ? "Couldn't reopen it. Publish the latest /firestore.rules in the Firebase console, then try again."
                : "Couldn't reopen it. Check your connection and try again.";
            button.disabled = false;
        }
    });
    return button;
}

// The read-only view: every item's answer, note and photos.
function checklistReport(c) {
    const tpl = CHECKLISTS[c.type];
    const wrap = el("div", "admin-ck");
    wrap.append(checklistHead(c), checklistProgress(c).node);
    wrap.append(el("p", "admin-ck-signoff", c.status === "submitted"
        ? `Signed off by ${c.signedOffBy || "—"} · ${formatDate(toDate(c.submittedAt))}`
        : `In progress${c.createdBy ? ` · started by ${c.createdBy}` : ""} · last updated ${formatDate(toDate(c.updatedAt) || toDate(c.createdAt))}`));
    const items = c.items || {};
    for (const section of tpl.sections) {
        const sec = el("section", "admin-ck-section");
        sec.append(el("h3", "admin-ck-section-title", section.title));
        for (const item of section.items) {
            const answer = items[item.id] || {};
            const state = itemResult(item, answer) || "open";
            const row = el("div", `admin-ck-item admin-ck-${state}`);
            const mark = el("span", "admin-ck-mark");
            mark.append(el("span", "material-symbols-rounded", CK_RESULTS[state].icon));
            const main = el("div", "admin-ck-main");
            main.append(el("div", "admin-ck-text", item.text));
            if (item.options && answer.v) main.append(el("div", "admin-ck-value", answer.v));
            if (answer.note) main.append(el("div", "admin-ck-note-text", answer.note));
            const photos = Array.isArray(answer.photos) ? answer.photos : [];
            if (photos.length) {
                const grid = el("ul", "admin-attachment-grid admin-ck-photos");
                main.append(grid);
                loadAttachments(photos, grid);
            }
            const label = item.options && answer.v && state !== "open" ? (state === "fix" ? "Needs attention" : "Answered") : CK_RESULTS[state].label;
            row.append(mark, main, el("span", "admin-ck-result", label));
            sec.append(row);
        }
        wrap.append(sec);
    }
    return wrap;
}

// The form the installer fills in. Every change saves (notes after a short
// pause), and the pending save is flushed before any reload.
function checklistForm(c) {
    const tpl = CHECKLISTS[c.type];
    const items = JSON.parse(JSON.stringify(c.items || {}));
    const ref = firestore.doc(db, "jobChecklists", c.id);
    const form = el("div", "admin-ck admin-ck-edit");
    const progress = checklistProgress(c);
    const saveState = el("button", "admin-ck-save");
    saveState.type = "button";
    saveState.setAttribute("role", "status");
    const topRow = el("div", "admin-ck-toprow");
    topRow.append(progress.node, saveState);
    form.append(
        checklistHead(c),
        topRow,
        el("p", "admin-ck-intro", "Work through each item: tick it off, pick an answer, or add the photo. Add a note wherever it helps. Your answers save as you go."),
    );

    // ---- saving
    let timer = 0;
    let dirty = false;
    let inflight = 0;
    let chain = Promise.resolve();
    const say = (text, state = "") => { saveState.textContent = text; saveState.dataset.state = state; };
    say("Saves automatically");

    function persist() {
        clearTimeout(timer);
        dirty = false;
        // The entry in `data` follows along, so a re-render shows the latest.
        Object.assign(c, checklistCounts(c.type, items), {
            items: JSON.parse(JSON.stringify(items)),
            updatedAt: { toDate: () => new Date() },
            updatedBy: currentEmail,
        });
        progress.update(c);
        refreshChecklistMeta(c);
        updateSubmit();
        inflight++;
        say("Saving…", "busy");
        chain = chain.then(() => firestore.updateDoc(ref, {
            items: JSON.parse(JSON.stringify(items)),
            ...checklistCounts(c.type, items),
            updatedAt: firestore.serverTimestamp(),
            updatedBy: currentEmail,
        })).then(() => {
            inflight--;
            if (!inflight) say("Saved", "ok");
        }).catch((err) => {
            inflight--;
            console.error("Admin: saving checklist failed", err);
            say(err.code === "permission-denied" ? "Couldn't save: this checklist is locked." : "Couldn't save. Tap to retry.", "error");
        });
        return chain;
    }
    const persistSoon = () => {
        dirty = true;
        clearTimeout(timer);
        say("Typing…", "busy");
        timer = setTimeout(persist, CK_SAVE_DELAY_MS);
    };
    saveState.addEventListener("click", () => { if (saveState.dataset.state === "error") persist(); });
    flushChecklist = async () => {
        if (dirty) persist();
        await chain;
    };

    // One item's answer, note and photos; empty parts are dropped.
    function setItem(id, patch) {
        const next = { ...(items[id] || {}), ...patch };
        if (!next.r) delete next.r;
        if (!next.v) delete next.v;
        if (!next.note) delete next.note;
        if (!next.photos || !next.photos.length) delete next.photos;
        if (Object.keys(next).length) items[id] = next;
        else delete items[id];
    }

    const localUrls = new Map();

    function itemRow(item) {
        const row = el("div", "admin-ck-item");
        const main = el("div", "admin-ck-main");
        main.append(el("div", "admin-ck-text", item.text));
        if (item.hint) main.append(el("div", "admin-ck-hint", item.hint));
        row.append(main);

        // Pass / Needs fix / N/A
        const choices = el("div", "admin-ck-choices");
        choices.setAttribute("role", "group");
        choices.setAttribute("aria-label", item.text);
        const choiceButtons = {};
        // Set answers for a question, N/A only for a photo, else Pass / Needs fix / N/A.
        const keys = item.options ? item.options : item.type === "photo" ? ["na"] : ["pass", "fix", "na"];
        if (item.options) choices.classList.add("admin-ck-options");
        for (const key of keys) {
            const button = el("button", `admin-ck-choice admin-ck-choice-${item.options ? (item.flagged || []).includes(key) ? "fix" : "pass" : key}`);
            button.type = "button";
            if (item.options) button.append(key);
            else button.append(el("span", "material-symbols-rounded", CK_RESULTS[key].icon), item.type === "photo" ? "Can't do this (N/A)" : CK_RESULTS[key].label);
            button.addEventListener("click", () => {
                // Tapping the chosen one again clears it.
                const now = items[item.id] || {};
                if (item.options) setItem(item.id, { v: now.v === key ? "" : key });
                else setItem(item.id, { r: now.r === key ? "" : key });
                sync();
                persist();
            });
            choiceButtons[key] = button;
            choices.append(button);
        }
        if (item.type !== "photo") row.append(choices);

        // Note and photos
        const extra = el("div", "admin-ck-extra");
        const note = el("textarea", "admin-ck-note");
        note.rows = 2;
        note.maxLength = 500;
        note.setAttribute("aria-label", `Note for: ${item.text}`);
        note.value = (items[item.id] && items[item.id].note) || "";
        note.addEventListener("input", () => {
            setItem(item.id, { note: note.value.trim() ? note.value : "" });
            persistSoon();
        });
        const tools = el("div", "admin-ck-tools");
        const noteButton = el("button", "admin-ck-tool");
        noteButton.type = "button";
        noteButton.append(el("span", "material-symbols-rounded", "edit_note"), "Note");
        let noteOpen = Boolean(note.value);
        noteButton.addEventListener("click", () => {
            noteOpen = !noteOpen;
            sync();
            if (noteOpen) note.focus();
        });
        const photoButton = el("label", "admin-ck-tool");
        photoButton.append(el("span", "material-symbols-rounded", "photo_camera"), item.type === "photo" ? "Add photo" : item.photo ? "Photo (recommended)" : "Photo");
        const fileInput = el("input");
        fileInput.type = "file";
        fileInput.accept = "image/*";
        fileInput.multiple = true;
        fileInput.hidden = true;
        photoButton.append(fileInput);
        if (item.type === "photo") {
            photoButton.classList.add("admin-ck-tool-main");
            tools.append(photoButton, choices);
            if (!item.notePrompt) tools.append(noteButton);
        } else if (item.options) tools.append(noteButton);
        else tools.append(noteButton, photoButton);
        if (item.options) photoButton.hidden = true;
        const photoError = el("p", "admin-ck-error");
        const photos = el("ul", "admin-attachment-grid admin-ck-photos");
        extra.append(note, tools, photoError, photos);
        row.append(extra);

        function photoThumb(path) {
            const li = el("li");
            const frame = el("span", "admin-thumb admin-ck-photo");
            const img = el("img");
            img.alt = "Photo";
            img.addEventListener("error", () => frame.classList.add("admin-ck-photo-broken"));
            const local = localUrls.get(path);
            if (local) img.src = local;
            else {
                loadStorage()
                    .then(({ storageSdk, storage }) => storageSdk.getDownloadURL(storageSdk.ref(storage, path)))
                    .then((url) => { img.src = url; })
                    .catch(() => frame.classList.add("admin-ck-photo-broken"));
            }
            frame.append(img);
            const remove = el("button", "admin-ck-photo-remove");
            remove.type = "button";
            remove.setAttribute("aria-label", "Remove photo");
            remove.append(el("span", "material-symbols-rounded", "close"));
            remove.addEventListener("click", async () => {
                if (!confirm("Remove this photo?")) return;
                setItem(item.id, { photos: (items[item.id].photos || []).filter((p) => p !== path) });
                drawPhotos();
                persist();
                try {
                    const { storageSdk, storage } = await loadStorage();
                    await storageSdk.deleteObject(storageSdk.ref(storage, path));
                } catch (err) {
                    console.warn("Admin: couldn't delete checklist photo", path, err);
                }
            });
            li.append(frame, remove);
            return li;
        }
        function drawPhotos() {
            photos.replaceChildren(...((items[item.id] && items[item.id].photos) || []).map(photoThumb));
        }

        fileInput.addEventListener("change", async () => {
            const files = [...fileInput.files];
            fileInput.value = "";
            if (!files.length) return;
            photoError.textContent = "";
            say("Uploading photo…", "busy");
            try {
                const { storageSdk, storage } = await loadStorage();
                let n = 0;
                for (const file of files) {
                    if (((items[item.id] && items[item.id].photos) || []).length >= CK_MAX_PHOTOS) {
                        photoError.textContent = `Up to ${CK_MAX_PHOTOS} photos per item.`;
                        break;
                    }
                    if (!/^image\//i.test(fileType(file))) {
                        photoError.textContent = `${file.name} isn't a photo.`;
                        continue;
                    }
                    const prepared = await shrinkImage(file);
                    if (prepared.size > MAX_FILE_BYTES) {
                        photoError.textContent = `${file.name} is over 10 MB.`;
                        continue;
                    }
                    const path = `jobChecklists/${c.id}/${item.id}-${Date.now()}-${++n}-${safeFileName(prepared.name)}`;
                    await storageSdk.uploadBytes(storageSdk.ref(storage, path), prepared, { contentType: fileType(prepared) });
                    localUrls.set(path, URL.createObjectURL(prepared));
                    setItem(item.id, { r: item.type === "photo" ? "" : (items[item.id] || {}).r, photos: [...((items[item.id] && items[item.id].photos) || []), path] });
                    drawPhotos();
                    await persist();
                }
                if (!photoError.textContent) say(saveState.dataset.state === "error" ? saveState.textContent : "Saved", saveState.dataset.state === "error" ? "error" : "ok");
            } catch (err) {
                console.error("Admin: uploading checklist photo failed", err);
                photoError.textContent = err.code === "storage/unauthorized"
                    ? "Couldn't upload: publish the latest /storage.rules in the Firebase console."
                    : "Couldn't upload that photo. Check your connection and try again.";
                say("Photo not saved", "error");
            }
        });

        // Shows the chosen answer, and the note field when there's something to say.
        function sync() {
            const answer = items[item.id] || {};
            const r = itemResult(item, answer);
            const picked = item.options ? answer.v : answer.r;
            row.dataset.state = r || "open";
            for (const [key, button] of Object.entries(choiceButtons)) button.setAttribute("aria-pressed", String(key === picked));
            const showNote = noteOpen || r === "fix" || Boolean(note.value) || Boolean(item.notePrompt);
            note.hidden = !showNote || (item.type === "photo" && answer.r === "na");
            note.placeholder = item.notePrompt ? `${item.notePrompt}${item.noteRequired ? "" : " (optional)"}` : r === "fix" ? "What needs fixing?" : "Add a note (optional)";
            noteButton.setAttribute("aria-pressed", String(showNote));
        }
        sync();
        drawPhotos();
        return row;
    }

    for (const section of tpl.sections) {
        const sec = el("section", "admin-ck-section");
        sec.append(el("h3", "admin-ck-section-title", section.title));
        for (const item of section.items) sec.append(itemRow(item));
        form.append(sec);
    }

    // ---- sign off
    const submit = el("section", "admin-ck-section admin-ck-submit");
    submit.append(el("h3", "admin-ck-section-title", "Sign off"));
    const nameField = el("label", "admin-ck-field");
    nameField.append(el("span", "", "Your name"));
    const nameInput = el("input");
    nameInput.type = "text";
    nameInput.maxLength = 100;
    nameInput.autocomplete = "name";
    nameInput.placeholder = "Who completed this checklist?";
    nameField.append(nameInput);
    const submitNote = el("p", "admin-ck-submit-note");
    const submitError = el("p", "admin-ck-error");
    const submitButton = el("button", "admin-action admin-action-primary");
    submitButton.type = "button";
    submitButton.append(el("span", "material-symbols-rounded", "task_alt"), "Submit checklist");
    submit.append(nameField, submitNote, submitError, submitButton);
    form.append(submit);

    let submitting = false;
    function updateSubmit() {
        const left = (c.total || 0) - (c.answered || 0);
        submitNote.textContent = left
            ? `${plural(left, ["item", "items"])} still to answer before you can submit.`
            : c.fixes
                ? `${plural(c.fixes, ["item needs", "items need"])} fixing. You can still submit; the office will see them.`
                : "Everything is answered.";
        submitButton.disabled = submitting || left > 0 || nameInput.value.trim().length < 2;
    }
    nameInput.addEventListener("input", updateSubmit);
    updateSubmit();

    submitButton.addEventListener("click", async () => {
        if (!confirm("Submit this checklist? It locks once submitted; the office can reopen it if something needs changing.")) return;
        submitting = true;
        updateSubmit();
        submitError.textContent = "";
        try {
            if (dirty) persist();
            await chain;
            await firestore.updateDoc(ref, {
                items: JSON.parse(JSON.stringify(items)),
                ...checklistCounts(c.type, items),
                status: "submitted",
                signedOffBy: nameInput.value.trim(),
                submittedAt: firestore.serverTimestamp(),
                updatedAt: firestore.serverTimestamp(),
                updatedBy: currentEmail,
            });
            flushChecklist = null;
            selected = { tab: c.type, id: c.id };
            formOpen = false;
            await loadSubmissions();
            if (!desktop.matches) detailPane.scrollIntoView({ block: "start" });
        } catch (err) {
            console.error("Admin: submitting checklist failed", err);
            submitError.textContent = err.code === "permission-denied"
                ? "Couldn't submit it. Every item needs an answer and a name, and the latest /firestore.rules must be published."
                : "Couldn't submit it. Check your connection and try again.";
            submitting = false;
            updateSubmit();
        }
    });

    return form;
}

// ---- starting a checklist

// The right-hand pane's "start a checklist" picker: the installer's home.
function showChecklistStart(type) {
    formOpen = true;
    itemFormOpen = false;
    selected = null;
    setBackButton({ hidden: role === "installer" });
    const tpl = CHECKLISTS[type];
    detailPane.querySelector(".admin-detail-kind").textContent = "New checklist";
    const main = el("div", "admin-entry-main");
    main.append(el("span", "admin-entry-title", tpl.title), el("span", "admin-entry-meta", "Choose the job this checklist is for."));
    detailPane.querySelector(".admin-detail-title").replaceChildren(main);
    detailPane.querySelector(".admin-detail-body").replaceChildren(checklistStartPanel(type));
    overview.hidden = true;
    detailPane.hidden = false;
    mainArea.scrollTop = 0;
    markSelected();
}

function checklistStartPanel(type) {
    const tpl = CHECKLISTS[type];
    const panel = el("div", "admin-ck-start");
    panel.append(el("p", "admin-ck-intro", "Pick the client below, or add the job by hand. Your answers save as you go."));

    const search = el("input", "admin-ck-search");
    search.type = "search";
    search.placeholder = "Search clients by name or address";
    search.setAttribute("aria-label", "Search clients");
    const allLabel = el("label", "admin-ck-showall");
    const allBox = el("input");
    allBox.type = "checkbox";
    allLabel.append(allBox, "Show all clients");
    const tools = el("div", "admin-ck-start-tools");
    tools.append(search, allLabel);
    const note = el("p", "admin-ck-start-note");
    const list = el("ul", "admin-ck-clients");
    const error = el("p", "admin-ck-error");
    error.setAttribute("role", "alert");

    const stages = CK_START_STAGES[type];
    function draw() {
        const term = search.value.trim().toLowerCase();
        const everyone = Boolean(term) || allBox.checked;
        const pool = everyone ? data.visits : data.visits.filter((v) => stages.includes(stageOf("visits", v)));
        const found = term
            ? pool.filter((v) => [v.name, v.address, v.phone].join(" ").toLowerCase().includes(term))
            : pool;
        const shown = found.slice(0, 40);
        note.textContent = everyone
            ? `${plural(found.length, ["client", "clients"])}${found.length > shown.length ? ` (showing ${shown.length})` : ""}`
            : `Showing clients at: ${stages.map((key) => (stageInfo("visits", key) || {}).label).filter(Boolean).join(", ")}. Search, or tick “Show all clients”, to see the rest.`;
        list.replaceChildren(...(shown.length
            ? shown.map((v) => clientRow(v))
            : [el("li", "admin-empty", data.visits.length ? "No clients match." : "No clients to show yet.")]));
    }

    function clientRow(v) {
        const existing = data[type].find((c) => c.visitId === v.id);
        const stage = stageInfo("visits", stageOf("visits", v));
        const li = el("li", "admin-ck-client");
        const info = el("div", "admin-ck-client-info");
        info.append(el("strong", "", v.name || "(no name)"), el("span", "", [v.address, stage && stage.label].filter(Boolean).join(" · ")));
        const button = el("button", existing ? "admin-action" : "admin-action admin-action-primary");
        button.type = "button";
        button.append(
            el("span", "material-symbols-rounded", existing ? "open_in_new" : "play_arrow"),
            existing ? (existing.status === "submitted" ? "View" : "Continue") : "Start",
        );
        button.addEventListener("click", () => startChecklist(type, { visitId: v.id, clientName: v.name, address: v.address }, error, panel));
        li.append(info, button);
        return li;
    }

    search.addEventListener("input", draw);
    allBox.addEventListener("change", draw);

    // A job that isn't in the Ocular Visits list.
    const manual = el("details", "admin-ck-manual");
    manual.append(el("summary", "", "Job not in the list? Add it by name and address"));
    const field = (label, attrs) => {
        const wrap = el("label", "admin-ck-field");
        wrap.append(el("span", "", label));
        const input = el("input");
        Object.assign(input, attrs);
        wrap.append(input);
        return { wrap, input };
    };
    const nameField = field("Client name", { type: "text", maxLength: 100, autocomplete: "off" });
    const addressField = field("Address", { type: "text", maxLength: 300, autocomplete: "off" });
    const manualButton = el("button", "admin-action admin-action-primary");
    manualButton.type = "button";
    manualButton.append(el("span", "material-symbols-rounded", "play_arrow"), "Start");
    manualButton.addEventListener("click", () => {
        const name = nameField.input.value.trim();
        if (!name) {
            error.textContent = "Enter the client's name.";
            nameField.input.focus();
            return;
        }
        startChecklist(type, { visitId: "", clientName: name, address: addressField.input.value.trim() }, error, panel);
    });
    manual.append(nameField.wrap, addressField.wrap, manualButton);

    panel.append(tools, note, list, manual, error);
    draw();
    return panel;
}

async function startChecklist(type, job, errorText, panel) {
    const existing = job.visitId ? data[type].find((c) => c.visitId === job.visitId) : null;
    if (existing) {
        showEntry(type, existing.id);
        return;
    }
    checklistStartBusy = true;
    const buttons = [...panel.querySelectorAll("button")];
    buttons.forEach((b) => { b.disabled = true; });
    errorText.textContent = "";
    try {
        const id = job.visitId ? `${type}-${job.visitId}` : firestore.doc(firestore.collection(db, "jobChecklists")).id;
        await firestore.setDoc(firestore.doc(db, "jobChecklists", id), {
            type,
            visitId: job.visitId || "",
            clientName: (job.clientName || "").slice(0, 100) || "(no name)",
            address: (job.address || "").slice(0, 300),
            items: {},
            ...checklistCounts(type, {}),
            status: "in_progress",
            version: CHECKLIST_VERSION,
            createdAt: firestore.serverTimestamp(),
            createdBy: currentEmail,
            updatedAt: firestore.serverTimestamp(),
            updatedBy: currentEmail,
        });
        formOpen = false;
        selected = { tab: type, id };
        await loadSubmissions();
    } catch (err) {
        console.error("Admin: starting checklist failed", err);
        errorText.textContent = err.code === "permission-denied"
            ? "Couldn't start it. Publish the latest /firestore.rules in the Firebase console, then try again."
            : "Couldn't start the checklist. Check your connection and try again.";
        buttons.forEach((b) => { b.disabled = false; });
    } finally {
        checklistStartBusy = false;
    }
}

// ---- the admin overview's "Installer checklists" box

function checklistCell(c) {
    if (!c) return el("span", "admin-ck-cell admin-ck-cell-none", "Not started");
    const cell = el("button", "admin-ck-cell");
    cell.type = "button";
    const bar = el("span", "admin-ck-minibar");
    const fill = el("i");
    fill.style.width = `${checklistPercent(c)}%`;
    bar.append(fill);
    cell.append(bar, el("span", "admin-ck-cell-text", c.status === "submitted" ? "Submitted" : `${checklistPercent(c)}%`));
    if (c.fixes) cell.append(el("span", "admin-badge admin-badge-warn", `${c.fixes} to fix`));
    cell.title = `${c.answered || 0} of ${c.total || 0} answered`;
    cell.addEventListener("click", () => {
        selectTab(c.type);
        showEntry(c.type, c.id);
    });
    return cell;
}

function renderChecklistOverview() {
    const box = document.querySelector(".admin-checklists");
    if (role !== "admin") {
        box.hidden = true;
        return;
    }
    box.hidden = false;
    const all = [...data.inspection, ...data.installation];
    const summary = box.querySelector(".admin-checklists-summary");
    const alertBox = box.querySelector(".admin-checklists-alert");
    const table = box.querySelector(".admin-checklists-table");

    const submitted = all.filter((c) => c.status === "submitted").length;
    const fixes = all.reduce((n, c) => n + (c.fixes || 0), 0);
    const latest = all.map((c) => toDate(c.updatedAt) || toDate(c.createdAt)).filter(Boolean).sort((a, b) => b - a)[0];
    const stat = (value, label, small) => {
        const tile = el("div", "admin-stat");
        tile.append(el("span", small ? "admin-stat-value admin-stat-value-small" : "admin-stat-value", String(value)), el("span", "admin-stat-label", label));
        return tile;
    };
    summary.replaceChildren(
        stat(all.length - submitted, "In progress"),
        stat(submitted, "Submitted"),
        stat(fixes, "Items need fixing"),
        stat(latest ? formatDate(latest) : "—", "Last activity", true),
    );

    // Jobs being installed with no installation checklist yet.
    const missing = data.visits.filter((v) => stageOf("visits", v) === "installing" && !data.installation.some((c) => c.visitId === v.id));
    alertBox.hidden = !missing.length;
    if (missing.length) {
        alertBox.textContent = `${plural(missing.length, ["job", "jobs"])} in Installing ${missing.length === 1 ? "has" : "have"} no installation checklist yet: ${missing.slice(0, 5).map((v) => v.name).join(", ")}${missing.length > 5 ? "…" : ""}.`;
    }

    // One row per job (a client's visit request, or a job typed by hand).
    const jobs = new Map();
    for (const c of all) {
        const key = c.visitId || `m:${(c.clientName || "").toLowerCase()}|${(c.address || "").toLowerCase()}`;
        const job = jobs.get(key) || { name: c.clientName, address: c.address, inspection: null, installation: null, updated: null };
        job[c.type] = c;
        const when = toDate(c.updatedAt) || toDate(c.createdAt);
        if (when && (!job.updated || when > job.updated)) job.updated = when;
        jobs.set(key, job);
    }
    const rows = [...jobs.values()].sort((a, b) => (b.updated || 0) - (a.updated || 0)).slice(0, 12);
    if (!rows.length) {
        table.replaceChildren(el("p", "admin-empty", "No checklists started yet. Installers start them from the Installer Checklists workspace."));
        return;
    }
    const head = el("div", "admin-checklists-row admin-checklists-head");
    head.append(el("span", "", "Job"), el("span", "", CHECKLISTS.inspection.title), el("span", "", CHECKLISTS.installation.title));
    table.replaceChildren(head, ...rows.map((job) => {
        const row = el("div", "admin-checklists-row");
        const name = el("span", "admin-checklists-job");
        name.append(el("strong", "", job.name || "(no name)"), el("span", "", job.address || ""));
        row.append(name, checklistCell(job.inspection), checklistCell(job.installation));
        return row;
    }));
}


// -------------------------------------------------------------- inventory

// Stock on hand, kept by the installer account and admins on the Inventory
// tab. One document per item in `inventory` (name, category, unit, qty, the
// restock level `lowAt`, a note and up to INV_MAX_PHOTOS photos in Storage
// under inventory/<item id>/). Every change to the count (Use, Add stock, Set
// count, and the starting count) is written together with a record in
// `inventoryLog` in one transaction, and the item points at it (`lastLogId`),
// so the history always explains the count. Checked by isValidInventoryItem /
// isValidInventoryLog in /firestore.rules and the inventory/ rule in
// /storage.rules.
const INV_MAX_PHOTOS = 6;
const INV_MAX_QTY = 1000000;
// The add / edit form's choices. An item saved with something else (from
// before these lists) keeps it as an extra choice. The rules only limit length
// (category ≤ 50, unit 1–20 characters), so changing these needs no rule change.
const INV_CATEGORIES = ["Cables & Wiring", "Connectors", "Major Equipment", "Mounting & Racking", "Grounding Hardware"];
const INV_UNITS = ["pcs", "mtrs"];
const INV_REASONS = {
    create: { label: "Added to inventory", icon: "add_box" },
    restock: { label: "Stock added", icon: "add_circle" },
    use: { label: "Used", icon: "remove_circle" },
    count: { label: "Count corrected", icon: "fact_check" },
};
// The stock panel's three ways to change the count.
const INV_MODES = [
    { key: "use", label: "Use", icon: "remove" },
    { key: "restock", label: "Add stock", icon: "add" },
    { key: "count", label: "Set count", icon: "fact_check" },
];
// "Restock needed" filter on the Inventory tab.
let lowOnly = false;
// Category chip on the Inventory tab: "all", a category, or "" (no category).
let activeCategory = "all";
// True while the add / edit item form is in the detail pane.
let itemFormOpen = false;

const inventoryActions = document.querySelector(".admin-inventory-actions");
const lowFilterButton = inventoryActions.querySelector(".admin-low-filter");
const categoryFilter = document.querySelector(".admin-category-filter");

const qtyOf = (item) => (Number.isInteger(item.qty) ? item.qty : 0);
const unitOf = (item) => item.unit || "pcs";
const qtyText = (item, qty = qtyOf(item)) => `${qty.toLocaleString()} ${unitOf(item)}`;

// "out" (none left), "low" (at or below its restock level) or "ok".
function stockState(item) {
    const qty = qtyOf(item);
    if (qty <= 0) return "out";
    if (item.lowAt > 0 && qty <= item.lowAt) return "low";
    return "ok";
}

const needsRestock = (item) => stockState(item) !== "ok";

function stockStateText(item) {
    const state = stockState(item);
    if (state === "out") return "Out of stock";
    if (state === "low") return `Restock needed · at or below ${item.lowAt.toLocaleString()}`;
    return item.lowAt > 0 ? `In stock · restock at ${item.lowAt.toLocaleString()}` : "In stock";
}

function stockBadge(item) {
    const state = stockState(item);
    if (state === "ok") return null;
    return el("span", `admin-badge ${state === "out" ? "admin-badge-stale" : "admin-badge-warn"}`, state === "out" ? "Out of stock" : "Restock");
}

// Out of stock first, then low, then the rest; by name within each.
function byStock(a, b) {
    const rank = { out: 0, low: 1, ok: 2 };
    return rank[stockState(a)] - rank[stockState(b)] || (a.name || "").localeCompare(b.name || "");
}

const canDeleteItem = (item) => role === "admin" || (item.createdBy || "").toLowerCase() === currentEmail;

function inventoryErrorMessage(err) {
    if (err && err.userMessage) return err.userMessage;
    if (err && (err.code === "permission-denied" || err.code === "storage/unauthorized")) {
        return "Permission denied. Publish the latest /firestore.rules and /storage.rules in the Firebase console, then try again.";
    }
    return "Couldn't save. Check your connection and try again.";
}

// Download links for item photos, fetched once per path and shared by the
// list thumbnails, the pane header and the gallery.
const photoUrls = new Map();

function photoUrl(path) {
    if (!photoUrls.has(path)) {
        const url = loadStorage().then(({ storageSdk, storage }) => storageSdk.getDownloadURL(storageSdk.ref(storage, path)));
        url.catch(() => photoUrls.delete(path));
        photoUrls.set(path, url);
    }
    return photoUrls.get(path);
}

// The square photo beside an item's name (its first photo, or a box icon).
function itemThumb(item) {
    const path = serialList(item.photos)[0];
    const thumb = el("span", path ? "admin-inv-thumb" : "admin-inv-thumb admin-inv-thumb-empty");
    thumb.setAttribute("aria-hidden", "true");
    if (path) {
        thumb.dataset.photo = path;
        const img = el("img");
        img.alt = "";
        img.loading = "lazy";
        thumb.append(img);
        photoUrl(path)
            .then((url) => { img.src = url; })
            .catch(() => thumb.classList.add("admin-inv-thumb-broken"));
    } else {
        thumb.append(el("span", "material-symbols-rounded", "inventory_2"));
    }
    return thumb;
}

// Fills in the thumbnails under `root` (also used on the pane header, which
// is a copy of the list row made before its photo had loaded).
function hydrateThumbs(root) {
    for (const thumb of root.querySelectorAll(".admin-inv-thumb[data-photo]")) {
        const img = thumb.querySelector("img");
        if (!img || img.getAttribute("src")) continue;
        photoUrl(thumb.dataset.photo)
            .then((url) => { img.src = url; })
            .catch(() => thumb.classList.add("admin-inv-thumb-broken"));
    }
}

// The open item's photo, shown like a social media profile: a square photo
// (tap to view full size, with the others) beside the item's name and
// category. No photo yet: a dashed box that opens the edit form.
function itemGallery(item) {
    const paths = serialList(item.photos);
    const profile = el("figure", "admin-inv-profile");
    const avatar = el("button", paths.length ? "admin-inv-avatar" : "admin-inv-avatar admin-inv-avatar-empty");
    avatar.type = "button";
    const info = el("figcaption", "admin-inv-profile-info");
    info.append(el("strong", "admin-inv-profile-name", item.name));
    const sub = [item.category, unitOf(item)].filter(Boolean).join(" · ");
    if (sub) info.append(el("span", "admin-inv-profile-sub", sub));
    profile.append(avatar, info);

    if (!paths.length) {
        avatar.setAttribute("aria-label", "Add a photo");
        avatar.append(el("span", "material-symbols-rounded", "add_a_photo"));
        avatar.addEventListener("click", () => showItemForm(item));
        info.append(el("span", "admin-inv-profile-hint", "No photo yet. Tap the box to add one."));
        return { node: profile, load: () => {} };
    }

    avatar.setAttribute("aria-label", `View photo of ${item.name} full size`);
    const img = el("img");
    img.alt = item.name;
    avatar.append(img);
    let urls = [];
    const open = (i = 0) => {
        const images = urls.map((url, n) => ({ url, name: `${item.name} · photo ${n + 1}` })).filter((x) => x.url);
        if (images.length) openViewer(images, Math.min(i, images.length - 1));
    };
    avatar.addEventListener("click", () => open(0));
    if (paths.length > 1) {
        const more = el("button", "admin-inv-profile-photos");
        more.type = "button";
        more.append(el("span", "material-symbols-rounded", "photo_library"), `${paths.length} photos`);
        more.addEventListener("click", () => open(0));
        info.append(more);
    }
    const load = () => {
        avatar.classList.add("loading");
        Promise.all(paths.map((path) => photoUrl(path).catch(() => ""))).then((list) => {
            urls = list;
            avatar.classList.remove("loading");
            if (urls[0]) img.src = urls[0];
            else avatar.classList.add("broken");
        });
    };
    return { node: profile, load };
}

// Quick − / + on each list row. Taps made close together are added up and
// saved as one change QUICK_SAVE_MS after the last tap: − as "Used", + as
// "Stock added" (no client or note; the full Use / Add stock controls in the
// open item have those). Until it's saved the count shows the new number in
// blue. `quick` holds, per item id, the taps not yet sent (`delta`) and those
// being saved (`saving`).
const QUICK_SAVE_MS = 1500;
const quick = new Map();

function quickState(item) {
    if (!quick.has(item.id)) quick.set(item.id, { delta: 0, saving: 0, timer: 0 });
    return quick.get(item.id);
}

// The count the row shows: saved count plus taps not saved yet.
const quickQty = (item) => qtyOf(item) + quickState(item).saving + quickState(item).delta;

function quickStepper(item) {
    const box = el("span", "admin-inv-quick");
    box.setAttribute("role", "group");
    box.setAttribute("aria-label", `Quick count for ${item.name}`);
    const minus = el("button", "admin-inv-quick-btn");
    minus.type = "button";
    minus.setAttribute("aria-label", `Use one ${item.name}`);
    minus.append(el("span", "material-symbols-rounded", "remove"));
    const count = el("span", "admin-inv-quick-count");
    count.setAttribute("aria-live", "polite");
    const plus = el("button", "admin-inv-quick-btn");
    plus.type = "button";
    plus.setAttribute("aria-label", `Add one ${item.name}`);
    plus.append(el("span", "material-symbols-rounded", "add"));
    box.append(minus, count, plus);

    const draw = () => {
        const st = quickState(item);
        const shown = quickQty(item);
        count.textContent = shown.toLocaleString();
        box.classList.toggle("pending", Boolean(st.delta || st.saving));
        minus.disabled = shown <= 0;
        plus.disabled = shown >= INV_MAX_QTY;
    };
    const tap = (step) => (e) => {
        // Inside the row's <summary>: don't open the item.
        e.preventDefault();
        e.stopPropagation();
        const st = quickState(item);
        const next = quickQty(item) + step;
        if (next < 0 || next > INV_MAX_QTY) return;
        st.delta += step;
        draw();
        clearTimeout(st.timer);
        st.timer = setTimeout(() => saveQuick(item), QUICK_SAVE_MS);
    };
    minus.addEventListener("click", tap(-1));
    plus.addEventListener("click", tap(1));
    // A click between the buttons shouldn't open the item either.
    box.addEventListener("click", (e) => { e.preventDefault(); e.stopPropagation(); });
    draw();
    return box;
}

async function saveQuick(item) {
    const st = quickState(item);
    const delta = st.delta;
    if (!delta) return;
    st.delta = 0;
    st.saving += delta;
    try {
        await changeStock(item, delta < 0 ? "use" : "restock", Math.abs(delta), "", "");
        st.saving -= delta;
        loadError.hidden = true;
        // The list may have been reloaded meanwhile: update its copy too.
        const current = data.inventory.find((i) => i.id === item.id);
        if (current && current !== item) {
            Object.assign(current, { qty: item.qty, lastLogId: item.lastLogId, updatedAt: item.updatedAt, updatedBy: item.updatedBy });
        }
    } catch (err) {
        st.saving -= delta;
        console.error("Admin: quick count change failed", err);
        loadError.textContent = `Couldn't save the change to ${item.name} (${delta > 0 ? "+" : ""}${delta}). ${inventoryErrorMessage(err)}`;
        loadError.hidden = false;
    }
    redrawInventory(item);
}

// Closing or reloading the page before a quick tap or a stock panel change
// has saved would lose it:
// save what's waiting straight away and ask the browser to confirm leaving.
window.addEventListener("beforeunload", (e) => {
    let waiting = false;
    for (const [id, st] of quick) {
        if (st.delta) {
            clearTimeout(st.timer);
            const item = data.inventory.find((i) => i.id === id);
            if (item) saveQuick(item);
        }
        if (st.delta || st.saving) waiting = true;
    }
    for (const flush of [...panelFlushes]) {
        flush();
        waiting = true;
    }
    if (waiting) e.preventDefault();
});

// Re-draws after a count change (quick − / + or the item's stock panel)
// without opening or scrolling to anything:
// the list (keeping open rows open on phones), the counts and filter, and the
// open item or the installer's home if they're showing.
function redrawInventory(item) {
    const openIds = [...document.querySelectorAll('[data-list="inventory"] .admin-entry[open]')].map((d) => d.dataset.id);
    data.inventory.sort(byStock);
    renderStats();
    renderList();
    for (const id of openIds) {
        const node = document.querySelector(`[data-list="inventory"] [data-id="${CSS.escape(id)}"]`);
        if (node) node.open = true;
    }
    if (selected && selected.tab === "inventory" && selected.id === item.id && !formOpen) showEntry("inventory", item.id);
    else if (inventoryHomeShown()) showInventoryHome();
}

function renderInventoryItem(item) {
    const meta = [qtyText(item), item.category].filter(Boolean).join(" · ");
    const details = entryShell(item.name, meta, toDate(item.updatedAt) || toDate(item.createdAt));
    details.classList.add("admin-inv-entry", `admin-inv-entry-${stockState(item)}`);
    const summary = details.querySelector("summary");
    // The Restock / Out of stock tag goes on its own line under the count, so
    // the name keeps the full width.
    const badge = stockBadge(item);
    if (badge) {
        const tagLine = el("span", "admin-inv-tagline");
        tagLine.append(badge);
        summary.querySelector(".admin-entry-main").append(tagLine);
    }
    summary.prepend(itemThumb(item));
    summary.insertBefore(quickStepper(item), summary.querySelector(".admin-entry-date"));

    const actions = el("div", "admin-actions admin-install-entry-actions");
    const error = el("span", "admin-action-error");
    const edit = el("button", "admin-action");
    edit.type = "button";
    edit.append(el("span", "material-symbols-rounded", "edit"), "Edit item");
    edit.addEventListener("click", () => showItemForm(item));
    actions.append(error, edit);
    if (canDeleteItem(item)) {
        const remove = el("button", "admin-action admin-action-danger");
        remove.type = "button";
        remove.append(el("span", "material-symbols-rounded", "delete"), "Delete");
        remove.addEventListener("click", async () => {
            if (!confirm(`Delete ${item.name} from the inventory? Its photos are deleted too. Its history stays on record. This can't be undone.`)) return;
            remove.disabled = true;
            error.textContent = "";
            try {
                await deleteItem(item);
                selected = null;
                await loadSubmissions();
                closeEntry();
            } catch (err) {
                console.error("Admin: deleting inventory item failed", err);
                error.textContent = inventoryErrorMessage(err);
                remove.disabled = false;
            }
        });
        actions.append(remove);
    }

    const body = el("div", "admin-inv");
    const gallery = itemGallery(item);
    body.append(gallery.node, stockPanel(item));

    const list = el("dl", "admin-details");
    list.append(
        detailRow("Category", item.category),
        detailRow("Unit", unitOf(item)),
        detailRow("Restock level", item.lowAt > 0 ? `At or below ${qtyText(item, item.lowAt)}` : "No warning set"),
        detailRow("Note", item.note, { wide: true }),
        detailRow("Added", `${formatDate(toDate(item.createdAt))}${item.createdBy ? ` by ${item.createdBy}` : ""}`, { wide: true }),
        detailRow("Last updated", `${formatDate(toDate(item.updatedAt))}${item.updatedBy ? ` by ${item.updatedBy}` : ""}`, { wide: true }),
    );
    body.append(list);

    const history = el("section", "admin-inv-history");
    const historyList = el("ol", "admin-inv-log");
    history.append(el("h3", "admin-ck-section-title", "History"), historyList);
    body.append(history);

    details.append(actions, body);
    // Photos and history load the first time the entry is opened.
    let loaded = false;
    details.addEventListener("toggle", () => {
        if (!details.open || loaded) return;
        loaded = true;
        gallery.load();
        loadItemHistory(item, historyList);
    });
    return details;
}

// The count and the Use / Add stock / Set count controls. There's no save
// button: a change saves itself PANEL_SAVE_MS after the last tap or keystroke
// (a "Saving in a moment… Cancel" line shows meanwhile). It waits while the
// "Used for" or note field is being typed in, and saves once you leave the
// field (or press Enter). Use and Add stock start at 0, so nothing is saved
// until you choose an amount; Set count starts at the current count.
const PANEL_SAVE_MS = 1500;
// The mode each item's panel was last in, so it stays put after a save.
const panelModes = new Map();
// Saves waiting in open panels, run straight away if the page is closed.
const panelFlushes = new Set();

function stockPanel(item) {
    const panel = el("section", `admin-inv-stock admin-inv-stock-${stockState(item)}`);
    const top = el("div", "admin-inv-top");
    const count = el("div", "admin-inv-count");
    count.append(el("span", "admin-inv-qty", qtyOf(item).toLocaleString()), el("span", "admin-inv-unit", unitOf(item)));
    const state = el("span", "admin-inv-state");
    state.append(el("span", "admin-inv-state-dot"), stockStateText(item));
    top.append(count, state);

    let mode = panelModes.get(item.id) || "use";
    const startAmount = () => (mode === "count" ? String(qtyOf(item)) : "0");
    const modes = el("div", "admin-inv-modes");
    modes.setAttribute("role", "group");
    modes.setAttribute("aria-label", "Change the count");
    const modeButtons = INV_MODES.map((m) => {
        const button = el("button", "admin-inv-mode");
        button.type = "button";
        button.dataset.mode = m.key;
        button.append(el("span", "material-symbols-rounded", m.icon), m.label);
        button.addEventListener("click", () => {
            if (mode === m.key) return;
            // Switching drops a change that hasn't saved yet.
            cancelPending();
            mode = m.key;
            panelModes.set(item.id, mode);
            amount.value = startAmount();
            update();
        });
        modes.append(button);
        return button;
    });

    // − [n] +
    const stepper = el("div", "admin-inv-stepper");
    const minus = el("button", "admin-inv-step");
    minus.type = "button";
    minus.setAttribute("aria-label", "One less");
    minus.append(el("span", "material-symbols-rounded", "remove"));
    const amount = el("input", "admin-inv-amount");
    amount.type = "number";
    amount.inputMode = "numeric";
    amount.min = "0";
    amount.max = String(INV_MAX_QTY);
    amount.step = "1";
    amount.value = startAmount();
    const plus = el("button", "admin-inv-step");
    plus.type = "button";
    plus.setAttribute("aria-label", "One more");
    plus.append(el("span", "material-symbols-rounded", "add"));
    stepper.append(minus, amount, plus);
    const preview = el("div", "admin-inv-preview");
    const stepRow = el("div", "admin-inv-steprow");
    stepRow.append(stepper, preview);

    // Use: which job it's for (suggests clients from Ocular Visits).
    const jobWrap = el("label", "admin-field admin-inv-field");
    const job = el("input");
    job.type = "text";
    job.maxLength = 150;
    job.placeholder = "Client or job (optional)";
    const jobs = el("datalist");
    jobs.id = `inv-jobs-${item.id}`;
    const names = [...new Set(data.visits.map((v) => v.name).filter(Boolean))].slice(0, 300);
    jobs.append(...names.map((name) => { const o = el("option"); o.value = name; return o; }));
    job.setAttribute("list", jobs.id);
    jobWrap.append(el("span", "admin-label", "Used for"), job, jobs);

    const noteWrap = el("label", "admin-field admin-inv-field");
    const note = el("input");
    note.type = "text";
    note.maxLength = 300;
    note.placeholder = "Note (optional)";
    noteWrap.append(el("span", "admin-label", "Note"), note);

    // "Saving in a moment… Cancel" / "Saving…" / "Saved" / an error.
    const status = el("p", "admin-inv-autosave");
    status.setAttribute("role", "status");
    const statusText = el("span", "admin-inv-autosave-text");
    const cancel = el("button", "admin-inv-autosave-cancel");
    cancel.type = "button";
    cancel.textContent = "Cancel";
    status.append(statusText, cancel);
    const say = (text, tone = "", canCancel = false) => {
        statusText.textContent = text;
        status.dataset.tone = tone;
        cancel.hidden = !canCancel;
    };

    const read = () => {
        const n = Number(amount.value);
        return amount.value.trim() !== "" && Number.isInteger(n) ? n : NaN;
    };
    // What's wrong with the chosen amount, "" if it can be saved, or null if
    // nothing has been chosen yet (0 to use or add, or the count unchanged).
    function problemWith(n) {
        const qty = qtyOf(item);
        if (!Number.isInteger(n) || n < 0) return "Enter a whole number.";
        if (mode !== "count" && n === 0) return null;
        if (mode === "count" && n === qty) return null;
        const next = mode === "use" ? qty - n : mode === "restock" ? qty + n : n;
        if (mode === "use" && n > qty) return qty ? `Only ${qtyText(item)} left.` : "None left to use.";
        if (next > INV_MAX_QTY) return "That's more than the limit.";
        return "";
    }

    function update() {
        const qty = qtyOf(item);
        const n = read();
        modeButtons.forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.mode === mode)));
        jobWrap.hidden = mode !== "use";
        const problem = problemWith(n);
        preview.replaceChildren();
        if (problem) preview.append(el("span", "admin-inv-preview-bad", problem));
        else if (problem === null) {
            preview.append(el("span", "", mode === "count"
                ? "Change the number to correct the count"
                : mode === "use" ? "Tap + for how many were used" : "Tap + for how many were added"));
        } else {
            const next = mode === "use" ? qty - n : mode === "restock" ? qty + n : n;
            preview.append(
                el("span", "", qty.toLocaleString()),
                el("span", "material-symbols-rounded", "arrow_forward"),
                el("strong", "", qtyText(item, next)),
            );
            if (item.lowAt > 0 && next <= item.lowAt) preview.append(el("span", "admin-badge admin-badge-warn", next <= 0 ? "Out of stock" : "Restock"));
        }
        minus.disabled = !(n > 0);
        plus.disabled = mode === "use" && n >= qty;
    }

    // ---- saving
    let timer = 0;
    let saving = false;
    const typing = () => document.activeElement === job || document.activeElement === note;

    function cancelPending() {
        clearTimeout(timer);
        timer = 0;
        panelFlushes.delete(flush);
        if (!saving) say("");
    }

    // Called after every change: saves after a pause, unless there's nothing
    // to save or a text field is still being typed in.
    function schedule() {
        clearTimeout(timer);
        timer = 0;
        if (saving) return;
        const problem = problemWith(read());
        if (problem !== "") {
            panelFlushes.delete(flush);
            say("");
            return;
        }
        panelFlushes.add(flush);
        if (typing()) {
            say("Saves when you finish typing", "wait", true);
            return;
        }
        say("Saving in a moment…", "wait", true);
        timer = setTimeout(flush, PANEL_SAVE_MS);
    }

    async function flush() {
        clearTimeout(timer);
        timer = 0;
        panelFlushes.delete(flush);
        const n = read();
        if (saving || problemWith(n) !== "") return;
        saving = true;
        say("Saving…", "busy");
        [amount, minus, plus, job, note, ...modeButtons].forEach((node) => { node.disabled = true; });
        try {
            await changeStock(item, mode, n, mode === "use" ? job.value.trim() : "", note.value.trim());
            say("Saved", "ok");
            // Re-draws the item (a fresh panel, in the same mode) and the list.
            setTimeout(() => redrawInventory(item), 600);
        } catch (err) {
            console.error("Admin: changing stock failed", err);
            saving = false;
            [amount, job, note, ...modeButtons].forEach((node) => { node.disabled = false; });
            update();
            say(inventoryErrorMessage(err), "error");
        }
    }

    const changed = () => { update(); schedule(); };
    minus.addEventListener("click", () => { amount.value = String(Math.max(0, (read() || 0) - 1)); changed(); });
    plus.addEventListener("click", () => { amount.value = String(Math.min(INV_MAX_QTY, (read() || 0) + 1)); changed(); });
    amount.addEventListener("input", changed);
    amount.addEventListener("focus", () => amount.select());
    for (const field of [job, note]) {
        field.addEventListener("input", schedule);
        field.addEventListener("blur", () => setTimeout(schedule, 0));
        field.addEventListener("keydown", (e) => {
            if (e.key === "Enter") {
                e.preventDefault();
                field.blur();
            }
        });
    }
    cancel.addEventListener("click", () => {
        cancelPending();
        amount.value = startAmount();
        update();
        say("Cancelled — nothing was saved");
    });

    panel.append(top, modes, stepRow, jobWrap, noteWrap, status);
    update();
    say("");
    return panel;
}

// Changes the count and records why, in one transaction (so two people
// changing it at once can't lose an update).
async function changeStock(item, reason, amount, job, note) {
    const itemRef = firestore.doc(db, "inventory", item.id);
    const logRef = firestore.doc(firestore.collection(db, "inventoryLog"));
    const { after } = await firestore.runTransaction(db, async (tx) => {
        const snap = await tx.get(itemRef);
        if (!snap.exists()) throw userError("This item was deleted. Refresh the list.");
        const current = snap.data();
        const before = Number.isInteger(current.qty) ? current.qty : 0;
        const next = reason === "use" ? before - amount : reason === "restock" ? before + amount : amount;
        if (next < 0) throw userError(`Only ${before.toLocaleString()} ${current.unit || "pcs"} left (someone may have just used some).`);
        if (next === before) throw userError("That's already the count.");
        if (next > INV_MAX_QTY) throw userError("That's more than the limit.");
        tx.update(itemRef, {
            qty: next,
            lastLogId: logRef.id,
            updatedAt: firestore.serverTimestamp(),
            updatedBy: currentEmail,
        });
        tx.set(logRef, {
            itemId: item.id,
            itemName: current.name,
            reason,
            change: next - before,
            qtyBefore: before,
            qtyAfter: next,
            job,
            note,
            at: firestore.serverTimestamp(),
            by: currentEmail,
        });
        return { after: next };
    });
    Object.assign(item, { qty: after, lastLogId: logRef.id, updatedAt: { toDate: () => new Date() }, updatedBy: currentEmail });
}

async function loadItemHistory(item, list) {
    list.replaceChildren(el("li", "admin-empty", "Loading…"));
    try {
        // Filtered by item only (no orderBy), so no composite index is needed.
        const snapshot = await firestore.getDocs(firestore.query(
            firestore.collection(db, "inventoryLog"),
            firestore.where("itemId", "==", item.id),
            firestore.limit(200),
        ));
        const rows = snapshot.docs.map((doc) => doc.data())
            .sort((a, b) => (toDate(b.at) || 0) - (toDate(a.at) || 0))
            .slice(0, 30);
        if (!rows.length) {
            list.replaceChildren(el("li", "admin-empty", "No changes recorded yet."));
            return;
        }
        list.replaceChildren(...rows.map((log) => {
            const info = INV_REASONS[log.reason] || { label: log.reason, icon: "history" };
            const li = el("li", `admin-inv-log-row admin-inv-log-${log.change < 0 ? "down" : "up"}`);
            li.append(el("span", "material-symbols-rounded admin-inv-log-icon", info.icon));
            const main = el("div", "admin-inv-log-main");
            const line = el("div", "admin-inv-log-line");
            line.append(el("strong", "", info.label), el("span", "", log.job ? ` for ${log.job}` : ""));
            main.append(line);
            main.append(el("div", "admin-inv-log-meta", [formatDate(toDate(log.at)), log.by].filter(Boolean).join(" · ")));
            if (log.note) main.append(el("div", "admin-inv-log-note", log.note));
            const change = el("div", "admin-inv-log-change");
            change.append(
                el("strong", "", `${log.change > 0 ? "+" : ""}${(log.change || 0).toLocaleString()}`),
                el("span", "", `${(log.qtyBefore || 0).toLocaleString()} → ${(log.qtyAfter || 0).toLocaleString()}`),
            );
            li.append(main, change);
            return li;
        }));
    } catch (err) {
        console.error("Admin: loading inventory history failed", err);
        list.replaceChildren(el("li", "admin-muted", err.code === "permission-denied"
            ? "Couldn't load the history. Publish the latest /firestore.rules in the Firebase console."
            : "Couldn't load the history."));
    }
}

// The add / edit form in the detail pane (top of the page on phones).
function showItemForm(item) {
    formOpen = true;
    itemFormOpen = true;
    selected = item ? { tab: "inventory", id: item.id } : null;
    setBackButton();
    detailPane.querySelector(".admin-detail-kind").textContent = item ? "Edit item" : "New item";
    const main = el("div", "admin-entry-main");
    main.append(
        el("span", "admin-entry-title", item ? item.name : "Add an item"),
        el("span", "admin-entry-meta", item
            ? "Change the details or photos, then save. Change the count from the item's Use / Add stock / Set count controls."
            : "Name it, set the starting count and when to warn for a restock, and add a photo."),
    );
    detailPane.querySelector(".admin-detail-title").replaceChildren(main);
    detailPane.querySelector(".admin-detail-body").replaceChildren(itemForm(item));
    overview.hidden = true;
    detailPane.hidden = false;
    mainArea.scrollTop = 0;
    if (!desktop.matches) detailPane.scrollIntoView({ block: "start" });
    markSelected();
}

function itemForm(item) {
    const form = el("form", "admin-install-form admin-inv-form");
    form.noValidate = true;
    const grid = el("div", "admin-install-grid");
    const field = (label, input, { wide, hint } = {}) => {
        const wrap = el("label", wide ? "admin-field admin-install-wide" : "admin-field");
        wrap.append(el("span", "admin-label", label), input);
        if (hint) wrap.append(el("span", "admin-serial-summary", hint));
        grid.append(wrap);
        return input;
    };
    const input = (type, value, attrs = {}) => {
        const node = el("input");
        node.type = type;
        node.value = value;
        Object.assign(node, attrs);
        return node;
    };

    const name = field("Item name *", input("text", item ? item.name : "", { maxLength: 100, required: true, placeholder: "e.g. MC4 connector pair" }), { wide: true });
    // Dropdowns; an older value not in the list stays selectable.
    const select = (values, current, placeholder) => {
        const node = el("select", "admin-select");
        if (placeholder) {
            const none = el("option", "", placeholder);
            none.value = "";
            none.disabled = true;
            node.append(none);
        }
        for (const value of current && !values.includes(current) ? [...values, current] : values) {
            const option = el("option", "", value);
            option.value = value;
            node.append(option);
        }
        node.value = current || "";
        return node;
    };
    const category = field("Category *", select(INV_CATEGORIES, item ? item.category || "" : "", "Choose a category"));
    const unit = field("Unit", select(INV_UNITS, item ? unitOf(item) : "pcs"));
    const qty = item ? null : field("Starting count *", input("number", "0", { min: 0, max: INV_MAX_QTY, step: 1, inputMode: "numeric" }));
    const lowAt = field("Warn to restock at or below", input("number", item && item.lowAt ? String(item.lowAt) : "", { min: 0, max: INV_MAX_QTY, step: 1, inputMode: "numeric", placeholder: "e.g. 5" }), { hint: "Leave blank for no warning (it still warns when none are left)." });
    const note = field("Note", el("textarea"), { wide: true });
    note.rows = 3;
    note.maxLength = 500;
    note.value = item ? item.note || "" : "";
    note.placeholder = "Where it's kept, supplier, size… (optional)";

    // Photos: keep / remove saved ones, add new ones (camera or library).
    const kept = item ? [...serialList(item.photos)] : [];
    const added = [];
    const photoBox = el("div", "admin-field admin-install-wide");
    const thumbs = el("ul", "admin-attachment-grid admin-ck-photos admin-inv-form-photos");
    const picker = el("input");
    picker.type = "file";
    picker.accept = "image/*";
    picker.multiple = true;
    picker.hidden = true;
    const addPhoto = el("button", "admin-ck-tool admin-ck-tool-main");
    addPhoto.type = "button";
    addPhoto.append(el("span", "material-symbols-rounded", "photo_camera"), "Add photo");
    addPhoto.addEventListener("click", () => picker.click());
    const photoNote = el("span", "admin-serial-summary");
    photoBox.append(el("span", "admin-label", "Photos"), thumbs, addPhoto, photoNote, picker);
    grid.append(photoBox);

    const thumb = (src, onRemove) => {
        const li = el("li");
        const frame = el("span", "admin-thumb admin-ck-photo");
        const img = el("img");
        img.alt = "Photo";
        img.addEventListener("error", () => frame.classList.add("admin-ck-photo-broken"));
        if (typeof src === "string") img.src = src;
        else src.then((url) => { img.src = url; }).catch(() => frame.classList.add("admin-ck-photo-broken"));
        frame.append(img);
        const x = el("button", "admin-ck-photo-remove");
        x.type = "button";
        x.setAttribute("aria-label", "Remove photo");
        x.append(el("span", "material-symbols-rounded", "close"));
        x.addEventListener("click", onRemove);
        li.append(frame, x);
        return li;
    };
    const savedUrls = new Map();
    const savedUrl = (path) => {
        if (!savedUrls.has(path)) {
            savedUrls.set(path, loadStorage().then(({ storageSdk, storage }) => storageSdk.getDownloadURL(storageSdk.ref(storage, path))));
        }
        return savedUrls.get(path);
    };
    function drawPhotos() {
        thumbs.replaceChildren(
            ...kept.map((path, i) => thumb(savedUrl(path), () => { kept.splice(i, 1); drawPhotos(); })),
            ...added.map((entry, i) => thumb(entry.url, () => { URL.revokeObjectURL(entry.url); added.splice(i, 1); drawPhotos(); })),
        );
        const total = kept.length + added.length;
        addPhoto.hidden = total >= INV_MAX_PHOTOS;
        photoNote.textContent = total ? `${total} of ${INV_MAX_PHOTOS} photos` : `Up to ${INV_MAX_PHOTOS} photos, so everyone knows exactly which item it is.`;
    }
    picker.addEventListener("change", () => {
        for (const file of picker.files) {
            if (kept.length + added.length >= INV_MAX_PHOTOS) break;
            if (!/^image\//i.test(fileType(file))) continue;
            added.push({ file, url: URL.createObjectURL(file) });
        }
        picker.value = "";
        drawPhotos();
    });
    drawPhotos();

    const actions = el("div", "admin-install-form-actions");
    const error = el("p", "admin-error admin-install-error");
    error.setAttribute("role", "alert");
    const cancel = el("button", "admin-action");
    cancel.type = "button";
    cancel.textContent = "Cancel";
    cancel.addEventListener("click", () => {
        if (item) showEntry("inventory", item.id);
        else closeEntry();
    });
    const submit = el("button", "admin-action admin-action-primary");
    submit.type = "submit";
    submit.append(el("span", "material-symbols-rounded", "save"), item ? "Save changes" : "Add item");
    // Add item (or Save changes) on the left, Cancel on the right, equal widths.
    actions.classList.add("admin-inv-form-actions");
    actions.append(error, submit, cancel);
    form.append(grid, actions);

    form.addEventListener("submit", async (e) => {
        e.preventDefault();
        error.textContent = "";
        const wholeNumber = (node, blank) => {
            const text = node.value.trim();
            if (!text) return blank;
            const n = Number(text);
            return Number.isInteger(n) && n >= 0 && n <= INV_MAX_QTY ? n : NaN;
        };
        const values = {
            name: name.value.trim(),
            category: category.value.trim(),
            unit: unit.value.trim() || "pcs",
            lowAt: wholeNumber(lowAt, 0),
            note: note.value.trim(),
        };
        const startQty = qty ? wholeNumber(qty, 0) : null;
        if (!values.name) { error.textContent = "Enter the item's name."; name.focus(); return; }
        if (!values.category) { error.textContent = "Choose a category."; category.focus(); return; }
        if (Number.isNaN(startQty)) { error.textContent = "The starting count must be a whole number."; qty.focus(); return; }
        if (Number.isNaN(values.lowAt)) { error.textContent = "The restock level must be a whole number."; lowAt.focus(); return; }
        const duplicate = data.inventory.find((i) => i.id !== (item && item.id) && (i.name || "").trim().toLowerCase() === values.name.toLowerCase());
        if (duplicate && !confirm(`There's already an item called ${duplicate.name}. Add another one anyway?`)) return;
        submit.disabled = true;
        cancel.disabled = true;
        try {
            const id = await saveItem(item, values, startQty, kept, added.map((a) => a.file));
            added.forEach((a) => URL.revokeObjectURL(a.url));
            itemFormOpen = false;
            formOpen = false;
            selected = { tab: "inventory", id };
            await loadSubmissions();
        } catch (err) {
            console.error("Admin: saving inventory item failed", err);
            error.textContent = inventoryErrorMessage(err);
            submit.disabled = false;
            cancel.disabled = false;
        }
    });
    return form;
}

// Uploads the new photos, then saves the item (and, for a new one, its
// starting count's history record) and deletes photos that were removed.
async function saveItem(existing, values, startQty, kept, files) {
    const itemRef = existing
        ? firestore.doc(db, "inventory", existing.id)
        : firestore.doc(firestore.collection(db, "inventory"));
    const uploaded = [];
    if (files.length) {
        const { storageSdk, storage } = await loadStorage();
        let n = 0;
        for (const file of files) {
            const prepared = await shrinkImage(file);
            if (prepared.size > MAX_FILE_BYTES) throw userError(`${file.name} is over 10 MB.`);
            const path = `inventory/${itemRef.id}/${Date.now()}-${++n}-${safeFileName(prepared.name)}`;
            await storageSdk.uploadBytes(storageSdk.ref(storage, path), prepared, { contentType: fileType(prepared) || "image/jpeg" });
            uploaded.push(path);
        }
    }
    const photos = [...kept, ...uploaded];
    if (existing) {
        await firestore.updateDoc(itemRef, {
            ...values,
            photos,
            updatedAt: firestore.serverTimestamp(),
            updatedBy: currentEmail,
        });
        const removed = serialList(existing.photos).filter((path) => !kept.includes(path));
        if (removed.length) {
            const { storageSdk, storage } = await loadStorage();
            await Promise.all(removed.map((path) => storageSdk.deleteObject(storageSdk.ref(storage, path)).catch((err) => {
                if (err.code !== "storage/object-not-found") console.warn("Admin: couldn't delete item photo", path, err);
            })));
        }
    } else {
        const logRef = firestore.doc(firestore.collection(db, "inventoryLog"));
        const batch = firestore.writeBatch(db);
        batch.set(itemRef, {
            ...values,
            qty: startQty,
            photos,
            lastLogId: logRef.id,
            createdAt: firestore.serverTimestamp(),
            createdBy: currentEmail,
            updatedAt: firestore.serverTimestamp(),
            updatedBy: currentEmail,
        });
        batch.set(logRef, {
            itemId: itemRef.id,
            itemName: values.name,
            reason: "create",
            change: startQty,
            qtyBefore: 0,
            qtyAfter: startQty,
            job: "",
            note: "",
            at: firestore.serverTimestamp(),
            by: currentEmail,
        });
        await batch.commit();
    }
    return itemRef.id;
}

async function deleteItem(item) {
    await firestore.deleteDoc(firestore.doc(db, "inventory", item.id));
    const paths = serialList(item.photos);
    if (paths.length) {
        const { storageSdk, storage } = await loadStorage();
        await Promise.all(paths.map((path) => storageSdk.deleteObject(storageSdk.ref(storage, path)).catch((err) => {
            if (err.code !== "storage/object-not-found") console.warn("Admin: couldn't delete item photo", path, err);
        })));
    }
}

// Stock on hand: item / running-low / out-of-stock tiles and the restock
// list. Shown as the installer's home on the Inventory tab, and in the admin
// overview's Inventory box. `onOpen(item)` opens a restock row's item.
function inventorySummary(onOpen) {
    const items = data.inventory;
    const low = items.filter(needsRestock);
    const home = el("div", "admin-inv-home");
    const tiles = el("div", "admin-inv-tiles");
    const tile = (value, label, tone) => {
        const t = el("div", `admin-inv-tile${tone ? ` admin-inv-tile-${tone}` : ""}`);
        t.append(el("span", "admin-inv-tile-value", String(value)), el("span", "admin-inv-tile-label", label));
        return t;
    };
    tiles.append(
        tile(items.length, "Items"),
        tile(low.filter((i) => stockState(i) === "low").length, "Running low", low.some((i) => stockState(i) === "low") ? "low" : ""),
        tile(low.filter((i) => stockState(i) === "out").length, "Out of stock", low.some((i) => stockState(i) === "out") ? "out" : ""),
    );
    // "Add item" is in the sidebar of the Inventory tab, next to "Restock needed".
    home.append(tiles);

    if (low.length) {
        const section = el("section", "admin-inv-restock");
        section.append(el("h3", "admin-ck-section-title", "Restock needed"));
        const list = el("ul", "admin-inv-restock-list");
        list.append(...low.map((item) => {
            const li = el("li");
            const button = el("button", `admin-inv-restock-row admin-inv-restock-${stockState(item)}`);
            button.type = "button";
            const info = el("span", "admin-inv-restock-info");
            info.append(el("strong", "", item.name), el("span", "", item.lowAt > 0 ? `Restock at ${item.lowAt.toLocaleString()}` : "Restock"));
            button.append(info, el("span", "admin-inv-restock-qty", qtyText(item)), el("span", "material-symbols-rounded", "chevron_right"));
            button.addEventListener("click", () => onOpen(item));
            li.append(button);
            return li;
        }));
        section.append(list);
        home.append(section);
    } else if (items.length) {
        home.append(el("p", "admin-ck-intro", "Everything is above its restock level. Open an item in the list to use some, add stock or correct the count."));
    } else {
        home.append(el("p", "admin-ck-intro", "No items yet. Add the parts and tools you keep in stock, with a photo and the count you have, and set when to warn for a restock."));
    }
    return home;
}

// The admin overview's Inventory box (the same summary, opening an item on
// the Inventory tab).
function renderInventoryOverview() {
    const box = document.querySelector(".admin-inventory-box");
    if (role !== "admin") {
        box.hidden = true;
        return;
    }
    box.hidden = false;
    const low = data.inventory.filter(needsRestock).length;
    box.querySelector(".admin-inventory-box-hint").textContent = data.inventory.length
        ? `${plural(data.inventory.length, ["item", "items"])} · ${low ? `${low} need restocking` : "nothing to restock"}`
        : "";
    box.querySelector(".admin-inventory-box-body").replaceChildren(inventorySummary((item) => {
        selectTab("inventory");
        openInventoryItem(item.id);
    }));
}

// True while the right-hand pane shows "Stock on hand".
const inventoryHomeShown = () => !detailPane.hidden && Boolean(detailPane.querySelector(".admin-detail-body > .admin-inv-home"));

// The installer's pane on the Inventory tab (and admins' on desktop, when no
// item is open): totals and what needs
// restocking.
function showInventoryHome() {
    formOpen = true;
    itemFormOpen = false;
    selected = null;
    setBackButton({ hidden: true });
    const items = data.inventory;
    const low = items.filter(needsRestock);
    detailPane.querySelector(".admin-detail-kind").textContent = "Inventory";
    const main = el("div", "admin-entry-main");
    main.append(
        el("span", "admin-entry-title", "Stock on hand"),
        el("span", "admin-entry-meta", `${plural(items.length, ["item", "items"])} · ${low.length ? `${low.length} need restocking` : "nothing to restock"}`),
    );
    detailPane.querySelector(".admin-detail-title").replaceChildren(main);

    detailPane.querySelector(".admin-detail-body").replaceChildren(inventorySummary((item) => openInventoryItem(item.id)));
    overview.hidden = true;
    detailPane.hidden = false;
    mainArea.scrollTop = 0;
    markSelected();
}

// Opens an item: in the pane on desktop, in place in the list on phones.
function openInventoryItem(id) {
    if (desktop.matches) {
        showEntry("inventory", id);
        return;
    }
    const node = document.querySelector(`[data-list="inventory"] [data-id="${CSS.escape(id)}"]`);
    if (node) {
        node.open = true;
        node.scrollIntoView({ block: "start", behavior: "smooth" });
    }
}

function renderLowFilter() {
    const low = data.inventory.filter(needsRestock).length;
    lowFilterButton.setAttribute("aria-pressed", String(lowOnly));
    lowFilterButton.classList.toggle("admin-low-filter-alert", low > 0);
    lowFilterButton.querySelector(".admin-low-filter-text").textContent = `Restock needed (${low})`;
}

// The category dropdown: All categories, then INV_CATEGORIES, then any other
// category still on an item (from before the list), and "No category" if any,
// each with its item count.
function renderCategoryFilter() {
    const counts = new Map();
    for (const item of data.inventory) counts.set(item.category || "", (counts.get(item.category || "") || 0) + 1);
    const extra = [...counts.keys()].filter((c) => c && !INV_CATEGORIES.includes(c)).sort();
    const keys = ["all", ...INV_CATEGORIES, ...extra, ...(counts.has("") ? [""] : [])];
    // A chosen category that no longer exists goes back to All.
    if (!keys.includes(activeCategory)) activeCategory = "all";
    categoryFilter.replaceChildren(...keys.map((key) => {
        const n = key === "all" ? data.inventory.length : counts.get(key) || 0;
        const option = el("option", "", `${key === "all" ? "All categories" : key || "No category"} (${n})`);
        option.value = key;
        return option;
    }));
    categoryFilter.value = activeCategory;
}

// The Inventory list with all categories shown: one section per category,
// in the dropdown's order, each under a heading with its item count (and how
// many need restocking). Within a section the list's order holds: out of
// stock, then running low, then the rest, by name.
function categoryOrder(category) {
    const i = INV_CATEGORIES.indexOf(category);
    return i >= 0 ? i : category ? INV_CATEGORIES.length : INV_CATEGORIES.length + 1;
}

function groupedInventory(entries) {
    const groups = new Map();
    for (const item of entries) {
        const key = item.category || "";
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(item);
    }
    const keys = [...groups.keys()].sort((a, b) => categoryOrder(a) - categoryOrder(b) || a.localeCompare(b));
    return keys.flatMap((key) => {
        const items = groups.get(key);
        const low = items.filter(needsRestock).length;
        const head = el("div", "admin-inv-group");
        head.append(el("span", "admin-inv-group-name", key || "No category"), el("span", "admin-inv-group-count", String(items.length)));
        if (low) head.append(el("span", "admin-inv-group-low", `${low} to restock`));
        return [head, ...items.map((item) => renderEntry("inventory", item))];
    });
}

categoryFilter.addEventListener("change", () => {
    activeCategory = categoryFilter.value;
    renderList();
});

lowFilterButton.addEventListener("click", () => {
    lowOnly = !lowOnly;
    renderLowFilter();
    renderList();
});

inventoryActions.querySelector(".admin-add-item").addEventListener("click", () => showItemForm(null));


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
    setView("list");
    listTitle.textContent = tabLabel(name);
    // Desktop admins: the right-hand pane shows "Select an entry" until one is
    // opened (the overview has its own item in the navigation).
    if (role === "admin" && desktop.matches) {
        if (name === "inventory" && !selected && (!formOpen || inventoryHomeShown())) showInventoryHome();
        else if (inventoryHomeShown()) closeEntry();
        else if (!selected && !formOpen) overview.hidden = true;
    }
    document.querySelectorAll(".admin-tab").forEach((t) => {
        const active = t.dataset.tab === name;
        t.classList.toggle("active", active);
        t.setAttribute("aria-selected", String(active));
    });
    document.querySelectorAll(".admin-list").forEach((list) => {
        list.hidden = list.dataset.list !== name;
    });
    markMenuTab();
    productFilter.hidden = name !== "waitlist";
    sourceFilter.hidden = name !== "visits";
    categoryFilter.hidden = name !== "inventory";
    installActions.hidden = name !== "installs";
    visitActions.hidden = name !== "visits" || role !== "admin";
    checklistActions.hidden = !CHECKLIST_TYPES.includes(name);
    inventoryActions.hidden = name !== "inventory";
    updateStatusFilter();
    renderList();
    // The installer's right-hand pane follows the tab: the picker for it, or
    // the stock summary.
    if (role === "installer" && CHECKLIST_TYPES.includes(name)) showChecklistStart(name);
    else if (role === "installer" && name === "inventory") showInventoryHome();
}

checklistActions.querySelector(".admin-start-checklist").addEventListener("click", () => {
    if (CHECKLIST_TYPES.includes(activeTab)) showChecklistStart(activeTab);
});

updateStatusFilter();

document.querySelectorAll(".admin-tab").forEach((tab) => {
    tab.addEventListener("click", () => {
        selectTab(tab.dataset.tab);
        // On phones (tabs are in the menu), start the new list at the top.
        if (!desktop.matches) window.scrollTo({ top: 0 });
    });
});

search.addEventListener("input", renderList);
statusFilter.addEventListener("change", renderList);
sourceFilter.addEventListener("change", renderList);
