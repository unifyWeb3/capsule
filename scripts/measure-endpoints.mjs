/**
 * Measure a Capsule deployment.
 *
 * For each endpoint: the latency distribution over N samples, the payload
 * size, and the cache headers. This is the script that produced the tables
 * in `docs/OPTIMIZATION.md`, so the numbers there can be re-checked rather
 * than taken on trust.
 *
 *   node scripts/measure-endpoints.mjs [base-url] [samples]
 *
 * No dependencies: it is plain `fetch`, which is what the deployment uses.
 */
const base = process.argv[2] ?? "https://capsule-phi-blond.vercel.app";
const samples = Number(process.argv[3] ?? 7);

function percentile(values, p) {
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(
    sorted.length - 1,
    Math.max(0, Math.ceil((p / 100) * sorted.length) - 1),
  );
  return sorted[index];
}

const ENDPOINTS = [
  "/",
  "/app.css",
  "/app.js",
  "/proof.json",
  "/runs.json",
  "/runs/recorded.json",
  "/runs/contrast.json",
  "/decision-log.jsonl",
  "/verify?log=" + encodeURIComponent(`${base}/decision-log.jsonl`) + "&format=json",
  "/healthz",
];

const rows = [];

for (const path of ENDPOINTS) {
  const url = path.startsWith("http") ? path : `${base}${path}`;
  const times = [];
  let bytes = 0;
  let headers = {};
  let status = 0;

  for (let i = 0; i < samples; i += 1) {
    const started = process.hrtime.bigint();
    const response = await fetch(url, { headers: { accept: "*/*" } });
    const text = await response.text();
    times.push(Number(process.hrtime.bigint() - started) / 1e6);
    bytes = Buffer.byteLength(text);
    headers = response.headers;
    status = response.status;
  }

  rows.push({
    path: path.length > 46 ? path.slice(0, 44) + "…" : path,
    status,
    bytes,
    min: Math.round(Math.min(...times)),
    median: Math.round(percentile(times, 50)),
    p95: Math.round(percentile(times, 95)),
    cache: headers.get("cache-control") ?? "n/a",
    edge: headers.get("x-vercel-cache") ?? headers.get("x-cache") ?? "n/a",
    age: headers.get("age") ?? "n/a",
  });
}

console.log(
  ["endpoint", "status", "bytes", "min", "median", "p95", "cache-control", "edge", "age"].join(
    " | ",
  ),
);
for (const row of rows) {
  console.log(
    [
      row.path,
      row.status,
      row.bytes,
      `${row.min}ms`,
      `${row.median}ms`,
      `${row.p95}ms`,
      row.cache,
      row.edge,
      row.age,
    ].join(" | "),
  );
}
