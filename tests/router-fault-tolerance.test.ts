/**
 * Regression test for the 2026-07-18 outage: libp2p's compound contentRouting merges
 * every delegated router's findProviders stream with it-merge, which rejects the WHOLE
 * merged stream the moment any single router errors. With two of the six production
 * routers down (Cloudflare 521), discovery died before the healthy routers could answer
 * and the site sat on "not connected to seeder, retrying…" forever.
 *
 * The test runs two local fake routers — one answering 521 to everything, one serving a
 * valid provider record — and asserts:
 *   1. (control) the raw delegated-routing client still has the failure mode, i.e. the
 *      merged findProviders stream throws. If this ever fails, upstream fixed it and
 *      faultTolerantDelegatedRouting can be deleted.
 *   2. faultTolerantDelegatedRouting yields the healthy router's provider anyway.
 *
 *   npm test
 */
import { createServer, type Server } from "node:http";
import assert from "node:assert/strict";
import { createLibp2p, type Libp2p } from "libp2p";
import { webSockets } from "@libp2p/websockets";
import { noise } from "@chainsafe/libp2p-noise";
import { yamux } from "@chainsafe/libp2p-yamux";
import { delegatedRoutingV1HttpApiClient } from "@helia/delegated-routing-v1-http-api-client";
import { CID } from "multiformats/cid";
import { faultTolerantDelegatedRouting } from "../src/routing.js";

const SEEDER_PEER_ID = "12D3KooWMHBC5CbncuNVLn6LtNc3UcSFXYPDGBK77zNrscmtAHW7";
const ANY_CID = CID.parse("bafyreicyjfqthbsnspmqffnbbv4jvxymimso3z4pgizysrs5qulu6jz5nq");

const listen = (server: Server): Promise<string> =>
    new Promise((resolve) =>
        server.listen(0, "127.0.0.1", () => {
            const addr = server.address();
            if (addr === null || typeof addr === "string") throw new Error("no port");
            resolve(`http://127.0.0.1:${addr.port}`);
        })
    );

// One router is dead the way a Cloudflare 521 is dead; the other serves the seeder.
const deadServer = createServer((_req, res) => {
    res.writeHead(521, { "content-type": "text/plain" });
    res.end("error code: 521");
});
const healthyServer = createServer((req, res) => {
    if (req.url?.startsWith("/routing/v1/providers/")) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
            JSON.stringify({
                Providers: [
                    {
                        Schema: "peer",
                        ID: SEEDER_PEER_ID,
                        Addrs: [`/ip4/127.0.0.1/tcp/4001/ws/p2p/${SEEDER_PEER_ID}`]
                    }
                ]
            })
        );
        return;
    }
    res.writeHead(404).end();
});
const [deadUrl, healthyUrl] = await Promise.all([listen(deadServer), listen(healthyServer)]);

/** A node wired like src/node.ts startBrowserNode, minus the services discovery doesn't need. */
const makeNode = (routerFactory: (url: string) => (components: unknown) => unknown): Promise<Libp2p> =>
    createLibp2p({
        transports: [webSockets()],
        connectionEncrypters: [noise()],
        streamMuxers: [yamux()],
        services: Object.fromEntries(
            // Dead router first so its error races ahead, like the production outage.
            [deadUrl, healthyUrl].map((url, i) => [`delegatedRouting${i}`, routerFactory(url) as never])
        )
    });

const collectProviders = async (node: Libp2p) => {
    const found: string[] = [];
    for await (const provider of node.contentRouting.findProviders(ANY_CID, { signal: AbortSignal.timeout(10_000) }))
        found.push(provider.id.toString());
    return found;
};

// 1. Control: the raw client + compound routing still fail as a whole on one dead router.
const rawNode = await makeNode((url) => delegatedRoutingV1HttpApiClient({ url }) as never);
await assert.rejects(
    () => collectProviders(rawNode),
    (err: Error) => err.name !== "TimeoutError" && err.name !== "AbortError",
    "expected the unwrapped merged stream to throw on the 521 router — if it no longer does, " +
        "upstream fixed the it-merge failure mode and faultTolerantDelegatedRouting can be removed"
);
await rawNode.stop();
console.log("control: unwrapped client still poisons the merged stream (bug reproduced)");

// 2. The fix: the wrapped client must surface the healthy router's provider regardless.
const tolerantNode = await makeNode(faultTolerantDelegatedRouting);
const providers = await collectProviders(tolerantNode);
assert.deepEqual(providers, [SEEDER_PEER_ID], "healthy router's provider must survive a dead sibling router");
await tolerantNode.stop();
console.log("fix: fault-tolerant client yielded the healthy router's provider");

deadServer.close();
healthyServer.close();
console.log("PASS router-fault-tolerance");
