/**
 * Multiaddrs of the always-on seeder node(s) browsers bootstrap through.
 *
 * TODO(REQUIRED before launch): run `npm run seeder` on the seeder machine
 * (new-plebbit); once AutoTLS provisions its certificate it prints (and writes to
 * seeder-data/multiaddrs.txt) browser-dialable WSS addresses shaped like:
 *
 *   /dns4/<peerid-base36>.libp2p.direct/tcp/4003/tls/ws/p2p/<peerid>
 *
 * Paste them here and redeploy the site. For local testing you can instead run the
 * seeder on this machine with AUTO_TLS=off and use its printed
 * /ip4/127.0.0.1/tcp/4003/ws/... address (plain ws works from http://localhost).
 */
export const SEEDER_MULTIADDRS: string[] = [];

/** How often the browser re-dials the seeder when disconnected (ms). */
export const REDIAL_INTERVAL_MS = 5_000;
