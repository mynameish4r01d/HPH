(function () {
    const dots = document.querySelectorAll('.scroll-dots a');
    const sections = document.querySelectorAll('.panel[id]');

    const sectionObserver = new IntersectionObserver((entries) => {
        const visible = entries.filter((entry) => entry.isIntersecting);
        if (!visible.length) return;

        const dominant = visible.reduce((a, b) => (b.intersectionRatio > a.intersectionRatio ? b : a));

        dots.forEach((dot) => dot.classList.remove('active'));
        const activeDot = document.querySelector(`.scroll-dots a[href="#${dominant.target.id}"]`);
        if (activeDot) activeDot.classList.add('active');
    }, { threshold: [0, 0.25, 0.5, 0.75, 1] });

    sections.forEach((section) => sectionObserver.observe(section));

    const prefersReducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (prefersReducedMotion) return;

    const numerals = document.querySelectorAll('.numeral');
    if (!numerals.length) return;

    let ticking = false;

    function updateParallax() {
        const viewportH = window.innerHeight;
        numerals.forEach((numeral) => {
            const rect = numeral.parentElement.getBoundingClientRect();
            const progress = rect.top / viewportH;
            numeral.style.transform = `translate(-50%, calc(-50% + ${progress * -60}px))`;
        });
        ticking = false;
    }

    window.addEventListener('scroll', () => {
        if (!ticking) {
            requestAnimationFrame(updateParallax);
            ticking = true;
        }
    }, { passive: true });

    updateParallax();
})();
