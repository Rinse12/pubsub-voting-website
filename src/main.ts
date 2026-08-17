import {
    PubsubVoter,
    topicFor,
    republishIntervalBuckets,
    CommunitySchema,
    InvalidCommunityNameError,
    VoteEvictedError,
    type Contest,
    type Criteria,
    type Vote
} from "@bitsocial/pubsub-voting";
import { eligibilityBadge, explainEviction as describeEviction, renderGateChecklist } from "./eligibility-view.js";
import { allCriteria, sharedRules, directoryCodeOf, SECONDS_PER_BLOCK } from "../shared/contests.js";
import { directoryManifest } from "../shared/directory-manifest.js";
import { chainClientFactory } from "../shared/chains.js";
import { makeNameResolvers } from "../shared/resolvers.js";
import {
    decodeChunkBundles,
    describeGossipMessage,
    describeRootRecord,
    extractBundleBlock,
    extractLiveBundle,
    parseRootRecord,
    type DownloadedBundle
} from "../shared/wire-log.js";
import { startPkcNode, keepSeederConnected, type Pkc } from "./node.js";
import { PREWARM_HINT_FETCH_KEY, PREWARM_HINT_TIMEOUT_MS, PREWARM_HINT_MAX_PEERS, PREWARM_HINT_MAX_ADDRS } from "./config.js";
import { multiaddr } from "@multiformats/multiaddr";
import type { CID } from "multiformats/cid";
import { BrowserWalletSigner } from "./signer.js";

/* ---------- tiny DOM helpers ---------- */
const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;
const logEl = $<HTMLPreElement>("log");
function log(message: string) {
    const line = `[${new Date().toLocaleTimeString()}] ${message}`;
    console.log(line);
    logEl.textContent = `${line}\n${logEl.textContent ?? ""}`.slice(0, 20_000);
}
const shortKey = (key: string) => (key.length > 20 ? `${key.slice(0, 10)}…${key.slice(-6)}` : key);

/* ---------- light/dark theme toggle (initial theme is set by an inline script in index.html) ---------- */
const THEME_KEY = "bso-vote:theme";
const themeBtn = $<HTMLButtonElement>("theme-btn");
function renderThemeBtn() {
    const light = document.documentElement.dataset.theme === "light";
    themeBtn.textContent = light ? "🌙" : "☀️";
    themeBtn.title = light ? "Switch to dark theme" : "Switch to light theme";
}
themeBtn.onclick = () => {
    const next = document.documentElement.dataset.theme === "light" ? "dark" : "light";
    document.documentElement.dataset.theme = next;
    try {
        localStorage.setItem(THEME_KEY, next);
    } catch {
        // theme still applies for this page view; it just won't persist
    }
    renderThemeBtn();
};
renderThemeBtn();

/* ---------- the 63 directory contests ---------- */
interface DirEntry {
    code: string; // e.g. "g"
    title: string; // e.g. "/g/ - Technology"
    criteria: Criteria;
    topic: string; // derived before contests are created
    contest?: Contest;
    joined: boolean; // update() resolved (topic joined + snapshot restored)
    /** A root record for this contest was actually fetched (or answered "no record") —
     * before this, an empty ranking means "still pulling", not "no votes". */
    rootFetched: boolean;
    joinError?: string;
    /** performance.now() of this contest's first non-empty ranking (benchmark attribution). */
    firstTallyAt?: number;
    /* ---- leaderboard-#1 community, loaded via pkc-js per contest (see syncLeaderCommunity) ---- */
    leaderCommunity?: PkcCommunity; // the live pkc-js community for this contest's #1 board
    leaderKey?: string; // guard: `${code}|${name}|${publicKey}` of the leader being loaded/shown
    leaderLoaded?: boolean; // this contest's community has fired its first `update`
    leaderEverLoaded?: boolean; // has loaded at least once ever (survives leader flips; for count benchmarks)
    leaderStatus?: { text: string; cls?: "status-ok" | "status-pending" }; // last status, for re-render on select
}
const entries: DirEntry[] = allCriteria.map((criteria) => ({
    code: directoryCodeOf(criteria),
    // The criteria name is "<title> directory (test)"; the title alone reads better in tables.
    title: criteria.name.replace(/ directory \(test\)$/, ""),
    criteria,
    topic: "",
    joined: false,
    rootFetched: false
}));
const byCode = new Map(entries.map((e) => [e.code, e]));
const byTopic = new Map<string, DirEntry>(); // filled once topics are derived

let selected: DirEntry | undefined;

/* ---------- my-vote persistence (per contest topic + wallet) ---------- */
interface StoredVote {
    publicKey: string;
    name?: string;
    at: number; // epoch ms of the FIRST publish of this ballot (what the voter thinks of as "cast")
    /** epoch ms of the most recent (re-)publish — what expiry actually counts from. Absent on
     * records written before auto re-publishing existed; those fall back to `at`. */
    refreshedAt?: number;
}
/** The publish that decides this vote's expiry: its latest one. */
const lastPublishedAt = (stored: StoredVote) => stored.refreshedAt ?? stored.at;
const myVoteKey = (entry: DirEntry, address: string) => `bso-vote:${entry.topic}:${address.toLowerCase()}`;
function loadMyVote(entry: DirEntry, address: string): StoredVote | undefined {
    try {
        const raw = localStorage.getItem(myVoteKey(entry, address));
        return raw ? (JSON.parse(raw) as StoredVote) : undefined;
    } catch {
        return undefined;
    }
}
/** Every wallet-address record this browser holds for `entry`, for the my-votes sweep. */
function storedVotesFor(address: string): { entry: DirEntry; stored: StoredVote }[] {
    const out: { entry: DirEntry; stored: StoredVote }[] = [];
    for (const entry of entries) {
        if (!entry.topic) continue;
        const stored = loadMyVote(entry, address);
        if (stored) out.push({ entry, stored });
    }
    return out;
}

/* ---------- state ---------- */
const signer = new BrowserWalletSigner();
let pkc: Pkc;
let voter: PubsubVoter;
let publishing = false;
let booted = false; // set once EVERY contest's initial update() (join + snapshot restore) resolved

/* ---------- benchmarks ----------
 * Wall-clock load times, measured in this tab with performance.now(). Every row answers
 * one question the log can't answer at a glance: how long did X take, and how far into
 * the page load was it done. `sinceMs` defaults to page start; pass a later mark to
 * measure a phase (e.g. community load time measured FROM its leaderboard being ready,
 * since that's when loading could start at the earliest). */
const t0 = performance.now();
const benchRows: { label: string; tookMs: number; doneAtMs: number }[] = [];
const fmtSeconds = (ms: number) => `${(ms / 1000).toFixed(2)} s`;
function renderBench() {
    $("bench-hint").hidden = benchRows.length > 0;
    $("bench-table").hidden = benchRows.length === 0;
    const body = $("bench-body");
    body.textContent = "";
    for (const row of benchRows) {
        const tr = document.createElement("tr");
        for (const text of [row.label, fmtSeconds(row.tookMs), `t+${fmtSeconds(row.doneAtMs)}`]) {
            const td = document.createElement("td");
            td.textContent = text;
            tr.appendChild(td);
        }
        body.appendChild(tr);
    }
}
function markBench(label: string, sinceMs = t0) {
    const now = performance.now();
    benchRows.push({ label, tookMs: now - sinceMs, doneAtMs: now - t0 });
    renderBench();
    log(`benchmark: ${label} — ${fmtSeconds(now - sinceMs)}`);
    phase("bench", label, { tookMs: now - sinceMs });
}

/* ---------- machine-readable phase timeline (for scripts/coldstart-bench.mjs) ----------
 * The UI table above answers "how does this feel"; this answers "which step ate the
 * seconds". Every interesting edge on the cold-start path pushes one event here with its
 * t+ offset, so a Playwright driver can read `window.__phases` and attribute wall-clock to
 * a phase (seeder dial vs root fetch vs bitswap chase vs pkc-js community load) instead of
 * inferring it from the five coarse rows the panel shows. Pure instrumentation: nothing
 * reads these back, and `kind` is the grouping key the driver aggregates on.
 *
 * BOUNDED, oldest-first. Five of the call sites fire per-event for the life of the tab
 * (`conn` on every connection:open, `subscription-change` per peer, and the three
 * `fetch-*` ones per fetch), so an unbounded array here grew with uptime and peer churn
 * and could never be collected — `window.__phases` pins it. Measured at ~1.2 GB of live
 * JS objects over a 20.8 h run (see issue #3). The driver reads this during or just after
 * cold start, which is a few hundred events, so a cap this size never truncates what a
 * benchmark actually looks at. */
export type PhaseEvent = { kind: string; label: string; atMs: number; [extra: string]: unknown };
const PHASE_LIMIT = 5_000;
const phases: PhaseEvent[] = [];
function phase(kind: string, label: string, extra: Record<string, unknown> = {}) {
    phases.push({ kind, label, atMs: performance.now() - t0, ...extra });
    // splice, not reassign: `window.__phases` holds this exact array.
    if (phases.length > PHASE_LIMIT) phases.splice(0, phases.length - PHASE_LIMIT);
}
declare global {
    interface Window {
        __phases: PhaseEvent[];
        __bench: { label: string; tookMs: number; doneAtMs: number }[];
    }
}
window.__phases = phases;
window.__bench = benchRows;

/* ---------- downloaded vote bundles (debug panel) ----------
 * Every signed bundle this tab has admitted, by CID, across ALL contests, tagged with how
 * it arrived. Two exact wire taps (live-delta gossip messages; checkpoint chunks read
 * back via the chunk CIDs the fetched root records advertised — retried on the next tally
 * update if the chase hasn't stored them yet) plus a catch-all tap on
 * helia.blockstore.put, which every CRDT admission path writes the standalone bundle
 * block through. The put tap's source is inferred from context (local vote / snapshot
 * restore / chase), so an exact tag may upgrade an inferred one when both see the same
 * bundle. */
