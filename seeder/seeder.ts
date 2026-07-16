import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { createLibp2p, type Libp2pOptions } from "libp2p";
import { tcp } from "@libp2p/tcp";
import { webSockets } from "@libp2p/websockets";
import { noise } from "@chainsafe/libp2p-noise";
import { yamux } from "@chainsafe/libp2p-yamux";
import { identify } from "@libp2p/identify";
import { gossipsub } from "@libp2p/gossipsub";
import { fetch as fetchService } from "@libp2p/fetch";
import { keychain } from "@libp2p/keychain";
import { http } from "@libp2p/http";
import { autoNAT } from "@libp2p/autonat";
import { bootstrap } from "@libp2p/bootstrap";
import { autoTLS } from "@ipshipyard/libp2p-auto-tls";
import { generateKeyPair, privateKeyFromProtobuf, privateKeyToProtobuf } from "@libp2p/crypto/keys";
import { FsDatastore } from "datastore-fs";
import { createHelia } from "helia";
import { PubsubVoter, topicFor } from "@bitsocial/pubsub-voting";
import { criteria } from "../shared/criteria.js";
import { chainClientFactory } from "../shared/chains.js";
import { makeNameResolvers } from "../shared/resolvers.js";
import { describeGossipMessage, describeRootRecord } from "../shared/wire-log.js";

/**
 * The always-on seeder: a publicly reachable Node.js Helia node that joins the contest
 * topic, enforces the validate-before-forward gossip gate, serves the checkpoint to cold
 * joiners, and — via AutoTLS (libp2p.direct) — gets a real TLS certificate so BROWSERS
 * can dial it over WSS. Browser peers cannot dial each other; every browser connects
 * here and the gossipsub mesh forms through this node.
 *
 * Environment:
 *   SEEDER_DATA  data directory (default ./seeder-data): peer key, keychain pass,
 *                AutoTLS cert store, voting caches, multiaddrs.txt
 *   TCP_PORT     public TCP port          (default 4002)  — open it in the firewall
 *   WS_PORT      public WSS port          (default 4003)  — open it in the firewall
 *   PUBLIC_IP    optional; announce this IP explicitly if AutoNAT cannot confirm the
 *                public address on its own (e.g. no inbound dials yet)
 *   AUTO_TLS     "off" for local testing: plain /ws listener, no cert, no bootstrap
 *
 * The certificate takes a few minutes on first run (ACME + DNS propagation). Once
 * provisioned, the browser-dialable /dns4/<peerid>.libp2p.direct/.../tls/ws addresses
 * are printed and written to $SEEDER_DATA/multiaddrs.txt — paste them into the site's
 * src/config.ts.
 */

const dataDir = process.env.SEEDER_DATA ?? join(process.cwd(), "seeder-data");
const tcpPort = Number(process.env.TCP_PORT ?? 4002);
const wsPort = Number(process.env.WS_PORT ?? 4003);
const autoTlsEnabled = process.env.AUTO_TLS !== "off";
mkdirSync(dataDir, { recursive: true });

// Every log line goes to stdout (journald) AND $SEEDER_DATA/seeder.log so diagnostics
// survive without journalctl access. One rotation generation at 10 MB keeps it bounded.
const logFile = join(dataDir, "seeder.log");
const LOG_ROTATE_BYTES = 10 * 1024 * 1024;
const log = (msg: string) => {
    const line = `[${new Date().toISOString()}] ${msg}`;
    console.log(line);
    try {
        if (existsSync(logFile) && statSync(logFile).size >= LOG_ROTATE_BYTES) renameSync(logFile, `${logFile}.1`);
        appendFileSync(logFile, `${line}\n`);
    } catch {
        // Never let diagnostics take the seeder down (e.g. disk full).
    }
};

/** Stable identity across restarts — the AutoTLS domain and the browser-pinned multiaddr embed the peer id. */
async function loadOrCreatePrivateKey() {
    const keyPath = join(dataDir, "peer.key");
    if (existsSync(keyPath)) return privateKeyFromProtobuf(readFileSync(keyPath));
    const key = await generateKeyPair("Ed25519");
    writeFileSync(keyPath, privateKeyToProtobuf(key), { mode: 0o600 });
    log(`generated new peer key at ${keyPath}`);
    return key;
}

