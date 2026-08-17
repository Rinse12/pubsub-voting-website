import { readFileSync } from "node:fs";
import { createLibp2p } from "libp2p";
import { tcp } from "@libp2p/tcp";
import { webSockets } from "@libp2p/websockets";
import { noise } from "@chainsafe/libp2p-noise";
import { yamux } from "@chainsafe/libp2p-yamux";
import { identify } from "@libp2p/identify";
import { gossipsub } from "@libp2p/gossipsub";
import { fetch as fetchService } from "@libp2p/fetch";
import { createHelia } from "helia";
import { multiaddr } from "@multiformats/multiaddr";
import {
    PubsubVoter,
    InvalidCommunityNameError,
    EIP712_SIGNATURE_TYPE,
    type BallotTypedData,
    type Signature,
    type VoteSigner,
    type Criteria
} from "@bitsocial/pubsub-voting";
import { privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";
import { allCriteria, directoryCodeOf, sharedRules } from "../shared/contests.js";
import { chainClientFactory } from "../shared/chains.js";
import { makeNameResolvers } from "../shared/resolvers.js";

/**
 * Seed each directory contest with one REAL signed vote for its registered candidate
 * board (from the lists repo) — the same ballots any visitor casts, published over
 * pubsub and verified by every peer; nothing is imported into the tally out-of-band.
 *
 * The signing wallet lives in .vote-seed-wallet.json (gitignored; generated once) and
 * must hold a 5chan Pass: the script WAITS until `contest.checkEligibility` says the
 * contest's own gate admits the wallet, then publishes one vote per directory and
 * verifies a sample of tallies converged. It does not read any balance itself — which
 * block the gate reads at is the rule's business (today: the head first, so a Pass
 * airdropped mid-window counts immediately).
 *
 * One wallet gets ONE vote per contest (maxVotesPerAddress 1, last-write-wins), so a
 * directory with several registered candidates (/biz/, /pol/) gets a vote for its
 * FIRST-registered board only. Re-running the script re-publishes the same votes,
 * which is exactly how votes are kept alive past voteExpiryBuckets (~30 d).
 *
 *   npx tsx scripts/seed-candidate-votes.ts
 *
 * Env: WALLET_FILE (default .vote-seed-wallet.json), SEEDER_ADDR (default the
 * production seeder's TCP addr), GATE_POLL_S (default 30), GATE_TIMEOUT_H (default 24).
 */

const seederAddr =
    process.env.SEEDER_ADDR ??
    "/ip4/89.36.231.48/tcp/6742/p2p/12D3KooWMHBC5CbncuNVLn6LtNc3UcSFXYPDGBK77zNrscmtAHW7";
const walletFile = process.env.WALLET_FILE ?? ".vote-seed-wallet.json";
const gatePollS = Number(process.env.GATE_POLL_S ?? 30);
const gateTimeoutH = Number(process.env.GATE_TIMEOUT_H ?? 24);
const RAW_BASE = "https://raw.githubusercontent.com/bitsocialnet/lists/master/5chan-directories";

const t0 = Date.now();
const log = (msg: string) => console.log(`[t+${((Date.now() - t0) / 1000).toFixed(1)}s] ${msg}`);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** The same EIP-712 ballot signing the site's burner wallet does, over a key file. */
class KeySigner implements VoteSigner {
    constructor(private readonly account: PrivateKeyAccount) {}
    address(): string {
        return this.account.address;
    }
    async signBallot(typedData: BallotTypedData): Promise<Signature> {
        const signature = await this.account.signTypedData({
            domain: typedData.domain,
            types: typedData.types,
            primaryType: typedData.primaryType,
            message: typedData.message
        });
        return { signature, type: EIP712_SIGNATURE_TYPE };
    }
}

const wallet = JSON.parse(readFileSync(walletFile, "utf8")) as { address: `0x${string}`; privateKey: `0x${string}` };
const account = privateKeyToAccount(wallet.privateKey);
log(`seed wallet: ${account.address}`);

/* ---------- 1. the candidate board per directory (lists repo, first-registered) ---------- */
interface Board {
    address: string;
    publicKey: string;
    addedAt?: number;
}
const picks: { criteria: Criteria; code: string; board: Board; alsoRegistered: Board[] }[] = [];
for (const criteria of allCriteria) {
    const code = directoryCodeOf(criteria);
    const res = await fetch(`${RAW_BASE}/5chan-${code}-directory.json`);
    if (res.status === 404) continue; // no candidates registered for this directory yet
    if (!res.ok) throw new Error(`fetching /${code}/ candidates failed: ${res.status}`);
    const boards = ((await res.json()) as { boards?: Board[] }).boards ?? [];
    if (boards.length === 0) continue;
    const sorted = [...boards].sort((a, b) => (a.addedAt ?? 0) - (b.addedAt ?? 0));
    picks.push({ criteria, code, board: sorted[0], alsoRegistered: sorted.slice(1) });
}
log(`${picks.length}/${allCriteria.length} directories have a registered candidate to vote for`);
for (const { code, alsoRegistered } of picks)
    for (const other of alsoRegistered)
        log(`note: /${code}/ also registers ${other.address} — one wallet votes once per directory, so it gets NO vote from this wallet`);

/* ---------- 2. a real voter node, meshed through the production seeder ---------- */
const libp2p = await createLibp2p({
    transports: [tcp(), webSockets()],
    connectionEncrypters: [noise()],
    streamMuxers: [yamux()],
    connectionGater: { denyDialMultiaddr: () => false },
    services: {
        identify: identify(),
        fetch: fetchService(),
        pubsub: gossipsub({ scoreParams: { IPColocationFactorWeight: 0 } })
    }
});
const helia = await createHelia({ libp2p });
const voter = new PubsubVoter({
    helia,
    chains: chainClientFactory,
    signer: new KeySigner(account),
    nameResolvers: makeNameResolvers()
});
await libp2p.dial(multiaddr(seederAddr));
log(`connected to seeder as ${libp2p.peerId}`);

const pubsub = libp2p.services.pubsub as { getSubscribers(topic: string): unknown[] };
const waitForSubscriber = async (topic: string) => {
    const deadline = Date.now() + 20_000;
    while (pubsub.getSubscribers(topic).length === 0 && Date.now() < deadline) await sleep(200);
    return pubsub.getSubscribers(topic).length > 0;
};

/* ---------- 3. wait until the wallet passes the contest's own gate ---------- */
// This used to read `balanceOf` itself, twice — at head and at the voting window's boundary
// block — and hold the votes back until the Pass was visible at the boundary. That was a copy
// of the gate rule's block choice living outside the rule, and it went stale exactly as the
// site's did: the v1 gate reads the HEAD first, so a Pass acquired mid-window votes
// immediately and there is no next window to wait for. Ask the contest instead — it runs the
// real gate through the real verify context and answers in the rule's own words. Any contest
// answers for all of them: they share one gate, and the library namespaces the memo by rule.
const gateContest = await voter.createContest({ criteria: sharedRules });
const gateDeadline = Date.now() + gateTimeoutH * 3600_000;
for (;;) {
    // A transient RPC failure must never kill a poll that may run for hours — log it
    // and try again next tick.
    try {
        const check = await gateContest.checkEligibility({ address: account.address });
        if (check.eligible) {
            log(`gate PASSES (score ${check.score}) — publishing votes`);
            break;
        }
        // The rule's own wording, rendered verbatim: this script knows nothing about
        // contracts, thresholds or blocks any more.
        log(`waiting for the 5chan Pass airdrop to ${account.address}: ${check.error}`);
    } catch (err) {
        log(`gate poll failed (retrying next tick): ${(err as Error).message?.split("\n")[0]}`);
    }
    if (Date.now() > gateDeadline) throw new Error(`gate never passed within ${gateTimeoutH} h — rerun after the airdrop`);
    await sleep(gatePollS * 1000);
}
await gateContest.stop();

/* ---------- 4. publish one vote per directory ---------- */
const failures: string[] = [];
let published = 0;
for (const { criteria, code, board } of picks) {
    const named = board.address !== board.publicKey;
    const community = named ? { publicKey: board.publicKey, name: board.address } : { publicKey: board.publicKey };
    try {
        const vote = await voter.createContestVote({ criteria, votes: [{ community, vote: 1 }] });
        if (!(await waitForSubscriber(vote.topic))) throw new Error("seeder never showed as topic subscriber");
        try {
            const { recipientCount } = await vote.publish();
            published++;
            log(`/${code}/ voted for ${board.address} (${recipientCount} direct recipient(s))`);
        } catch (err) {
            if (!(err instanceof InvalidCommunityNameError) || !named) throw err;
            // The claimed .bso name provably doesn't resolve to this key — the registry
            // entry is stale/wrong. The board can still be voted by its bare key.
            log(`/${code}/ name ${board.address} failed resolution (${(err as Error).message}) — voting by public key only`);
            const bare = await voter.createContestVote({ criteria, votes: [{ community: { publicKey: board.publicKey }, vote: 1 }] });
            const { recipientCount } = await bare.publish();
            published++;
            log(`/${code}/ voted for ${board.publicKey} (${recipientCount} direct recipient(s))`);
        }
    } catch (err) {
        failures.push(code);
        log(`/${code}/ FAILED: ${(err as Error).message}`);
    }
    await sleep(200); // don't firehose the seeder's verify pipeline
}
log(`published ${published}/${picks.length} votes${failures.length ? `; FAILED: ${failures.join(", ")}` : ""}`);

/* ---------- 5. verify a sample of tallies converged (fresh contest views) ---------- */
const sample = ["g", "a", "biz", "pol", "x"].filter((code) => picks.some((p) => p.code === code));
let verified = 0;
for (const code of sample) {
    const criteria = allCriteria.find((c) => directoryCodeOf(c) === code)!;
    const contest = await voter.createContest({ criteria });
    await contest.update();
    const deadline = Date.now() + 30_000;
    while ((contest.tally?.ranking ?? []).length === 0 && Date.now() < deadline) await sleep(1000);
    const top = contest.tally?.ranking[0];
    if (top) {
        verified++;
        log(`verify /${code}/: leader ${top.community.name ?? top.community.publicKey} with ${top.weight} vote(s)${top.chainVerified ? " (chain-verified)" : ""}`);
    } else log(`verify /${code}/: tally still empty after 30 s — check the seeder log`);
    await contest.stop();
}
log(`verified ${verified}/${sample.length} sampled tallies`);

await voter.destroy().catch(() => {});
await helia.stop().catch(() => {});
process.exit(failures.length === 0 && verified === sample.length ? 0 : 1);
