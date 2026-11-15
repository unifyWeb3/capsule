/**
 * The share surface.
 *
 * The link in the X post and the link in the README are the first thing a
 * judge sees, so the card they render has to be right: a title, a sentence
 * that says what the thing is, an image, and one canonical URL.
 *
 * The deployment answers on three aliases, so "which address is this page"
 * is a real question with a real answer, and the answer has to be written
 * down rather than inferred from whichever host the reader arrived on.
 *
 * This test is the gate. It reads the files that are actually served, so a
 * page that loses its tags fails here rather than in somebody's feed.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PUBLIC = path.join(ROOT, "public");

/** The one address the site answers on. */
const CANONICAL_HOST = "https://capsule-phi-blond.vercel.app";

/** The pages, and the address each one lives at. */
const PAGES: Array<[string, string]> = [
  ["index.html", "/"],
  ["cost.html", "/cost"],
  ["runs.html", "/runs"],
  ["run.html", "/run"],
  ["replay.html", "/replay"],
  ["verify.html", "/verify"],
  ["components.html", "/components"],
  ["docs/format.html", "/docs/format"],
  ["docs/security-model.html", "/docs/security-model"],
];

/** The content of one attribute, or null when the attribute is not there. */
function attribute(html: string, name: string, value: string): string | null {
  const pattern = new RegExp(
    `<meta\\s+(?:property|name)=["']${name}["']\\s+content=(?:"([^"]*)"|'([^']*)')`,
  );
  const match = pattern.exec(html);
  return match?.[1] ?? match?.[2] ?? null;
}

/**
 * The text a reader sees.
 *
 * An apostrophe in an attribute may be written as `'` and in the title as
 * `'`, and both say the same thing. The comparison is about what the
 * card shows, so the entities are decoded before the two are compared.
 */
function decode(value: string): string {
  return value
    .replace(/&#x([0-9a-f]+);/gi, (_, code: string) =>
      String.fromCodePoint(Number.parseInt(code, 16)),
    )
    .replace(/&#(\d+);/g, (_, code: string) =>
      String.fromCodePoint(Number.parseInt(code, 10)),
    )
    .replace(/"/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/</g, "<")
    .replace(/>/g, ">")
    .replace(/&/g, "&");
}

/** The href of one link relation. */
function link(html: string, relation: string): string | null {
  const pattern = new RegExp(
    `<link\\s+rel=["']${relation}["']\\s+href=(?:"([^"]*)"|'([^']*)')`,
  );
  const match = pattern.exec(html);
  return match?.[1] ?? match?.[2] ?? null;
}

test("every page states one canonical address, and says so in the card", async () => {
  for (const [file, route] of PAGES) {
    const html = await readFile(path.join(PUBLIC, file), "utf8");
    const where = `${file} (${route})`;

    assert.match(html, /<title>[^<]+<\/title>/, `${where} needs a title`);
    assert.ok(
      attribute(html, "description", ""),
      `${where} needs a meta description`,
    );

    const title = /<title>([^<]+)<\/title>/.exec(html)?.[1];
    assert.equal(
      decode(attribute(html, "og:title", "") ?? ""),
      decode(title ?? ""),
      `${where} needs an og:title that matches its title`,
    );
    assert.equal(
      decode(attribute(html, "twitter:title", "") ?? ""),
      decode(title ?? ""),
      `${where} needs a twitter:title that matches its title`,
    );
    assert.equal(
      decode(attribute(html, "og:description", "") ?? ""),
      decode(attribute(html, "description", "") ?? ""),
      `${where} needs an og:description that matches its description`,
    );
    assert.equal(
      decode(attribute(html, "twitter:description", "") ?? ""),
      decode(attribute(html, "description", "") ?? ""),
      `${where} needs a twitter:description that matches its description`,
    );

    const expected = `${CANONICAL_HOST}${route}`;
    assert.equal(
      attribute(html, "og:url", ""),
      expected,
      `${where} needs og:url pointing at ${expected}`,
    );
    assert.equal(
      link(html, "canonical"),
      expected,
      `${where} needs a canonical link pointing at ${expected}`,
    );

    // The image is on the same host, or the card is half ours.
    const image = attribute(html, "og:image", "");
    assert.ok(image, `${where} needs an og:image`);
    assert.ok(
      image.startsWith(CANONICAL_HOST),
      `${where} needs its og:image on ${CANONICAL_HOST}`,
    );
  }
});

test("every page on disk is in the test, and every page in the test is on disk", async () => {
  const onDisk = new Set<string>();
  async function walk(dir: string, prefix = ""): Promise<void> {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        await walk(path.join(dir, entry.name), relative);
      } else if (entry.name.endsWith(".html")) {
        onDisk.add(relative);
      }
    }
  }
  await walk(PUBLIC);

  const listed = new Set(PAGES.map(([file]) => file));
  for (const file of onDisk) {
    assert.ok(listed.has(file), `${file} is a page, so the test has to know it`);
  }
  for (const file of listed) {
    assert.ok(onDisk.has(file), `${file} is in the test, so it has to be a page`);
  }
});

test("the sitemap lists every page once, and robots points at it", async () => {
  const sitemap = await readFile(path.join(PUBLIC, "sitemap.xml"), "utf8");
  const locations = [...sitemap.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]);

  const expected = PAGES.map(([, route]) => `${CANONICAL_HOST}${route}`);
  assert.deepEqual(
    locations.sort(),
    expected.sort(),
    "the sitemap lists exactly the canonical addresses of the pages",
  );

  const robots = await readFile(path.join(PUBLIC, "robots.txt"), "utf8");
  assert.match(
    robots,
    new RegExp(`Sitemap:\\s*${CANONICAL_HOST}/sitemap\\.xml`),
    "robots.txt points at the sitemap",
  );
  assert.match(robots, /User-agent:\s*\*/, "robots.txt has a user-agent line");
});
