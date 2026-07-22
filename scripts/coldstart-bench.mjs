// Cold-start benchmark: drive the REAL site in real Chromium, cold (fresh profile, empty
// IndexedDB) and attribute the wall clock to a phase instead of the five coarse rows the
// on-page panel shows. Each round reports the chain the user actually waits through:
//
//   pkc-js boot → seeder dial → seeder subscription gossip → 63 joins → root fetches →
//   first tally → pkc-js community loads
//
// The point is A/B: every knob the app reads from the query string is settable here, so
// "does the fetch limiter still earn its keep" is a measurement, not an argument.
//
// Usage:
//   node scripts/coldstart-bench.mjs                             # defaults (as shipped)
//   ROUNDS=5 LABEL=baseline node scripts/coldstart-bench.mjs
//   QUERY='fetchLimit=0&joinLimit=0&waitSeeder=0' LABEL=no-limits node scripts/coldstart-bench.mjs
//
// Env: ROUNDS (3), TARGET_COMMUNITIES (6), TIMEOUT_MS (180000), QUERY, LABEL, HEADED=1,
//      SKIP_BUILD=1, APPEND_JSONL=results/coldstart.jsonl, PORT (0 = pick a free one)

import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import { execSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
// Playwright lives in the pkc-js checkout (same pattern as the browser-bench harness in
// investigate_why_5chan_p2p_is_slow); fall back to a local install if there is one.
const PLAYWRIGHT_FROM = process.env.PLAYWRIGHT_FROM || "/home/user2/Nextcloud/projects/plebbit/pkc-js";
const require = createRequire(path.join(PLAYWRIGHT_FROM, "package.json"));
const { chromium } = require("playwright");

const ROUNDS = Number(process.env.ROUNDS ?? 3);
const TARGET_COMMUNITIES = Number(process.env.TARGET_COMMUNITIES ?? 6);
const TIMEOUT_MS = Number(process.env.TIMEOUT_MS ?? 180_000);
const QUERY = process.env.QUERY ?? "";
const LABEL = process.env.LABEL ?? (QUERY || "default");
const APPEND_JSONL = process.env.APPEND_JSONL;

const fmt = (ms) => (ms == null ? "     —" : `${(ms / 1000).toFixed(2)}s`.padStart(6));

/* ---------- build + serve dist ---------- */
if (!process.env.SKIP_BUILD) {
    console.log("building site…");
    execSync("npx vite build", { cwd: ROOT, stdio: "inherit" });
}
const DIST = path.join(ROOT, "dist");
const MIME = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".svg": "image/svg+xml" };
const server = http.createServer((req, res) => {
    const rel = decodeURIComponent(new URL(req.url, "http://x").pathname);
    const file = path.join(DIST, rel === "/" ? "index.html" : rel);
    if (!file.startsWith(DIST) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
        res.writeHead(404).end("not found");
        return;
    }
    res.writeHead(200, { "content-type": MIME[path.extname(file)] ?? "application/octet-stream" });
    fs.createReadStream(file).pipe(res);
});
await new Promise((r) => server.listen(Number(process.env.PORT ?? 0), "127.0.0.1", r));
const origin = `http://127.0.0.1:${server.address().port}`;
console.log(`serving ${DIST} at ${origin}`);

/* ---------- one cold round ---------- */
async function round(browser, n) {
    // A brand-new context per round is what makes this a COLD start: pubsub-voting persists
    // checkpoints in IndexedDB and would otherwise restore the tally from disk, which is a
    // different (and much faster) code path than the one we are trying to measure.
    const context = await browser.newContext();
    const page = await context.newPage();
    const consoleLines = [];
    page.on("console", (msg) => consoleLines.push(msg.text()));
    page.on("pageerror", (err) => consoleLines.push(`PAGEERROR ${err.message}`));

    const url = `${origin}/${QUERY ? `?${QUERY}` : ""}`;
    const startedAt = Date.now();
    await page.goto(url, { waitUntil: "commit" });

    let timedOut = false;
    try {
        await page.waitForFunction(
            (target) => (window.__phases ?? []).filter((p) => p.kind === "community-loaded").length >= target,
            TARGET_COMMUNITIES,
            { timeout: TIMEOUT_MS, polling: 250 }
        );
    } catch {
        timedOut = true;
    }
    const phases = await page.evaluate(() => window.__phases ?? []);
    const bench = await page.evaluate(() => window.__bench ?? []);
    await context.close();
    return { n, wallMs: Date.now() - startedAt, timedOut, phases, bench, consoleLines };
}

