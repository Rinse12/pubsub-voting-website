import {
    PubsubVoter,
    topicFor,
    CommunitySchema,
    InvalidCommunityNameError,
    VoteEvictedError,
    type Contest,
    type Vote
} from "@bitsocial/pubsub-voting";
import { erc721Abi } from "viem";
import { criteria, SECONDS_PER_BLOCK } from "../shared/criteria.js";
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
import { startBrowserNode, keepSeederConnected } from "./node.js";
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

/* ---------- my-vote persistence (per contest + wallet) ---------- */
interface StoredVote {
    publicKey: string;
    name?: string;
    at: number; // epoch ms when published
}
let storageKey = "bso-vote"; // finalized once the topic is known
const myVoteKey = (address: string) => `${storageKey}:${address.toLowerCase()}`;
function loadMyVote(address: string): StoredVote | undefined {
    try {
        const raw = localStorage.getItem(myVoteKey(address));
        return raw ? (JSON.parse(raw) as StoredVote) : undefined;
    } catch {
        return undefined;
    }
}

/* ---------- state ---------- */
const signer = new BrowserWalletSigner();
let voter: PubsubVoter;
let contest: Contest;
let publishing = false;
let booted = false; // set once the initial contest.update() (join + snapshot restore) resolves

/* ---------- downloaded vote bundles (debug panel) ----------
 * Every signed bundle this tab has admitted, by CID, tagged with how it arrived. Two
 * exact wire taps (live-delta gossip messages; checkpoint chunks read back via the chunk
 * CIDs the last fetched root record advertised — retried on the next tally update if the
 * chase hasn't stored them yet) plus a catch-all tap on helia.blockstore.put, which every
 * CRDT admission path writes the standalone bundle block through. The put tap's source is
 * inferred from context (local vote / snapshot restore / chase), so an exact tag may
 * upgrade an inferred one when both see the same bundle. */
type BundleSource = "live gossip" | "checkpoint chunk" | "local vote" | "snapshot restore" | "chase";
const INFERRED_SOURCES = new Set<BundleSource>(["snapshot restore", "chase"]);
const downloadedBundles = new Map<string, { bundle: unknown; source: BundleSource }>();
let checkpointChunks: CID[] = [];

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
    for (const chunk of checkpointChunks) {
        try {
            const bytes = (await blockstore.get(chunk, { signal: AbortSignal.timeout(10_000) })) as Uint8Array;
            for (const item of await decodeChunkBundles(bytes)) addBundle(item, "checkpoint chunk");
        } catch {
            // Chunk not chased/served yet — the next tally update retries.
        }
    }
}

/* ---------- rendering ---------- */
function renderMyVote() {
    const card = $("my-vote-card");
    const address = signer.connectedAddress;
    const stored = address ? loadMyVote(address) : undefined;
    if (!stored) {
        card.hidden = true;
        return;
    }
    card.hidden = false;
    $("my-vote-target").textContent = stored.name ? `${stored.name} (${shortKey(stored.publicKey)})` : stored.publicKey;
    $("my-vote-when").textContent = new Date(stored.at).toLocaleString();
    const lifetimeMs = criteria.voteExpiryBuckets * criteria.blocksPerBucket * SECONDS_PER_BLOCK * 1000;
    $("my-vote-expiry").textContent = `≈ ${new Date(stored.at + lifetimeMs).toLocaleString()}`;
}

function renderTally() {
    const ranking = contest.tally?.ranking ?? [];
    $("tally-hint").hidden = ranking.length > 0;
    if (ranking.length === 0) {
        $("tally-hint").textContent = "No votes yet — be the first: submit a board below.";
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
        btn.onclick = () => void castVote([{ community: { publicKey: row.community.publicKey }, vote: 1 }]);
        actions.appendChild(btn);
        tr.appendChild(actions);
        body.appendChild(tr);
    });
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
    // The contest gate is `erc721-min-balance`: the wallet must hold a 5chan Pass.
    // Show the live balance read; peers verify the same read at the bucket block.
    $("wallet-eligible").textContent = "checking 5chan Pass balance…";
    void renderEligibility(address);
    renderMyVote();
}

