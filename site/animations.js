/* ===================================================================
 * Vibecoder — Reusable GSAP Animation Module  (site/animations.js)
 * Patterns sourced from greensock/gsap-skills:
 *   gsap-core      — tweens, eases, stagger, gsap.matchMedia()
 *   gsap-timeline  — sequencing, labels, paused timelines
 *   gsap-scrolltrigger — scroll-linked reveal, scrub (used ONLY for ambient
 *                       effects like nav background — NOT for content reveals,
 *                       because the site's content uses a vanilla IntersectionObserver
 *                       with .reveal-hidden/.show classes and GSAP tweens on the
 *                       same elements would override the observer's inline styles)
 *   gsap-plugins   — SplitText (wordmark stagger), ScrollTrigger.register
 *   gsap-utils     — gsap.utils.mapRange for scroll-linked values
 *   gsap-performance — transform/opacity only, will-change, stagger over manual delays
 *
 * GSAP 3.15.0 installed locally in site/node_modules/gsap.
 * Load order in index.html:
 *   1. gsap.min.js          (core + CSSPlugin)
 *   2. ScrollTrigger.min.js
 *   3. SplitText.min.js     (optional — wordmark character split)
 *   4. animations.js        (this module)
 *
 * Content reveal strategy:
 *   The HTML uses a vanilla IntersectionObserver that adds .show to
 *   .reveal-hidden elements when they scroll into view. That observer
 *   lives in the inline <script> at the bottom of <body>. GSAP does NOT
 *   touch .reveal or .reveal-hidden elements, so the observer stays in
 *   full control of content visibility. GSAP is used ONLY for:
 *   - Hero entrance (hero-tag, hero-visual, hero-cta, wordmark)
 *   - Interactive flow demo timeline (flow-step, flow-arrow, replay)
 *   - Terminal typing demo (terminal mock pre)
 *   - Ambient glow pulse, nav background scroll effect
 *   These are elements WITHOUT .reveal-hidden on them, so there's no
 *   conflict with the observer.
 * =================================================================== */

"use strict";

/* ---- module state ---- */
let _registered = false;
const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");

/* ---- registration (idempotent) ---- */
function ensureRegistered() {
  if (_registered) return;
  if (typeof gsap === "undefined") {
    return;
  }
  const plugins = [ScrollTrigger];
  if (typeof SplitText !== "undefined") plugins.push(SplitText);
  gsap.registerPlugin.apply(gsap, plugins);
  _registered = true;
}

/* ===================================================================
 * Public API — reusable animation functions
 * Drop these into any page that loads GSAP + this module.
 * =================================================================== */

/* heroEntrance() — staggered hero entrance: hero-tag, hero-visual, ctas.
 * Called once on load. Targets elements that do NOT have .reveal-hidden,
 * so it never fights the IntersectionObserver. */
function heroEntrance() {
  ensureRegistered();
  if (reducedMotion.matches) {
    gsap.set(".hero-tag, .hero-visual, .hero-cta", { autoAlpha: 1, y: 0, scale: 1 });
    return;
  }
  gsap.from(".hero-tag", {
    autoAlpha: 0, y: 16, duration: 0.6, ease: "power2.out", delay: 0.25
  });
  gsap.from(".hero-visual", {
    autoAlpha: 0, scale: 0.94, duration: 0.9, ease: "power3.out", delay: 0.45
  });
  gsap.from(".hero-cta", {
    autoAlpha: 0, y: 20, duration: 0.5, ease: "power2.out",
    stagger: 0.12, delay: 0.65
  });
}

/* wordmarkEntrance() — staggered character entrance for #wordmark.
 * Uses SplitText if available, otherwise wraps each character manually. */