/* ---------- attribute the timeline to phases ---------- */
const at = (phases, kind, label) =>
    phases.find((p) => p.kind === kind && (label === undefined || p.label === label))?.atMs;

function summarize(r) {
    const p = r.phases;
    const nth = (kind, i) => p.filter((x) => x.kind === kind)[i]?.atMs;
    const loaded = p.filter((x) => x.kind === "community-loaded");
    const rootFetches = p.filter((x) => x.kind === "fetch-done" && x.isVoteRoot);
    const queued = p.filter((x) => x.kind === "fetch-start" && x.isVoteRoot).map((x) => x.queuedMs);
    const sum = (xs) => xs.reduce((a, b) => a + b, 0);
    const med = (xs) => (xs.length === 0 ? undefined : [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]);

    const pkcReady = at(p, "bench", "pkc-js ready (in-browser helia/libp2p node booted)");
    const firstConn = at(p, "conn", "open");
    const subsSeen = at(p, "subscription-change");
    const joinStart = at(p, "boot", "join fan-out start");
    const joinsDone = Math.max(0, ...p.filter((x) => x.kind === "join-done").map((x) => x.atMs));
    const firstTally = nth("first-tally", 0);
    const firstCommunity = loaded[0]?.atMs;
    const targetCommunity = loaded[TARGET_COMMUNITIES - 1]?.atMs;

    return {
        label: LABEL,
        query: QUERY,
        round: r.n,
        timedOut: r.timedOut,
        // absolute t+ marks
        pkcReady, firstConn, subsSeen, joinStart, joinsDone, firstTally, firstCommunity, targetCommunity,
        // derived segment durations — the actual answer to "which step ate the seconds"
        seg: {
            boot: pkcReady,
            dial: firstConn != null && pkcReady != null ? firstConn - pkcReady : undefined,
            subGossip: subsSeen != null && firstConn != null ? subsSeen - firstConn : undefined,
            joinGate: joinStart != null && subsSeen != null ? joinStart - subsSeen : undefined,
            joins: joinsDone && joinStart != null ? joinsDone - joinStart : undefined,
            coldPull: firstTally != null && joinStart != null ? firstTally - joinStart : undefined,
            firstCommunityLoad: firstCommunity != null && firstTally != null ? firstCommunity - firstTally : undefined,
            sixthAfterFirst: targetCommunity != null && firstCommunity != null ? targetCommunity - firstCommunity : undefined
        },
        // A pre-warm that dials a stale address fails silently in the app (fire-and-forget, with
        // discovery still running underneath), so the only symptom is quietly losing the time it
        // exists to buy. Surface it here instead.
        prewarm: (() => {
            const ok = p.find((x) => x.kind === "prewarm-connected");
            const failed = p.find((x) => x.kind === "prewarm-failed");
            if (ok) return { state: "connected", atMs: ok.atMs };
            if (failed) return { state: "FAILED", error: failed.error };
            return { state: p.some((x) => x.kind === "prewarm-start") ? "pending" : "off" };
        })(),
        counts: {
            communitiesLoaded: loaded.length,
            joinsDone: p.filter((x) => x.kind === "join-done").length,
            joinsFailed: p.filter((x) => x.kind === "join-failed").length,
            rootFetches: rootFetches.length,
            rootFetchFailed: p.filter((x) => x.kind === "fetch-failed").length,
            conns: p.filter((x) => x.kind === "conn").length
        },
        fetch: {
            // If the limiter is hurting, queueMedMs is large relative to wireMedMs — and any
            // queue wait at all is stolen from pkc-js's own 5 s direct-fetch timeout.
            queueMedMs: med(queued),
            queueMaxMs: queued.length ? Math.max(...queued) : undefined,
            wireMedMs: med(rootFetches.map((x) => x.wireMs)),
            wireSumMs: sum(rootFetches.map((x) => x.wireMs))
        }
    };
}