type BundleSource = "live gossip" | "checkpoint chunk" | "local vote" | "snapshot restore" | "chase";
const INFERRED_SOURCES = new Set<BundleSource>(["snapshot restore", "chase"]);
/* BOUNDED, oldest-first. This is an observation log, NOT vote state: the tally is a
 * last-write-wins set keyed by wallet inside pubsub-voting, which supersedes a wallet's
 * older bundle on its own. This map is keyed by bundle CID, and a re-published vote lands
 * at a new bucket → new blockNumber → new bytes → new CID, so with the hourly re-publish
 * across 63 contests it grew forever instead of converging. Dropping the oldest rows
 * cannot lose a vote or change a tally; it only shortens how far back the panel remembers. */
const BUNDLE_LIMIT = 500;
const downloadedBundles = new Map<string, { bundle: unknown; source: BundleSource }>();
let bundlesSeen = 0; // lifetime count, so the summary stays honest once we start evicting
const checkpointChunks = new Map<string, CID>(); // chunk CID string → CID; PENDING decode only
const decodedChunks = new Set<string>(); // chunk CIDs already decoded, so we never redo them
const DECODED_CHUNK_LIMIT = 5_000; // forgetting one only costs a re-decode, never correctness

/** Drop oldest entries until `size <= limit`. Maps and Sets both iterate in insertion order. */
function capOldest(store: Map<string, unknown> | Set<string>, limit: number) {
    while (store.size > limit) {
        const oldest = store.keys().next().value;
        if (oldest === undefined) return;
        store.delete(oldest);
    }
}

function renderBundles() {
    // The summary is cheap and always accurate, whether or not the panel is expanded.
    const bySource = new Map<BundleSource, number>();
    for (const { source } of downloadedBundles.values()) bySource.set(source, (bySource.get(source) ?? 0) + 1);
    const breakdown = [...bySource.entries()].map(([source, count]) => `${count} ${source}`).join(", ");
    const shown = bundlesSeen > downloadedBundles.size ? `${downloadedBundles.size} of ${bundlesSeen}` : `${downloadedBundles.size}`;
    $("bundles-summary").textContent = `Downloaded vote bundles (${shown}${breakdown ? ` — ${breakdown}` : ""})`;
    // The JSON body is O(n) to build, so only pay for it while someone is looking. Before
    // this, every insert re-serialised the whole map, making a fill O(n²) in time and garbage.
    if (!$<HTMLDetailsElement>("bundles-details").open) return;
    $("bundles-json").textContent =
        downloadedBundles.size === 0
            ? "none yet"
            : JSON.stringify(
                  [...downloadedBundles.entries()].map(([cid, { source, bundle }]) => ({ cid, source, bundle })),
                  null,
                  2
              );
}

function addBundle({ cid, bundle }: DownloadedBundle, source: BundleSource) {
    const existing = downloadedBundles.get(cid);
    if (existing) {
        // An exact tap may correct an inferred tag; nothing else changes an entry.
        if (!INFERRED_SOURCES.has(existing.source) || INFERRED_SOURCES.has(source)) return;
        existing.source = source;
        renderBundles();
        return;
    }
    downloadedBundles.set(cid, { bundle, source });
    bundlesSeen++;
    capOldest(downloadedBundles, BUNDLE_LIMIT);
    log(`vote bundle downloaded (${source}): ${describeBundleContent(bundle)} — cid ${cid}`);
    renderBundles();
}

// Expanding the panel is what pays for the JSON body; renderBundles() skips it while closed.
$<HTMLDetailsElement>("bundles-details").addEventListener("toggle", () => renderBundles());

/** One line of WHO voted for WHAT, from a decoded display bundle; best-effort. */
function describeBundleContent(bundle: unknown): string {
    try {
        const b = bundle as { address?: string; votes?: { community: { name?: string; publicKey: string }; vote: number }[] };
        const votes = (b.votes ?? [])
            .map((v) => `${v.community.name ?? shortKey(v.community.publicKey)}:${v.vote >= 0 ? "+" : ""}${v.vote}`)
            .join(", ");
        return `${b.address ?? "(unknown address)"} → [${votes}]`;
    } catch {
        return "(undecodable)";
    }
}

/* Incremental and non-overlapping. This used to re-fetch and re-decode EVERY chunk it had
 * ever seen on every root fetch that carried chunks — across 63 contests that set only
 * grows, so each pass was longer than the last, and it was invoked with `void` so passes
 * piled up on each other. A chunk's content is immutable (it is content-addressed), so
 * decoding it twice can only ever produce the same bundles: once decoded, it is done. */
let refreshingChunks = false;
async function refreshCheckpointBundles(blockstore: { get(cid: CID, opts?: { signal?: AbortSignal }): unknown }) {
    if (refreshingChunks) return;
    refreshingChunks = true;
    try {
        for (const [key, chunk] of [...checkpointChunks]) {
            try {
                const bytes = (await blockstore.get(chunk, { signal: AbortSignal.timeout(10_000) })) as Uint8Array;
                for (const item of await decodeChunkBundles(bytes)) addBundle(item, "checkpoint chunk");
                checkpointChunks.delete(key);
                decodedChunks.add(key);
                capOldest(decodedChunks, DECODED_CHUNK_LIMIT);
            } catch {
                // Chunk not chased/served yet — it stays pending and the next tally update retries.
            }
        }
    } finally {
        refreshingChunks = false;
    }
}

/* ---------- directories overview ---------- */
let dirsTimer: ReturnType<typeof setTimeout> | undefined;
/** Rebuilding a 63-row table on every one of 63 contests' update events would thrash; coalesce. */
function scheduleRenderDirs() {
    if (dirsTimer) return;
    dirsTimer = setTimeout(() => {
        dirsTimer = undefined;
        renderDirs();
    }, 100);
}

function renderDirs() {
    const address = signer.connectedAddress;
    const body = $("dirs-body");
    body.textContent = "";
    for (const entry of entries) {
        const tr = document.createElement("tr");
        tr.className = `dir-row${entry === selected ? " selected" : ""}`;
        tr.onclick = () => select(entry.code);

        const dir = document.createElement("td");
        const code = document.createElement("code");
        code.textContent = `/${entry.code}/`;
        dir.appendChild(code);
        dir.title = entry.title;

        const ranking = entry.contest?.tally?.ranking ?? [];
        const top = ranking[0];
        const leader = document.createElement("td");
        if (top) {
            leader.textContent = top.community.name ?? shortKey(top.community.publicKey);
            leader.title = top.community.publicKey;
        } else {
            // "no votes yet" is only claimed once this contest's checkpoint root has
            // actually been read — an empty ranking before that just means the cold
            // pull hasn't completed, which over 63 contests can take a while.
            leader.textContent = entry.joinError ? "join failed" : entry.joined && entry.rootFetched ? "no votes yet" : "syncing…";
            leader.className = "muted";
            if (entry.joinError) leader.title = entry.joinError;
        }

        const votes = document.createElement("td");
        votes.textContent = top ? String(top.weight) : "—";
        const boards = document.createElement("td");
        boards.textContent = ranking.length > 0 ? String(ranking.length) : "—";

        const mine = document.createElement("td");
        const stored = address && entry.topic ? loadMyVote(entry, address) : undefined;
        if (stored) {
            mine.textContent = stored.name ?? shortKey(stored.publicKey);
            mine.title = stored.publicKey;
            mine.className = "status-ok";
        } else {
            mine.textContent = "—";
        }

        tr.append(dir, leader, votes, boards, mine);
        body.appendChild(tr);
    }
}

/* ---------- selected directory ---------- */
function select(code: string) {
    const entry = byCode.get(code);
    if (!entry) return;
    if (location.hash !== `#/${code}/`) location.hash = `#/${code}/`;
    selected = entry;
    hideVoteConfirm(); // a lingering confirmation would describe the PREVIOUS directory's vote
    $("dir-card").hidden = false;
    $("community-card").hidden = false;
    $("dir-title").textContent = `${entry.title} — directory contest`;
    $("dir-blurb").textContent =
        `Boards competing to host /${entry.code}/ on 5chan. The highest-scoring board resolves the ` +
        `directory code; if it goes offline, 5chan rotates to the next-highest.`;
    $("dir-topic").textContent = entry.topic || "(deriving…)";
    renderTally();
    renderMyVote();
    renderDirs();
    showSelectedCommunity(); // paint this directory's community from what it's already loaded
    void syncLeaderCommunity(entry); // and (re)start its loader if the leader isn't loading yet
}

function renderMyVote() {
    const wrap = $("my-vote-wrap");
    const address = signer.connectedAddress;
    const stored = selected && address && selected.topic ? loadMyVote(selected, address) : undefined;
    if (!stored) {
        wrap.hidden = true;
        return;
    }
    wrap.hidden = false;
    $("my-vote-target").textContent = stored.name ? `${stored.name} (${shortKey(stored.publicKey)})` : stored.publicKey;
    $("my-vote-when").textContent = new Date(stored.at).toLocaleString();
    // Only interesting once it differs from the cast time — i.e. once this ballot has been
    // refreshed at least once. Expiry always counts from the LATEST publish.
    const refreshed = lastPublishedAt(stored);
    $("my-vote-refreshed-row").hidden = refreshed === stored.at;
    $("my-vote-refreshed").hidden = refreshed === stored.at;
    $("my-vote-refreshed").textContent = new Date(refreshed).toLocaleString();
    $("my-vote-expiry").textContent = `≈ ${new Date(refreshed + VOTE_LIFETIME_MS).toLocaleString()}`;
}

/* ---------- post-publish confirmation cue ----------
 * One ballot per wallet means a second vote silently replaces the first, so without a cue a
 * re-vote looks like it did nothing. Says WHAT the publish did to your standing ballot
 * (cast / moved / re-published / withdrawn). Only for publishes the user initiated — the
 * background re-publish already reports through the "Last re-published" row. */
