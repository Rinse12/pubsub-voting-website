import { createLibp2p } from "libp2p";
import { webSockets } from "@libp2p/websockets";
import { noise } from "@chainsafe/libp2p-noise";
import { yamux } from "@chainsafe/libp2p-yamux";
import { identify } from "@libp2p/identify";
import { gossipsub } from "@libp2p/gossipsub";
import { fetch as fetchService } from "@libp2p/fetch";
import { delegatedRoutingV1HttpApiClient } from "@helia/delegated-routing-v1-http-api-client";
import { createHelia, type Helia } from "helia";
import { criteriaCid } from "@bitsocial/pubsub-voting";
import { criteria } from "../shared/criteria.js";
import { DISCOVERY_TIMEOUT_MS, HTTP_ROUTER_URLS, REDIAL_INTERVAL_MS } from "./config.js";

/**
 * The in-browser Helia node PubsubVoter drives. Browsers cannot accept inbound dials,
 * so the node only dials out — to seeders discovered through the delegated routing
 * HTTP routers — and the gossipsub mesh forms through them. The service keys
 * (pubsub, fetch) are the exact seams PubsubVoter's construction guards check for,
 * and the delegatedRouting* services compose into `libp2p.contentRouting`, which is
 * ALSO what the voter's own cold-join provider discovery rides.
 */
export async function startBrowserNode(): Promise<Helia> {
    const routers = Object.fromEntries(
        HTTP_ROUTER_URLS.map((url, i) => [`delegatedRouting${i}`, delegatedRoutingV1HttpApiClient({ url })])
    );
    const libp2p = await createLibp2p({
        transports: [webSockets()],
        connectionEncrypters: [noise()],
        streamMuxers: [yamux()],
        // Allow ws:// to 127.0.0.1 for local-dev seeders; production dials are wss anyway.
        connectionGater: { denyDialMultiaddr: () => false },
        services: {
            ...routers,
            identify: identify(),
            fetch: fetchService(),
            pubsub: gossipsub({
                // Test deployments often have several voters behind one IP (or one dev
                // machine); don't let the colocation penalty graylist them.
                scoreParams: { IPColocationFactorWeight: 0 }
            })
        }
    });
    return createHelia({ libp2p });
}

/**
 * Keep at least one seeder connection alive, 5chan-style: ask the routers who provides
 * this contest's criteria CID, dial every provider's addrs (the transport skips the
 * browser-undialable plain-TCP ones), and re-run discovery whenever the connection
 * count to known seeders drops to zero. Reports state changes so the UI can show a
 * connectivity dot.
 */
export function keepSeederConnected(helia: Helia, onChange: (connected: boolean, error?: Error) => void): () => void {
    // Every peer the routers have EVER returned for this contest: a connection to any
    // of them counts as "connected", even after the router entry's TTL lapses.
    const seederPeerIds = new Set<string>();

    const isConnected = () =>
        helia.libp2p.getConnections().some((c) => seederPeerIds.has(c.remotePeer.toString()));

    let stopped = false;
    let discovering = false;
    const tick = async () => {
        if (stopped || discovering) return;
        if (isConnected()) {
            onChange(true);
            return;
        }
        onChange(false);
        discovering = true;
        try {
            const cid = await criteriaCid(criteria);
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
