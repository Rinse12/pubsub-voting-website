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

/** How often the browser re-runs discovery + dial while it has no seeder connection (ms). */
export const REDIAL_INTERVAL_MS = 5_000;

/** Per-attempt time budget for one discovery round across the routers (ms). */
export const DISCOVERY_TIMEOUT_MS = 15_000;