let voteConfirmTimer: ReturnType<typeof setTimeout> | undefined;
function hideVoteConfirm() {
    clearTimeout(voteConfirmTimer);
    $("vote-confirm").hidden = true;
}
function showVoteConfirm(votes: Vote[], previous: StoredVote | undefined) {
    const nameOf = (c: { name?: string; publicKey: string }) => c.name ?? shortKey(c.publicKey);
    const target = votes[0]?.community;
    const sameBallot = target && previous?.publicKey === target.publicKey && previous?.name === target.name;
    let message: string;
    if (!target)
        message = previous
            ? `Vote withdrawn — your vote for ${nameOf(previous)} no longer counts.`
            : "Withdrawal published — this wallet has no standing vote here.";
    else if (sameBallot)
        message =
            `You already voted for ${nameOf(target)} — nothing double-counts. Your ballot was re-published, ` +
            `pushing its expiry to ≈ ${new Date(Date.now() + VOTE_LIFETIME_MS).toLocaleString()}.`;
    else if (previous)
        message =
            `Vote moved from ${nameOf(previous)} to ${nameOf(target)} — one ballot per wallet, ` +
            `so your earlier vote no longer counts.`;
    else message = `Vote cast for ${nameOf(target)}.`;
    const confirm = $("vote-confirm");
    confirm.textContent = `✓ ${message}`;
    confirm.hidden = false;
    clearTimeout(voteConfirmTimer);
    voteConfirmTimer = setTimeout(hideVoteConfirm, 15_000);
    // Pulse both the banner and the "Your vote" panel it summarizes; restart the animation
    // when publishes come back-to-back.
    for (const el of [confirm, $("my-vote-wrap")]) {
        el.classList.remove("flash");
        void el.offsetWidth;
        el.classList.add("flash");
    }
}

function renderTally() {
    if (!selected) return;
    const ranking = selected.contest?.tally?.ranking ?? [];
    $("tally-hint").hidden = ranking.length > 0;
    if (ranking.length === 0) {
        $("tally-hint").textContent = selected.joined
            ? "No votes yet — be the first: vote for a board by its public key below."
            : "Syncing this contest…";
        $("tally-table").hidden = true;
        return;
    }
    $("tally-table").hidden = false;
    const body = $("tally-body");
    body.textContent = "";
    ranking.forEach((row, i) => {
        const tr = document.createElement("tr");
        for (const text of [String(i + 1), "", String(row.weight), ""]) {
            const td = document.createElement("td");
            td.textContent = text;
            tr.appendChild(td);
        }
        // Board cell: identity is the publicKey (kept in the tooltip); a carried name is
        // shown right away with its registry-check state. A name that FAILS the check is
        // never shown — the library evicts that bundle instead of displaying it.
        const board = tr.children[1] as HTMLTableCellElement;
        board.title = row.community.publicKey;
        if (row.community.name) {
            board.textContent = row.community.name;
            const tag = document.createElement("span");
            tag.className = row.nameResolved === true ? "status-ok" : "status-pending";
            tag.textContent = row.nameResolved === true ? " (name verified)" : " (name unverified)";
            board.appendChild(tag);
        } else {
            board.textContent = shortKey(row.community.publicKey);
        }
        const status = tr.children[3] as HTMLTableCellElement;
        status.innerHTML = row.chainVerified
            ? `<span class="status-ok">verified</span>`
            : `<span class="status-pending">verifying…</span>`;
        const actions = document.createElement("td");
        const btn = document.createElement("button");
        btn.className = "small";
        btn.textContent = "Vote";
        btn.title = `Vote for ${row.community.publicKey}`;
        const entry = selected!;
        btn.onclick = (e) => {
            e.stopPropagation();
            void castVote(entry, [{ community: { publicKey: row.community.publicKey }, vote: 1 }]);
        };
        actions.appendChild(btn);
        tr.appendChild(actions);
        body.appendChild(tr);
    });
}

/* ---------- leaderboard-#1 community of EVERY directory (loaded via pkc-js) ----------
 * The boards being voted on ARE pkc communities — a board's publicKey is its community
 * address. As each of the 63 directories gains a leaderboard (and whenever its leader
 * changes), load the #1 board's community over the SAME shared helia node through pkc-js
 * (`createCommunity` + `community.update()`). Every contest keeps its own live community;
 * the panel shows whichever directory is currently selected. The community's `update`
 * event fires each time a (newer) community record lands; the first one is the "loaded"
 * moment. The benchmarks panel reports the first community and, once every leaderboard's
 * #1 is loaded, how long all of them took. */
type PkcCommunity = Awaited<ReturnType<Pkc["getCommunity"]>>;
let firstCommunityLoaded = false; // first leader community across all contests has loaded
let allCommunitiesBenchDone = false; // the "all communities loaded" benchmark has fired once
// Count of distinct contests whose #1 community has loaded at least once, and the
// milestones (from page start) benchmarked as that count climbs.
let communitiesLoadedCount = 0;
const COMMUNITY_COUNT_MILESTONES = [6];
const countMilestonesDone = new Set<number>();
function maybeMarkCommunityCount() {
    for (const n of COMMUNITY_COUNT_MILESTONES) {
        if (communitiesLoadedCount >= n && !countMilestonesDone.has(n)) {
            countMilestonesDone.add(n);
            markBench(`${n} leader communities loaded via pkc-js`);
        }
    }
}

function communityStatus(text: string, cls?: "status-ok" | "status-pending") {
    const el = $("community-status");
    el.textContent = text;
    el.className = cls ?? "";
}

// Record this contest's community status and, when it's the selected one, show it.
function setLeaderStatus(entry: DirEntry, text: string, cls?: "status-ok" | "status-pending") {
    entry.leaderStatus = { text, cls };
    if (entry === selected) communityStatus(text, cls);
}

// Paint the community panel from the SELECTED contest's already-loaded state (called on
// select, so switching directories shows that directory's community immediately without
// waiting for its next `update` event).
function showSelectedCommunity() {
    const entry = selected;
    if (!entry) return;
    if (entry.leaderCommunity && entry.leaderLoaded) {
        renderCommunity(entry.leaderCommunity);
    } else {
        $("community-info").hidden = true;
        $("community-details").hidden = true;
    }
    communityStatus(entry.leaderStatus?.text ?? "", entry.leaderStatus?.cls);
}

// Once every leaderboard's #1 community has loaded at least once, mark how long all of
// them took (from page start). Contests with no votes have no #1 to load, so they don't
// block this; it needs at least one leaderboard and waits until every contest has joined.
function maybeMarkAllCommunitiesLoaded() {
    if (allCommunitiesBenchDone || !booted) return;
    const withLeader = entries.filter((e) => (e.contest?.tally?.ranking.length ?? 0) > 0);
    if (withLeader.length === 0 || !withLeader.every((e) => e.leaderLoaded)) return;
    allCommunitiesBenchDone = true;
    markBench(`all ${withLeader.length} leader communities loaded via pkc-js`);
}

function renderCommunity(community: PkcCommunity) {
    $("community-info").hidden = false;
    $("community-details").hidden = false;
    // With a name the address IS the name; keep the canonical key visible next to it.
    $("community-address").textContent =
        community.publicKey && community.publicKey !== community.address
            ? `${community.address} (${community.publicKey})`
            : community.address;
    $("community-title").textContent = community.title ?? "(untitled)";
    $("community-description").textContent = community.description ?? "—";
    $("community-created").textContent = community.createdAt ? new Date(community.createdAt * 1000).toLocaleString() : "—";
    $("community-updated").textContent = community.updatedAt ? new Date(community.updatedAt * 1000).toLocaleString() : "—";
    $("community-last-post").textContent = community.lastPostCid ?? "none";
    $("community-json").textContent = JSON.stringify(community.raw.communityIpfs ?? {}, null, 2);
}

async function syncLeaderCommunity(entry: DirEntry) {
    const top = entry.contest?.tally?.ranking[0];
    const publicKey = top?.community.publicKey;
    if (!publicKey) {
        setLeaderStatus(entry, `waiting for the first board on the /${entry.code}/ leaderboard…`);
        return;
    }
    // Hand pkc-js BOTH identity halves the winning bundle carries: the canonical
    // publicKey (loads without resolution) and the claimed .bso name when there is one
    // (pkc-js resolves and verifies it — `nameResolved` — and uses it as the address).
    const name = top.community.name;
    const key = `${entry.code}|${name ?? ""}|${publicKey}`;
    if (key === entry.leaderKey) return; // already loading/showing this leader
    entry.leaderKey = key;
    entry.leaderLoaded = false;
    const label = name ?? shortKey(publicKey);

    // A dethroned leader's community stops syncing — one community per contest at a time.
    const previous = entry.leaderCommunity;
    entry.leaderCommunity = undefined;
    if (entry === selected) {
        $("community-info").hidden = true;
        $("community-details").hidden = true;
    }
    if (previous) void previous.stop().catch((err: Error) => log(`stopping previous community failed: ${err.message}`));

    const startedAt = performance.now();
    // Split the community load into its three observable segments: createCommunity (which
    // includes .bso name resolution), update() returning (it only starts the loop), and the
    // first `update` event (the actual network round-trip). Reported separately because they
    // have completely different fixes.
    phase("community-create-start", entry.code, { label, named: Boolean(name) });
    setLeaderStatus(entry, `loading community ${label} (/${entry.code}/ leaderboard #1) via pkc-js…`, "status-pending");
    log(`/${entry.code}/ leaderboard #1 is ${label} — loading its community via pkc-js createCommunity + update()`);
    try {
        const community = (await pkc.createCommunity(name ? { name, publicKey } : { publicKey })) as PkcCommunity;
        phase("community-created", entry.code, { tookMs: performance.now() - startedAt, label });
        if (entry.leaderKey !== key) return; // leader changed while constructing
        entry.leaderCommunity = community;
        community.on("update", () => {
            if (entry.leaderKey !== key) return;
            if (!entry.leaderLoaded) {
                entry.leaderLoaded = true;
                phase("community-loaded", entry.code, { tookMs: performance.now() - startedAt, label });
                if (!firstCommunityLoaded) {
                    firstCommunityLoaded = true;
                    markBench(`first leader community loaded via pkc-js (/${entry.code}/ ${label})`, startedAt);
                }
                if (!entry.leaderEverLoaded) {
                    entry.leaderEverLoaded = true; // count each contest once, even if its leader later flips
                    communitiesLoadedCount++;
                    maybeMarkCommunityCount();
                }
                maybeMarkAllCommunitiesLoaded();
            }
            setLeaderStatus(entry, `community ${label} loaded — live-updating`, "status-ok");
            log(`community update: ${community.address} (title ${JSON.stringify(community.title ?? null)}, record updatedAt ${community.updatedAt})`);
            if (entry === selected) renderCommunity(community);
        });
        community.on("updatingstatechange", (state) => {
            if (entry.leaderKey !== key) return;
            phase("community-state", entry.code, { state, atSinceStartMs: performance.now() - startedAt, label });
            log(`community ${label} updating state: ${state}`);
            if (!entry.leaderLoaded && state !== "succeeded")
                setLeaderStatus(
                    entry,
                    `loading community ${label} via pkc-js… (${state}${state === "failed" ? " — a board that isn't a real community never resolves; retrying anyway" : ""})`,
                    "status-pending"
                );
        });
        community.on("error", (err: Error) => {
            if (entry.leaderKey !== key) return;
            log(`community ${label} error: ${err.message}`);
        });
        await community.update(); // starts the update loop; the `update` event does the rendering
    } catch (err) {
        if (entry.leaderKey === key) {
            setLeaderStatus(entry, `loading community ${label} failed: ${(err as Error).message}`);
            log(`community ${label} load failed: ${(err as Error).message}`);
        }
    }
}