function printRound(s) {
    const g = s.seg;
    console.log(`
── round ${s.round} (${s.label})${s.timedOut ? "  ⚠ TIMED OUT" : ""}
   ${fmt(g.boot)}  pkc-js boot
   ${fmt(g.dial)}  → first peer connection
   ${fmt(g.subGossip)}  → seeder subscription gossip visible
   ${fmt(g.joinGate)}  → join gate released
   ${fmt(g.joins)}  → 63 joins resolved (local)
   ${fmt(g.coldPull)}  → FIRST TALLY (root fetch + bitswap chase)
   ${fmt(g.firstCommunityLoad)}  → first community loaded (pkc-js)
   ${fmt(g.sixthAfterFirst)}  → community #${TARGET_COMMUNITIES} loaded
   ${"".padStart(6)}  ═ t+${fmt(s.targetCommunity)} total to ${TARGET_COMMUNITIES} communities
   pre-warm: ${s.prewarm.state}${s.prewarm.atMs != null ? ` at ${fmt(s.prewarm.atMs)}` : ""}${s.prewarm.error ? ` — ${s.prewarm.error}` : ""}
   joins ${s.counts.joinsDone} ok / ${s.counts.joinsFailed} failed · root fetches ${s.counts.rootFetches} (${s.counts.rootFetchFailed} failed) · conns ${s.counts.conns}
   root fetch: queue med ${fmt(s.fetch.queueMedMs)} max ${fmt(s.fetch.queueMaxMs)} · wire med ${fmt(s.fetch.wireMedMs)} · Σwire ${fmt(s.fetch.wireSumMs)}`);
}

/* ---------- run ---------- */
// The playwright package resolved from PLAYWRIGHT_FROM may expect a different browser
// build than the one actually downloaded, so point at the installed one explicitly (same
// default the browser-bench harness uses) and only fall back to playwright's own lookup.
const CHROME_PATH = process.env.CHROME_PATH || "/home/user2/.cache/ms-playwright/chromium-1228/chrome-linux64/chrome";
const browser = await chromium.launch({
    headless: !process.env.HEADED,
    executablePath: fs.existsSync(CHROME_PATH) ? CHROME_PATH : undefined
});
const summaries = [];
for (let i = 1; i <= ROUNDS; i++) {
    const r = await round(browser, i);
    const s = summarize(r);
    summaries.push(s);
    printRound(s);
    if (APPEND_JSONL) {
        const out = path.resolve(ROOT, APPEND_JSONL);
        fs.mkdirSync(path.dirname(out), { recursive: true });
        fs.appendFileSync(out, JSON.stringify({ ...s, phases: r.phases }) + "\n");
    }
}
await browser.close();
server.close();

/* ---------- medians across rounds ---------- */
const medOf = (pick) => {
    const xs = summaries.map(pick).filter((x) => x != null).sort((a, b) => a - b);
    return xs.length ? xs[Math.floor(xs.length / 2)] : undefined;
};
console.log(`
════ medians over ${ROUNDS} round(s) — ${LABEL}${QUERY ? ` (?${QUERY})` : ""} ════
   ${fmt(medOf((s) => s.seg.boot))}  pkc-js boot
   ${fmt(medOf((s) => s.seg.dial))}  first peer connection
   ${fmt(medOf((s) => s.seg.subGossip))}  seeder subscription gossip
   ${fmt(medOf((s) => s.seg.joins))}  63 joins (local)
   ${fmt(medOf((s) => s.seg.coldPull))}  cold pull to first tally
   ${fmt(medOf((s) => s.seg.firstCommunityLoad))}  first community (pkc-js)
   ${fmt(medOf((s) => s.seg.sixthAfterFirst))}  communities 2..${TARGET_COMMUNITIES}
   ─────────
   ${fmt(medOf((s) => s.targetCommunity))}  TOTAL to ${TARGET_COMMUNITIES} communities`);
if (APPEND_JSONL) console.log(`\nappended ${ROUNDS} round(s) to ${APPEND_JSONL}`);
