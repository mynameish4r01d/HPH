// "More below" button for the product pages (plain `defer` script, loaded by
// every page under products/product-pages/ that has a specs sheet).
//
// Adds a round down-arrow button (.pp-more, styled in each page's styles.css)
// that floats just above the page's main button while some of the specs are
// out of view:
// - desktop: over the bottom of the specs column (.desktop .specs-sheet, which
//   scrolls on its own); clicking scrolls the column to its end.
// - phones: above the pinned button bar (.mobile-btn-bar); tapping scrolls the
//   page to the end of the specs (.mobile .specs-sheet).
// It fades out once the end is reached (.pp-more-on), and rechecks when the
// specs' length changes (e.g. the Power Pack's Basic / DIY Kit switch).
(function () {
    const desktopSheet = document.querySelector(".desktop .specs-sheet");
    const mobileSheet = document.querySelector(".mobile .specs-sheet");
    const mobileBar = document.querySelector(".mobile-btn-bar");
    const smooth = () => (window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth");

    function makeButton(extra) {
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = `pp-more${extra}`;
        btn.setAttribute("aria-label", "Scroll to the end of the specs");
        btn.tabIndex = -1;
        btn.innerHTML = '<span class="material-symbols-rounded" aria-hidden="true">arrow_downward</span>';
        return btn;
    }

    const show = (btn, on) => {
        btn.classList.toggle("pp-more-on", on);
        btn.tabIndex = on ? 0 : -1;
    };

    let desktopBtn = null;
    if (desktopSheet && desktopSheet.parentElement) {
        desktopBtn = makeButton("");
        desktopSheet.parentElement.classList.add("pp-more-host");
        desktopSheet.parentElement.append(desktopBtn);
        desktopBtn.addEventListener("click", () => {
            desktopSheet.scrollTo({ top: desktopSheet.scrollHeight, behavior: smooth() });
        });
        desktopSheet.addEventListener("scroll", updateDesktop, { passive: true });
    }

    let mobileBtn = null;
    if (mobileSheet && mobileBar) {
        mobileBtn = makeButton(" pp-more-mobile");
        mobileBar.prepend(mobileBtn);
        mobileBtn.addEventListener("click", () => {
            const target = window.scrollY + mobileSheet.getBoundingClientRect().bottom - (window.innerHeight - mobileBar.offsetHeight) + 16;
            window.scrollTo({ top: target, behavior: smooth() });
        });
        window.addEventListener("scroll", updateMobile, { passive: true });
    }

    function updateDesktop() {
        if (!desktopBtn) return;
        const left = desktopSheet.scrollHeight - desktopSheet.clientHeight - desktopSheet.scrollTop;
        show(desktopBtn, left > 8);
    }

    function updateMobile() {
        if (!mobileBtn) return;
        show(mobileBtn, mobileSheet.getBoundingClientRect().bottom > mobileBar.getBoundingClientRect().top + 8);
    }

    function update() {
        updateDesktop();
        updateMobile();
    }

    window.addEventListener("resize", update);
    window.addEventListener("load", update);
    // The desktop sheet keeps its size while its content grows, so watch the
    // sections inside it too.
    if (window.ResizeObserver) {
        const ro = new ResizeObserver(update);
        [desktopSheet, mobileSheet].forEach((sheet) => {
            if (!sheet) return;
            ro.observe(sheet);
            Array.from(sheet.children).forEach((child) => ro.observe(child));
        });
    }
    update();
})();