/** Keychain password (encrypts the AutoTLS cert key at rest), generated once. */
function loadOrCreateKeychainPass(): string {
    const passPath = join(dataDir, "keychain.pass");
    if (existsSync(passPath)) return readFileSync(passPath, "utf8").trim();
    const pass = randomBytes(24).toString("hex");
    writeFileSync(passPath, pass, { mode: 0o600 });
    return pass;
}

/** Public peers used for AutoNAT dial-backs so libp2p confirms our public address (AutoTLS waits for that). */
const BOOTSTRAP_PEERS = [
    "/dnsaddr/bootstrap.libp2p.io/p2p/QmNnooDu7bfjPFoTZYxMNLWUQJyrVwtbZg5gBMjTezGAJN",
    "/dnsaddr/bootstrap.libp2p.io/p2p/QmQCU2EcMqAqQPR2i9bChDtGNJchTbq5TbXJJ16u19uLTa",
    "/dnsaddr/bootstrap.libp2p.io/p2p/QmbLHAnMoJPWSCR5Zhtx6BHJX9KiKNN6tpvbUcqanj75Nb",
    "/dnsaddr/bootstrap.libp2p.io/p2p/QmcZf59bWwK5XFi76CZX8cbJ4BhTzzA3gU1ZjYZcYW3dwt"
];

