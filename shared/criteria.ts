import type { Criteria } from "@bitsocial/pubsub-voting";

/**
 * The contest configuration, shared byte-identically by the web client and the seeder.
 *
 * The pubsub topic is derived from this document's canonical dag-cbor CID
 * (topic = "bitsocial-votes/" + CID). ANY change here — including the RPC URLs and the
 * contract address — changes the topic and forks the contest, so the site and the seeder
 * must always ship the same document.
 */

/**
 * The BSO ERC-20 contract on Ethereum mainnet ("Bitsocial", symbol BSO, 18 decimals —
 * verified on-chain). Replacing it changes the topic: redeploy the site AND restart
 * the seeder together.
 */
export const BSO_CONTRACT = "0xB50cea4c109dc223A10d44c14f521CaeD91DaB5A";

/**
 * Public, CORS-enabled, archive-capable Ethereum mainnet RPCs. Archive matters:
 * verifiers re-read balances at each bundle's historical bucket block (up to
 * voteExpiryBuckets old). These are consensus-critical bytes (part of the topic).
 */
export const ETH_RPC_URLS = ["https://ethereum-rpc.publicnode.com", "https://eth.drpc.org"] as const;

export const criteria: Criteria = {
    name: "BSO board vote (test)",
    // Distinct contestId per contest; bump the suffix to start a fresh contest.
    contestId: "bso-board-vote-test-1",
    // v1 upvote-only: each vote value is exactly 1.
    voteSchema: { min: 1, max: 1 },
    // One board choice per wallet; publishing again replaces the previous vote (LWW).
    maxVotesPerAddress: 1,
    // ~1 hour of Ethereum mainnet blocks (12s): all verifiers read balances at the same
    // sampled block within a bucket.
    blocksPerBucket: 300,
    // A vote stays valid ~30 days after its block; re-vote before then to keep it alive.
    voteExpiryBuckets: 720,
    // Gate: any wallet holding >= 1 BSO may vote...
    rule: { type: "erc20-balance", chain: "eth", contract: BSO_CONTRACT, decimals: 18, min: 1 },
    // ...and every eligible wallet counts exactly once (not balance-weighted).
    weight: { type: "constant", value: 1 },
    requires: {
        rules: ["erc20-balance", "constant"],
        chains: { eth: { chainId: 1, rpcUrls: [...ETH_RPC_URLS] } }
    }
};

/** UI-side helpers, NOT part of the criteria bytes. */
export const CHAIN_TICKER = "eth";
export const CHAIN_ID = 1;
export const TOKEN_SYMBOL = "BSO";
export const TOKEN_DECIMALS = 18;
/** Average mainnet block time, for turning bucket math into wall-clock estimates. */
export const SECONDS_PER_BLOCK = 12;
