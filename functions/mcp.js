// Claude connector: a read-only remote MCP server over the admin data, so
// claude.ai can answer things like "any new visit requests this week?".
//
// Stateless Streamable HTTP (a new McpServer per request, JSON responses, POST
// only). Access is one secret, MCP_ACCESS_KEY (`firebase functions:secrets:set
// MCP_ACCESS_KEY`, never in the repo), given as the first path segment
// (https://<function url>/<key>) or as `Authorization: Bearer <key>`. Anything
// else gets a plain 404.
//
// It uses the Admin SDK, so /firestore.rules don't apply: the key is the only
// protection. It never writes. Every read takes at most READ_LIMIT documents
// from a collection and filters in memory (the collections are small), so no
// composite indexes are needed.
//
// Stages, "no contact" and stage keys mirror TABS / stageOf() /
// STALE_WARN_HOURS in HPH RENEWABLE/admin/admin.js; keep them in step.
const crypto = require("node:crypto");
const { onRequest } = require("firebase-functions/v2/https");
const { defineSecret } = require("firebase-functions/params");
const logger = require("firebase-functions/logger");
const admin = require("firebase-admin");
const { McpServer } = require("@modelcontextprotocol/sdk/server/mcp.js");
const { StreamableHTTPServerTransport } = require("@modelcontextprotocol/sdk/server/streamableHttp.js");
const { z } = require("zod");

const MCP_ACCESS_KEY = defineSecret("MCP_ACCESS_KEY");
const REGION = "us-central1"; // same as notifyNewVisit / the Firestore database
const READ_LIMIT = 1000;
const TZ = "Asia/Manila";

// ---- mirrors admin.js -------------------------------------------------------
const STALE_WARN_HOURS = 48;
const PIPELINES = {
    visits: {
        stages: [
            ["new", "New"], ["contacted", "Contacted"], ["scheduled", "Visit scheduled"], ["visited", "Visited"],
            ["quoted", "Quote sent"], ["installing", "Installing"], ["installed", "Installed"],
        ],
        legacyDone: "visited",
    },
    waitlist: {
        stages: [["new", "New"], ["contacted", "Contacted"], ["reserved", "Reserved"], ["delivered", "Delivered"], ["cancelled", "Cancelled"]],
        legacyDone: "contacted",
    },
};
const VISIT_STAGES = PIPELINES.visits.stages.map(([k]) => k);
const WAITLIST_STAGES = PIPELINES.waitlist.stages.map(([k]) => k);
const VISIT_SOURCES = ["website", "admin", "install", "waitlist", "opensolar"];
const CHECKLIST_SYSTEMS = { mx2250: "MX2250", mau5000: "MAU5000 Elite", msu4000: "MSU4000 Elite" };

function stageOf(tab, d) {
    const p = PIPELINES[tab];
    if (p.stages.some(([k]) => k === d.stage)) return d.stage;
    return d.status === "done" ? p.legacyDone : "new";
}
const stageLabel = (tab, key) => (PIPELINES[tab].stages.find(([k]) => k === key) || [key, key])[1];

// Hours an entry has sat at New; null once it moved on or has no date.
function hoursWaiting(tab, d) {
    const created = toDate(d.createdAt);
    if (stageOf(tab, d) !== "new" || !created) return null;
    return (Date.now() - created.getTime()) / 3600000;
}
const noContact = (tab, d) => { const h = hoursWaiting(tab, d); return h !== null && h >= STALE_WARN_HOURS; };

// ---- formatting -------------------------------------------------------------
function toDate(v) {
    if (!v) return null;
    if (typeof v.toDate === "function") return v.toDate();
    if (v instanceof Date) return v;
    if (typeof v === "string" && /^\d{4}-\d{2}-\d{2}/.test(v)) { const d = new Date(v); return isNaN(d) ? null : d; }
    return null;
}
const manilaFmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false,
});
function manila(v) {
    const d = toDate(v);
    if (!d) return null;
    const p = Object.fromEntries(manilaFmt.formatToParts(d).map((x) => [x.type, x.value]));
    return `${p.year}-${p.month}-${p.day} ${p.hour === "24" ? "00" : p.hour}:${p.minute} Manila`;
}
const peso = (n) => (Number.isFinite(n) ? `₱${n.toLocaleString("en-PH", { maximumFractionDigits: 2 })}` : null);
const list = (v) => (Array.isArray(v) ? v.filter((x) => typeof x === "string") : []);
const digits = (v) => String(v ?? "").replace(/\D/g, "");