/** Burner button labels track whether a key is stored; the forget button only shows then. */
function refreshBurnerButtons() {
    const stored = BrowserWalletSigner.hasStoredBurner();
    $("burner-btn").textContent = stored ? "Use my browser wallet" : "No wallet? Generate one in this browser";
    $("forget-btn").hidden = !stored;
}

function renderWallet(address: `0x${string}`) {
    $("wallet-error").hidden = true;
    $("connect-btn").textContent = signer.kind === "injected" ? "Reconnect wallet" : "Connect wallet";
    $("wallet-info").hidden = false;
    $("wallet-address").textContent = address;
    $("wallet-kind").textContent =
        signer.kind === "burner" ? "burner — generated and stored in this browser" : "injected (MetaMask etc.)";
    // Every contest's gate is the same `erc5192-min-balance` (shared manifest defaults):
    // the wallet must hold a 5chan Pass, on a contract that declares the pass soulbound.
    // Show the live balance read; peers verify the same read at the bucket block.
    $("wallet-eligible").textContent = "checking 5chan Pass balance…";
    void renderEligibility(address);
    renderMyVote();
    renderRepublish(); // which votes are held (and whether signing pops up) is per-wallet
    void republishVotes(); // this wallet's votes may have gone stale while the tab was closed
    scheduleRenderDirs(); // the "Your vote" column is per-wallet
}

/* ---------- voting-window (bucket) math ----------
 * Only for wall-clock estimates now (re-publish cadence, vote lifetime). Eligibility does NOT
 * live here: which block the gate reads at is the RULE's business, and this file used to guess
 * it — mirroring a bucket-boundary read that stopped being what the gate did the moment it
 * started reading the head. Ask `contest.checkEligibility` instead (see renderEligibility). */
/** One voting window in wall-clock ms (~1 h here). A re-publish only moves a vote forward when
 * it lands in a LATER window than the last one: the ballot is stamped with the window's boundary
 * block, so two publishes inside one window sign identical bytes — same bundle, same CID, no
 * refresh. That makes one window the shortest re-publish interval worth offering. */
const BUCKET_MS = sharedRules.blocksPerBucket * SECONDS_PER_BLOCK * 1000;
/** How long a ballot keeps counting, measured from the window it was signed in (~30 days here). */
const VOTE_LIFETIME_MS = sharedRules.voteExpiryBuckets * BUCKET_MS;
/**
 * Any joined contest can answer an eligibility question: all 63 share one gate rule, and the
 * library namespaces the gate memo by that rule, so whichever contest we ask, the read is shared
 * with every other one and with the verify path.
 */
function gateAnsweringContest(): Contest | undefined {
    return entries.find((entry) => entry.joined && entry.contest)?.contest ?? entries.find((entry) => entry.contest)?.contest;
}

/** Show `text` in the eligibility badge, class `cls`. `text` is set as text, never as HTML. */
function setEligibilityBadge(text: string, cls: "badge-ok" | "badge-bad"): void {
    const span = document.createElement("span");
    span.className = cls;
    span.textContent = text;
    $("wallet-eligible").replaceChildren(span);
}

/**
 * Ask the LIBRARY whether this wallet's vote would count, and show its answer.
 *
 * This used to read `balanceOf` twice — at head and at the voting window's boundary block — and
 * decide for itself which one peers honour. That was a copy of the gate rule's block choice
 * living outside the gate rule, and it went silently wrong the moment the rule changed: after the
 * gate began reading the head first, this kept telling voters their Pass "arrived mid-window" and
 * to wait up to an hour for a window that no longer gated anything.
 *
 * `checkEligibility` runs the contest's real rules through the real verify context, so each reads
 * at whatever block it reads at and applies whatever threshold it applies. The wording is the
 * rules' own and is rendered verbatim — this file deliberately knows nothing about blocks, buckets
 * or `min` any more.
 *
 * The badge is the verdict; `renderGateChecklist` draws the per-rule breakdown beneath it when the
 * gate is a tree. Both live in eligibility-view.ts, where they are tested against the tree shapes
 * these single-rule test contests never produce: `check.error` alone is the blame set joined into
 * one sentence, which is everything a one-rule gate can say, but the moment a contest gates on
 * `all`/`any` it loses the structure — and loses an unknown (a rule whose read failed) entirely.
 */
async function renderEligibility(address: `0x${string}`) {
    $<HTMLButtonElement>("recheck-btn").disabled = true;
    try {
        const contest = gateAnsweringContest();
        if (!contest) {
            $("wallet-eligible").textContent = "checking once a directory contest has joined…";
            return;
        }
        const check = await contest.checkEligibility({ address });
        if (signer.connectedAddress !== address) return; // wallet changed mid-read
        const badge = eligibilityBadge(check);
        setEligibilityBadge(badge.text, badge.cls);
        renderGateChecklist(document, $("wallet-gate"), check);
    } catch (err) {
        if (signer.connectedAddress !== address) return;
        $("wallet-gate").hidden = true;
        $("wallet-eligible").textContent = `balance check failed (${err instanceof Error ? err.message : String(err)}) — you can still vote; peers do their own read`;
    } finally {
        // A wallet switch mid-read means a newer renderEligibility owns the button now.
        if (signer.connectedAddress === address) $<HTMLButtonElement>("recheck-btn").disabled = false;
    }
}

/** The peer-side rejection message; the wording (and its per-rule list) lives in eligibility-view.ts. */
function explainEviction(entry: DirEntry, err: VoteEvictedError): string {
    return describeEviction(entry.code, err.verdict);
}


/* ---------- voting ---------- */
function showWalletError(message: string) {
    const el = $("wallet-error");
    el.textContent = message;
    el.hidden = false;
    $("wallet-card").scrollIntoView({ behavior: "smooth", block: "center" });
    log(message);
}

/**
 * Sign and publish one ballot for `entry`, then remember it locally.
 *
 * `refresh` marks a re-publish of a ballot this browser already published (see the
 * auto-re-publish section): identical votes, signed again into the CURRENT voting window so the
 * bundle's expiry clock restarts. Everything else is the same publish — the library has no
 * separate refresh call, and peers cannot tell the two apart (nor should they).
 */
async function castVote(entry: DirEntry, votes: Vote[], { refresh = false } = {}) {
    if (publishing) return;
    if (!voter) {
        log("not ready to vote yet — still booting");
        return;
    }
    if (!signer.connectedAddress) {
        showWalletError(
            "No wallet yet — your vote must be signed by one. Connect an extension wallet (MetaMask etc.) or generate a free wallet in this browser, then vote again."
        );
        return;
    }
    publishing = true;
    try {
        const vote = await voter.createContestVote({ criteria: entry.criteria, votes });
        vote.on("publishingstatechange", (state: string) => log(`/${entry.code}/ publishing state: ${state}`));
        // Post-hoc rejection feedback: fires AFTER publish() resolved if a deferred check
        // (background gate read / name resolution) evicts this vote. The contest-level
        // handler owns the visible wallet-card alert; this keeps the debug log complete.
        vote.on("error", (err: unknown) => log(`/${entry.code}/ vote error: ${err instanceof Error ? err.message : String(err)}`));
        const { recipientCount } = await vote.publish();
        // Name WHAT was voted for — a log full of anonymous "vote published" lines is
        // useless when several votes fly in one session.
        const votedFor = votes
            .map((v) => `${v.community.name ?? shortKey(v.community.publicKey)}:${v.vote >= 0 ? "+" : ""}${v.vote}`)
            .join(", ");
        log(
            `/${entry.code}/ vote ${refresh ? "re-published (keeping it alive)" : "published"} for ` +
                `[${votedFor || "(empty ballot — retracts previous vote)"}] by ${signer.connectedAddress} ` +
                `(gossipsub sent it directly to ${recipientCount} peer${recipientCount === 1 ? "" : "s"})`
        );
        const address = signer.connectedAddress;
        if (address) {
            const previous = loadMyVote(entry, address);
            if (votes.length === 0) localStorage.removeItem(myVoteKey(entry, address));
            else {
                // Re-publishing the SAME ballot (auto refresh, or the voter clicking the same
                // board again) keeps the original cast time and only moves the expiry clock;
                // voting for a different board starts a new record.
                const target = votes[0].community;
                const sameBallot = previous?.publicKey === target.publicKey && previous?.name === target.name;
                const now = Date.now();
                localStorage.setItem(
                    myVoteKey(entry, address),
                    JSON.stringify({
                        publicKey: target.publicKey,
                        name: target.name,
                        at: sameBallot ? previous.at : now,
                        refreshedAt: now
                    } satisfies StoredVote)
                );
            }
            // Every non-refresh publish is a click in the selected dir card, so the cue
            // always describes the leaderboard the user is looking at.
            if (!refresh) showVoteConfirm(votes, previous);
        }
        renderMyVote();
        renderRepublish();
        scheduleRenderDirs();
    } catch (err) {
        const message = (err as Error).message ?? String(err);
        if (err instanceof InvalidCommunityNameError)
            // publish() preflighted the name and refused before signing: it provably does
            // not resolve to the claimed key, so every peer would silently drop the vote.
            showWalletError(`Vote refused: ${message}`);
        else if (message.includes("NoPeersSubscribedToTopic") || message.includes("no peers"))
            log(`/${entry.code}/ publish failed: not connected to any topic peer yet — wait for the seeder connection and retry.`);
        else log(`/${entry.code}/ publish failed: ${message}`);
    } finally {
        publishing = false;
    }
}

