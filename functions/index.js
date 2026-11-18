// Emails the admins whenever a visitor submits the Schedule a Visit form.
//
// Triggered by a new document in `visitRequests`. Only requests from the public
// form notify: the form never sets `source`, while entries added by staff
// ("admin"), copied from installs/waitlist/OpenSolar all do, so those are skipped.
//
// Sends through Resend (https://resend.com) with one secret, set with
// `firebase functions:secrets:set RESEND_API_KEY` (never in the repo).
const { onDocumentCreated } = require("firebase-functions/v2/firestore");
const { defineSecret } = require("firebase-functions/params");
const logger = require("firebase-functions/logger");

const RESEND_API_KEY = defineSecret("RESEND_API_KEY");

// Who gets the alert. hphtechsolutions.com is verified in Resend (Tokyo region,
// DNS at GoDaddy), so FROM must stay an address on that domain; it doesn't need
// to be a real mailbox, since replies go to the visitor via reply_to.
// Each owner gets their own email, so one address Resend refuses can't block
// the others.
const ADMIN_EMAILS = ["harold.t.hermosa@gmail.com", "jeff.hermosa@gmail.com", "lerin.hermosa@gmail.com"];
const FROM = "HPH Alerts <alerts@hphtechsolutions.com>";

// Must match the region of your Firestore database (us-central1 here).
const REGION = "us-central1";

const LOGO_URL = "https://hphtechsolutions.com/HPH%20RENEWABLE/global-elements/HPH%20Renewable%20Black.png";
const ADMIN_URL = "https://hphtechsolutions.com/hphrenewable/admin/";