async function renderEligibility(address: `0x${string}`) {
    const gate = criteria.rule as unknown as { contract: `0x${string}`; min: number };
    try {
        const chain = chainClientFactory({ chain: "baseSepolia", chainId: 84532 });
        if (!chain) throw new Error("no Base Sepolia chain client configured");
        const balance = await chain.readContract({
            address: gate.contract,
            abi: erc721Abi,
            functionName: "balanceOf",
            args: [address]
        });
        if (signer.connectedAddress !== address) return; // wallet changed mid-read
        $("wallet-eligible").innerHTML =
            balance >= BigInt(gate.min)
                ? `<span class="badge-ok">yes — holds ${balance} 5chan Pass${balance === 1n ? "" : "es"}</span>`
                : `<span class="badge-bad">no — holds no 5chan Pass (peers will drop this wallet's votes; ask the owner for an airdrop)</span>`;
    } catch (err) {
        if (signer.connectedAddress !== address) return;
        $("wallet-eligible").textContent = `balance check failed (${err instanceof Error ? err.message : String(err)}) — you can still vote; peers do their own read`;
    }
}

/* ---------- voting ---------- */
function showWalletError(message: string) {
    const el = $("wallet-error");
    el.textContent = message;
    el.hidden = false;
    $("wallet-card").scrollIntoView({ behavior: "smooth", block: "center" });
    log(message);
}

async function castVote(votes: Vote[]) {
    if (publishing) return;
    if (!signer.connectedAddress) {
        showWalletError(
            "No wallet yet — your vote must be signed by one. Connect an extension wallet (MetaMask etc.) or generate a free wallet in this browser, then vote again."
        );
        return;
    }
    publishing = true;
    try {
        const vote = await voter.createContestVote({ criteria, votes });
        vote.on("publishingstatechange", (state: string) => log(`publishing state: ${state}`));
        // Post-hoc rejection feedback: fires AFTER publish() resolved if a deferred check
        // (background gate read / name resolution) evicts this vote. The contest-level
        // handler owns the visible wallet-card alert; this keeps the debug log complete.
        vote.on("error", (err: unknown) => log(`vote error: ${err instanceof Error ? err.message : String(err)}`));
        const { recipientCount } = await vote.publish();
        // Name WHAT was voted for — a log full of anonymous "vote published" lines is
        // useless when several votes fly in one session.
        const votedFor = votes
            .map((v) => `${v.community.name ?? shortKey(v.community.publicKey)}:${v.vote >= 0 ? "+" : ""}${v.vote}`)
            .join(", ");
        log(
            `vote published for [${votedFor || "(empty ballot — retracts previous vote)"}] by ${signer.connectedAddress} ` +
                `(gossipsub sent it directly to ${recipientCount} peer${recipientCount === 1 ? "" : "s"})`
        );
        const address = signer.connectedAddress;
        if (address) {
            if (votes.length === 0) localStorage.removeItem(myVoteKey(address));
            else
                localStorage.setItem(
                    myVoteKey(address),
                    JSON.stringify({
                        publicKey: votes[0].community.publicKey,
                        name: votes[0].community.name,
                        at: Date.now()
                    } satisfies StoredVote)
                );
        }
        renderMyVote();
    } catch (err) {
        const message = (err as Error).message ?? String(err);
        if (err instanceof InvalidCommunityNameError)
            // publish() preflighted the name and refused before signing: it provably does
            // not resolve to the claimed key, so every peer would silently drop the vote.
            showWalletError(`Vote refused: ${message}`);
        else if (message.includes("NoPeersSubscribedToTopic") || message.includes("no peers"))
            log("publish failed: not connected to any topic peer yet — wait for the seeder connection and retry.");
        else log(`publish failed: ${message}`);
    } finally {
        publishing = false;
    }
}

