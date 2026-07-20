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
import { PubsubVoter } from "@bitsocial/pubsub-voting";
import { allCriteria, directoryCodeOf } from "../shared/contests.js";
import { chainClientFactory } from "../shared/chains.js";
import { makeNameResolvers } from "../shared/resolvers.js";

const t0 = Date.now();
const log = (m: string) => console.log(`[t+${((Date.now() - t0) / 1000).toFixed(1)}s] ${m}`);
const libp2p = await createLibp2p({
    transports: [tcp(), webSockets()],
    connectionEncrypters: [noise()],
    streamMuxers: [yamux()],
    services: { identify: identify(), fetch: fetchService(), pubsub: gossipsub({ scoreParams: { IPColocationFactorWeight: 0 } }) }
});
const helia = await createHelia({ libp2p });
const voter = new PubsubVoter({ helia, chains: chainClientFactory, nameResolvers: makeNameResolvers() });
// Diagnostic: join ALL 63 directory contests at once like the site does and report
// convergence. SEEDER_ADDR overrides the dial target (TCP or WSS).
await libp2p.dial(multiaddr(process.env.SEEDER_ADDR ?? "/ip4/89.36.231.48/tcp/6742/p2p/12D3KooWMHBC5CbncuNVLn6LtNc3UcSFXYPDGBK77zNrscmtAHW7"));
log("connected; joining all 63 contests (concurrency 8, like the site)");
const contests = new Map<string, { ranking: number }>();
let active = 0; const queue: (() => void)[] = [];
const limit = <T,>(fn: () => Promise<T>): Promise<T> => new Promise((res, rej) => {
    const run = () => { active++; fn().then(res, rej).finally(() => { active--; queue.shift()?.(); }); };
    active < 8 ? run() : queue.push(run);
});
await Promise.all(allCriteria.map((criteria) => limit(async () => {
    const code = directoryCodeOf(criteria);
    const contest = await voter.createContest({ criteria });
    contest.on("update", () => { contests.set(code, { ranking: (contest.tally?.ranking ?? []).length }); });
    contest.on("error", () => {});
    await contest.update();
    contests.set(code, { ranking: (contest.tally?.ranking ?? []).length });
})));
log("all joined");
for (let s = 0; s <= 120; s += 15) {
    const withVotes = [...contests.values()].filter((c) => c.ranking > 0).length;
    log(`converged ${withVotes}/63`);
    if (withVotes === 63) break;
    await new Promise((r) => setTimeout(r, 15000));
}
process.exit(0);
