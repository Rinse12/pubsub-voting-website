import { delegatedRoutingV1HttpApiClient } from "@helia/delegated-routing-v1-http-api-client";
import { contentRoutingSymbol, peerRoutingSymbol, type ContentRouting, type PeerRouting } from "@libp2p/interface";

/**
 * A delegated-routing client whose streaming errors END that router's stream instead of
 * throwing. libp2p merges every router's findProviders/getClosestPeers stream with
 * it-merge, which rejects the WHOLE merged stream the moment any one source throws — so
 * a single dead router (e.g. a Cloudflare 521) would blind discovery to providers the
 * healthy routers are already serving. (findPeer doesn't need this: libp2p's compound
 * peer routing already catches per-router findPeer errors.)
 */
export function faultTolerantDelegatedRouting(url: string) {
    const factory = delegatedRoutingV1HttpApiClient({ url });
    return (components: unknown) => {
        const client = factory(components as never);
        const swallow = <A extends unknown[], T>(routing: object, fn: (...args: A) => AsyncIterable<T>, what: string) => {
            const inner = fn.bind(routing) as (...args: A) => AsyncIterable<T>;
            return async function* (...args: A): AsyncIterable<T> {
                try {
                    yield* inner(...args);
                } catch (err) {
                    console.warn(`router ${url}: ${what} failed — ${(err as Error).message}`);
                }
            };
        };
        // The published typings omit the class's [contentRoutingSymbol]/[peerRoutingSymbol]
        // getters libp2p discovers the routing implementations through.
        const symbols = client as unknown as {
            [contentRoutingSymbol]: ContentRouting;
            [peerRoutingSymbol]: PeerRouting;
        };
        const content = symbols[contentRoutingSymbol];
        content.findProviders = swallow(content, content.findProviders, "findProviders");
        const peer = symbols[peerRoutingSymbol];
        peer.getClosestPeers = swallow(peer, peer.getClosestPeers, "getClosestPeers");
        return client;
    };
}
