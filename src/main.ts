import { PubsubVoter, topicFor, CommunitySchema, type Contest, type Vote } from "@bitsocial/pubsub-voting";
import { erc20Abi, formatUnits, getAddress } from "viem";
import { criteria, BSO_CONTRACT, SECONDS_PER_BLOCK, TOKEN_DECIMALS, TOKEN_SYMBOL } from "../shared/criteria.js";
import { customRules } from "../shared/erc20-balance-rule.js";
import { chainClientFactory, makeEthClient } from "../shared/chains.js";
import { makeNameResolvers } from "../shared/resolvers.js";
import { startBrowserNode, keepSeederConnected } from "./node.js";
import { InjectedWalletSigner } from "./signer.js";

/* ---------- tiny DOM helpers ---------- */
const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;
const logEl = $<HTMLPreElement>("log");
function log(message: string) {
    const line = `[${new Date().toLocaleTimeString()}] ${message}`;
    console.log(line);
    logEl.textContent = `${line}\n${logEl.textContent ?? ""}`.slice(0, 20_000);
}
const shortKey = (key: string) => (key.length > 20 ? `${key.slice(0, 10)}…${key.slice(-6)}` : key);

const contractIsPlaceholder = BSO_CONTRACT.includes("TODO");

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
const signer = new InjectedWalletSigner();
let voter: PubsubVoter;
let contest: Contest;
let publishing = false;

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
        // Identity is always publicKey; show the name only once it verified on-chain.
        const label = row.community.name && row.nameResolved ? row.community.name : shortKey(row.community.publicKey);
        const tr = document.createElement("tr");

        const cells = [String(i + 1), label, String(row.weight), ""];
        for (const text of cells) {
            const td = document.createElement("td");
            td.textContent = text;
            tr.appendChild(td);
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

async function renderWallet(address: `0x${string}`) {
    $("connect-btn").textContent = "Reconnect wallet";
    $("wallet-info").hidden = false;
    $("wallet-address").textContent = address;
    renderMyVote();
    if (contractIsPlaceholder) {
        $("wallet-balance").textContent = "unknown — BSO contract address not configured yet";
        $("wallet-eligible").innerHTML = `<span class="badge-bad">voting disabled (placeholder contract)</span>`;
        return;
    }
    try {
        const balance = await makeEthClient().readContract({
            address: getAddress(BSO_CONTRACT),
            abi: erc20Abi,
            functionName: "balanceOf",
            args: [address]
        });
        const whole = formatUnits(balance, TOKEN_DECIMALS);
        $("wallet-balance").textContent = `${whole} ${TOKEN_SYMBOL}`;
        const eligible = Number(whole) >= 1;
        $("wallet-eligible").innerHTML = eligible
            ? `<span class="badge-ok">yes — you can vote</span>`
            : `<span class="badge-bad">no — needs ≥ 1 ${TOKEN_SYMBOL}</span>`;
    } catch (err) {
        $("wallet-balance").textContent = "balance read failed (RPC error)";
        log(`balance read failed: ${(err as Error).message}`);
    }
}

/* ---------- voting ---------- */
async function castVote(votes: Vote[]) {
    if (publishing) return;
    if (contractIsPlaceholder) {
        log("Cannot vote: the BSO contract address in shared/criteria.ts is still the placeholder.");
        return;
    }
    if (!signer.connectedAddress) {
        log("Connect your wallet first — the vote must be signed by the wallet holding your BSO.");
        return;
    }
    publishing = true;
    try {
        const vote = await voter.createContestVote({ criteria, votes });
        vote.on("publishingstatechange", (state: string) => log(`publishing state: ${state}`));
        const { recipientCount } = await vote.publish();
        log(`vote published (gossipsub sent it directly to ${recipientCount} peer${recipientCount === 1 ? "" : "s"})`);
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
        if (message.includes("NoPeersSubscribedToTopic") || message.includes("no peers"))
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
    if (contractIsPlaceholder)
        log("WARNING: shared/criteria.ts still has the placeholder BSO contract address — voting is disabled until it is filled in.");

    keepSeederConnected(helia, (connected, err) => {
        const dot = $("seeder-dot");
        dot.className = `dot ${connected ? "ok" : "bad"}`;
        $("seeder-status").textContent = connected
            ? "connected to seeder"
            : `not connected to seeder${err ? ` — ${err.message}` : ", retrying…"}`;
    });

    voter = new PubsubVoter({
        helia,
        chains: chainClientFactory,
        signer,
        rules: customRules,
        nameResolvers: makeNameResolvers()
    });

    contest = await voter.createContest({ criteria });
    contest.on("update", () => renderTally());
    contest.on("error", (err: unknown) => log(`contest error (retrying): ${err instanceof Error ? err.message : String(err)}`));
    await contest.update();
    log("joined the contest topic; syncing votes…");

    /* wire UI events */
    $("connect-btn").onclick = async () => {
        try {
            const address = await signer.connect();
            log(`wallet connected: ${address}`);
            await renderWallet(address);
        } catch (err) {
            log(`wallet connect failed: ${(err as Error).message}`);
        }
    };

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
