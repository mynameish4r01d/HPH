// The sales team's referral codes: the one list the "Schedule a Visit" form
// (schedule-a-visit/visit-form.js) checks codes against, and the admin page
// (admin/admin.js) uses to show whose referral a visit request is.
// To add a salesperson, add a line here; nothing else needs to change.

export const SALES_TEAM = [
    { code: "HPH-MPM01", name: "Mike P. Medina" },
    { code: "HPH-RPB01", name: "Rodel P. Bacsal" },
    { code: "HPH-AJD01", name: "Alvin J. Duran" },
    { code: "HPH-JMD01", name: "Jopay M. Duran" },
    { code: "HPH-ADG01", name: "Andrew De Guia" },
    { code: "HPH-NVT01", name: "Norman V. Tolorio" },
    { code: "HPH-MJA01", name: "Mary Jane Antonio" },
];

// Codes are compared ignoring case, spaces and dashes, so "hph mpm01" and
// "HPHMPM01" both count as HPH-MPM01.
const squash = (text) => String(text || "").toUpperCase().replace(/[\s\-_]+/g, "");
const BY_KEY = new Map(SALES_TEAM.map((person) => [squash(person.code), person]));

// The salesperson for a typed code ({ code, name } with the official
// spelling), or null if it isn't one of ours.
export function findReferrer(text) {
    return BY_KEY.get(squash(text)) || null;
}
