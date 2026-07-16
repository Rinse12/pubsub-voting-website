import { BsoResolver } from "@bitsocial/bso-resolver";
import { ETH_RPC_URLS } from "./criteria.js";

/**
 * .bso name resolvers, injected into PubsubVoter as `nameResolvers`.
 *
 * A vote MAY carry a community `name` (e.g. "memes.bso") next to its publicKey, but the
 * name is a verified claim: peers resolve it and DROP the whole vote if it does not
 * resolve to the claimed publicKey. A name whose TLD no resolver handles is dropped too.
 * The site UI therefore treats the name field as optional-and-dangerous: leave it empty
 * unless the board really owns that .bso name.
 */
export function makeNameResolvers() {
    return ETH_RPC_URLS.map(
        (url) =>
            new BsoResolver({
                key: `bso-${new URL(url).host}`,
                provider: url
            })
    );
}
