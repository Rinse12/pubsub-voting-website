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
 * EXPERIMENT (pre-warm): peers to dial at boot, in parallel with the votes-seeder dial,
 * purely so the connection is already open when a leaderboard resolves.
 *
 * Measured motivation: the browser dials 89.36.231.48 TWICE — once at ~1.3 s for votes
 * (the seeder's Helia node, port 6743) and again at ~4.6 s for community content (the
 * daemon's Kubo node, port 4001). Those are two peer ids and two TLS/WS handshakes to one
 * machine, because bitsocial-seeder cannot merge them: votes gossipsub needs
 * validate-before-forward topic validators and a `@libp2p/fetch` responder, neither of
 * which Kubo's RPC can register (see bitsocial-seeder lib/votes/node.ts). The second dial
 * lands ~1.2 s AFTER the community load begins, so roughly half of that load is spent
 * discovering and dialing a host the tab was already talking to.
 *
 * This tests whether an already-open connection recovers that time — i.e. whether merging
 * the two nodes would be worth its (large) cost — without merging anything. Hardcoded on
 * purpose: it is an experiment, not the discovery path. Everything else in this app still
 * finds seeders through the routers.
 */
export const PREWARM_PEER_ADDRS: string[] = [
    // The daemon's Kubo node on the production seeder host (port 4001), browser-dialable via its
    // AutoTLS libp2p.direct address.
    //
    // KNOWN TO ROT, and it already has: this node's peer id changed on 2026-07-21 (was
    // 12D3KooWLNoZZe8n…, and the /dns4 label changed with it, since that label is derived from the
    // key). Every pre-warm between the change and this edit dialed a peer that no longer existed —
    // silently, because the dial is fire-and-forget and normal discovery still runs underneath, so
    // the only symptom was quietly losing the ~0.9 s the pre-warm exists to buy. That is the whole
    // argument for making this discovery-driven before it ships anywhere.
    "/dns4/89-36-231-48.k51qzi5uqu5dh7t6qna0btkj3a89cip7aiuoz8qwgvvb7blzn2g0jaswuyiyq4.libp2p.direct/tcp/4001/tls/ws/p2p/12D3KooWCcJKbrF4hdBa9n9YmqgHJajRHC1GtLQNMkMPNSMagwUo"
];

/** How often the browser re-runs discovery + dial while it has no seeder connection (ms). */
export const REDIAL_INTERVAL_MS = 5_000;

/** Per-attempt time budget for one discovery round across the routers (ms). */
export const DISCOVERY_TIMEOUT_MS = 15_000;
