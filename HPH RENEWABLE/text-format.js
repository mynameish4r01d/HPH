// Tidies names and addresses typed in ALL CAPS or all lowercase, e.g.
// "harold t. hermosa" → "Harold T. Hermosa". Used by every website form
// (Schedule a Visit, Join the Waitlist, Feedback, NDA), which tidy a field
// when the visitor leaves it, and by the admin page, which shows older
// entries tidied.
//
// Words typed in mixed case (McDonald, DeGuia) are left as typed. In
// addresses, an all-caps word in otherwise normal text is kept too, since it's
// usually an acronym (BGC, QC, SM).

const HAS_LETTER = /\p{L}/u;
const isLower = (s) => s === s.toLowerCase() && s !== s.toUpperCase();
const isUpper = (s) => s === s.toUpperCase() && s !== s.toLowerCase();
// Jose Rizal III, Phase IV: kept in capitals (in names only as the last word,
// so a name like "Vi" isn't changed; in addresses anywhere but first).
const ROMAN = /^(ii|iii|iv|vi|vii|viii|ix)$/i;
// 12th, 3rd: the suffix stays lowercase.
const ORDINAL = /^\d+(st|nd|rd|th)$/i;

function capitalise(part) {
    const lower = part.toLowerCase();
    const i = lower.search(HAS_LETTER);
    return i < 0 ? part : lower.slice(0, i) + lower[i].toUpperCase() + lower.slice(i + 1);
}

// One word, tidied piece by piece across - ' . / (Mary-Jane, O'Brien, T.).
// `keepCaps`: leave all-caps pieces alone (addresses in normal text).
function tidyWord(word, romanOk, keepCaps) {
    return word.split(/([-'’./])/).map((part) => {
        if (!HAS_LETTER.test(part)) return part;
        if (/\d/.test(part)) return ORDINAL.test(part) ? part.toLowerCase() : part.toUpperCase();
        if (romanOk && ROMAN.test(part.replace(/[^\p{L}]/gu, ""))) return part.toUpperCase();
        if (isLower(part)) return capitalise(part);
        if (isUpper(part) && !keepCaps) return capitalise(part);
        return part;
    }).join("");
}

const words = (text) => String(text || "").trim().split(/\s+/).filter(Boolean);

export function tidyName(text) {
    const list = words(text);
    return list.map((word, i) => tidyWord(word, i > 0 && i === list.length - 1, false)).join(" ");
}

export function tidyAddress(text) {
    // Typed all in capitals or all in lowercase: tidy every word. Otherwise
    // only all-lowercase words get a capital.
    const letters = String(text || "").replace(/[^\p{L}]/gu, "");
    const keepCaps = !(isUpper(letters) || isLower(letters));
    return words(text).map((word, i) => tidyWord(word, i > 0, keepCaps)).join(" ");
}

// Tidies an input when the visitor leaves it (so they see what's saved).
export function tidyOnBlur(input, tidy) {
    if (!input) return;
    input.addEventListener("blur", () => {
        const tidied = tidy(input.value);
        if (tidied !== input.value) input.value = tidied;
    });
}
