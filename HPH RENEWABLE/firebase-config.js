// Firebase web app settings for HPH Renewable's "Schedule a Visit" form.
//
// Paste the values from: Firebase console → Project settings → General →
// Your apps → (your Web app) → SDK setup and configuration → Config.
//
// These values are safe to publish — a Firebase web config only identifies
// the project. What visitors can do is controlled by the Firestore security
// rules in /firestore.rules (they can submit requests, but not read them).
//
// While projectId still starts with "YOUR_", the site keeps opening the old
// Google Form instead of the built-in form.
export const firebaseConfig = {
    apiKey: "YOUR_API_KEY",
    authDomain: "YOUR_PROJECT_ID.firebaseapp.com",
    projectId: "YOUR_PROJECT_ID",
    storageBucket: "YOUR_PROJECT_ID.firebasestorage.app",
    messagingSenderId: "YOUR_SENDER_ID",
    appId: "YOUR_APP_ID",
};
