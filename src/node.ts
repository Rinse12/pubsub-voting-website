import { createLibp2p } from "libp2p";
import { webSockets } from "@libp2p/websockets";
import { noise } from "@chainsafe/libp2p-noise";
import { yamux } from "@chainsafe/libp2p-yamux";
import { identify } from "@libp2p/identify";
import { gossipsub } from "@libp2p/gossipsub";
import { fetch as fetchService } from "@libp2p/fetch";
import { createHelia, type Helia } from "helia";
import { multiaddr } from "@multiformats/multiaddr";
import { REDIAL_INTERVAL_MS, SEEDER_MULTIADDRS } from "./config.js";

/**
 * The in-browser Helia node PubsubVoter drives. Browsers cannot accept inbound dials,
 * so the node only dials out — to the seeder's AutoTLS WSS address — and the gossipsub
 * mesh forms through it. The service keys (pubsub, fetch) are the exact seams
 * PubsubVoter's construction guards check for.
 */
export async function startBrowserNode(): Promise<Helia> {
    const libp2p = await createLibp2p({
        transports: [webSockets()],
        connectionEncrypters: [noise()],
        streamMuxers: [yamux()],
        // Allow ws:// to 127.0.0.1 for local-dev seeders; production dials are wss anyway.
        connectionGater: { denyDialMultiaddr: () => false },
        services: {
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
 * Keep at least one connection to a configured seeder alive: dial every seeder addr,
 * re-dialing whenever the connection count to them drops to zero. Reports state changes
 * so the UI can show a connectivity dot.
 */
export function keepSeederConnected(helia: Helia, onChange: (connected: boolean, error?: Error) => void): () => void {
    if (SEEDER_MULTIADDRS.length === 0) {
        onChange(false, new Error("no seeder multiaddrs configured in src/config.ts"));
        return () => {};
    }
    const addrs = SEEDER_MULTIADDRS.map((a) => multiaddr(a));
    const seederPeerIds = new Set(
        addrs
            .map((a) => a.getComponents().findLast((c) => c.name === "p2p")?.value)
            .filter((p): p is string => p !== undefined)
    );

    const isConnected = () =>
        helia.libp2p.getConnections().some((c) => seederPeerIds.has(c.remotePeer.toString()));

    let stopped = false;
    const tick = async () => {
        if (stopped) return;
        if (isConnected()) {
            onChange(true);
            return;
        }
        onChange(false);
        try {
            await helia.libp2p.dial(addrs);
            onChange(true);
        } catch (err) {
            onChange(false, err as Error);
        }
    };
    void tick();
    const timer = setInterval(() => void tick(), REDIAL_INTERVAL_MS);
    return () => {
        stopped = true;
        clearInterval(timer);
    };
}
