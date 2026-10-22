// Installer checklist: the content.
//
// One checklist per job, with two tabs: Site inspection and Commissioning.
// Its items depend on the job's system type (SYSTEMS). Only the MX2250 micro
// inverter has a checklist so far; the others show "coming soon" until they
// get an entry in CHECKLISTS.
//
// To change a checklist, edit the items below (text, order, add, remove) and
// bump CHECKLIST_VERSION. Nothing else needs changing: the form, the printed
// report, the CSV and the overview all read from here.
//
// Rules for items:
//   - `id` must be unique within the whole checklist (both tabs): short,
//     lowercase, letters, numbers and dashes only (no dots). It's the key
//     answers are saved under, so don't rename an id that already has answers;
//     remove it and add a new one.
//   - `text` is what the installer reads; `hint` is an optional smaller line.
//
// Kinds of item (`type`), and when each counts as done:
//   - "photo": a photo is added. `label` names the button ("Add photo",
//     "Add screenshot"). `fromVisit: true` also offers "Import from Ocular
//     Visit", which links the files the client uploaded with their visit
//     request (the files stay with the request).
//   - "text": a short answer is typed in (`placeholder` optional).
//   - "lengths": AC and DC cable lengths, in meters, are both filled in.
//   - "choice": one of `options` is picked. `allowPhoto: true` adds optional
//     photos.
//   - "check": it's ticked.
// Every item can also have a note.
//
// Answers are saved in Firestore collection `checklists` (see admin.js and
// /firestore.rules); each checklist records the CHECKLIST_VERSION it was
// started on.

export const CHECKLIST_VERSION = "2026-10-mx2250";

// The job's system type. `kwp: true` asks for the system size in kWp.
export const SYSTEMS = [
    { id: "mx2250", label: "Micro inverter (MX2250)", short: "MX2250", kwp: true },
    { id: "mau5000", label: "MAU5000 Elite", short: "MAU5000 Elite" },
    { id: "msu4000", label: "MSU4000 Elite", short: "MSU4000 Elite" },
];

// The two tabs every checklist has, in order.
export const CHECKLIST_TABS = [
    { id: "inspection", title: "Site inspection", icon: "travel_explore" },
    { id: "commissioning", title: "Commissioning", icon: "construction" },
];

export const CHECKLISTS = {
    mx2250: {
        title: "MX2250 Checklist",
        inspection: [
            { id: "meter", type: "photo", text: "Meter", label: "Add photo" },
            { id: "wire-size", type: "text", text: "Wire size for zero export", placeholder: "e.g. 5.5 mm²" },
            { id: "panel-board", type: "photo", text: "Panel board", label: "Add photo" },
            { id: "mi-box", type: "photo", text: "MI Box location", label: "Add photo" },
            {
                id: "meralco-bill", type: "photo", text: "Meralco bill", label: "Add photo", fromVisit: true,
                hint: "The “Your Monthly Consumption” graph must be clearly visible",
            },
            {
                id: "roof-pin", type: "photo", text: "Roof with pinned location", label: "Add screenshot",
                hint: "A map screenshot with the roof pinned",
            },
            { id: "cable-estimate", type: "lengths", text: "Estimated AC and DC cable length" },
            {
                id: "shading", type: "choice", text: "Possible shading from surrounding structures or trees",
                options: ["None", "Some", "Heavy"], allowPhoto: true,
            },
        ],
        commissioning: [
            { id: "cable-actual", type: "lengths", text: "Actual AC and DC cable length used" },
            { id: "bolts", type: "check", text: "Bolts re-torqued" },
            { id: "cable-ties", type: "check", text: "Wires secured with cable ties" },
            { id: "hdpe", type: "check", text: "HDPE pipe secured" },
            { id: "l-feet", type: "check", text: "L-feet sealed with silicone" },
            { id: "connections", type: "check", text: "Electrical connections re-torqued" },
        ],
    },
};