async function main() {
    const privateKey = await loadOrCreatePrivateKey();
    const datastore = new FsDatastore(join(dataDir, "datastore"));

    const common = {
        privateKey,
        datastore,
        addresses: {
            listen: [
                `/ip4/0.0.0.0/tcp/${tcpPort}`,
                `/ip6/::/tcp/${tcpPort}`,
                // Plain /ws on purpose, even with AutoTLS on: the websockets listener
                // serves http and https on the same port (first-byte sniffing) and only
                // installs the AutoTLS certificate into a listener that isn't already
                // https — an explicit /tls/ws listen creates a certless https server
                // that rejects every handshake (TLS alert 40) forever.
                `/ip4/0.0.0.0/tcp/${wsPort}/ws`,
                `/ip6/::/tcp/${wsPort}/ws`
            ],
            ...(process.env.PUBLIC_IP
                ? {
                      appendAnnounce: [
                          `/ip4/${process.env.PUBLIC_IP}/tcp/${tcpPort}`,
                          `/ip4/${process.env.PUBLIC_IP}/tcp/${wsPort}/ws`
                      ]
                  }
                : {})
        },
        transports: [tcp(), webSockets()],
        connectionEncrypters: [noise()],
        streamMuxers: [yamux()]
    } satisfies Libp2pOptions;
    const baseServices = {
        identify: identify(),
        keychain: keychain({ pass: loadOrCreateKeychainPass() }),
        // Raised stream caps: every browser voter cold-joins through this node's
        // libp2p-fetch root-record responder.
        fetch: fetchService({ maxInboundStreams: 200, maxOutboundStreams: 200 }),
        pubsub: gossipsub({
            // Keep publishing checkpoint heartbeats even when no browser is online.
            allowPublishToZeroTopicPeers: true,
            // Several voters may share one IP (NAT, classroom, dev machine); don't
            // graylist them for colocation in a small test network.
            scoreParams: { IPColocationFactorWeight: 0 }
        })
    };

    // Two statically-typed configs (not conditional spreads) so libp2p's service-map
    // inference can prove AutoTLS's required sibling services (`keychain`, `http`) exist.
    const libp2p = autoTlsEnabled
        ? await createLibp2p({
              ...common,
              peerDiscovery: [bootstrap({ list: BOOTSTRAP_PEERS })],
              services: {
                  ...baseServices,
                  // AutoTLS talks to the registration.libp2p.direct ACME broker over
                  // libp2p-HTTP, so it requires sibling `http` and `keychain` services.
                  http: http(),
                  autoNAT: autoNAT(),
                  autoTLS: autoTLS()
              }
          })
        : await createLibp2p({ ...common, services: baseServices });
    const helia = await createHelia({ libp2p });
    const topic = await topicFor(criteria);

    // ---- connection/topic diagnostics (journald + seeder.log) ----
    // Answers "did that browser tab ever reach us, join the topic, and pull the checkpoint?"
    libp2p.addEventListener("connection:open", (evt) => {
        const conn = evt.detail;
        log(`conn open: ${conn.remotePeer} via ${conn.remoteAddr} (${libp2p.getConnections().length} conns)`);
    });
    libp2p.addEventListener("connection:close", (evt) => {
        const conn = evt.detail;
        log(`conn close: ${conn.remotePeer} via ${conn.remoteAddr} (${libp2p.getConnections().length} conns)`);
    });
    const pubsub = libp2p.services.pubsub;
    pubsub.addEventListener("subscription-change", (evt) => {
        for (const sub of evt.detail.subscriptions) {
            if (sub.topic !== topic) continue;
            log(
                `topic ${sub.subscribe ? "subscribe" : "unsubscribe"}: ${evt.detail.peerId} ` +
                    `(${pubsub.getSubscribers(topic).length} subscriber(s))`
            );
        }
    });
    pubsub.addEventListener("message", (evt) => {
        if (evt.detail.topic !== topic) return;
        const from = "from" in evt.detail ? evt.detail.from.toString() : "(unsigned)";
        void describeGossipMessage(evt.detail.data).then((described) =>
            log(`gossip from ${from}: ${described} (${evt.detail.data.length} bytes)`)
        );
    });
    // The fetch protocol has no serve event, so wrap lookup registration: each cold joiner
    // pulling the checkpoint root record shows up as one "fetch serve" line.
    const fetchSvc = libp2p.services.fetch;
    const realRegister = fetchSvc.registerLookupFunction.bind(fetchSvc);
    fetchSvc.registerLookupFunction = (prefix, lookup) => {
        realRegister(prefix, async (key) => {
            const value = await lookup(key);
            log(
                `fetch serve: ${new TextDecoder().decode(key)} → ` +
                    (value === undefined ? "no value" : `${value.length} bytes: ${describeRootRecord(value)}`)
            );
            return value;
        });
    };

    log(`peer id: ${libp2p.peerId.toString()}`);
    log(`listening: ${libp2p.getMultiaddrs().map(String).join(", ") || "(no confirmed addrs yet)"}`);
    if (autoTlsEnabled) log("waiting for AutoNAT to confirm the public address, then AutoTLS provisions the certificate…");

    // Surface the browser-dialable addresses as soon as (and whenever) they change.
    let lastWritten = "";
    const publishAddrs = () => {
        const all = libp2p.getMultiaddrs().map(String);
        const dialable = all.filter((a) => a.includes("/tls/ws") || a.includes("libp2p.direct") || a.includes("/ws"));
        const text = dialable.join("\n");
        if (text && text !== lastWritten) {
            lastWritten = text;
            writeFileSync(join(dataDir, "multiaddrs.txt"), `${text}\n`);
            log(`browser-dialable multiaddrs (also in ${join(dataDir, "multiaddrs.txt")}):\n${text}`);
        }
    };
    libp2p.addEventListener("self:peer:update", publishAddrs);
    libp2p.addEventListener("certificate:provision", () => {
        log("AutoTLS certificate provisioned ✔");
        publishAddrs();
    });
    setInterval(publishAddrs, 30_000);
    publishAddrs();

    // Join the contest as a read-only seeder: enforce the forward-gate, hold the CRDT,
    // serve the checkpoint root record to cold joiners. No signer — a seeder never votes.
    const voter = new PubsubVoter({
        helia,
        chains: chainClientFactory,
        nameResolvers: makeNameResolvers(),
        dataPath: join(dataDir, "voting")
    });
    log(`contest topic: ${topic}`);
    const contest = await voter.createContest({ criteria });
    contest.on("update", () => {
        const ranking = contest.tally?.ranking ?? [];
        const top = ranking[0];
        log(
            `tally update: ${ranking.length} board(s)` +
                (top ? `, leader ${top.community.name ?? top.community.publicKey} with ${top.weight} vote(s)` : "")
        );
    });
    contest.on("error", (err: unknown) => log(`contest error (retrying): ${err instanceof Error ? err.message : String(err)}`));
    await contest.update();
    log("joined the contest topic; seeding.");

    const shutdown = async (signal: string) => {
        log(`${signal} received, shutting down…`);
        await voter.destroy().catch(() => {});
        await helia.stop().catch(() => {});
        process.exit(0);
    };
    process.on("SIGINT", () => void shutdown("SIGINT"));
    process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
