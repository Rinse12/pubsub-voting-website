import { createPublicClient, fallback, http } from "viem";
import { baseSepolia, mainnet } from "viem/chains";
import type { ChainClient, ChainClientFactory } from "@bitsocial/pubsub-voting";
import { BASE_SEPOLIA_RPC_URLS, ETH_RPC_URLS } from "./criteria.js";

/**
 * ChainClientFactory for PubsubVoter. Since pubsub-voting 0.1.x the criteria names chains
 * by ticker + chainId only and the RPC endpoints are this client's own configuration. The
 * contest requires Base Sepolia (bucket blocks + 5chan Pass balanceOf gate reads), so the
 * factory maps chainId 84532 to a viem PublicClient over BASE_SEPOLIA_RPC_URLS with
 * automatic fallback; mainnet stays available for contests that need it. One memoized
 * client per chain per process, as the voter's read coalescer expects; both viem chain
 * configs carry the multicall3 deployment the background verifier batches cold-join gate
 * reads through.
 */
let baseSepoliaClient: ChainClient | undefined;
let ethClient: ChainClient | undefined;
export const chainClientFactory: ChainClientFactory = ({ chainId }) => {
    if (chainId === baseSepolia.id) {
        // baseSepolia's OP-stack formatters (deposit txs) make the concrete client type
        // structurally incompatible with ChainClient's default-generic PublicClient; the
        // voter only uses readContract/multicall/block reads, which are unaffected.
        baseSepoliaClient ??= createPublicClient({
            chain: baseSepolia,
            transport: fallback(BASE_SEPOLIA_RPC_URLS.map((url) => http(url)))
        }) as unknown as ChainClient;
        return baseSepoliaClient;
    }
    if (chainId === mainnet.id) {
        ethClient ??= createPublicClient({
            chain: mainnet,
            transport: fallback(ETH_RPC_URLS.map((url) => http(url)))
        });
        return ethClient;
    }
    return undefined;
};