// Firestore values → plain JSON: Timestamps as Manila time, GeoPoints/refs flattened.
function plain(v) {
    if (v === null || v === undefined) return v;
    if (typeof v.toDate === "function") return manila(v);
    if (v instanceof admin.firestore.GeoPoint) return { lat: v.latitude, lng: v.longitude };
    if (v instanceof admin.firestore.DocumentReference) return v.path;
    if (Array.isArray(v)) return v.map(plain);
    if (typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, plain(x)]));
    return v;
}
// Drop empty values so the output stays short.
function compact(o) {
    return Object.fromEntries(Object.entries(o).filter(([, v]) =>
        v !== undefined && v !== null && v !== "" && !(Array.isArray(v) && !v.length)));
}

function aircons(v) {
    const sizes = list(v);
    if (!sizes.length) return null;
    const counts = new Map();
    for (const s of sizes) counts.set(s, (counts.get(s) || 0) + 1);
    return `${sizes.length} aircon${sizes.length === 1 ? "" : "s"}: ${[...counts].map(([s, n]) => `${n} × ${s}`).join(", ")}`;
}
const usage = (v) => (v === "Flat" ? "Balanced" : v || null);

// ---- search -----------------------------------------------------------------
// Text fields contain the query (case ignored), or, for a query that's mostly
// digits, a phone field contains it with the country code / leading 0 ignored,
// so "0917 123 4567" matches "+63 917 123 4567".
function matches(d, query, textFields, phoneFields = ["phone"]) {
    const q = String(query || "").trim().toLowerCase();
    if (!q) return true;
    if (textFields.some((f) => String(d[f] ?? "").toLowerCase().includes(q))) return true;
    const qd = digits(q);
    if (qd.length >= 4 && qd.length >= q.replace(/[\s()+-]/g, "").length - 1) {
        const core = qd.replace(/^63(?=9)/, "").replace(/^0(?=9)/, "").slice(-10);
        return phoneFields.some((f) => digits(d[f]).slice(-10).includes(core));
    }
    return false;
}

// ---- reads ------------------------------------------------------------------
let dbInstance = null;
function db() {
    if (!dbInstance) {
        if (!admin.apps.length) admin.initializeApp();
        dbInstance = admin.firestore();
    }
    return dbInstance;
}
async function readAll(collection, orderField) {
    let q = db().collection(collection);
    if (orderField) q = q.orderBy(orderField, "desc");
    const snap = await q.limit(READ_LIMIT).get();
    return snap.docs.map((doc) => ({ id: doc.id, ...doc.data() }));
}
const sinceMs = (days) => (days ? Date.now() - days * 86400000 : null);
const newerThan = (d, field, ms) => !ms || ((toDate(d[field]) || new Date(0)).getTime() >= ms);
const byCreatedDesc = (a, b) => (toDate(b.createdAt)?.getTime() || 0) - (toDate(a.createdAt)?.getTime() || 0);
const ticket = (id) => `#${id.slice(0, 6).toUpperCase()}`;