/* ---------- automatic re-publishing (keeping votes alive) ----------
 * Votes decay on purpose: a ballot stops counting `voteExpiryBuckets` windows (~30 days here)
 * after the window it was signed in, and the CRDT filters it out at read time, so a directory
 * whose voters all fall silent ends with an empty leaderboard and NO board resolving its code —
 * a live electorate is what keeps a directory resolvable.
 *
 * Nothing else can prevent that on a voter's behalf. The seeder holds no private key, so it can
 * serve and re-gossip a bundle but can never re-sign one; the library deliberately doesn't
 * re-publish either (upstream DESIGN.md "Republishing is the client's job", and its
 * `republishIntervalBuckets` helper is exactly this scheduling hint). Only the browser holding
 * the wallet can refresh a vote, by signing the same ballot again into the current window.
 *
 * So this tab does it: every stored vote for the connected wallet is re-published on the
 * configured interval, catching up on load for anything that went stale while the tab was
 * closed. The interval defaults to ONE VOTING WINDOW — far more often than
 * `republishIntervalBuckets` (half the expiry window) actually requires, because these are test
 * contests and a chatty refresh loop is the thing under test. Cheap per round: one signature
 * and one gossip message per vote held, no gas, no chain write.
 *
 * Not one duration below is a literal. Window size, vote lifetime and the recommended interval
 * all fall out of the manifest (`blocksPerBucket` × `voteExpiryBuckets` × block time), so they
 * are computed here and written into the copy at runtime — a manifest edit must move the UI,
 * not silently make it lie.
 *
 * Two things bound the damage if it misbehaves. A refresh signed in the same voting window as
 * the last one is byte-identical, so it is a de-duplicated no-op rather than a second vote. And
 * a wallet that has lost its 5chan Pass gets its refresh evicted by the same deferred gate check
 * as any other vote, which drops the local record (see the contest `error` handler) and thereby
 * stops the loop retrying that contest. */
const REPUBLISH_KEY = "bso-vote:republish";
interface RepublishSettings {
    enabled: boolean;
    intervalMs: number;
}
/** The library's own answer to "how often should a client refresh THIS contest set?" — half the
 * expiry window, the longest interval that still leaves a full missed cycle of slack. Derived
 * from the criteria, so it tracks the manifest instead of restating it. */
const RECOMMENDED_REPUBLISH_MS = republishIntervalBuckets(sharedRules) * BUCKET_MS;
const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;
/** A duration as its coarsest sensible unit ("1 hour", "6 hours", "15 days"). Everything this
 * panel says about time is manifest-derived, so no such number may be written into the copy. */
function formatDuration(ms: number): string {
    for (const [size, one, many] of [
        [DAY_MS, "day", "days"],
        [HOUR_MS, "hour", "hours"],
        [60_000, "minute", "minutes"],
        [1_000, "second", "seconds"]
    ] as const) {
        if (ms < size) continue;
        const n = Math.round((ms / size) * 10) / 10;
        return `${n} ${n === 1 ? one : many}`;
    }
    return `${Math.round(ms)} ms`;
}
/** Offered intervals, all derived. The floor is one voting window — below that a refresh
 * re-signs identical bytes (see BUCKET_MS) — and the ceiling is the recommendation above; the
 * round wall-clock steps in between are convenience, and a manifest whose window or expiry
 * squeezes them out simply doesn't offer them. */
const REPUBLISH_CHOICES: { ms: number; label: string }[] = [
    ...new Set([BUCKET_MS, 6 * HOUR_MS, DAY_MS, 7 * DAY_MS, RECOMMENDED_REPUBLISH_MS])
]
    .filter((ms) => ms >= BUCKET_MS && ms <= RECOMMENDED_REPUBLISH_MS)
    .sort((a, b) => a - b)
    .map((ms) => {
        const notes = [
            ...(ms === BUCKET_MS ? ["one voting window"] : []),
            ...(ms === RECOMMENDED_REPUBLISH_MS ? ["the protocol's own recommendation"] : [])
        ];
        return { ms, label: notes.length === 0 ? formatDuration(ms) : `${formatDuration(ms)} (${notes.join(" — ")})` };
    });
const DEFAULT_REPUBLISH: RepublishSettings = { enabled: true, intervalMs: BUCKET_MS };
/** How often the due-check runs. Independent of the interval itself: a wall-clock comparison per
 * tick is what makes this survive a suspended laptop, a closed tab, or a changed setting. */
const REPUBLISH_TICK_MS = 60_000;
/** Breathing room between two publishes in one sweep — a voter holding all 63 votes would
 * otherwise fire 63 signatures and gossip messages back to back. */
const REPUBLISH_GAP_MS = 250;
/** How long a sweep waits for the contest topics to have a subscribed peer before giving up on
 * this round. Measured: the catch-up sweep fires the moment the last contest's `update()`
 * resolves, which can be a second or two BEFORE any peer shows up as a subscriber of those
 * topics — and gossipsub rejects a publish outright (`NoPeersSubscribedToTopic`) when it would
 * reach nobody, so an un-gated sweep burns its refreshes on a mesh that isn't there yet. */
const REPUBLISH_MESH_WAIT_MS = 30_000;

function loadRepublishSettings(): RepublishSettings {
    try {
        const raw = localStorage.getItem(REPUBLISH_KEY);
        if (!raw) return { ...DEFAULT_REPUBLISH };
        const parsed = JSON.parse(raw) as Partial<RepublishSettings>;
        // A stored interval from an older build (or a hand-edited one) is snapped back onto the
        // offered set, so the <select> can never show a blank value.
        const choice = REPUBLISH_CHOICES.find((c) => c.ms === parsed.intervalMs);
        return {
            enabled: typeof parsed.enabled === "boolean" ? parsed.enabled : DEFAULT_REPUBLISH.enabled,
            intervalMs: choice?.ms ?? DEFAULT_REPUBLISH.intervalMs
        };
    } catch {
        return { ...DEFAULT_REPUBLISH };
    }
}
let republishSettings = loadRepublishSettings();
function saveRepublishSettings() {
    try {
        localStorage.setItem(REPUBLISH_KEY, JSON.stringify(republishSettings));
    } catch {
        // Setting still applies to this page view; it just won't persist.
    }
}

let republishSweeping = false; // one sweep at a time (a slow sweep must not overlap the next tick)
/** How many peers subscribe to `topic`; wired to the pubsub service once it exists (see main). */
let subscriberCount: (topic: string) => number = () => 0;

/** Votes whose last publish is older than the interval — i.e. due for a refresh now. */
function dueVotes(address: string): { entry: DirEntry; stored: StoredVote }[] {
    const cutoff = Date.now() - republishSettings.intervalMs;
    return storedVotesFor(address).filter(({ stored }) => lastPublishedAt(stored) <= cutoff);
}

/**
 * Re-publish every vote that is due (or every vote held, with `all`, for the manual button).
 *
 * Runs only once the contests have joined AND their topics have a subscribed peer. Both gates
 * are the same lesson: gossipsub refuses a publish that would reach nobody, so a refresh fired
 * into an empty mesh is not slow, it is lost — and a lost refresh looks exactly like a vote the
 * user never had. Anything skipped keeps its old timestamp and is simply due again next tick.
 */
async function republishVotes({ all = false } = {}) {
    const address = signer.connectedAddress;
    if (republishSweeping || !booted || !voter || !address) return;
    if (!all && !republishSettings.enabled) return;
    const targets = all ? storedVotesFor(address) : dueVotes(address);
    if (targets.length === 0) return;
    republishSweeping = true;
    try {
        // The seeder announces all 63 subscriptions in one exchange, so seeing ONE topic with a
        // subscriber is seeing them all — the same signal the join gate above waits on.
        const meshUp = () => targets.some(({ entry }) => subscriberCount(entry.topic) > 0);
        if (!meshUp()) {
            republishStatus("waiting for a topic peer before re-publishing…");
            const deadline = Date.now() + REPUBLISH_MESH_WAIT_MS;
            while (!meshUp() && Date.now() < deadline) await new Promise((r) => setTimeout(r, 500));
            if (!meshUp()) {
                log(`re-publish deferred: no peer subscribes to these contest topics yet — retrying in ${REPUBLISH_TICK_MS / 1000}s`);
                return;
            }
        }
        log(`re-publishing ${targets.length} vote${targets.length === 1 ? "" : "s"} for ${address} to keep ${targets.length === 1 ? "it" : "them"} from expiring`);
        let done = 0;
        let deferred = 0;
        for (const { entry } of targets) {
            // Re-read per contest: a sweep over 63 votes takes a while, and the voter may have
            // withdrawn, re-voted, or had a vote evicted since it started.
            if (signer.connectedAddress !== address) break; // wallet switched mid-sweep
            const stored = loadMyVote(entry, address);
            if (!stored) continue;
            if (subscriberCount(entry.topic) === 0) {
                deferred++; // this one topic has no peer yet; next tick tries it again
                continue;
            }
            const community = stored.name ? { publicKey: stored.publicKey, name: stored.name } : { publicKey: stored.publicKey };
            await castVote(entry, [{ community, vote: 1 }], { refresh: true });
            done++;
            republishStatus(`re-publishing your votes… (${done}/${targets.length})`);
            if (done < targets.length) await new Promise((r) => setTimeout(r, REPUBLISH_GAP_MS));
        }
        if (deferred > 0) log(`${deferred} vote(s) not re-published yet: no peer on those topics — retrying in ${REPUBLISH_TICK_MS / 1000}s`);
    } finally {
        republishSweeping = false;
        renderRepublish();
    }
}