/* ---------- boot ---------- */
async function main() {
    log("starting in-browser libp2p/Helia node…");
    const helia = await startBrowserNode();
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

    const topic = await topicFor(criteria);
    storageKey = `bso-vote:${topic}`;
    $("topic").textContent = topic;
    $("criteria-json").textContent = JSON.stringify(criteria, null, 2);
    log(`contest topic: ${topic}`);

    /* Wallet buttons + restore, before the network sync below: none of this needs the
     * voter, and a returning visitor should see their identity without waiting or clicking.
     * The restore waits for the topic above only because renderMyVote reads the
     * topic-scoped my-vote record. */
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
        // The my-vote record is keyed by that address, which can never be active again.
        if (address) localStorage.removeItem(myVoteKey(address));
        refreshBurnerButtons();
        if (wasActive) {
            $("wallet-info").hidden = true;
            $("connect-btn").textContent = "Connect wallet";
            renderMyVote();
        }
        log(address ? `browser wallet deleted: ${address}` : "no stored browser wallet to delete");
    };

    /* ---------- connectivity diagnostics ----------
     * Everything vote-sync does rides three observable seams: connections, gossipsub
     * subscriptions on the contest topic, and the cold-join checkpoint pull over the
     * fetch protocol. Log all three so "why don't I see votes?" is answerable from
     * the on-page log alone. */
    const libp2p = helia.libp2p;
    const pubsub = libp2p.services.pubsub as {
        getSubscribers(topic: string): unknown[];
        addEventListener(type: "subscription-change" | "message", cb: (evt: CustomEvent) => void): void;
    };
    libp2p.addEventListener("connection:open", (evt) =>
        log(`conn open: ${evt.detail.remotePeer} via ${evt.detail.remoteAddr}`)
    );
    libp2p.addEventListener("connection:close", (evt) => log(`conn close: ${evt.detail.remotePeer}`));
    pubsub.addEventListener("subscription-change", (evt) => {
        const detail = evt.detail as { peerId: unknown; subscriptions: { topic: string; subscribe: boolean }[] };
        for (const sub of detail.subscriptions ?? []) {
            if (sub.topic !== topic) continue;
            log(
                `topic ${sub.subscribe ? "subscribe" : "unsubscribe"}: ${detail.peerId} ` +
                    `(${pubsub.getSubscribers(topic).length} subscriber(s) visible)`
            );
        }
    });
    pubsub.addEventListener("message", (evt) => {
        const detail = evt.detail as { topic: string; data: Uint8Array; from?: unknown };
        if (detail.topic !== topic) return;
        void (async () => {
            log(`gossip from ${detail.from ?? "(unsigned)"}: ${await describeGossipMessage(detail.data)}`);
            const live = await extractLiveBundle(detail.data);
            if (live) addBundle(live, "live gossip");
        })();
    });
    const fetchSvc = libp2p.services.fetch as {
        fetch(peer: unknown, key: string | Uint8Array, opts?: unknown): Promise<Uint8Array | undefined>;
    };
    const realFetch = fetchSvc.fetch.bind(fetchSvc);
    fetchSvc.fetch = async (peer, key, opts) => {
        const keyStr = typeof key === "string" ? key : new TextDecoder().decode(key);
        log(`checkpoint fetch → ${peer} ${keyStr}`);
        try {
            const value = await realFetch(peer, key, opts);
            log(`checkpoint fetch ← ${value === undefined ? "no value" : `${value.length} bytes: ${describeRootRecord(value)}`}`);
            const record = value === undefined ? undefined : parseRootRecord(value);
            if (record?.chunks?.length) {
                checkpointChunks = record.chunks;
                void refreshCheckpointBundles(helia.blockstore);
            }
            return value;
        } catch (err) {
            log(`checkpoint fetch failed: ${(err as Error).message}`);
            throw err;
        }
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

    contest = await voter.createContest({ criteria });
    contest.on("update", () => {
        // Same line the seeder logs, so the two sides are directly comparable.
        const ranking = contest.tally?.ranking ?? [];
        const top = ranking[0];
        log(
            `tally update: ${ranking.length} board(s)` +
                (top ? `, leader ${top.community.name ?? shortKey(top.community.publicKey)} with ${top.weight} vote(s)` : "")
        );
        renderTally();
        // The chase that fired this update stored any checkpoint blocks it pulled.
        void refreshCheckpointBundles(helia.blockstore);
    });
    renderBundles();
    contest.on("error", (err: unknown) => {
        // Our own published vote failed a deferred check (gate read or name resolution) and
        // was evicted — every honest peer drops it the same way, so it counts nowhere. Show
        // it where the user acted (the wallet card) and retract the stale "Your vote" card.
        if (err instanceof VoteEvictedError) {
            showWalletError(`Your vote was rejected: ${err.verdict.reason}. Fix the cause and publish again.`);
            const address = err.bundle.address;
            if (address.toLowerCase() === signer.connectedAddress?.toLowerCase()) {
                localStorage.removeItem(myVoteKey(address));
                renderMyVote();
            }
            return;
        }
        log(`contest error (retrying): ${err instanceof Error ? err.message : String(err)}`);
    });
    await contest.update();
    booted = true;
    log("joined the contest topic; syncing votes…");

    /* wire the voting UI (needs the voter, so only after boot) */
    $<HTMLFormElement>("new-board-form").onsubmit = (e) => {
        e.preventDefault();
        const publicKey = $<HTMLInputElement>("board-key").value.trim();
        const name = $<HTMLInputElement>("board-name").value.trim();
        const community = CommunitySchema.safeParse(name ? { publicKey, name } : { publicKey });
        if (!community.success) {
            log(`invalid board: ${community.error.issues.map((i) => i.message).join("; ")}`);
            return;
        }
        void castVote([{ community: community.data, vote: 1 }]);
    };

    $("withdraw-btn").onclick = () => void castVote([]);
}

main().catch((err) => {
    log(`fatal: ${(err as Error).stack ?? err}`);
});
