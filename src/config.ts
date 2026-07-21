/**
 * Delegated Routing V1 HTTP routers the browser queries to DISCOVER seeders — the same
 * six routers pkc-js clients use by default (pkc-js schema.ts `httpRoutersOptions`; keep
 * in sync), which is also where every votes seeder announces itself (bitsocial-seeder's
 * `VOTES_HTTP_ROUTER_URLS` defaults to the same list). Discovery is content routing:
 * the browser asks each router "who provides this contest's criteria CID?" and dials the
 * WSS addrs it gets back (a seeder's AutoTLS-provisioned `/tls/sni/….libp2p.direct/ws`
 * or `/dns4/…/tls/ws` addr — plain-TCP addrs are undialable from a browser and are
 * skipped by the transport). No hardcoded seeder multiaddrs: seeders can come, go, and
 * change address without a site redeploy, exactly like 5chan.
 */
export const HTTP_ROUTER_URLS: string[] = [
    "https://peers.pleb.bot",
    "https://routing.lol",
    "https://peers.forumindex.com",
    "https://peers.plebpubsub.xyz",
    "https://routerofbitsocial.xyz",
    "https://bsotracker.online"
];

/**
 * Pre-warm (discovery-driven, `?prewarm=0` to disable): the fetch-protocol key a connected
 * votes seeder answers with its co-located Kubo peer's browser-dialable multiaddrs.
 *
 * Measured motivation: the browser dials 89.36.231.48 TWICE — once at ~1.3 s for votes
 * (the seeder's Helia node) and again at ~4.6 s for community content (the daemon's Kubo
 * node). Two peer ids, two TLS/WS handshakes, one machine — bitsocial-seeder cannot merge
 * the nodes (votes gossipsub needs topic validators and a `@libp2p/fetch` responder that
 * Kubo's RPC cannot register), and the second dial lands ~1.2 s AFTER the community load
 * begins, so roughly half of that load was discovery+dial to a host the tab was already
 * talking to.
 *
 * A hardcoded-multiaddr version of this rotted within a day (the Kubo peer id was
 * regenerated, and the /dns4 libp2p.direct label derives from the key — every pre-warm
 * silently dialed a dead peer). This version asks the seeder itself over the connection
 * discovery already opened, so the addrs are read live from Kubo and cannot rot. The
 * answer is a dial HINT with the peer id embedded — a dial either authenticates that key
 * or fails, exactly as with router-served addrs, so it adds no trust surface.
 */
export const PREWARM_HINT_FETCH_KEY = "bitsocial-seeder/peers";
/** Give up asking a peer for the hint after this long (it simply doesn't serve the key). */
export const PREWARM_HINT_TIMEOUT_MS = 5_000;
/** Ask at most this many distinct peers for the hint (only the seeder answers it). */
export const PREWARM_HINT_MAX_PEERS = 8;
/** Dial at most this many hinted addrs (a hint is bounded like any untrusted input). */
export const PREWARM_HINT_MAX_ADDRS = 3;

/** How often the browser re-runs discovery + dial while it has no seeder connection (ms). */
export const REDIAL_INTERVAL_MS = 5_000;

/** Per-attempt time budget for one discovery round across the routers (ms). */
export const DISCOVERY_TIMEOUT_MS = 15_000;
