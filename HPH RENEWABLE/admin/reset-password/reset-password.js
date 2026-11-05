// "Choose a new password": the page Firebase's password-reset email opens.
// The email's link carries ?mode=resetPassword&oobCode=<code>. The code is
// checked first (it shows whose password this is), then the new password is
// saved with it. Set this page's address as the action URL in Firebase console
// → Authentication → Templates → Password reset → Customize action URL.

import { firebaseConfig } from "../../firebase-config.js";

const FIREBASE_VERSION = "12.3.0";
const MIN_LENGTH = 8;

const intro = document.querySelector(".reset-intro");
const form = document.querySelector(".reset-form");
const error = form.querySelector(".admin-error");
const button = form.querySelector(".admin-button");
const done = document.querySelector(".reset-done");

const params = new URLSearchParams(window.location.search);
const mode = params.get("mode");
const code = params.get("oobCode");

function stop(message) {
    intro.textContent = message;
    form.hidden = true;
    done.hidden = false;
    done.textContent = "Back to sign in";
}

function errorMessage(err) {
    switch (err.code) {
        case "auth/expired-action-code":
            return "This link has expired. Go back to sign in and use “Forgot your password?” to get a new one.";
        case "auth/invalid-action-code":
            return "This link isn't valid, or it has already been used. Go back to sign in and use “Forgot your password?” to get a new one.";
        case "auth/weak-password":
            return `Please choose a stronger password (at least ${MIN_LENGTH} characters).`;
        case "auth/network-request-failed":
            return "Couldn't reach the server. Check your connection and try again.";
        default:
            return "Something went wrong. Please try again.";
    }
}

if (mode !== "resetPassword" || !code) {
    stop("This page is for password reset links. Go back to sign in and use “Forgot your password?” to get one.");
} else {
    try {
        const base = `https://www.gstatic.com/firebasejs/${FIREBASE_VERSION}`;
        const [appSdk, authSdk] = await Promise.all([
            import(`${base}/firebase-app.js`),
            import(`${base}/firebase-auth.js`),
        ]);
        const auth = authSdk.getAuth(appSdk.initializeApp(firebaseConfig));

        let email;
        try {
            email = await authSdk.verifyPasswordResetCode(auth, code);
        } catch (err) {
            console.error("Reset password: link check failed", err);
            stop(errorMessage(err));
            throw err;
        }

        intro.textContent = `Choose a new password for ${email}.`;
        form.hidden = false;
        form.password.focus();

        form.addEventListener("submit", async (e) => {
            e.preventDefault();
            error.hidden = true;
            const showError = (message) => {
                error.textContent = message;
                error.hidden = false;
            };
            if (form.password.value.length < MIN_LENGTH) return showError(`Use at least ${MIN_LENGTH} characters.`);
            if (form.password.value !== form.confirm.value) return showError("The two passwords don't match.");

            button.disabled = true;
            button.textContent = "Saving…";
            try {
                await authSdk.confirmPasswordReset(auth, code, form.password.value);
                form.reset();
                form.hidden = true;
                intro.textContent = "Your password has been changed. You can now sign in with your new password.";
                done.hidden = false;
            } catch (err) {
                console.error("Reset password: couldn't save", err);
                showError(errorMessage(err));
            } finally {
                button.disabled = false;
                button.textContent = "Save new password";
            }
        });
    } catch (err) {
        // A bad link was already explained above; this is for the tools not loading.
        if (intro.textContent === "Checking your link…") {
            stop("Couldn't load the page's tools. Check your connection and reload.");
        }
    }
}
