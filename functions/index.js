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

// Who gets the alert. Until a sending domain is verified in Resend, Resend only
// delivers to the email the Resend account was created with, so keep this to
// that address. After verifying hphtechsolutions.com, add the other owners and
// change FROM to an address on that domain.
const ADMIN_EMAILS = ["harold.t.hermosa@gmail.com"];
const FROM = "HPH Alerts <onboarding@resend.dev>";

// Must match the region of your Firestore database (us-central1 here).
const REGION = "us-central1";

const ADMIN_URL = "https://hphtechsolutions.com/hphrenewable/admin/";

const oneLine = (v) => String(v ?? "").replace(/[\r\n]+/g, " ").trim();

exports.notifyNewVisit = onDocumentCreated(
    { document: "visitRequests/{id}", region: REGION, secrets: [RESEND_API_KEY] },
    async (event) => {
        const snap = event.data;
        if (!snap) return;
        const d = snap.data();
        if (d.source) return; // not from the public form

        const lines = [
            `Name: ${oneLine(d.name)}`,
            `Mobile: ${oneLine(d.phone)}`,
            `Email: ${oneLine(d.email)}`,
            `Property: ${oneLine(d.propertyType)}`,
            `Address: ${oneLine(d.address)}`,
            `Interested in: ${oneLine(d.product)}`,
            `Monthly bill: ${oneLine(d.monthlyBill)}`,
            `Preferred time: ${oneLine(d.preferredTime)}`,
        ];
        if (d.referralCode) lines.push(`Referral code: ${oneLine(d.referralCode)}`);
        if (d.message) lines.push("", `Message: ${String(d.message).trim()}`);
        lines.push("", `Open in the admin page: ${ADMIN_URL}`, `Ticket: #${event.params.id.slice(0, 6)}`);

        try {
            const res = await fetch("https://api.resend.com/emails", {
                method: "POST",
                headers: { Authorization: `Bearer ${RESEND_API_KEY.value().trim()}`, "Content-Type": "application/json" },
                body: JSON.stringify({
                    from: FROM,
                    to: ADMIN_EMAILS,
                    reply_to: d.email && /^\S+@\S+$/.test(d.email) ? d.email : undefined,
                    subject: `New site visit request: ${oneLine(d.name) || "Unknown"}`.slice(0, 150),
                    text: lines.join("\n"),
                }),
            });
            if (!res.ok) throw new Error(`Resend ${res.status}: ${await res.text()}`);
            logger.info("Visit alert sent", { id: event.params.id });
        } catch (err) {
            // Don't rethrow: the request is saved either way, and a retry loop
            // would just send duplicates.
            logger.error("Visit alert failed", { id: event.params.id, error: String(err) });
        }
    }
);
