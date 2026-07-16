import type { Criteria } from "@bitsocial/pubsub-voting";

/**
 * The contest configuration, shared byte-identically by the web client and the seeder.
 *
 * The pubsub topic is derived from this document's canonical dag-cbor CID
 * (topic = "bitsocial-votes/" + CID). ANY change here — including the RPC URLs — changes
 * the topic and forks the contest, so the site and the seeder must always ship the same
 * document.
 */

/**
 * Public, CORS-enabled Ethereum mainnet RPCs. With the open `constant` gate there are no
 * balance reads, but the chain is still consensus-critical: the first entry in
 * `requires.chains` is where every peer samples the bucket block (vote freshness/expiry),
 * the chainId bound into each EIP-712 ballot, and the tally's tie-break block hash.
 */
export const ETH_RPC_URLS = ["https://ethereum-rpc.publicnode.com", "https://eth.drpc.org"] as const;

export const criteria: Criteria = {
    name: "BSO board vote (test)",
    // Distinct contestId per contest; bump the suffix to start a fresh contest.
    contestId: "bso-board-vote-test-2",
    // v1 upvote-only: each vote value is exactly 1.
    voteSchema: { min: 1, max: 1 },
    // One board choice per wallet; publishing again replaces the previous vote (LWW).
    maxVotesPerAddress: 1,
    // ~1 hour of Ethereum mainnet blocks (12s): all verifiers stamp votes against the same
    // sampled block within a bucket.
    blocksPerBucket: 300,
    // A vote stays valid ~30 days after its block; re-vote before then to keep it alive.
    voteExpiryBuckets: 720,
    // Gate: OPEN — the built-in `constant` rule scores every wallet 1 > 0, so any EVM
    // wallet that can sign is eligible (test contest: we want maximum participation;
    // knowingly sybil-open since wallets are free to generate).
    rule: { type: "constant", value: 1 },
    // ...and every wallet counts exactly once.
    weight: { type: "constant", value: 1 },
    requires: {
        // Built-ins only: any stock @bitsocial/pubsub-voting client can join this contest.
        rules: ["constant"],
        // Still required: a chainless rule falls back to the first configured chain for
        // bucket sampling, the ballot chainId, and the tie-break hash.
        chains: { eth: { chainId: 1, rpcUrls: [...ETH_RPC_URLS] } }
    }
};

/** UI-side helper, NOT part of the criteria bytes. Average mainnet block time, for turning bucket math into wall-clock estimates. */
export const SECONDS_PER_BLOCK = 12;