function wordmarkEntrance() {
  ensureRegistered();
  const wordmark = document.querySelector("#wordmark");
  if (!wordmark) return;
  if (reducedMotion.matches) {
    gsap.set(wordmark, { autoAlpha: 1 });
    return;
  }
  let chars;
  if (typeof SplitText !== "undefined") {
    const split = new SplitText(wordmark, { type: "chars", charsClass: "split-char" });
    chars = split.chars;
  } else {
    const text = wordmark.textContent;
    wordmark.textContent = "";
    for (let i = 0; i < text.length; i++) {
      const ch = document.createElement("span");
      ch.textContent = text[i];
      ch.style.display = "inline-block";
      wordmark.appendChild(ch);
    }
    chars = wordmark.querySelectorAll("span");
  }
  gsap.set(chars, { autoAlpha: 0, y: 14 });
  gsap.to(chars, {
    autoAlpha: 1, y: 0, duration: 0.5, ease: "power2.out",
    stagger: { each: 0.055, from: "center" },
    delay: 0.1
  });
}

/* flowTimeline() — GSAP timeline sequences the interactive loop demo.
 * Returns the timeline so callers can control it (pause/resume/restart).
 * Steps are visible by default (CSS); GSAP adds a staggered entrance animation
 * (lift + fade-in per step) so the section always shows content even if GSAP
 * is slow or fails to load. */
function flowTimeline() {
  ensureRegistered();
  const steps = document.querySelectorAll(".flow-step");
  const arrows = document.querySelectorAll(".flow-arrow");
  const replayBtn = document.getElementById("flow-play");
  if (!steps.length) return null;
  if (reducedMotion.matches) {
    gsap.set(".flow-step, .flow-arrow", { autoAlpha: 1, y: 0, scale: 1, opacity: 1 });
    return null;
  }
  // Steps are visible by default (CSS); GSAP adds a staggered entrance (lift +
  // scale) so the section always shows content. autoAlpha:1 in FROM vars keeps
  // steps visible throughout — never blank. Arrows fade in after each step.
  const tl = gsap.timeline({ paused: true });
  steps.forEach((step, i) => {
    tl.fromTo(step, { autoAlpha: 1, y: 24, scale: 0.95 }, {
      autoAlpha: 1, y: 0, scale: 1, duration: 0.55, ease: "back.out(1.4)"
    }, i * 0.12);
    if (arrows[i]) {
      tl.to(arrows[i], {
        autoAlpha: 1, opacity: 1, duration: 0.35, ease: "power2.out"
      }, "-=0.25");
    }
  });
  tl.to(replayBtn || {}, { scale: 1.05, duration: 0.3, ease: "power1.inOut", yoyo: true, repeat: 1 }, "-=0.1");
  tl.play();
  if (replayBtn) {
    replayBtn.addEventListener("click", () => {
      tl.restart();
      gsap.fromTo(replayBtn, { scale: 0.92 }, { scale: 1, duration: 0.25, ease: "power2.out" });
    });
  }
  return tl;
}

/* terminalTyping() — cycles sample commands through the hero terminal mock.
 * Shows the product working live (not decoration): each line appears, pauses,
 * then the next. Loops back to the start after the last line. */
function terminalTyping() {
  ensureRegistered();
  if (reducedMotion.matches) {
    const term = document.querySelector(".terminal-mock .terminal-body pre");
    if (term) term.textContent = "Build a small Python tool to rename photos in a folder.";
    return;
  }
  const term = document.querySelector(".terminal-mock .terminal-body pre");
  if (!term) return;
  const lines = [
    "$ vibecoder --prompt \"Build a small Python tool to rename photos in a folder.\"",
    "→ Understand: rename photos in a folder by date → plan → exec → verify",
    "→ Created rename_photos.py — tests pass.",
    "✓ Done in 5 steps."
  ];
  let idx = 0;
  function showNext() {
    if (idx > 0) {
      gsap.delayedCall(1800, () => {
        idx++;
        if (idx < lines.length) {
          gsap.fromTo(term, { autoAlpha: 0, y: 6 }, {
            autoAlpha: 1, y: 0, duration: 0.35, ease: "power2.out",
            onComplete: showNext
          });
          term.textContent = lines[idx];
        } else {
          gsap.delayedCall(2600, () => {
            idx = 0;
            gsap.to(term, { autoAlpha: 0, duration: 0.25, onComplete: () => {
              term.textContent = lines[0];
              gsap.to(term, { autoAlpha: 1, duration: 0.3, onComplete: showNext });
            }});
          });
        }
      });
    } else {
      term.textContent = lines[0];
      gsap.delayedCall(2200, showNext);
    }
  }
  showNext();
}