// ---- shapes -----------------------------------------------------------------
function visitOut(d) {
    const stage = stageOf("visits", d);
    const h = hoursWaiting("visits", d);
    return compact({
        id: d.id, ticket: ticket(d.id), name: d.name, phone: d.phone, email: d.email, address: d.address,
        stage: stageLabel("visits", stage),
        noContactHours: h !== null && h >= STALE_WARN_HOURS ? Math.floor(h) : undefined,
        source: d.source || "website",
        interestedIn: d.product, propertyType: d.propertyType, monthlyBill: d.monthlyBill,
        usagePattern: usage(d.usagePattern), preferredDate: d.preferredDate, preferredTime: d.preferredTime,
        aircons: aircons(d.aircons), referralCode: d.referralCode, message: d.message,
        roofPin: d.roofPin && Number.isFinite(d.roofPin.lat)
            ? `https://www.google.com/maps?q=${d.roofPin.lat},${d.roofPin.lng}${d.roofPin.adjusted ? "" : " (address only, not adjusted by the client)"}` : undefined,
        attachments: list(d.attachments).length + list(d.roofPhotos).length || undefined,
        openSolarStage: d.openSolarStage,
        createdAt: manila(d.createdAt), stageUpdatedAt: manila(d.stageUpdatedAt), stageUpdatedBy: d.stageUpdatedBy,
        editedAt: manila(d.editedAt),
    });
}
function waitlistOut(d) {
    const stage = stageOf("waitlist", d);
    const h = hoursWaiting("waitlist", d);
    return compact({
        id: d.id, ticket: ticket(d.id), name: d.name, phone: d.phone, email: d.email, address: d.address || d.location,
        stage: stageLabel("waitlist", stage),
        noContactHours: h !== null && h >= STALE_WARN_HOURS ? Math.floor(h) : undefined,
        source: d.source || "website",
        system: d.system, quantities: d.quantities,
        estimatedTotal: d.estimatedTotal > 0 ? peso(d.estimatedTotal) : undefined,
        referralCode: d.referralCode || undefined,
        message: d.message, attachments: list(d.attachments).length || undefined,
        createdAt: manila(d.createdAt), stageUpdatedAt: manila(d.stageUpdatedAt),
    });
}
function installCounts(d) {
    const serialPanels = list(d.panelSerials).length;
    return {
        inverters: list(d.inverterSerials).length,
        panels: Number.isFinite(d.panelCount) ? Math.max(d.panelCount, serialPanels) : serialPanels,
        batteries: list(d.batterySerials).length,
    };
}
function installOut(d, { serials = false } = {}) {
    const c = installCounts(d);
    return compact({
        id: d.id, clientName: d.clientName, contact: d.contact, email: d.email, address: d.address,
        installDate: d.installDate, capacityKwp: d.capacityKwp,
        inverters: c.inverters, panels: c.panels, batteries: c.batteries || undefined,
        inverterSerials: serials ? list(d.inverterSerials) : undefined,
        panelSerials: serials ? list(d.panelSerials) : undefined,
        batterySerials: serials ? list(d.batterySerials) : undefined,
        batteryModels: serials ? d.batteryModels : undefined,
        source: d.source, createdBy: d.createdBy, updatedAt: manila(d.updatedAt),
    });
}
function stockState(d) {
    const qty = Number(d.qty) || 0;
    if (qty <= 0) return "Out of stock";
    if (d.lowAt > 0 && qty <= d.lowAt) return "Restock";
    return "In stock";
}
function inventoryOut(d, suppliers) {
    const supplier = d.supplierId && suppliers.get(d.supplierId);
    return compact({
        id: d.id, name: d.name, category: d.category || "No category", qty: d.qty, unit: d.unit,
        restockAt: d.lowAt, state: stockState(d),
        supplier: supplier ? supplier.name : d.supplier, note: d.note,
        photos: list(d.photos).length || undefined,
        updatedAt: manila(d.updatedAt), updatedBy: d.updatedBy,
    });
}
// An answer counts as filled when it has what most item kinds need. The exact
// per-item rules (photoRequired etc.) live in checklist-templates.js, which
// isn't deployed with the function, so this is approximate.
function answered(a) {
    if (!a || typeof a !== "object") return false;
    return list(a.photos).length > 0 || Boolean(String(a.v ?? "").trim())
        || (Number.isFinite(a.ac) && Number.isFinite(a.dc)) || a.done === true;
}
function checklistOut(d) {
    const items = d.items && typeof d.items === "object" ? d.items : {};
    return compact({
        id: d.id, clientName: d.clientName, address: d.address,
        system: CHECKLIST_SYSTEMS[d.system] || d.system, kwp: d.kwp, visitId: d.visitId,
        itemsAnswered: Object.values(items).filter(answered).length,
        itemsWithNotes: Object.values(items).filter((a) => a && String(a.note ?? "").trim()).length || undefined,
        createdAt: manila(d.createdAt), createdBy: d.createdBy, updatedAt: manila(d.updatedAt), updatedBy: d.updatedBy,
    });
}
function wishOut(d) {
    const total = Number.isFinite(d.price) && Number.isFinite(d.qty) ? d.price * d.qty : null;
    return compact({
        id: d.id, name: d.name, price: peso(d.price), qty: d.qty, total: peso(total), link: d.link, note: d.note,
        status: d.status || "open", createdBy: d.createdBy, createdAt: manila(d.createdAt),
        completedAt: manila(d.completedAt), completedBy: d.completedBy,
    });
}

// ---- server -----------------------------------------------------------------
const json = (obj) => ({ content: [{ type: "text", text: JSON.stringify(obj, null, 1) }] });
const RO = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
const limitArg = (def) => z.number().int().min(1).max(200).default(def).describe(`Max results (default ${def}).`);