function republishStatus(text: string) {
    $("republish-status").textContent = text;
}

/** Checkbox, interval, button state and the one-line "what will happen next" status. */
function renderRepublish() {
    $<HTMLInputElement>("republish-enabled").checked = republishSettings.enabled;
    $<HTMLSelectElement>("republish-interval").value = String(republishSettings.intervalMs);
    const address = signer.connectedAddress;
    const held = address ? storedVotesFor(address) : [];
    $<HTMLButtonElement>("republish-now").disabled = republishSweeping || !booted || held.length === 0;
    // An injected wallet signs with a popup per vote, so a sweep over many votes is a very
    // different experience there than with a burner. Say so where the interval is chosen.
    $("republish-warn").hidden = !(signer.kind === "injected" && republishSettings.enabled && held.length > 0);

    if (republishSweeping) return; // the sweep owns the status line while it runs
    if (!address) {
        republishStatus("No wallet yet — only the browser that signed a vote can refresh it.");
        return;
    }
    const votes = `${held.length} vote${held.length === 1 ? "" : "s"}`;
    if (held.length === 0) {
        republishStatus(`No votes cast from this browser with ${shortKey(address)} yet — nothing to keep alive.`);
        return;
    }
    if (!republishSettings.enabled) {
        const soonest = Math.min(...held.map(({ stored }) => lastPublishedAt(stored) + VOTE_LIFETIME_MS));
        republishStatus(`Off — ${votes} held; the first stops counting ≈ ${new Date(soonest).toLocaleString()} unless you vote again.`);
        return;
    }
    const nextAt = Math.min(...held.map(({ stored }) => lastPublishedAt(stored))) + republishSettings.intervalMs;
    republishStatus(
        booted
            ? `On — ${votes} held; next refresh ${nextAt <= Date.now() ? "due now" : `≈ ${new Date(nextAt).toLocaleString()}`}.`
            : `On — ${votes} held; the first refresh runs once every contest has joined.`
    );
}

/** Wire the controls and start the due-check ticker. Called during boot, before the join. */
function startRepublishing() {
    // The two durations the explanatory copy quotes are manifest-derived, so the markup ships
    // placeholders and they are filled in here alongside the interval list.
    $("vote-lifetime").textContent = formatDuration(VOTE_LIFETIME_MS);
    $("republish-recommended").textContent = formatDuration(RECOMMENDED_REPUBLISH_MS);
    $<HTMLSelectElement>("republish-interval").replaceChildren(
        ...REPUBLISH_CHOICES.map(({ ms, label }) => new Option(label, String(ms)))
    );
    $<HTMLInputElement>("republish-enabled").onchange = (e) => {
        republishSettings.enabled = (e.target as HTMLInputElement).checked;
        saveRepublishSettings();
        log(`automatic vote re-publishing ${republishSettings.enabled ? "enabled" : "disabled"}`);
        renderRepublish();
        if (republishSettings.enabled) void republishVotes();
    };
    $<HTMLSelectElement>("republish-interval").onchange = (e) => {
        republishSettings.intervalMs = Number((e.target as HTMLSelectElement).value);
        saveRepublishSettings();
        log(`vote re-publish interval set to ${REPUBLISH_CHOICES.find((c) => c.ms === republishSettings.intervalMs)?.label}`);
        renderRepublish();
        void republishVotes(); // a shorter interval can make votes due immediately
    };
    $("republish-now").onclick = () => void republishVotes({ all: true });
    renderRepublish();
    // Wall-clock due-check rather than a per-vote timer: this catches up votes that went stale
    // while the tab was closed or the laptop asleep, and needs no rescheduling when the interval
    // changes. The re-render also keeps the "next refresh" line honest as time passes.
    setInterval(() => {
        renderRepublish();
        void republishVotes();
    }, REPUBLISH_TICK_MS);
}

/* ---------- cold-start tuning knobs ----------
 * Overridable from the query string so the benchmark driver can A/B without a rebuild;
 * 0 (or anything non-finite) means "no limit". `?fetchLimit=6&joinLimit=8&waitSeeder=20000`
 * restores the pre-2026-07-20 shipped values.
 *
 * All three now default to OFF, against commit da35976's caps, because
 * scripts/coldstart-bench.mjs measured them costing more than they saved (n=3 medians,
 * real Chromium, cold context, 6 leader communities):
 *
 *     baseline (6/8/20s)  10.41s total, first community 4.64s
 *     fetchLimit off       7.74s total, first community 2.47s
 *     all off              6.87s total, first community 2.42s
 *
 * The fetch cap was the expensive one, and NOT for the reason it was added: the wrapper it
 * installs sits on `libp2p.services.fetch`, which pkc-js also uses for its IPNS direct
 * fetch — and pkc-js starts its own 5 s AbortSignal BEFORE the call enters this queue, so
 * queue wait (median 1.22 s, max 2.79 s, against 0.40 s of actual wire time) came straight
 * out of the community-load timeout budget. Vote root fetches were never the victim: they
 * are 63/63 successful in every configuration measured, capped or not.
 *
 * What the caps DID buy is real but smaller: uncapped, the 63 separate `<topic>/root`
 * fetches contend on one connection and the cold pull slows 2.3 s -> 4.2 s. The fix for
 * that is to stop making 63 round-trips (one aggregate root-record fetch), not to
 * rate-limit them — see README. */
const knob = (name: string, fallback: number) => {
    const raw = new URLSearchParams(location.search).get(name);
    if (raw === null) return fallback;
    const value = Number(raw);
    return Number.isFinite(value) && value > 0 ? value : Infinity;
};
/** Pre-warm the community-serving Kubo peer via the seeder-served hint (see config.ts). */
const PREWARM = new URLSearchParams(location.search).get("prewarm") !== "0";
const FETCH_WIRE_LIMIT = knob("fetchLimit", Infinity);
const JOIN_LIMIT = knob("joinLimit", Infinity);
/** ms to wait for the seeder's subscription gossip before joining anyway; 0 = don't wait.
 * Off by default: the library's cold start does not need the subscription exchange — its
 * `#discoverProviders` dials a provider from the routers and fetches the root record
 * directly (pubsub-voting DESIGN.md:218). The gate was working around the 63-way router
 * stampede, which is the same fan-out the aggregate root fetch removes. */
const WAIT_SEEDER_MS = (() => {
    const raw = new URLSearchParams(location.search).get("waitSeeder");
    return raw === null ? 0 : Math.max(0, Number(raw) || 0);
})();

/* ---------- boot ---------- */
/** Minimal promise-concurrency limiter: joining 63 contests at once would stampede the
 * seeder's checkpoint fetch and the RPCs; a handful in flight keeps boot smooth. */
function pLimit(limit: number) {
    let active = 0;
    const queue: (() => void)[] = [];
    const next = () => {
        active--;
        queue.shift()?.();
    };
    return <T>(fn: () => Promise<T>): Promise<T> =>
        new Promise((resolve, reject) => {
            const run = () => {
                active++;
                fn().then(resolve, reject).finally(next);
            };
            active < limit ? run() : queue.push(run);
        });
}

const selectedCodeFromHash = () => /^#\/?([a-z0-9]+)\/?$/.exec(location.hash)?.[1];

