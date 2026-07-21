import {
    PubsubVoter,
    topicFor,
    CommunitySchema,
    InvalidCommunityNameError,
    VoteEvictedError,
    type Contest,
    type Criteria,
    type Vote
} from "@bitsocial/pubsub-voting";
import { erc721Abi } from "viem";
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
import { PREWARM_PEER_ADDRS } from "./config.js";
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
    at: number; // epoch ms when published
}
const myVoteKey = (entry: DirEntry, address: string) => `bso-vote:${entry.topic}:${address.toLowerCase()}`;
function loadMyVote(entry: DirEntry, address: string): StoredVote | undefined {
    try {
        const raw = localStorage.getItem(myVoteKey(entry, address));
        return raw ? (JSON.parse(raw) as StoredVote) : undefined;
    } catch {
        return undefined;
    }
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
 * reads these back, and `kind` is the grouping key the driver aggregates on. */
export type PhaseEvent = { kind: string; label: string; atMs: number; [extra: string]: unknown };
const phases: PhaseEvent[] = [];
function phase(kind: string, label: string, extra: Record<string, unknown> = {}) {
    phases.push({ kind, label, atMs: performance.now() - t0, ...extra });
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
const downloadedBundles = new Map<string, { bundle: unknown; source: BundleSource }>();
const checkpointChunks = new Map<string, CID>(); // chunk CID string → CID, across all contests

function renderBundles() {
    const bySource = new Map<BundleSource, number>();
    for (const { source } of downloadedBundles.values()) bySource.set(source, (bySource.get(source) ?? 0) + 1);
    const breakdown = [...bySource.entries()].map(([source, count]) => `${count} ${source}`).join(", ");
    $("bundles-summary").textContent = `Downloaded vote bundles (${downloadedBundles.size}${breakdown ? ` — ${breakdown}` : ""})`;
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
    log(`vote bundle downloaded (${source}): ${describeBundleContent(bundle)} — cid ${cid}`);
    renderBundles();
}

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

async function refreshCheckpointBundles(blockstore: { get(cid: CID, opts?: { signal?: AbortSignal }): unknown }) {
    for (const chunk of checkpointChunks.values()) {
        try {
            const bytes = (await blockstore.get(chunk, { signal: AbortSignal.timeout(10_000) })) as Uint8Array;
            for (const item of await decodeChunkBundles(bytes)) addBundle(item, "checkpoint chunk");
        } catch {
            // Chunk not chased/served yet — the next tally update retries.
        }
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
    const lifetimeMs = sharedRules.voteExpiryBuckets * sharedRules.blocksPerBucket * SECONDS_PER_BLOCK * 1000;
    $("my-vote-expiry").textContent = `≈ ${new Date(stored.at + lifetimeMs).toLocaleString()}`;
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
    // Every contest's gate is the same `erc721-min-balance` (shared manifest defaults):
    // the wallet must hold a 5chan Pass. Show the live balance read; peers verify the
    // same read at the bucket block.
    $("wallet-eligible").textContent = "checking 5chan Pass balance…";
    void renderEligibility(address);
    renderMyVote();
    scheduleRenderDirs(); // the "Your vote" column is per-wallet
}

/* ---------- voting-window (bucket) math ----------
 * Mirrors the library's (unexported) bucket math: every verifier reads gate balances at
 * the current bucket's boundary block — the head rounded down to `blocksPerBucket`. So a
 * Pass received mid-bucket only starts counting at the NEXT boundary, up to a full
 * bucket (~1 h here) after the airdrop. The bucket size and gate are shared manifest
 * defaults, identical for every directory contest. */
const sampleBlockFor = (block: number) => Math.floor(block / sharedRules.blocksPerBucket) * sharedRules.blocksPerBucket;
const nextWindowAfter = (sampleBlock: number) => sampleBlock + sharedRules.blocksPerBucket;
/** "≈ HH:MM (in ~N min)" for the block `toBlock`, assuming `fromBlock` is (close to) head now. */
function clockAtBlock(fromBlock: number, toBlock: number): string {
    const ms = Math.max(0, toBlock - fromBlock) * SECONDS_PER_BLOCK * 1000;
    const clock = new Date(Date.now() + ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    const minutes = Math.round(ms / 60_000);
    return `≈ ${clock} (${minutes < 1 ? "under a minute" : `in ~${minutes} min`})`;
}

let eligibilityRecheck: ReturnType<typeof setTimeout> | undefined;

async function renderEligibility(address: `0x${string}`) {
    const gate = sharedRules.rule as unknown as { contract: `0x${string}`; min: number };
    clearTimeout(eligibilityRecheck);
    try {
        const chain = chainClientFactory({ chain: "baseSepolia", chainId: 84532 });
        if (!chain) throw new Error("no Base Sepolia chain client configured");
        const head = Number(await chain.getBlockNumber());
        const sampleBlock = sampleBlockFor(head);
        const balanceAt = (blockNumber?: number) =>
            chain.readContract({
                address: gate.contract,
                abi: erc721Abi,
                functionName: "balanceOf",
                args: [address],
                ...(blockNumber === undefined ? {} : { blockNumber: BigInt(blockNumber) })
            });
        // Two reads: "latest" is what the user's wallet UI agrees with; the window's
        // boundary block is what every peer actually verifies against. When they disagree
        // (Pass airdropped mid-window), warn BEFORE the user publishes a doomed vote.
        const [balance, sampled] = await Promise.all([balanceAt(), balanceAt(sampleBlock)]);
        if (signer.connectedAddress !== address) return; // wallet changed mid-read
        const min = BigInt(gate.min);
        if (sampled >= min) {
            $("wallet-eligible").innerHTML =
                `<span class="badge-ok">yes — holds ${balance} 5chan Pass${balance === 1n ? "" : "es"}</span>`;
        } else if (balance >= min) {
            const nextBlock = nextWindowAfter(sampleBlock);
            $("wallet-eligible").innerHTML =
                `<span class="badge-warn">not yet — your 5chan Pass arrived mid-window. Peers verify balances at ` +
                `block ${sampleBlock} (before your Pass), so a vote published now will be rejected. The next voting ` +
                `window opens at block ${nextBlock}, ${clockAtBlock(head, nextBlock)} — vote then.</span>`;
            // Flip the badge (and clear any stale rejection alert) once the window opens.
            eligibilityRecheck = setTimeout(
                () => void renderEligibility(address),
                ((nextBlock - head) * SECONDS_PER_BLOCK + 10) * 1000
            );
        } else {
            $("wallet-eligible").innerHTML =
                `<span class="badge-bad">no — holds no 5chan Pass (peers will drop this wallet's votes; ask the owner for an airdrop)</span>`;
        }
    } catch (err) {
        if (signer.connectedAddress !== address) return;
        $("wallet-eligible").textContent = `balance check failed (${err instanceof Error ? err.message : String(err)}) — you can still vote; peers do their own read`;
    }
}

/** Translate a peer-side eviction verdict into something actionable. The one rejection an
 * honestly-eligible voter hits is the gate sampling a balance BEFORE their Pass arrived
 * (see the voting-window note above); every other reason passes through verbatim. */
function explainEviction(entry: DirEntry, err: VoteEvictedError): string {
    const gated = /^not admitted: rule score is 0n at block (\d+)$/.exec(err.verdict.reason);
    if (gated) {
        const sampleBlock = Number(gated[1]);
        const nextBlock = nextWindowAfter(sampleBlock);
        // The bundle was block-stamped at publish time, moments before this eviction —
        // close enough to head for a wall-clock estimate without another RPC read.
        return (
            `Your /${entry.code}/ vote was rejected: your wallet held no 5chan Pass at block ${sampleBlock}, where this voting ` +
            `window's balances are read — a Pass received after that block does not count yet. The next window ` +
            `opens at block ${nextBlock} (${clockAtBlock(err.bundle.blockNumber, nextBlock)}); publish your vote again then.`
        );
    }
    return `Your /${entry.code}/ vote was rejected: ${err.verdict.reason}. Fix the cause and publish again.`;
}

/* ---------- voting ---------- */
function showWalletError(message: string) {
    const el = $("wallet-error");
    el.textContent = message;
    el.hidden = false;
    $("wallet-card").scrollIntoView({ behavior: "smooth", block: "center" });
    log(message);
}

async function castVote(entry: DirEntry, votes: Vote[]) {
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
            `/${entry.code}/ vote published for [${votedFor || "(empty ballot — retracts previous vote)"}] by ${signer.connectedAddress} ` +
                `(gossipsub sent it directly to ${recipientCount} peer${recipientCount === 1 ? "" : "s"})`
        );
        const address = signer.connectedAddress;
        if (address) {
            if (votes.length === 0) localStorage.removeItem(myVoteKey(entry, address));
            else
                localStorage.setItem(
                    myVoteKey(entry, address),
                    JSON.stringify({
                        publicKey: votes[0].community.publicKey,
                        name: votes[0].community.name,
                        at: Date.now()
                    } satisfies StoredVote)
                );
        }
        renderMyVote();
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
/** EXPERIMENT: pre-warm the community-serving peers at boot (see PREWARM_PEER_ADDRS). */
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

    /* EXPERIMENT (?prewarm=0 to disable): open the community-serving peers' connections NOW,
     * concurrently with everything below, instead of paying for them at t+3.4 s when the first
     * leaderboard resolves and pkc-js starts discovering. See PREWARM_PEER_ADDRS for the
     * measurement that motivates it. Fire-and-forget by design — a failed pre-warm must cost
     * nothing, since the normal discovery path still runs underneath. */
    if (PREWARM) {
        for (const addr of PREWARM_PEER_ADDRS) {
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
            for (const chunk of record?.chunks ?? []) checkpointChunks.set(chunk.toString(), chunk);
            if (record?.chunks?.length) void refreshCheckpointBundles(helia.blockstore);
            return value;
        } catch (err) {
            phase("fetch-failed", keyStr, { wireMs: performance.now() - startedAt, isVoteRoot, isBulkRoots, error: (err as Error).message });
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
    if (selected) {
        renderTally();
        showSelectedCommunity();
    }
}

main().catch((err) => {
    log(`fatal: ${(err as Error).stack ?? err}`);
});
