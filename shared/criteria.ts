import type { Criteria } from "@bitsocial/pubsub-voting";

/**
 * The contest configuration, shared byte-identically by the web client and the seeder.
 *
 * The pubsub topic is derived from this document's canonical dag-cbor CID
 * (topic = "bitsocial-votes/" + CID). ANY change to the `criteria` object below changes
 * the topic and forks the contest, so the site and the seeder must always ship the same
 * document. Since pubsub-voting 0.1.x, RPC URLs are deliberately NOT part of the document
 * (see the RPC lists below) — an operator can swap a dead provider without forking.
 */

/**
 * Public, CORS-enabled Ethereum mainnet RPCs. Client-local transport configuration — NOT
 * part of the criteria bytes. The contest itself no longer reads Ethereum (see
 * BASE_SEPOLIA_RPC_URLS), but the .bso name resolvers (shared/resolvers.ts) still
 * resolve against mainnet, so the list stays.
 */
export const ETH_RPC_URLS = ["https://ethereum-rpc.publicnode.com", "https://eth.drpc.org"] as const;

/**
 * Public, CORS-enabled Base Sepolia RPCs (both verified to serve archive state, which
 * pinned bucket-block balanceOf reads need). Client-local transport configuration — NOT
 * part of the criteria bytes: these feed the chain-client factory (shared/chains.ts).
 * `requires.chains.baseSepolia` is where every peer samples the bucket block, reads the
 * 5chan Pass gate balance, binds the chainId into each EIP-712 ballot, and takes the
 * tally's tie-break block hash.
 */
export const BASE_SEPOLIA_RPC_URLS = ["https://sepolia.base.org", "https://base-sepolia.drpc.org"] as const;

export const criteria: Criteria = {
    name: "5chan Pass board vote (test)",
    // Distinct contestId per contest; bump the suffix to start a fresh contest.
    contestId: "5chan-pass-vote-test-1",
    // v1 upvote-only: each vote value is exactly 1.
    voteSchema: { min: 1, max: 1 },
    // One board choice per wallet; publishing again replaces the previous vote (LWW).
    maxVotesPerAddress: 1,
    // ~1 hour of Base Sepolia blocks (2s): all verifiers stamp votes (and read gate
    // balances) against the same sampled block within a bucket.
    blocksPerBucket: 1800,
    // A vote stays valid ~30 days after its block; re-vote before then to keep it alive.
    voteExpiryBuckets: 720,
    // Gate: hold at least one 5chan Pass — the FiveChanPass ERC-721 on Base Sepolia
    // (a free testnet NFT, airdropped by its owner). Every peer verifies each vote by
    // reading balanceOf(voter) at the bucket block.
    rule: {
        type: "erc721-min-balance",
        chain: "baseSepolia",
        contract: "0xa0095E8B45EBd2Fc590FeBC249bBc191D74920a9",
        min: 1
    },
    // ...and every eligible wallet counts exactly once.
    weight: { type: "constant", value: 1 },
    requires: {
        // Built-ins only: any stock @bitsocial/pubsub-voting client can join this contest.
        rules: ["erc721-min-balance", "constant"],
        // Ticker + chainId only (consensus-critical); which RPC gateway serves the reads
        // is each client's own choice via the ChainClientFactory.
        chains: { baseSepolia: { chainId: 84532 } }
    }
};

/** UI-side helper, NOT part of the criteria bytes. Average Base Sepolia block time, for turning bucket math into wall-clock estimates. */
export const SECONDS_PER_BLOCK = 2;