async function main() {
    log(`starting pkc-js with its in-browser libp2p/Helia node (shared by community loading AND syncing ${entries.length} directory contests)…`);
    const { pkc: pkcInstance, helia } = await startPkcNode();
    pkc = pkcInstance;
    markBench("pkc-js ready (in-browser helia/libp2p node booted)");

    /* Pre-warm, discovery-driven (?prewarm=0 to disable): the first peers discovery connects us
     * to are votes seeders — and the production seeder serves community content from a Kubo node
     * on the SAME machine under a DIFFERENT peer id, which pkc-js would otherwise only discover
     * at t+~5 s when the first leaderboard resolves. Ask each newly connected peer for the
     * PREWARM_HINT_FETCH_KEY (only the seeder answers it) and dial the returned Kubo addrs NOW,
     * while the votes cold pull is still running. Fire-and-forget at every step — a peer without
     * the key, a garbage answer, or a failed dial costs nothing; normal discovery still runs
     * underneath. See config.ts for why the hardcoded-multiaddr version of this was abandoned. */
    if (PREWARM) {
        const fetchService = helia.libp2p.services.fetch as {
            fetch(peer: unknown, key: string, options?: { signal?: AbortSignal }): Promise<Uint8Array | undefined | null>;
        };
        let hintPeersTried = 0;
        let hintAnswered = false;
        const tryHint = (peer: unknown): void => {
            if (hintAnswered || hintPeersTried >= PREWARM_HINT_MAX_PEERS) return;
            hintPeersTried += 1;
            void fetchService
                .fetch(peer, PREWARM_HINT_FETCH_KEY, { signal: AbortSignal.timeout(PREWARM_HINT_TIMEOUT_MS) })
                .then((answer) => {
                    if (hintAnswered || answer === undefined || answer === null) return;
                    const parsed = JSON.parse(new TextDecoder().decode(answer)) as { kubo?: unknown };
                    const addrs = (Array.isArray(parsed.kubo) ? parsed.kubo : [])
                        .filter((a): a is string => typeof a === "string")
                        .slice(0, PREWARM_HINT_MAX_ADDRS);
                    if (addrs.length === 0) return;
                    hintAnswered = true;
                    phase("prewarm-hint", `${addrs.length} addr(s) from ${String(peer)}`);
                    for (const addr of addrs) {
                        const startedAt = performance.now();
                        phase("prewarm-start", addr);
                        void helia.libp2p
                            .dial(multiaddr(addr))
                            .then(() => {
                                phase("prewarm-connected", addr, { tookMs: performance.now() - startedAt });
                                log(`pre-warm connected in ${fmtSeconds(performance.now() - startedAt)}: ${addr}`);
                            })
                            .catch((err: Error) => {
                                phase("prewarm-failed", addr, { tookMs: performance.now() - startedAt, error: err.message });
                                log(`pre-warm dial failed (harmless, discovery still runs): ${err.message}`);
                            });
                    }
                })
                .catch(() => {
                    // Peer doesn't serve the key (or timed out) — the next connection gets asked.
                });
        };
        helia.libp2p.addEventListener("connection:open", (evt: CustomEvent<{ remotePeer: unknown }>) => tryHint(evt.detail.remotePeer));
        for (const connection of helia.libp2p.getConnections()) tryHint(connection.remotePeer);
    }
    $("peer-id").textContent = helia.libp2p.peerId.toString();
    setInterval(() => {
        const connections = helia.libp2p.getConnections();
        $("peer-count").textContent = String(connections.length);
        // Live list of connected peers with the multiaddr each connection runs over.
        $("peer-list-wrap").hidden = connections.length === 0;
        const list = $("peer-list");
        list.textContent = "";
        for (const conn of connections) {
            const li = document.createElement("li");
            const peer = document.createElement("code");
            peer.textContent = conn.remotePeer.toString();
            const addr = document.createElement("span");
            addr.className = "peer-addr";
            addr.textContent = conn.remoteAddr.toString();
            li.append(peer, addr);
            list.appendChild(li);
        }
    }, 2000);

    $("criteria-json").textContent = JSON.stringify(directoryManifest, null, 2);
    for (const entry of entries) {
        entry.topic = await topicFor(entry.criteria);
        byTopic.set(entry.topic, entry);
    }
    phase("boot", "topics derived");
    log(`${entries.length} directory contest topics derived`);
    renderDirs();

    /* Wallet buttons + restore, before the network sync below: none of this needs the
     * voter, and a returning visitor should see their identity without waiting or clicking.
     * The restore waits for the topics above only because renderMyVote and the overview's
     * "Your vote" column read topic-scoped my-vote records. */
    startRepublishing(); // before the restore below: renderWallet paints the re-publish panel too
    if (BrowserWalletSigner.hasStoredBurner()) {
        const address = signer.useBurner();
        log(`browser wallet restored from a previous visit: ${address}`);
        renderWallet(address);
    }
    refreshBurnerButtons();
    $("connect-btn").onclick = async () => {
        try {
            const address = await signer.connectInjected();
            log(`wallet connected: ${address}`);
            renderWallet(address);
        } catch (err) {
            showWalletError(`Wallet connect failed: ${(err as Error).message}`);
        }
    };
    $("burner-btn").onclick = () => {
        try {
            const existing = BrowserWalletSigner.hasStoredBurner();
            const address = signer.useBurner();
            log(
                existing
                    ? `browser wallet loaded: ${address}`
                    : `browser wallet generated: ${address} (key saved in this browser's localStorage)`
            );
            refreshBurnerButtons();
            renderWallet(address);
        } catch (err) {
            log(`browser wallet failed: ${(err as Error).message}`);
        }
    };
    /* Re-read the Pass balance on demand. There is no automatic recheck any more: the old one
     * existed only to flip the badge at the next window boundary, and the gate no longer waits
     * for one — an airdrop counts as soon as it lands, so this button is the whole story. */
    $("recheck-btn").onclick = () => {
        const address = signer.connectedAddress;
        if (!address) return;
        $("wallet-eligible").textContent = "rechecking 5chan Pass balance…";
        log(`rechecking 5chan Pass balance for ${address}`);
        void renderEligibility(address);
    };
    $("forget-btn").onclick = () => {
        if (
            !window.confirm(
                "Delete the wallet key stored in this browser? This is permanent — without the key you can never change or withdraw a vote cast with this address."
            )
        )
            return;
        const wasActive = signer.kind === "burner";
        const address = signer.forgetBurner();
        // The my-vote records are keyed by that address, which can never be active again.
        if (address) for (const entry of entries) localStorage.removeItem(myVoteKey(entry, address));
        refreshBurnerButtons();
        if (wasActive) {
            $("wallet-info").hidden = true;
            $("connect-btn").textContent = "Connect wallet";
            renderMyVote();
            renderRepublish();
            scheduleRenderDirs();
        }
        log(address ? `browser wallet deleted: ${address}` : "no stored browser wallet to delete");
    };

    /* ---------- connectivity diagnostics ----------
     * Everything vote-sync does rides three observable seams: connections, gossipsub
     * subscriptions on the contest topics, and the cold-join checkpoint pulls over the
     * fetch protocol. Log all three so "why don't I see votes?" is answerable from
     * the on-page log alone. */
    const libp2p = helia.libp2p;
    const pubsub = libp2p.services.pubsub as {
        getSubscribers(topic: string): unknown[];
        addEventListener(type: "subscription-change" | "message", cb: (evt: CustomEvent) => void): void;
    };
    subscriberCount = (topic) => pubsub.getSubscribers(topic).length; // the re-publish sweep's mesh gate
    libp2p.addEventListener("connection:open", (evt) => {
        phase("conn", "open", { peer: String(evt.detail.remotePeer), addr: String(evt.detail.remoteAddr) });
        log(`conn open: ${evt.detail.remotePeer} via ${evt.detail.remoteAddr}`);
    });
    libp2p.addEventListener("connection:close", (evt) => log(`conn close: ${evt.detail.remotePeer}`));
    pubsub.addEventListener("subscription-change", (evt) => {
        const detail = evt.detail as { peerId: unknown; subscriptions: { topic: string; subscribe: boolean }[] };
        // One line per peer, not per topic: a seeder (un)subscribing all 63 at once is one event.
        const codes = (detail.subscriptions ?? [])
            .filter((sub) => byTopic.has(sub.topic))
            .map((sub) => `${sub.subscribe ? "+" : "-"}/${byTopic.get(sub.topic)!.code}/`);
        if (codes.length > 0) {
            phase("subscription-change", String(detail.peerId), { topics: codes.length });
            log(`topic subscriptions from ${detail.peerId}: ${codes.join(" ")}`);
        }
    });
    pubsub.addEventListener("message", (evt) => {
        const detail = evt.detail as { topic: string; data: Uint8Array; from?: unknown };
        const entry = byTopic.get(detail.topic);
        if (!entry) return;
        void (async () => {
            log(`/${entry.code}/ gossip from ${detail.from ?? "(unsigned)"}: ${await describeGossipMessage(detail.data)}`);
            const live = await extractLiveBundle(detail.data);
            if (live) addBundle(live, "live gossip");
        })();
    });
    const fetchSvc = libp2p.services.fetch as {
        fetch(peer: unknown, key: string | Uint8Array, opts?: unknown): Promise<Uint8Array | undefined>;
    };
    /* The tap is also where the site smooths the 63-contest cold-pull burst. Measured on
     * the live site: the library's own per-peer budget (24 concurrent) opens more muxed
     * streams than the browser connection digests — round-trips inflate from <1 s to
     * 5-12 s, stall-and-flush, and every attempt that hits a 10 s default timeout
     * (@libp2p/fetch's, then libp2p's stream-negotiation one) re-queues and compounds
     * the congestion, leaving the overview on "no votes yet" for many minutes. Two
     * countermeasures, both local to this wrapper: only a handful of fetches on the
     * wire at once (queued ones haven't started any timeout yet), and a long explicit
     * signal for each once it starts (the library passes none, so the 10 s default
     * would apply). A node client needs neither — this is browser-connection behavior. */
    const fetchWireLimit = pLimit(FETCH_WIRE_LIMIT);
    const realFetch = fetchSvc.fetch.bind(fetchSvc);
    fetchSvc.fetch = async (peer, key, opts) => {
        // Enqueued here, started below: the gap between the two IS the queue wait, which is
        // the number that decides whether the limiter is helping or just eating the callers'
        // (pkc-js's 5 s) timeout budget.
        const enqueuedAt = performance.now();
        return fetchWireLimit(async () => {
        const keyStr = typeof key === "string" ? key : new TextDecoder().decode(key);
        const startedAt = performance.now();
        // A votes fetch is either the per-topic root key or the bulk key that replaces 63 of
        // them; anything else on this service is pkc-js's IPNS direct fetch. Classifying the
        // bulk key matters — without it the votes side of the timeline reads as zero traffic.
        const isBulkRoots = keyStr === "bitsocial-votes/roots";
        const isVoteRoot = isBulkRoots || byTopic.has(keyStr.replace(/\/root$/, ""));
        phase("fetch-start", keyStr, { queuedMs: startedAt - enqueuedAt, isVoteRoot, isBulkRoots });
        log(`checkpoint fetch → ${peer} ${keyStr}`);
        if (!(opts as { signal?: AbortSignal } | undefined)?.signal)
            opts = { ...(opts ?? {}), signal: AbortSignal.timeout(60_000) };
        try {
            const value = await realFetch(peer, key, opts);
            const entry = byTopic.get(keyStr.replace(/\/root$/, ""));
            if (entry && !entry.rootFetched) {
                entry.rootFetched = true;
                scheduleRenderDirs();
            }
            phase("fetch-done", keyStr, { wireMs: performance.now() - startedAt, isVoteRoot, isBulkRoots, bytes: value?.length ?? 0 });
            log(`checkpoint fetch ← ${value === undefined ? "no value" : `${value.length} bytes: ${describeRootRecord(value)}`}`);
            const record = value === undefined ? undefined : parseRootRecord(value);
            for (const chunk of record?.chunks ?? []) {
                const key = chunk.toString();
                if (!decodedChunks.has(key)) checkpointChunks.set(key, chunk);
            }
            if (record?.chunks?.length) void refreshCheckpointBundles(helia.blockstore);
            return value;
        } catch (err) {
            // Truncated: these are @libp2p/fetch errors and short in practice, but a
            // retained error string is exactly how a client-side error can become a
            // memory problem (viem embeds whole RPC request bodies in `.message`).
            phase("fetch-failed", keyStr, {
                wireMs: performance.now() - startedAt,
                isVoteRoot,
                isBulkRoots,
                error: (err as Error).message.slice(0, 500)
            });
            log(`checkpoint fetch failed: ${(err as Error).message}`);
            throw err;
        }
        });
    };

    /* Catch-all bundle tap: every CRDT admission path (live accept, chase, local publish,
     * snapshot restore) writes the standalone bundle block through this put, and the
     * library's blockstore adapter dispatches dynamically so a wrapper installed here is
     * honoured. The source is inferred from context; the exact taps above may upgrade it. */
    const putSource = (bundle: unknown): BundleSource => {
        const address = (bundle as { address?: string }).address;
        if (publishing && address && address === signer.connectedAddress?.toLowerCase()) return "local vote";
        if (!booted) return "snapshot restore";
        return "chase";
    };
    const blockstore = helia.blockstore as { put(cid: CID, bytes: Uint8Array, opts?: unknown): Promise<CID> };
    const realPut = blockstore.put.bind(blockstore);
    blockstore.put = async (cid, bytes, opts) => {
        const result = await realPut(cid, bytes, opts);
        // Fire-and-forget so the tap can never slow or break admission.
        void (async () => {
            const item = await extractBundleBlock(bytes);
            if (item) addBundle(item, putSource(item.bundle));
        })();
        return result;
    };

    let seederConnected = false;
    keepSeederConnected(helia, (connected, err) => {
        const dot = $("seeder-dot");
        dot.className = `dot ${connected ? "ok" : "bad"}`;
        $("seeder-status").textContent = connected
            ? "connected to seeder"
            : `not connected to seeder${err ? ` — ${err.message}` : ", retrying…"}`;
        if (connected !== seederConnected)
            log(connected ? "seeder connection established" : `seeder connection lost${err ? ` — ${err.message}` : ""}`);
        seederConnected = connected;
    });

    voter = new PubsubVoter({
        helia,
        chains: chainClientFactory,
        signer,
        nameResolvers: makeNameResolvers()
    });

    /* Selection + voting UI wiring, BEFORE the (long) join below: overview rows are
     * clickable and a #/g/ deep link selects immediately; castVote guards on the pieces
     * that aren't ready yet. */
    window.addEventListener("hashchange", () => {
        const code = selectedCodeFromHash();
        if (code && code !== selected?.code) select(code);
    });
    const initial = selectedCodeFromHash();
    if (initial && byCode.has(initial)) select(initial);

    $<HTMLFormElement>("new-board-form").onsubmit = (e) => {
        e.preventDefault();
        if (!selected) return;
        const publicKey = $<HTMLInputElement>("board-key").value.trim();
        const name = $<HTMLInputElement>("board-name").value.trim();
        const community = CommunitySchema.safeParse(name ? { publicKey, name } : { publicKey });
        if (!community.success) {
            log(`invalid board: ${community.error.issues.map((i) => i.message).join("; ")}`);
            return;
        }
        void castVote(selected, [{ community: community.data, vote: 1 }]);
    };
    $("withdraw-btn").onclick = () => {
        if (selected) void castVote(selected, []);
    };

    /* Wait for the seeder to be VISIBLE AS A TOPIC SUBSCRIBER before joining, bounded:
     * a contest that joins before the subscription exchange lands misses the direct
     * cold-pull path and falls back to a 63-wide router race whose timeouts strand most
     * boards until the next heartbeat (measured: join-first converges ~1/63 in 2.5 min;
     * connect-first converges 63/63 in ~2 s — the same join-races-subscription lesson
     * README "Diagnosing" documents for single contests). The seeder announces all 63
     * subscriptions in one exchange, so seeing ONE topic is seeing them all. If no
     * seeder shows within the deadline, join anyway — cold-start is best-effort and the
     * armed re-pull + heartbeat converge it later. */
    {
        phase("boot", "seeder wait start", { budgetMs: WAIT_SEEDER_MS });
        const deadline = Date.now() + WAIT_SEEDER_MS;
        const seederVisible = () => entries.some((e) => pubsub.getSubscribers(e.topic).length > 0);
        while (!seederVisible() && Date.now() < deadline) await new Promise((r) => setTimeout(r, 250));
        if (seederVisible()) markBench("seeder visible as topic subscriber (cold pulls can go direct)");
        else log(`no seeder subscriber visible after ${WAIT_SEEDER_MS} ms — joining anyway; tallies fill in as the connection lands`);
    }

    /* Join every directory contest (bounded concurrency). Each contest's `update` event
     * re-renders its overview row, and the selected directory's full panel when it's the
     * one that changed. */
    let sawVotes = false;
    let joinedCount = 0;
    const renderJoinProgress = () =>
        ($("contest-count").textContent = `${entries.length} directory contests — ${joinedCount} joined${joinedCount < entries.length ? "…" : ""}`);
    renderJoinProgress();
    const limit = pLimit(JOIN_LIMIT);
    phase("boot", "join fan-out start", { limit: JOIN_LIMIT, contests: entries.length });
    await Promise.all(
        entries.map((entry) => {
            const enqueuedAt = performance.now();
            return limit(async () => {
                const startedAt = performance.now();
                phase("join-start", entry.code, { queuedMs: startedAt - enqueuedAt });
                try {
                    const contest = await voter.createContest({ criteria: entry.criteria });
                    entry.contest = contest;
                    contest.on("update", () => {
                        const ranking = contest.tally?.ranking ?? [];
                        const top = ranking[0];
                        if (ranking.length > 0 && !entry.firstTallyAt) {
                            entry.firstTallyAt = performance.now();
                            phase("first-tally", entry.code, { boards: ranking.length });
                        }
                        // Same line the seeder logs, so the two sides are directly comparable.
                        if (top)
                            log(
                                `/${entry.code}/ tally update: ${ranking.length} board(s), leader ` +
                                    `${top.community.name ?? shortKey(top.community.publicKey)} with ${top.weight} vote(s)`
                            );
                        if (!sawVotes && ranking.length > 0) {
                            sawVotes = true;
                            markBench(`first votes on a leaderboard (/${entry.code}/, ${ranking.length} board(s))`);
                        }
                        scheduleRenderDirs();
                        if (entry === selected) renderTally();
                        // The moment ANY leaderboard has content, its #1 board's community
                        // loads via pkc-js — every contest, not just the selected one — and if
                        // a later vote flips a leader, that contest's community follows it.
                        void syncLeaderCommunity(entry);
                        // The chase that fired this update stored any checkpoint blocks it pulled.
                        void refreshCheckpointBundles(helia.blockstore);
                    });
                    contest.on("error", (err: unknown) => {
                        // Our own published vote failed a deferred check (gate read or name
                        // resolution) and was evicted — every honest peer drops it the same
                        // way, so it counts nowhere. Show it where the user acted (the wallet
                        // card) and retract the stale "Your vote" record.
                        if (err instanceof VoteEvictedError) {
                            showWalletError(explainEviction(entry, err));
                            const address = err.bundle.address;
                            if (address.toLowerCase() === signer.connectedAddress?.toLowerCase()) {
                                localStorage.removeItem(myVoteKey(entry, address));
                                renderMyVote();
                                // Dropping the record is also what stops the re-publish loop from
                                // refreshing a vote the network will keep rejecting.
                                renderRepublish();
                                scheduleRenderDirs();
                            }
                            return;
                        }
                        log(`/${entry.code}/ contest error (retrying): ${err instanceof Error ? err.message : String(err)}`);
                    });
                    await contest.update();
                    entry.joined = true;
                    phase("join-done", entry.code, { tookMs: performance.now() - startedAt });
                } catch (err) {
                    entry.joinError = (err as Error).message;
                    phase("join-failed", entry.code, { tookMs: performance.now() - startedAt, error: entry.joinError });
                    log(`/${entry.code}/ join failed: ${entry.joinError}`);
                } finally {
                    joinedCount++;
                    renderJoinProgress();
                    scheduleRenderDirs();
                }
            });
        })
    );
    booted = true;
    markBench(`all ${entries.length} contests joined (topics joined + persisted votes restored)`);
    log(`joined all ${entries.length} directory contest topics; syncing votes…`);
    renderBundles();
    // Every contest has joined and restored its snapshot: kick off each leaderboard's #1
    // community (those whose update already fired are no-ops) and re-check the "all loaded"
    // benchmark now that `booted` is true.
    phase("boot", "sweep all leader communities");
    for (const entry of entries) void syncLeaderCommunity(entry);
    maybeMarkAllCommunitiesLoaded();
    // Every topic is joined now, so a refresh can actually reach subscribers: catch up any vote
    // that fell due while this browser was closed (the ticker handles the rest of the session).
    renderRepublish();
    void republishVotes();
    if (selected) {
        renderTally();
        showSelectedCommunity();
    }
}

main().catch((err) => {
    log(`fatal: ${(err as Error).stack ?? err}`);
});