const esc = (v) => String(v ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const oneLine = (v) => String(v ?? "").replace(/[\r\n]+/g, " ").trim();

exports.notifyNewVisit = onDocumentCreated(
    { document: "visitRequests/{id}", region: REGION, secrets: [RESEND_API_KEY] },
    async (event) => {
        const snap = event.data;
        if (!snap) return;
        const d = snap.data();
        if (d.source) return; // not from the public form

        // [label, value, optional link] rows shared by the HTML and plain-text versions.
        const rows = [
            ["Name", oneLine(d.name)],
            ["Mobile", oneLine(d.phone), `tel:${oneLine(d.phone).replace(/[^\d+]/g, "")}`],
            ["Email", oneLine(d.email), /^\S+@\S+$/.test(d.email || "") ? `mailto:${oneLine(d.email)}` : ""],
            ["Property", oneLine(d.propertyType)],
            ["Address", oneLine(d.address), `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(oneLine(d.address))}`],
            ["Interested in", oneLine(d.product)],
            ["Monthly bill", oneLine(d.monthlyBill)],
            ["Usage pattern", oneLine(d.usagePattern) || "Not sure"],
            ["Preferred time", oneLine(d.preferredTime)],
        ];
        if (Array.isArray(d.aircons)) {
            rows.push(["Aircons", d.aircons.length ? `${d.aircons.length} (${d.aircons.map(oneLine).join(", ")})` : "None"]);
        }
        if (d.roofPin && typeof d.roofPin.lat === "number" && typeof d.roofPin.lng === "number") {
            rows.push([
                "Roof pin",
                d.roofPin.adjusted ? "Pinned by the client" : "Address only, not adjusted by the client",
                `https://www.google.com/maps?q=${d.roofPin.lat},${d.roofPin.lng}`,
            ]);
        }
        const files = (Array.isArray(d.attachments) ? d.attachments.length : 0) + (Array.isArray(d.roofPhotos) ? d.roofPhotos.length : 0);
        if (files) rows.push(["Attached files", `${files} (view on the admin page)`]);
        if (d.referralCode) rows.push(["Referral code", oneLine(d.referralCode)]);
        const message = d.message ? String(d.message).trim() : "";
        const ticket = event.params.id.slice(0, 6).toUpperCase();

        const text = [
            ...rows.map(([k, v, link]) => `${k}: ${v}${link && /^https/.test(link) ? ` (${link})` : ""}`),
            ...(message ? ["", `Message: ${message}`] : []),
            "",
            `Open in the admin page: ${ADMIN_URL}`,
            `Ticket: #${ticket}`,
        ].join("\n");

        // Styled like the website: white page, Inter, near-black text, hairline borders, 4px corners.
        const FONT = "Inter,-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif";
        const rowHtml = rows
            .filter(([, v]) => v)
            .map(([k, v, link]) => {
                const val = link && link !== "tel:" ? `<a href="${esc(link)}" style="color:#1A1A1A;text-decoration:underline;text-decoration-color:#C7C7CC;">${esc(v)}</a>` : esc(v);
                return `<tr><td style="padding:12px 16px 12px 0;border-top:1px solid #E5E5E7;color:#7D8187;font-size:12px;width:120px;vertical-align:top;">${esc(k)}</td>` +
                    `<td style="padding:12px 0;border-top:1px solid #E5E5E7;color:#1A1A1A;font-size:15px;line-height:1.45;vertical-align:top;word-break:break-word;overflow-wrap:anywhere;">${val}</td></tr>`;
            })
            .join("");
        const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light"><meta name="supported-color-schemes" content="light">
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600&display=swap" rel="stylesheet"></head>
<body style="margin:0;padding:0;background:#ffffff;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#ffffff;">
<tr><td align="center" style="padding:40px 20px;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:600px;font-family:${FONT};color:#1A1A1A;">
<tr><td align="center" style="padding-bottom:64px;"><img src="${LOGO_URL}" width="260" alt="HPH Renewable" style="display:block;margin:0 auto;border:0;height:auto;width:260px;max-width:100%;"></td></tr>
<tr><td style="font-size:12px;font-weight:500;color:#7D8187;">New site visit request &middot; #${esc(ticket)}</td></tr>
<tr><td style="padding:6px 0 28px;font-size:34px;font-weight:600;line-height:1.15;letter-spacing:-0.02em;color:#1A1A1A;">${esc(oneLine(d.name)) || "Unknown"}</td></tr>
<tr><td><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-bottom:1px solid #E5E5E7;">${rowHtml}</table></td></tr>
${message ? `<tr><td style="padding-top:28px;"><div style="border:1px solid #E5E5E7;border-radius:4px;padding:14px 16px;font-size:15px;line-height:1.55;color:#1A1A1A;white-space:pre-wrap;"><div style="font-size:12px;color:#7D8187;margin-bottom:6px;">Message</div>${esc(message)}</div></td></tr>` : ""}
<tr><td align="center" style="padding-top:40px;font-size:12px;line-height:1.5;color:#7D8187;text-align:center;">Sent automatically when someone submits the Schedule a Visit form.<br>Manage requests on the <a href="${ADMIN_URL}" style="color:#7D8187;">admin page</a>.</td></tr>
</table>
</td></tr></table></body></html>`;

        const subject = `New site visit request: ${oneLine(d.name) || "Unknown"}`.slice(0, 150);
        const replyTo = d.email && /^\S+@\S+$/.test(d.email) ? d.email : undefined;
        for (const to of ADMIN_EMAILS) {
            try {
                const res = await fetch("https://api.resend.com/emails", {
                    method: "POST",
                    headers: { Authorization: `Bearer ${RESEND_API_KEY.value().trim()}`, "Content-Type": "application/json" },
                    body: JSON.stringify({ from: FROM, to: [to], reply_to: replyTo, subject, text, html }),
                });
                if (!res.ok) throw new Error(`Resend ${res.status}: ${await res.text()}`);
                logger.info("Visit alert sent", { id: event.params.id, to });
            } catch (err) {
                // Don't rethrow: the request is saved either way, and a retry loop
                // would just send duplicates.
                logger.error("Visit alert failed", { id: event.params.id, to, error: String(err) });
            }
        }
    }
);
