import { createLibp2p } from "libp2p";
import { tcp } from "@libp2p/tcp";
import { webSockets } from "@libp2p/websockets";
import { noise } from "@chainsafe/libp2p-noise";
import { yamux } from "@chainsafe/libp2p-yamux";
import { identify } from "@libp2p/identify";
import { gossipsub } from "@libp2p/gossipsub";
import { fetch as fetchService } from "@libp2p/fetch";
import { createHelia } from "helia";
import { multiaddr } from "@multiformats/multiaddr";
import { PubsubVoter, topicFor } from "@bitsocial/pubsub-voting";
import { criteria } from "../shared/criteria.js";
import { chainClientFactory } from "../shared/chains.js";
import { makeNameResolvers } from "../shared/resolvers.js";

/**
 * Diagnostic: act as a brand-new voter (like a freshly opened browser tab) and measure
 * how long until the contest tally converges to the seeder's state.
 *
 *   npx tsx scripts/cold-join-test.ts                # connect to seeder FIRST, then join (healthy order)
 *   ORDER=join-first npx tsx scripts/cold-join-test.ts   # join the topic before the dial completes
 *                                                        # (the website's actual boot order)
 *   WAIT_SUBS=1 npx tsx scripts/cold-join-test.ts    # additionally wait until the seeder is visible as a
 *                                                    # topic subscriber before joining (the proposed fix)
 *
 * SEEDER_ADDR overrides the dial target (default: the production seeder's TCP addr).
 * TIMEOUT_S bounds the wait (default 120).
 */

const seederAddr =
    process.env.SEEDER_ADDR ??
    "/ip4/89.36.231.48/tcp/4002/p2p/12D3KooWHHyYsyQLVs5w35zrpiybd8zSZdNdyAkg7Whz88WD8o2N";
const joinFirst = process.env.ORDER === "join-first";
const waitSubs = process.env.WAIT_SUBS === "1";
const timeoutS = Number(process.env.TIMEOUT_S ?? 120);

const t0 = Date.now();
const log = (msg: string) => console.log(`[t+${((Date.now() - t0) / 1000).toFixed(1)}s] ${msg}`);

const libp2p = await createLibp2p({
    transports: [tcp(), webSockets()],
    connectionEncrypters: [noise()],
    streamMuxers: [yamux()],
    connectionGater: { denyDialMultiaddr: () => false },
    services: {
        identify: identify(),
        fetch: fetchService(),
        pubsub: gossipsub({ scoreParams: { IPColocationFactorWeight: 0 } })
    }
});
const helia = await createHelia({ libp2p });
const voter = new PubsubVoter({
    helia,
    chains: chainClientFactory,
    nameResolvers: makeNameResolvers()
});
const topic = await topicFor(criteria);
log(`fresh peer ${libp2p.peerId}, topic ${topic}, order=${joinFirst ? "join-first (website order)" : "connect-first"}`);

const dial = async () => {
    await libp2p.dial(multiaddr(seederAddr));
    log(`connected to seeder (subscribers visible: ${(libp2p.services.pubsub as any).getSubscribers(topic).length})`);
};

if (!joinFirst) await dial();
if (waitSubs) {
    const waitDeadline = Date.now() + 15_000;
    while ((libp2p.services.pubsub as any).getSubscribers(topic).length === 0 && Date.now() < waitDeadline)
        await new Promise((r) => setTimeout(r, 100));
    log(`topic subscribers visible before join: ${(libp2p.services.pubsub as any).getSubscribers(topic).length}`);
}
const contest = await voter.createContest({ criteria });
contest.on("update", () => {
    const ranking = contest.tally?.ranking ?? [];
    log(`update: ${ranking.length} board(s)${ranking[0] ? ` — leader ${ranking[0].community.name ?? ranking[0].community.publicKey} (${ranking[0].weight})` : ""}`);
});
await contest.update();
log("joined the contest topic");
if (joinFirst) await dial();

const deadline = Date.now() + timeoutS * 1000;
while (Date.now() < deadline) {
    if ((contest.tally?.ranking ?? []).length > 0) {
        log(`CONVERGED: sees ${contest.tally!.ranking.length} board(s)`);
        break;
    }
    await new Promise((r) => setTimeout(r, 1000));
}
if ((contest.tally?.ranking ?? []).length === 0) log(`TIMED OUT after ${timeoutS}s with an empty tally`);
await voter.destroy().catch(() => {});
await helia.stop().catch(() => {});
process.exit(0);
