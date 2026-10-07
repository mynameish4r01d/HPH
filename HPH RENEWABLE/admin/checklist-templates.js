// Installer checklists: the content.
//
// To change a checklist, edit the items below (text, order, add, remove) and
// bump CHECKLIST_VERSION. Nothing else needs changing: the installer form, the
// admin report and the overview all read from here.
//
// Rules for items:
//   - `id` must be unique within its checklist: short, lowercase, letters,
//     numbers and dashes only (no dots). It's the key answers are saved under,
//     so don't rename an id that already has answers; remove it and add a new one.
//   - `text` is what the installer reads; `hint` is an optional smaller line.
//
// Three kinds of item:
//   - a normal item is answered Pass / Needs fix / N/A, with an optional note.
//   - `options: [...]` is a question with set answers (one is chosen). List any
//     answers that need attention in `flagged`: they count as "needs fixing" on
//     the admin overview.
//   - `type: "photo"` is answered by uploading a photo (or N/A if it can't be
//     done). Add `notePrompt` to show a note box with that prompt, and
//     `noteRequired: true` to make the note necessary before submitting.
//   Any item can also have `photo: true`, which adds a "Photo (recommended)" hint
//   to a normal item (photos are optional there).
//   A photo item with `fromVisit: true` also gets "Import from Ocular Visit",
//   which links every attachment of the job's visit request (e.g. the bills the
//   client uploaded) to the item; the files stay with the visit request.
//
// Answers are saved in Firestore collection `jobChecklists` (see admin.js and
// /firestore.rules); each saved checklist records the CHECKLIST_VERSION it was
// started on.

export const CHECKLIST_VERSION = "2026-10-owner";

const WIFI_OPTIONS = ["Good", "Needs improvement", "Bad"];
const WIFI_FLAGGED = ["Needs improvement", "Bad"];

export const CHECKLISTS = {
    inspection: {
        title: "Site visit",
        short: "Site Visit",
        sections: [
            {
                id: "visit",
                title: "Checklist",
                items: [
                    { id: "tapping-point", type: "photo", text: "Photo of the tapping point / distribution box" },
                    {
                        id: "cable-route", type: "photo", noteRequired: true, notePrompt: "Estimated cable length (meters)",
                        text: "Photo of the house where the cable will run",
                        hint: "Add a note with the estimated length of the cable",
                    },
                    { id: "wifi-test", text: "Wi-Fi signal test on the highest floor of the house", options: WIFI_OPTIONS, flagged: WIFI_FLAGGED },
                    { id: "usage", text: "Client's electricity usage", hint: "Ask the client when they use the most power", options: ["Mostly day", "Mostly night", "Balanced"] },
                    { id: "goal", text: "Client's goal", options: ["To save on the bill", "To go zero bill"] },
                    { id: "drone", type: "photo", text: "Drone shot of the house" },
                    {
                        id: "meralco-bill", type: "photo", fromVisit: true,
                        text: "Latest Meralco bill uploaded",
                        hint: "The “Your Monthly Consumption” graph must be clearly visible",
                    },
                ],
            },
        ],
    },

    installation: {
        title: "Installation",
        short: "Installation",
        sections: [
            {
                id: "install",
                title: "Checklist",
                items: [
                    { id: "materials", text: "Materials needed for the installation prepared" },
                    { id: "maps", text: "Navigated to the site using Maps" },
                    { id: "client-contacted", text: "Client contacted to say you're on the way" },
                    { id: "site-plan", text: "Site inspection and planning done" },
                    { id: "wifi-roof", text: "Wi-Fi tested on the roof", options: WIFI_OPTIONS, flagged: WIFI_FLAGGED },
                    {
                        id: "tsun-app", text: "TSUN Smart app set up before commissioning",
                        hint: "Wi-Fi configuration, system layout and zero export settings",
                    },
                    { id: "roof-clean", text: "Roof cleaned and solar panels wiped" },
                    { id: "tools", text: "Tools put back in the toolbox" },
                    { id: "hq", text: "Headed back to HQ" },
                ],
            },
        ],
    },
};
