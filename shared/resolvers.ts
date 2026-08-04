import { BsoResolver } from "@bitsocial/bso-resolver";
import { ETH_RPC_URLS } from "./contests.js";

/**
 * .bso name resolvers, injected into PubsubVoter as `nameResolvers`.
 *
 * A vote MAY carry a community `name` (e.g. "memes.bso") next to its publicKey, but the
 * name is a verified claim: peers resolve it and DROP the whole vote if it does not
 * resolve to the claimed publicKey. A name whose TLD no resolver handles is dropped too.
 * The site UI therefore treats the name field as optional-and-dangerous: leave it empty
 * unless the board really owns that .bso name.
 */

/**
 * Cap the Multicall3 batch well below bso-resolver's own default of 100 KB
 * (bitsocialnet/bso-resolver#8). That default is fine against a private node but hostile
 * to the public, unauthenticated endpoints ETH_RPC_URLS points at: a ~100 KB `eth_call`
 * gets rejected or throttled, and because a batch fails as ONE call, every name in it
 * fails together and viem then retries the whole thing. Each retry allocates another copy
 * of the request body, because viem embeds it verbatim in `HttpRequestError.message` —
 * measured at 37,516 concurrent ~34 KB error strings holding 112 MB during a profiling
 * run, with the resulting GC churn dominating the tab's memory profile.
 *
 * A resolve is ~500-600 bytes of calldata, so this still coalesces ~7 per call — most of
 * the round-trip saving — while keeping bodies small enough for a public RPC to accept.
 * Raise it only when pointing at a node that is ours.
 */
const NAME_RESOLVER_BATCH_SIZE = 4096;

export function makeNameResolvers() {
    return ETH_RPC_URLS.map(
        (url) =>
            new BsoResolver({
                key: `bso-${new URL(url).host}`,
                provider: url,
                batch: { batchSize: NAME_RESOLVER_BATCH_SIZE }
            })
    );
}
