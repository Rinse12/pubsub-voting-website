import { createPublicClient, fallback, http } from "viem";
import type { ChainClientFactory } from "@bitsocial/pubsub-voting";

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
