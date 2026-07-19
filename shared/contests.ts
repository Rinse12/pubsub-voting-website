import { deriveDirectoryCriteria, type Criteria } from "@bitsocial/pubsub-voting";
import { directoryManifest } from "./directory-manifest.js";

/**
 * The contest set, shared semantically byte-identically by the web client and the seeder.
 *
 * One contest per 5chan directory slot (63 of them), all derived from the generated
 * manifest (shared/directory-manifest.ts — see scripts/generate-directory-manifest.ts)
 * through the library's own deriveDirectoryCriteria, the SAME helper the seeder derives
 * with (bitsocial-seeder lib/votes/manifest.js). Each derived document's canonical
 * dag-cbor CID is that contest's pubsub topic ("bitsocial-votes/" + CID), so ANY change
 * to the manifest forks the affected contests — site and seeder must always ship the
 * same manifest. RPC URLs are deliberately NOT part of the documents (see below).
 */

/**
 * Public, CORS-enabled Ethereum mainnet RPCs. Client-local transport configuration — NOT
 * part of the criteria bytes. The contests themselves no longer read Ethereum (see
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

/** All 63 directory contests, in directory-code order (the manifest is sorted by code). */
export const allCriteria: Criteria[] = deriveDirectoryCriteria(directoryManifest);

/**
 * Every entry shares the manifest `defaults` (gate, bucket size, expiry, weight), so any
 * one document can answer "what are the rules?" — eligibility checks and bucket math read
 * this one instead of repeating themselves per contest.
 */
export const sharedRules: Criteria = allCriteria[0];

/** The directory code a contestId encodes, e.g. "5chan-dir-g-vote-test-1" → "g". */
export function directoryCodeOf(criteria: Criteria): string {
    const match = /^5chan-dir-(.+)-vote-test-\d+$/.exec(criteria.contestId);
    if (!match) throw new Error(`contestId ${criteria.contestId} does not encode a directory code`);
    return match[1];
}

/** UI-side helper, NOT part of the criteria bytes. Average Base Sepolia block time, for turning bucket math into wall-clock estimates. */
export const SECONDS_PER_BLOCK = 2;