/* ambientGlow() — subtle pulse behind the hero visual. Loop, low-impact,
 * transform + opacity only (compositor-friendly per gsap-performance). */
function ambientGlow() {
  ensureRegistered();
  if (reducedMotion.matches) return;
  const glow = document.querySelector(".hero-glow");
  if (!glow) return;
  gsap.to(glow, {
    scale: 1.08, opacity: 0.55,
    duration: 4.5, ease: "sine.inOut", repeat: -1, yoyo: true
  });
}

/* navScrollEffect() — nav background fades in as you scroll (ScrollTrigger scrub).
 * Starts transparent at top, becomes opaque by the time you've scrolled a bit. */
function navScrollEffect() {
  ensureRegistered();
  const nav = document.querySelector("nav");
  if (!nav) return;
  if (reducedMotion.matches) {
    gsap.set(nav, { background: "rgba(8,10,14,0.92)" });
    return;
  }
  gsap.fromTo(nav, { background: "rgba(8,10,14,0.0)" }, {
    background: "rgba(8,10,14,0.92)",
    duration: 0.8, ease: "power2.out",
    scrollTrigger: { trigger: "body", start: "top -180", end: "top 80", scrub: 1.2 }
  });
}

/* smoothNavScroll() — intercept nav link clicks for smooth scroll + active state.
 * Uses native scrollIntoView (works everywhere modern). Wires active class. */
function smoothNavScroll() {
  document.querySelectorAll("nav a[href^='#']").forEach((a) => {
    a.addEventListener("click", (e) => {
      const id = a.getAttribute("href").slice(1);
      const target = document.getElementById(id);
      if (!target) return;
      e.preventDefault();
      target.scrollIntoView({ behavior: "smooth", block: "start" });
      document.querySelectorAll("nav a").forEach((l) => l.classList.remove("active"));
      a.classList.add("active");
    });
  });
}

/* ===================================================================
 * init() — called once on DOMContentLoaded.
 * Sets reduced-motion fallbacks (immediate show), then runs GSAP-only
 * animations. Does NOT touch .reveal or .reveal-hidden elements — those
 * are handled by the vanilla IntersectionObserver in the inline script.
 * =================================================================== */
function init() {
  ensureRegistered();

  // Reduced motion: set all GSAP-animated elements to visible immediately.
  // (The .reveal-hidden elements are already visible via CSS default —
  //  .reveal has opacity:1 — and the observer will animate them if present.)
  if (reducedMotion.matches) {
    const stillHidden = [
      ".hero-tag", ".hero-visual", ".hero-cta",
      ".flow-step", ".flow-arrow",
    ];
    stillHidden.forEach((s) => gsap.set(s, { autoAlpha: 1, y: 0, x: 0, scale: 1, opacity: 1 }));
    const term = document.querySelector(".terminal-mock .terminal-body pre");
    if (term) term.textContent = "Build a small Python tool to rename photos in a folder.";
    return;
  }

  heroEntrance();
  wordmarkEntrance();
  flowTimeline();
  terminalTyping();
  ambientGlow();
  smoothNavScroll();
  navScrollEffect();

  // Refresh ScrollTrigger after layout settles
  if (typeof ScrollTrigger !== "undefined") {
    ScrollTrigger.refresh();
    window.addEventListener("load", () => { if (typeof ScrollTrigger !== "undefined") ScrollTrigger.refresh(); });
  }
}

/* ===================================================================
 * boot() — safe loader. Polls until gsap is available, then calls init()
 * after DOMContentLoaded (or immediately if already ready).
 * =================================================================== */
