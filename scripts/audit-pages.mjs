/**
 * The browser audit.
 *
 * Every page of the site, at a wide and a narrow viewport, checked for the
 * three things a page gets wrong quietly:
 *
 *   1. a console error or a failed request,
 *   2. content that overflows the viewport,
 *   3. text that is too low-contrast to read.
 *
 * It also counts the things a page is supposed to contain, so a page that
 * renders empty is a failure rather than a quiet success.
 *
 *   node scripts/audit-pages.mjs [base-url]
 *
 * The browser is the one Chromium build Playwright has cached. Set
 * PLAYWRIGHT_CHROMIUM to point at a different one.
 */
import { existsSync, readdirSync } from "node:fs";
import { chromium } from "playwright-core";

const base = process.argv[2] ?? "https://capsule-phi-blond.vercel.app";

// The third-party path fetches somebody else's log over HTTP *from the server*,
// and the SSRF guard refuses loopback addresses — which is the correct behaviour,
// not a bug. So when the audit is pointed at a local server, the two pages that
// fetch a log cannot work: the server will not fetch itself. They are skipped and
// said to be skipped, rather than reported red.
const isLoopback = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:|\/|$)/.test(base);
const SKIPPED_ON_LOOPBACK = new Set(["05-verify-trace", "08-verify-foreign"]);

/** Where the cached Chromium lives, if the default path is not there. */
function findChromium() {
  if (process.env.PLAYWRIGHT_CHROMIUM) return process.env.PLAYWRIGHT_CHROMIUM;
  const root = `${process.env.HOME ?? "/home/unify"}/.cache/ms-playwright`;
  if (!existsSync(root)) return undefined;
  for (const entry of readdirSync(root)) {
    if (!entry.startsWith("chromium-")) continue;
    const path = `${root}/${entry}/chrome-linux64/chrome`;
    if (existsSync(path)) return path;
  }
  return undefined;
}

const PAGES = [
  ["00-index", "/"],
  ["01-runs", "/runs"],
  ["02-run-recorded", "/run?id=recorded"],
  ["03-run-contrast", "/run?id=contrast"],
  ["04-verify-empty", "/verify"],
  [
    "05-verify-trace",
    "/verify?log=" + encodeURIComponent(`${base}/decision-log.jsonl`),
  ],
  ["06-security-model", "/docs/security-model"],
  ["07-format", "/docs/format"],
  [
    "08-verify-foreign",
    "/verify?log=" + encodeURIComponent(`${base}/examples/foreign-log.jsonl`),
  ],
  ["09-components", "/components"],
  ["10-replay", "/replay"],
];

/** The counts that say a page rendered something rather than nothing. */
const COUNTS = {
  replaySteps: ".replay-steps .replay-step",
  trace: ".trace li",
  record: ".record li",
  runcards: ".runcard",
  whyModel: ".why-model",
  callout: ".callout",
};

/**
 * What each page must contain.
 *
 * A page that renders nothing is a failure, not a quiet success — and that is
 * exactly the bug this list was written for: a list of markup was interpolated
 * as text, so the record came out as escaped source on every page and the
 * browser reported no errors at all.
 */
const MUST_CONTAIN = {
  "00-index": ["record", "callout"],
  "10-replay": ["replaySteps"],
  "01-runs": ["runcards"],
  "02-run-recorded": ["record"],
  "03-run-contrast": ["record"],
  "05-verify-trace": ["trace", "record"],
  "08-verify-foreign": ["trace", "record"],
  "09-components": ["record"],
};

const VIEWPORTS = [
  ["wide", { width: 1440, height: 1000 }],
  ["narrow", { width: 390, height: 844 }],
];

/** The contrast floor. The site's own palette is designed around it. */
const MIN_CONTRAST = 4.5;

const browser = await chromium.launch({
  executablePath: findChromium(),
  args: ["--no-sandbox", "--disable-dev-shm-usage"],
});

const findings = [];