function buildServer() {
    const server = new McpServer(
        { name: "hph-renewable-admin", version: "1.0.0" },
        {
            instructions: "Read-only access to HPH Renewable's admin data (solar installer in the Philippines): " +
                "Ocular site visit requests (leads), battery waitlist sign-ups, installations and serial numbers, " +
                "inventory, installer checklists, feedback, NDA responses and the purchase wishlist. " +
                "Times are Asia/Manila; money is Philippine pesos. Start with `summary` for an overview. " +
                "Nothing here can change data; changes are made on the admin page.",
        },
    );

    server.registerTool("summary", {
        title: "Business summary",
        description: "Overview of everything on the admin page: Ocular visit requests and waitlist sign-ups per pipeline stage, " +
            "how many came in during the last N days, the ones still at New with no contact for 48+ hours, install totals " +
            "(installs, kWp, inverters, panels), inventory items needing a restock, open wishlist count and ₱ total, number of " +
            "checklists and the average feedback rating. Use this first for questions like 'how are we doing' or 'anything new this week'.",
        inputSchema: { days: z.number().int().min(1).max(365).default(7).describe("Window for the 'new' counts, in days (default 7).") },
        annotations: { title: "Business summary", ...RO },
    }, async ({ days }) => {
        const [visits, waitlist, installs, inventory, wishlist, checklists, feedback] = await Promise.all(
            ["visitRequests", "waitlist", "installs", "inventory", "wishlist", "checklists", "feedback"].map((c) => readAll(c)));
        const since = sinceMs(days);
        const perStage = (tab, docs) => Object.fromEntries(PIPELINES[tab].stages.map(([k, label]) =>
            [label, docs.filter((d) => stageOf(tab, d) === k).length]));
        const brief = (tab) => (d) => ({ ticket: ticket(d.id), name: d.name, phone: d.phone,
            hoursWaiting: Math.floor(hoursWaiting(tab, d)), createdAt: manila(d.createdAt) });
        const restock = inventory.filter((d) => stockState(d) !== "In stock")
            .map((d) => ({ name: d.name, qty: d.qty, unit: d.unit, restockAt: d.lowAt, state: stockState(d) }));
        const openWishes = wishlist.filter((d) => (d.status || "open") === "open");
        const ratings = feedback.map((d) => d.rating).filter(Number.isFinite);
        const totals = installs.reduce((t, d) => {
            const c = installCounts(d);
            t.inverters += c.inverters; t.panels += c.panels; t.batteries += c.batteries;
            t.kwp += Number.isFinite(d.capacityKwp) ? d.capacityKwp : 0;
            return t;
        }, { inverters: 0, panels: 0, batteries: 0, kwp: 0 });
        return json({
            now: manila(new Date()),
            visitRequests: {
                total: visits.length, byStage: perStage("visits", visits),
                [`newInLast${days}Days`]: visits.filter((d) => newerThan(d, "createdAt", since)).length,
                noContact48h: visits.filter((d) => noContact("visits", d)).sort(byCreatedDesc).map(brief("visits")),
            },
            waitlist: {
                total: waitlist.length, byStage: perStage("waitlist", waitlist),
                [`newInLast${days}Days`]: waitlist.filter((d) => newerThan(d, "createdAt", since)).length,
                noContact48h: waitlist.filter((d) => noContact("waitlist", d)).sort(byCreatedDesc).map(brief("waitlist")),
            },
            installs: { total: installs.length, kwp: Math.round(totals.kwp * 100) / 100, inverters: totals.inverters, panels: totals.panels, batteries: totals.batteries },
            inventory: { items: inventory.length, needingRestock: restock },
            wishlist: { open: openWishes.length, openTotal: peso(openWishes.reduce((s, d) => s + ((d.price || 0) * (d.qty || 0)), 0)) },
            checklists: checklists.length,
            feedback: { count: feedback.length, averageRating: ratings.length ? Math.round(ratings.reduce((a, b) => a + b, 0) / ratings.length * 10) / 10 : null },
        });
    });

    server.registerTool("list_visit_requests", {
        title: "List Ocular visit requests",
        description: "Ocular site visit requests (leads from the Schedule a Visit form and entries added by staff), newest first. " +
            "Stages: new, contacted, scheduled (Visit scheduled), visited, quoted (Quote sent), installing, installed. " +
            "Source: website (public form), admin (added by staff), install (made from an installation), waitlist (copied from a waitlist sign-up), opensolar (imported). " +
            "Search matches name, phone (any format, e.g. 0917… finds +63917…), email, address, message and referral code. " +
            "noContactOnly returns requests still at New 48+ hours after they came in.",
        inputSchema: {
            stage: z.enum(VISIT_STAGES).optional().describe("Only this pipeline stage."),
            sinceDays: z.number().int().min(1).max(3650).optional().describe("Only requests created in the last N days."),
            source: z.enum(VISIT_SOURCES).optional().describe("Only this source."),
            noContactOnly: z.boolean().optional().describe("Only requests at New for 48+ hours."),
            search: z.string().max(200).optional().describe("Text or phone number to look for."),
            limit: limitArg(25),
        },
        annotations: { title: "List Ocular visit requests", ...RO },
    }, async ({ stage, sinceDays, source, noContactOnly, search, limit }) => {
        const since = sinceMs(sinceDays);
        const rows = (await readAll("visitRequests"))
            .filter((d) => !stage || stageOf("visits", d) === stage)
            .filter((d) => !source || (d.source || "website") === source)
            .filter((d) => newerThan(d, "createdAt", since))
            .filter((d) => !noContactOnly || noContact("visits", d))
            .filter((d) => matches(d, search, ["name", "email", "address", "message", "referralCode"]))
            .sort(byCreatedDesc);
        return json({ matching: rows.length, shown: Math.min(limit, rows.length), requests: rows.slice(0, limit).map(visitOut) });
    });

    server.registerTool("list_waitlist", {
        title: "List waitlist sign-ups",
        description: "Battery waitlist sign-ups (MSU4000 Elite + B4000 Elite, MAU5000 Elite + B5000 Elite, SigenStor Neo) and Power Pack " +
            "reservations (system 'Power Pack': 'Power Pack' is the Basic option, 'Power Pack DIY Kit' adds a Tier 1 650 W panel, " +
            "mounting and PV cable), newest first, " +
            "with the system, quantities per product and the estimated total shown to the customer. " +
            "Stages: new, contacted, reserved, delivered, cancelled. Search matches name, phone, email, address, system, message and referral code.",
        inputSchema: {
            stage: z.enum(WAITLIST_STAGES).optional().describe("Only this stage."),
            sinceDays: z.number().int().min(1).max(3650).optional().describe("Only sign-ups from the last N days."),
            search: z.string().max(200).optional().describe("Text or phone number to look for."),
            limit: limitArg(25),
        },
        annotations: { title: "List waitlist sign-ups", ...RO },
    }, async ({ stage, sinceDays, search, limit }) => {
        const since = sinceMs(sinceDays);
        const rows = (await readAll("waitlist"))
            .filter((d) => !stage || stageOf("waitlist", d) === stage)
            .filter((d) => newerThan(d, "createdAt", since))
            .filter((d) => matches(d, search, ["name", "email", "address", "system", "message", "referralCode"]))
            .sort(byCreatedDesc);
        return json({ matching: rows.length, shown: Math.min(limit, rows.length), signups: rows.slice(0, limit).map(waitlistOut) });
    });

    server.registerTool("list_installs", {
        title: "List installations",
        description: "Completed solar installations (client, address, install date, capacity in kWp, number of MX2250 inverters, " +
            "panels and batteries), newest install date first. Dates are YYYY-MM-DD. Search matches client name, contact number, " +
            "email and address. Use find_serial to look up a serial number, get_record for an install's full serial lists.",
        inputSchema: {
            fromDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe("Earliest install date, YYYY-MM-DD."),
            toDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe("Latest install date, YYYY-MM-DD."),
            search: z.string().max(200).optional(),
            limit: limitArg(50),
        },
        annotations: { title: "List installations", ...RO },
    }, async ({ fromDate, toDate, search, limit }) => {
        const rows = (await readAll("installs"))
            .filter((d) => !fromDate || (d.installDate || "") >= fromDate)
            .filter((d) => !toDate || (d.installDate || "9999") <= toDate)
            .filter((d) => matches(d, search, ["clientName", "email", "address"], ["contact"]))
            .sort((a, b) => (b.installDate || "").localeCompare(a.installDate || ""));
        const t = rows.reduce((s, d) => { const c = installCounts(d); s.inverters += c.inverters; s.panels += c.panels; s.kwp += d.capacityKwp || 0; return s; },
            { inverters: 0, panels: 0, kwp: 0 });
        return json({
            matching: rows.length, totals: { ...t, kwp: Math.round(t.kwp * 100) / 100 },
            shown: Math.min(limit, rows.length), installs: rows.slice(0, limit).map((d) => installOut(d)),
        });
    });

    server.registerTool("find_serial", {
        title: "Find a serial number",
        description: "Which installation has a given MX2250 inverter, solar panel or battery serial number. " +
            "Give the full serial; a partial one (6+ characters) is searched across all installs.",
        inputSchema: { serial: z.string().min(4).max(40).describe("Serial number, e.g. Y0019A57121D1234.") },
        annotations: { title: "Find a serial number", ...RO },
    }, async ({ serial }) => {
        const sn = serial.trim().toUpperCase().replace(/\s+/g, "");
        if (!/^[A-Z0-9]+$/.test(sn)) return json({ found: false, note: "Serials are letters and digits only." });
        const doc = await db().collection("serials").doc(sn).get();
        if (doc.exists) {
            const s = doc.data();
            const inst = s.installId ? await db().collection("installs").doc(s.installId).get() : null;
            return json({ found: true, serial: sn, type: s.type, install: inst && inst.exists ? installOut({ id: inst.id, ...inst.data() }) : s.installId });
        }
        const hits = [];
        for (const d of await readAll("installs")) {
            for (const [type, field] of [["inverter", "inverterSerials"], ["panel", "panelSerials"], ["battery", "batterySerials"]]) {
                for (const s of list(d[field])) {
                    const u = s.toUpperCase();
                    if (u === sn || (sn.length >= 6 && u.includes(sn))) hits.push({ serial: s, type, install: installOut(d) });
                }
            }
        }
        return json(hits.length ? { found: true, matches: hits.slice(0, 20) } : { found: false, serial: sn });
    });

    server.registerTool("list_inventory", {
        title: "List inventory",
        description: "Stock on hand: each item's count, unit, category, restock level, state (In stock / Restock / Out of stock) " +
            "and supplier. Items needing a restock come first. Categories: Cables & Wiring, Connectors, Major Equipment, " +
            "Mounting & Racking, Grounding Hardware.",
        inputSchema: {
            restockOnly: z.boolean().optional().describe("Only items at or below their restock level, or out of stock."),
            category: z.string().max(100).optional().describe("Category name (case ignored)."),
            search: z.string().max(200).optional().describe("Matches item name, note and supplier."),
        },
        annotations: { title: "List inventory", ...RO },
    }, async ({ restockOnly, category, search }) => {
        const [items, sups] = await Promise.all([readAll("inventory"), readAll("suppliers")]);
        const suppliers = new Map(sups.map((s) => [s.id, s]));
        const order = { "Out of stock": 0, "Restock": 1, "In stock": 2 };
        const rows = items.map((d) => inventoryOut(d, suppliers))
            .filter((d) => !restockOnly || d.state !== "In stock")
            .filter((d) => !category || d.category.toLowerCase() === category.trim().toLowerCase())
            .filter((d) => matches(d, search, ["name", "note", "supplier"], []))
            .sort((a, b) => order[a.state] - order[b.state] || a.category.localeCompare(b.category) || String(a.name).localeCompare(String(b.name)));
        return json({ count: rows.length, items: rows });
    });

    server.registerTool("inventory_history", {
        title: "Inventory history",
        description: "Stock changes (used, stock added, count set, item created), newest first, with before/after counts, " +
            "the job or client it was used for, the note and who did it. Filter by item (name or id) and/or job/client name.",
        inputSchema: {
            item: z.string().max(200).optional().describe("Item name (partial, case ignored) or item id."),
            job: z.string().max(200).optional().describe("Job / client the stock was used for (partial)."),
            sinceDays: z.number().int().min(1).max(3650).default(30).describe("How far back, in days (default 30)."),
            limit: limitArg(50),
        },
        annotations: { title: "Inventory history", ...RO },
    }, async ({ item, job, sinceDays, limit }) => {
        const since = sinceMs(sinceDays);
        const reasons = { create: "Created", use: "Used", restock: "Stock added", count: "Count set" };
        const q = (item || "").trim().toLowerCase();
        const rows = (await readAll("inventoryLog", "at"))
            .filter((d) => newerThan(d, "at", since))
            .filter((d) => !q || d.itemId === item.trim() || String(d.itemName || "").toLowerCase().includes(q))
            .filter((d) => !job || String(d.job || "").toLowerCase().includes(job.trim().toLowerCase()));
        return json({
            matching: rows.length, shown: Math.min(limit, rows.length),
            changes: rows.slice(0, limit).map((d) => compact({
                at: manila(d.at), item: d.itemName, itemId: d.itemId, reason: reasons[d.reason] || d.reason,
                change: d.change, before: d.qtyBefore, after: d.qtyAfter, job: d.job, note: d.note, by: d.by,
            })),
        });
    });

    server.registerTool("list_checklists", {
        title: "List installer checklists",
        description: "Installer checklists (one per job: Site inspection and Commissioning), most recently updated first, with client, " +
            "address, system and how many items have an answer (approximate; the admin page shows exact progress).",
        inputSchema: { search: z.string().max(200).optional().describe("Matches client name and address."), limit: limitArg(50) },
        annotations: { title: "List installer checklists", ...RO },
    }, async ({ search, limit }) => {
        const rows = (await readAll("checklists"))
            .filter((d) => matches(d, search, ["clientName", "address"], []))
            .sort((a, b) => (toDate(b.updatedAt)?.getTime() || 0) - (toDate(a.updatedAt)?.getTime() || 0));
        return json({ count: rows.length, checklists: rows.slice(0, limit).map(checklistOut) });
    });

    server.registerTool("list_feedback", {
        title: "List customer feedback",
        description: "Customer feedback from the Send Feedback form (1–5 star rating, message, name, contact, whether they allow it " +
            "to be published), newest first, with the average rating.",
        inputSchema: {
            minRating: z.number().int().min(1).max(5).optional(),
            maxRating: z.number().int().min(1).max(5).optional(),
            limit: limitArg(50),
        },
        annotations: { title: "List customer feedback", ...RO },
    }, async ({ minRating, maxRating, limit }) => {
        const rows = (await readAll("feedback"))
            .filter((d) => !minRating || d.rating >= minRating)
            .filter((d) => !maxRating || d.rating <= maxRating)
            .sort(byCreatedDesc);
        const r = rows.map((d) => d.rating).filter(Number.isFinite);
        return json({
            count: rows.length, averageRating: r.length ? Math.round(r.reduce((a, b) => a + b, 0) / r.length * 10) / 10 : null,
            feedback: rows.slice(0, limit).map((d) => compact({
                id: d.id, rating: d.rating, message: d.message, name: d.name, contact: d.contact,
                allowPublish: d.allowPublish, createdAt: manila(d.createdAt),
            })),
        });
    });

    server.registerTool("list_nda", {
        title: "List NDA responses",
        description: "Confidentiality Agreement (NDA) responses: full name, email, phone, quotation reference, response " +
            "(agreed / declined) and agreement date, newest first. Older ones were imported from a Google Form.",
        inputSchema: {
            response: z.enum(["agree", "disagree"]).optional().describe("Only agreed or only declined."),
            search: z.string().max(200).optional().describe("Matches name, email, phone, reference and company."),
            limit: limitArg(50),
        },
        annotations: { title: "List NDA responses", ...RO },
    }, async ({ response, search, limit }) => {
        const rows = (await readAll("ndaResponses"))
            .filter((d) => !response || d.response === response)
            .filter((d) => matches(d, search, ["fullName", "email", "reference", "company"]))
            .sort(byCreatedDesc);
        return json({
            count: rows.length, agreed: rows.filter((d) => d.response === "agree").length,
            responses: rows.slice(0, limit).map((d) => compact({
                id: d.id, fullName: d.fullName, email: d.email, phone: d.phone, reference: d.reference, company: d.company,
                response: d.response === "agree" ? "Agreed" : d.response === "disagree" ? "Declined" : d.response,
                agreementDate: d.agreementDate, source: d.source === "google-form" ? "Imported from Google Form" : undefined,
                createdAt: manila(d.createdAt),
            })),
        });
    });

    server.registerTool("list_wishlist", {
        title: "List wishlist",
        description: "Things the team wants bought: name, price each (₱), quantity, total, link, note and status. " +
            "Open items first, with the open items' ₱ total.",
        inputSchema: { status: z.enum(["open", "completed", "all"]).default("open").describe("Default open.") },
        annotations: { title: "List wishlist", ...RO },
    }, async ({ status }) => {
        const all = await readAll("wishlist");
        const rows = all.filter((d) => status === "all" || (d.status || "open") === status)
            .sort((a, b) => ((a.status || "open") === "open" ? 0 : 1) - ((b.status || "open") === "open" ? 0 : 1) || byCreatedDesc(a, b));
        const open = all.filter((d) => (d.status || "open") === "open");
        return json({
            count: rows.length, openTotal: peso(open.reduce((s, d) => s + (d.price || 0) * (d.qty || 0), 0)),
            items: rows.map(wishOut),
        });
    });

    const TYPES = {
        visit: "visitRequests", waitlist: "waitlist", install: "installs", feedback: "feedback", nda: "ndaResponses",
        inventory: "inventory", checklist: "checklists", wishlist: "wishlist", supplier: "suppliers",
    };
    server.registerTool("get_record", {
        title: "Get one record",
        description: "One record in full, every saved field. type is visit, waitlist, install, feedback, nda, inventory, " +
            "checklist, wishlist or supplier; id is the document id from a list tool. For a visit or waitlist entry the " +
            "6-character ticket number (e.g. #A1B2C3) also works.",
        inputSchema: {
            type: z.enum(Object.keys(TYPES)),
            id: z.string().min(1).max(200).describe("Document id, or a visit/waitlist ticket number."),
        },
        annotations: { title: "Get one record", ...RO },
    }, async ({ type, id }) => {
        const collection = TYPES[type];
        const raw = id.trim();
        let found = [];
        if (!raw.includes("/")) {
            const doc = await db().collection(collection).doc(raw.replace(/^#/, "")).get();
            if (doc.exists) found = [{ id: doc.id, ...doc.data() }];
        }
        const prefix = raw.replace(/^#/, "").toLowerCase();
        if (!found.length && (type === "visit" || type === "waitlist") && /^[a-z0-9-]{4,}$/i.test(prefix)) {
            found = (await readAll(collection)).filter((d) => d.id.toLowerCase().startsWith(prefix));
        }
        if (!found.length) return json({ found: false, type, id: raw });
        if (found.length > 1) {
            return json({ found: false, note: "More than one match; ask again with the full id.",
                candidates: found.slice(0, 10).map((d) => ({ id: d.id, name: d.name, createdAt: manila(d.createdAt) })) });
        }
        const d = found[0];
        const extra = type === "visit" ? { ticket: ticket(d.id), stage: stageLabel("visits", stageOf("visits", d)), source: d.source || "website" }
            : type === "waitlist" ? { ticket: ticket(d.id), stage: stageLabel("waitlist", stageOf("waitlist", d)), estimate: peso(d.estimatedTotal) }
            : type === "inventory" ? { state: stockState(d) }
            : type === "install" ? installCounts(d) : {};
        return json({ found: true, type, ...extra, record: plain(d) });
    });

    return server;
}

// ---- HTTP -------------------------------------------------------------------
const hash = (s) => crypto.createHash("sha256").update(String(s)).digest();
function keyOk(given, key) {
    return Boolean(given) && crypto.timingSafeEqual(hash(given), hash(key));
}
function authorized(req, key) {
    if (!key) return false;
    const first = decodeURIComponent((req.path || "/").split("/").filter(Boolean)[0] || "");
    const bearer = /^Bearer\s+(.+)$/i.exec(req.get("authorization") || "");
    // Evaluate both so timing doesn't reveal which one was given.
    const a = keyOk(first, key);
    const b = keyOk(bearer && bearer[1].trim(), key);
    return a || b;
}

async function handle(req, res) {
    if (!authorized(req, (MCP_ACCESS_KEY.value() || "").trim())) {
        res.status(404).type("text/plain").send("Not found");
        return;
    }
    if (req.method !== "POST") {
        res.status(405).set("Allow", "POST").json({ jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed." }, id: null });
        return;
    }
    const server = buildServer();
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on("close", () => { transport.close(); server.close(); });
    try {
        await server.connect(transport);
        await transport.handleRequest(req, res, req.body);
    } catch (err) {
        logger.error("claudeMcp failed", { error: String(err && err.stack || err) });
        if (!res.headersSent) res.status(500).json({ jsonrpc: "2.0", error: { code: -32603, message: "Internal error" }, id: null });
    }
}

exports.claudeMcp = onRequest(
    { region: REGION, invoker: "public", secrets: [MCP_ACCESS_KEY], timeoutSeconds: 60, memory: "512MiB", maxInstances: 3 },
    handle,
);
