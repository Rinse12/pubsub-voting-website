import { createPublicClient, fallback, http, type PublicClient } from "viem";
import type { ChainClientFactory } from "@bitsocial/pubsub-voting";
import { ETH_RPC_URLS } from "./criteria.js";

/**
 * ChainClientFactory for PubsubVoter: one viem PublicClient per chain ticker, reading
 * through every RPC in criteria.requires.chains[ticker].rpcUrls with automatic fallback.
 * Multicall batching stays on — the library's background verifier batches cold-join
 * gate reads via multicall3.
 */
export const chainClientFactory: ChainClientFactory = ({ config }) =>
    createPublicClient({
        transport: fallback(config.rpcUrls.map((url) => http(url)))
    });

/** A plain mainnet client for UI reads (live BSO balance display). */
export function makeEthClient(): PublicClient {
    return createPublicClient({ transport: fallback(ETH_RPC_URLS.map((url) => http(url))) });
}