for (const [label, path] of PAGES) {
  if (isLoopback && SKIPPED_ON_LOOPBACK.has(label)) {
    for (const size of VIEWPORTS.map(([size]) => size)) {
      console.log(
        `${label.padEnd(20)} ${size.padEnd(7)} SKIP: the server refuses to fetch a loopback log URL (SSRF guard)`,
      );
    }
    continue;
  }
  for (const [size, viewport] of VIEWPORTS) {
    const context = await browser.newContext({ viewport });
    const page = await context.newPage();
    const problems = [];
    const errors = [];

    page.on("console", (message) => {
      if (message.type() === "error") errors.push(message.text().slice(0, 120));
    });
    page.on("pageerror", (error) => errors.push(String(error).slice(0, 120)));
    page.on("requestfailed", (request) => {
      errors.push(`request failed: ${request.url().slice(0, 90)}`);
    });

    try {
      await page.goto(`${base}${path}`, { waitUntil: "networkidle", timeout: 45_000 });
      await page.waitForTimeout(1_200);

      const report = await page.evaluate(
        ({ counts, minContrast }) => {
          const parse = (value) => {
            const match = value.match(/rgba?\(([^)]+)\)/);
            if (!match) return null;
            const parts = match[1].split(",").map((n) => Number.parseFloat(n));
            return { r: parts[0], g: parts[1], b: parts[2], a: parts[3] ?? 1 };
          };
          const luminance = ({ r, g, b }) => {
            const channel = (v) => {
              const c = v / 255;
              return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
            };
            return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
          };
          const over = (fg, bg) => ({
            r: fg.r * fg.a + bg.r * (1 - fg.a),
            g: fg.g * fg.a + bg.g * (1 - fg.a),
            b: fg.b * fg.a + bg.b * (1 - fg.a),
            a: 1,
          });
          const backgroundOf = (element) => {
            let node = element;
            while (node) {
              const colour = parse(getComputedStyle(node).backgroundColor);
              if (colour && colour.a > 0) return colour;
              node = node.parentElement;
            }
            return { r: 11, g: 13, b: 16, a: 1 };
          };

          // 1. overflow
          //
          // An element that sticks out is only a problem if nothing clips it.
          // A link parked off-screen inside an `overflow: hidden` box scrolls
          // nothing; the page-level scrollWidth check below is the real test.
          const overflow = [];
          const width = document.documentElement.clientWidth;
          const clipped = (element) => {
            let node = element.parentElement;
            while (node) {
              const overflowX = getComputedStyle(node).overflowX;
              if (overflowX === "hidden" || overflowX === "auto" || overflowX === "scroll") {
                return true;
              }
              node = node.parentElement;
            }
            return false;
          };
          for (const element of document.querySelectorAll("body *")) {
            const box = element.getBoundingClientRect();
            if (box.width === 0 && box.height === 0) continue;
            if ((box.right > width + 1 || box.left < -1) && !clipped(element)) {
              overflow.push(
                `${element.tagName}.${String(element.className).slice(0, 24)}`,
              );
            }
          }

          // 2. contrast
          const contrast = [];
          const seen = new Set();
          for (const element of document.querySelectorAll(
            "h1,h2,h3,h4,p,span,a,button,td,th,li,label,code",
          )) {
            const text = (element.textContent ?? "").trim();
            if (!text) continue;
            const style = getComputedStyle(element);
            if (style.visibility === "hidden" || style.opacity === "0") continue;
            const foreground = parse(style.color);
            if (!foreground || foreground.a === 0) continue;
            const background = backgroundOf(element);
            const composed = over(foreground, background);
            const l1 = luminance(composed);
            const l2 = luminance(background);
            const ratio =
              (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
            if (ratio < minContrast) {
              const key = `${element.tagName}.${String(element.className)}`;
              if (seen.has(key)) continue;
              seen.add(key);
              contrast.push(
                `${key} ${ratio.toFixed(2)} < ${minContrast} (${text.slice(0, 24)})`,
              );
            }
          }

          // 3. did it render anything
          const rendered = {};
          for (const [name, selector] of Object.entries(counts)) {
            rendered[name] = document.querySelectorAll(selector).length;
          }

          return {
            h1: document.querySelector("h1")?.textContent?.replace(/\s+/g, " ").trim() ?? "",
            overflow: overflow.slice(0, 8),
            contrast: contrast.slice(0, 8),
            rendered,
            // A failure state is a problem unless it is an *example* of one:
            // the component gallery deliberately renders every state.
            failedStates: [...document.querySelectorAll(".state-failed")].filter(
              (node) => !node.closest(".demo"),
            ).length,
            emptyStates: document.querySelectorAll(".state-empty").length,
            scrollWidth: document.documentElement.scrollWidth,
          };
        },
        { counts: COUNTS, minContrast: MIN_CONTRAST },
      );

      if (errors.length) problems.push(`errors: ${errors.slice(0, 3).join(" | ")}`);
      if (report.overflow.length) problems.push(`overflow: ${JSON.stringify(report.overflow)}`);
      if (report.contrast.length) problems.push(`contrast ${report.contrast.join("; ")}`);
      if (report.scrollWidth > viewport.width + 1) {
        problems.push(`the page scrolls sideways (${report.scrollWidth} > ${viewport.width})`);
      }
      // A page that caught its own error and rendered a failure box is broken.
      // The browser is happy with it, which is exactly why it needs a check.
      if (report.failedStates) {
        problems.push(`the page rendered ${report.failedStates} failure state(s)`);
      }
      for (const what of MUST_CONTAIN[label] ?? []) {
        if (!report.rendered[what]) {
          problems.push(`the page rendered no ${what} (${report.rendered[what]})`);
        }
      }

      console.log(
        `${label.padEnd(20)} ${size.padEnd(7)} h1="${report.h1.slice(0, 48)}" ` +
          `counts=${JSON.stringify(report.rendered)}  ${problems.length ? "PROBLEMS" : "ok"}`,
      );
      for (const problem of problems) console.log(`    ${problem}`);
      if (problems.length) findings.push(`${label} (${size}): ${problems.join("; ")}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.log(`${label.padEnd(20)} ${size.padEnd(7)} FAILED: ${message.slice(0, 120)}`);
      findings.push(`${label} (${size}): ${message.slice(0, 160)}`);
    } finally {
      await context.close();
    }
  }
}

await browser.close();

console.log("\n=== findings ===");
console.log(findings.length ? findings.join("\n") : "none");
process.exit(findings.length ? 1 : 0);
