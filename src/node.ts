import PKC, { type HeliaWithLibp2pPubsub } from "@pkcprotocol/pkc-js";
import { gossipsub } from "@libp2p/gossipsub";
import { criteriaCid } from "@bitsocial/pubsub-voting";
import { allCriteria } from "../shared/contests.js";
import { makeNameResolvers } from "../shared/resolvers.js";
import { DISCOVERY_TIMEOUT_MS, HTTP_ROUTER_URLS, REDIAL_INTERVAL_MS } from "./config.js";

export type Pkc = Awaited<ReturnType<typeof PKC>>;

/** The one libp2p-js client key; `pkc.clients.libp2pJsClients[KEY].heliaNode` is THE node. */
export const LIBP2P_CLIENT_KEY = "bso-board-vote";

/**
 * The page's single networking stack: one pkc-js instance whose in-browser Helia/libp2p
 * node is shared by BOTH consumers — pkc-js itself (community loading) and PubsubVoter
 * (vote sync), reached through the public `Libp2pJsClient.heliaNode` accessor
 * (semver-covered since pkc-js 0.0.72; what pubsub-voting 0.1.4 is built against).
 * Never start a second Helia next to it.
 *
 * pkc-js registers everything PubsubVoter's construction guards demand — gossipsub at
 * `libp2p.services.pubsub`, `@libp2p/fetch` at `libp2p.services.fetch`, a blockstore —
 * and wraps each delegated-routing HTTP router so one dead router ends ITS stream
 * instead of poisoning the merged `findProviders` (pkc-js issue #171; the same outage
 * this repo previously carried its own src/routing.ts wrapper for).
 */
export async function startPkcNode(): Promise<{ pkc: Pkc; helia: HeliaWithLibp2pPubsub }> {
    const pkc = await PKC({
        // Same six routers as the default list — pinned here because every votes seeder
        // announces to exactly these (see config.ts), and a pkc-js default change should
        // be a conscious re-sync, not a silent fork.
        httpRoutersOptions: HTTP_ROUTER_URLS,
        // The same .bso resolver instances the voter uses, so community/author names
        // resolve through the same chain endpoints (the pattern pubsub-voting documents).
        nameResolvers: makeNameResolvers(),
        libp2pJsClientsOptions: [
            {
                key: LIBP2P_CLIENT_KEY,
                libp2pOptions: {
                    services: {
                        // Test deployments often have several voters behind one IP (or one
                        // dev machine); don't let the colocation penalty graylist them.
                        pubsub: gossipsub({ scoreParams: { IPColocationFactorWeight: 0 } })
                    }
                }
            }
        ]
    });
    const helia = pkc.clients.libp2pJsClients[LIBP2P_CLIENT_KEY].heliaNode;
    return { pkc, helia };
}

/**
 * Keep at least one seeder connection alive, 5chan-style: ask the routers who provides
 * a contest's criteria CID, dial every provider's addrs (the transport skips the
 * browser-undialable plain-TCP ones), and re-run discovery whenever the connection
 * count to known seeders drops to zero. Reports state changes so the UI can show a
 * connectivity dot.
 *
 * With 63 directory contests there are 63 criteria CIDs; the production seeder announces
 * ALL of them, so providers of any one CID cover every contest. Each discovery round
 * queries ONE CID, rotating through the set, so a seeder that only announces a subset
 * of the directories is still found within a few rounds.
 */
export function keepSeederConnected(
    helia: HeliaWithLibp2pPubsub,
    onChange: (connected: boolean, error?: Error) => void
): () => void {
    // Every peer the routers have EVER returned for this contest: a connection to any
    // of them counts as "connected", even after the router entry's TTL lapses.
    const seederPeerIds = new Set<string>();

    const isConnected = () =>
        helia.libp2p.getConnections().some((c) => seederPeerIds.has(c.remotePeer.toString()));

    let stopped = false;
    let discovering = false;
    let cidIndex = 0;
    const tick = async () => {
        if (stopped || discovering) return;
        if (isConnected()) {
            onChange(true);
            return;
        }
        onChange(false);
        discovering = true;
        try {
            const cid = await criteriaCid(allCriteria[cidIndex % allCriteria.length]);
            cidIndex++;
            const signal = AbortSignal.timeout(DISCOVERY_TIMEOUT_MS);
            let lastError: Error | undefined;
            let found = 0;
            for await (const provider of helia.libp2p.contentRouting.findProviders(cid, { signal })) {
                found++;
                seederPeerIds.add(provider.id.toString());
                try {
                    // The provider's addrs carry /p2p/ suffixes as announced; dial() tries
                    // them all and the websocket transport filters out non-wss ones.
                    await helia.libp2p.dial(provider.multiaddrs.length > 0 ? provider.multiaddrs : provider.id, { signal });
                    onChange(true);
                    return;
                } catch (err) {
                    console.warn(`seeder dial failed (${provider.id}): ${(err as Error).message}`);
                    lastError = err as Error;
                }
            }
            onChange(
                false,
                lastError ?? new Error(found === 0 ? "no seeder found on the routers for this contest" : "no discovered seeder was dialable")
            );
        } catch (err) {
            onChange(isConnected(), err as Error);
        } finally {
            discovering = false;
        }
    };
    void tick();
    const timer = setInterval(() => void tick(), REDIAL_INTERVAL_MS);
    return () => {
        stopped = true;
        clearInterval(timer);
    };
}