function boot() {
  if (typeof gsap === "undefined") {
    setTimeout(boot, 150);
    return;
  }
  ensureRegistered();
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
}

// If the DOM is already ready when this script executes, boot immediately.
if (document.readyState === "complete" || document.readyState === "interactive") {
  boot();
} else {
  document.addEventListener("DOMContentLoaded", boot);
}

// ── Scroll-triggered reveals for new sections (opencode.ai-style) ──

const revealElements = () => {
  if (typeof gsap === 'undefined' || typeof ScrollTrigger === 'undefined') return;

  // Feature bullet list items
  const featureItems = document.querySelectorAll('#features .flow-step');
  // Actually features use a different structure now — use the bullet rows
  const bulletRows = document.querySelectorAll('#features div[style*="border-bottom"]');
  
  // Trust bar
  const trustBar = document.querySelector('#trust-bar');
  
  // FAQ items
  const faqItems = document.querySelectorAll('#faq div[style*="border-bottom"]');
  
  // Privacy section
  const privacySection = document.querySelector('#privacy');
  
  // Curated models
  const curatedSection = document.querySelector('#curated-models');
  
  // Waitlist
  const waitlistSection = document.querySelector('#waitlist');

  // Helper: reveal a set of elements with stagger
  const revealStaggered = (elems, opts = {}) => {
    if (!elems || elems.length === 0) return;
    gsap.fromTo(elems, 
      { opacity: 0, y: 24 },
      { 
        opacity: 1, y: 0, 
        duration: opts.duration || 0.5, 
        stagger: opts.stagger || 0.08,
        ease: 'power3.out',
        scrollTrigger: {
          trigger: elems[0].parentElement || elems[0],
          start: 'top 88%',
          toggleActions: 'play none none none',
        }
      }
    );
  };

  // Reveal feature bullet rows
  if (bulletRows && bulletRows.length > 0) {
    revealStaggered(bulletRows, { duration: 0.45, stagger: 0.06 });
  }

  // Reveal FAQ items
  if (faqItems && faqItems.length > 0) {
    revealStaggered(faqItems, { duration: 0.4, stagger: 0.05 });
  }

  // Reveal privacy section content
  if (privacySection) {
    gsap.fromTo(privacySection.querySelectorAll('h2, p, div[style]'),
      { opacity: 0, y: 20 },
      { 
        opacity: 1, y: 0, 
        duration: 0.5, 
        stagger: 0.08,
        ease: 'power3.out',
        scrollTrigger: {
          trigger: privacySection,
          start: 'top 85%',
          toggleActions: 'play none none none',
        }
      }
    );
  }

  // Reveal curated models section
  if (curatedSection) {
    gsap.fromTo(curatedSection.querySelectorAll('h2, p, div[style]'),
      { opacity: 0, y: 20 },
      { 
        opacity: 1, y: 0, 
        duration: 0.5, 
        stagger: 0.08,
        ease: 'power3.out',
        scrollTrigger: {
          trigger: curatedSection,
          start: 'top 85%',
          toggleActions: 'play none none none',
        }
      }
    );
  }

  // Reveal waitlist section
  if (waitlistSection) {
    gsap.fromTo(waitlistSection.querySelectorAll('h2, p, div[style]'),
      { opacity: 0, y: 20 },
      { 
        opacity: 1, y: 0, 
        duration: 0.5, 
        stagger: 0.08,
        ease: 'power3.out',
        scrollTrigger: {
          trigger: waitlistSection,
          start: 'top 85%',
          toggleActions: 'play none none none',
        }
      }
    );
  }
};

// Run after DOM ready and after GSAP animations
document.addEventListener('DOMContentLoaded', () => {
  // Wait a tick for GSAP to be ready
  setTimeout(revealElements, 200);
});

// Also run after the main timeline completes
if (typeof animationsReady === 'function') {
  animationsReady(revealElements);
}
