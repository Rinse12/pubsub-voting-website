import type { Criteria } from "@bitsocial/pubsub-voting";

/**
 * The contest configuration, shared byte-identically by the web client and the seeder.
 *
 * The pubsub topic is derived from this document's canonical dag-cbor CID
 * (topic = "bitsocial-votes/" + CID). ANY change to the `criteria` object below changes
 * the topic and forks the contest, so the site and the seeder must always ship the same
 * document. Since pubsub-voting 0.1.x, RPC URLs are deliberately NOT part of the document
 * (see ETH_RPC_URLS below) — an operator can swap a dead provider without forking.
 */

/**
 * Public, CORS-enabled Ethereum mainnet RPCs. Client-local transport configuration — NOT
 * part of the criteria bytes (pubsub-voting 0.1.x moved endpoints out of the document):
 * these feed the chain-client factory (shared/chains.ts) and the .bso name resolvers
 * (shared/resolvers.ts). With the open `constant` gate there are no balance reads, but the
 * chain is still consensus-critical: `requires.chains.eth` is where every peer samples the
 * bucket block (vote freshness/expiry), the chainId bound into each EIP-712 ballot, and
 * the tally's tie-break block hash.
 */
export const ETH_RPC_URLS = ["https://ethereum-rpc.publicnode.com", "https://eth.drpc.org"] as const;

export const criteria: Criteria = {
    name: "BSO board vote (test)",
    // Distinct contestId per contest; bump the suffix to start a fresh contest.
    // test-3: the pubsub-voting 0.1.x criteria schema (rpcUrls removed from the document)
    // re-derives the topic anyway, so the id marks the fork honestly.
    contestId: "bso-board-vote-test-3",
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
        // Ticker + chainId only (consensus-critical); which RPC gateway serves the reads
        // is each client's own choice via the ChainClientFactory.
        chains: { eth: { chainId: 1 } }
    }
};

/** UI-side helper, NOT part of the criteria bytes. Average mainnet block time, for turning bucket math into wall-clock estimates. */
export const SECONDS_PER_BLOCK = 12;
