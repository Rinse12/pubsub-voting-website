import { createPublicClient, fallback, http } from "viem";
import { mainnet } from "viem/chains";
import type { ChainClient, ChainClientFactory } from "@bitsocial/pubsub-voting";
import { ETH_RPC_URLS } from "./criteria.js";

/**
 * ChainClientFactory for PubsubVoter. Since pubsub-voting 0.1.x the criteria names chains
 * by ticker + chainId only and the RPC endpoints are this client's own configuration, so
 * the factory maps chainId 1 to a viem PublicClient over ETH_RPC_URLS with automatic
 * fallback, and recuses (returns undefined) for any other chain. One memoized client per
 * process, as the voter's read coalescer expects; mainnet's viem chain config carries the
 * multicall3 deployment the background verifier batches cold-join gate reads through.
 */
let ethClient: ChainClient | undefined;
export const chainClientFactory: ChainClientFactory = ({ chainId }) => {
    if (chainId !== mainnet.id) return undefined;
    ethClient ??= createPublicClient({
        chain: mainnet,
        transport: fallback(ETH_RPC_URLS.map((url) => http(url)))
    });
    return ethClient;
};
