// Google Maps Platform key for the address suggestions on "Schedule a Visit"
// (schedule-a-visit/visit-form.js uses Google Places to suggest addresses as
// visitors type, and saves the picked place's location so the admin page can
// open Google Maps directions to it).
//
// Create it in Google Cloud console (the same project as Firebase) →
// APIs & Services → Credentials → Create credentials → API key. Turn on the
// "Maps JavaScript API" and "Places API (New)" for the project, and restrict
// the key:
//   - Application restrictions: Websites: https://hphtechsolutions.com/*,
//     https://www.hphtechsolutions.com/*, and for testing on this Mac
//     http://localhost:5500/* and http://127.0.0.1:5500/* (Google doesn't
//     accept a wildcard port; add a line per port you test on).
//   - API restrictions: Maps JavaScript API and Places API (New) only.
// A restricted key is safe to publish, like the Firebase settings.
//
// If it's ever removed (or starts with "YOUR_"), the address box is a plain text field
// (no suggestions) and everything else works as before.
export const GOOGLE_MAPS_API_KEY = "AIzaSyCespGO9GNqsFyseDEdZmZk-r5NAB5tacI";
