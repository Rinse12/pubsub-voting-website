# 5chan directory votes — pubsub voting on a real website

**Live site: <https://bso-board-vote.netlify.app>**

A static website where people vote over libp2p **pubsub** — no server counts the votes.
**One contest per 5chan directory** (`/g/`, `/a/`, `/b/`… — 63 of them, from the
canonical [5chan-directories list](https://github.com/bitsocialnet/lists/tree/master/5chan-directories)):
each directory's contest elects which board hosts that directory code — the
highest-scoring board resolves it, and if it goes offline 5chan rotates to the
next-highest. Every contest is **NFT-gated: one vote per wallet per directory, for
wallets holding at least one 5chan Pass**, the
[FiveChanPass ERC-721 on Base Sepolia](https://sepolia.basescan.org/address/0xA8e0155E0e7d014EAF3917982db6a9A4dF98C852)
(`erc5192-min-balance` rule; a free testnet NFT airdropped by its owner — voting itself
still costs no gas). Every peer reads the voter's `balanceOf` at the contest's pinned
bucket block before counting the vote, so an ineligible wallet's ballot is dropped by
the whole network, not by a moderator. Visitors without an extension wallet can have the
page **generate a burner wallet in the browser** (key persisted in localStorage) and ask
the Pass owner to airdrop to it. Voters pick a directory, then vote for a board on its
live tally or for any board by key (a `12D3KooW…` public key, optionally a verified
`.bso` name). **Every board the site shows comes from the vote tally itself** — the
site never reads the lists repo at runtime; only the one-time seed script
(`scripts/seed-candidate-votes.ts`) reads it, to cast a real signed vote for each
directory's first-registered board.

Built on [`@bitsocial/pubsub-voting`](https://github.com/bitsocialnet/pubsub-voting):
votes are EIP-712 ballots signed by the voter's wallet, gossiped on a topic derived
from the contest rules, validated by every peer (signature + bucketed-block freshness)
**before** re-forwarding, and merged with a last-write-wins CRDT. The 63 contests are
authored as ONE directory manifest (shared `defaults` + one entry per directory) and
derived through the library's `deriveDirectoryCriteria` — the exact multi-contest flow
the library documents for 5chan.

The page runs **one** in-browser Helia/libp2p node, built and owned by
[`@pkcprotocol/pkc-js`](https://github.com/pkcprotocol/pkc-js) and shared by both
consumers: pkc-js itself loads the **leaderboard #1 board's community** (a board's
public key *is* its community address) via `createCommunity` + `community.update()`,
and `PubsubVoter` syncs the votes on the same node through the public
`pkc.clients.libp2pJsClients[key].heliaNode` accessor (semver-covered since pkc-js
0.0.72 — the host pattern pubsub-voting 0.1.4 is built against). A **Benchmarks**
panel on the page reports how long the node boot, the leaderboard (votes), and the
community load each took.

Contest topics: one per directory, `bitsocial-votes/<CID(dag-cbor(criteria))>` — print
them all with `npm run topic`.

## Architecture

```
Netlify (static HTML/JS)                     new-plebbit (89.36.231.48)
┌──────────────────────────┐                ┌────────────────────────────────┐
│ browser voter            │   WSS          │ seeder: Node.js Helia node     │
│  - ONE pkc-js Helia node─┼───────────────▶│  - AutoTLS cert (libp2p.direct)│
│    shared by votes AND   │  (AutoTLS)     │  - joins all 63 contest topics │
│    community loading     │                │  - validates + forwards votes  │
│  - MetaMask signs ballot │                │  - serves checkpoint to        │
│  - renders live tally +  │                │    cold-joining browsers       │
│    #1 board's community  │                └────────────────────────────────┘
└──────────────────────────┘
        ▲    ▲
        │    └── other browsers, meshed through the seeder
        └── Base Sepolia RPC (bucket-block reads + 5chan Pass balanceOf gate reads)
```

Browsers can't accept inbound connections, so they all dial the seeder's WSS address
(discovered via the delegated-routing HTTP routers listed in
[src/config.ts](src/config.ts)) and the gossipsub mesh forms through it. The
seeder never votes (read-only, no signer) and can't forge or drop votes without honest
peers noticing — validation is done by every participant.

## How a vote works

1. The visitor connects an injected wallet (MetaMask etc.) **or clicks "generate one in
   this browser"** — a burner key created with viem and persisted in localStorage, so
   the same browser keeps the same voter identity (needed to replace/withdraw a vote).
   Either way the wallet is the identity — no transaction, no gas.
2. The library builds the ballot (chosen board, current block bucket, the contest's
   criteria CID) and the wallet signs it (EIP-712; a popup for injected wallets,
   silent for burners).
3. The signed bundle is gossiped on the topic. Every receiving peer recovers the signer
   address from the signature, checks the ballot's bucket freshness, and reads the
   wallet's 5chan Pass `balanceOf` at the bucket block on Base Sepolia — a wallet
   holding none has its vote dropped before it is re-forwarded.
4. One wallet, one vote: a newer ballot from the same wallet replaces the older one
   (last-write-wins), and an empty ballot withdraws.
5. Votes expire after ~30 days (`voteExpiryBuckets`), counted from the voting window the
   ballot was signed in — so a directory nobody keeps voting in eventually has an empty
   leaderboard and **no board resolving its code**. Refreshing a vote means re-signing the
   same ballot into the current window, which only the browser holding the wallet can do
   (the seeder serves votes but has no key). The wallet card's **"Keep your votes alive"**
   setting does it automatically for every vote this browser cast — hourly by default,
   catching up on load for anything that went stale while the tab was closed — and the
   selected directory shows the cast time, the last refresh, and the expiry estimate.

## Repo layout

```
shared/    directory-manifest.{json,ts} (GENERATED — defines all 63 contests AND
           their topics; .json ships to the seeder, .ts into the site bundle),
           contests.ts (derives the criteria), viem chain factory, .bso name
           resolvers, wire-log decoders
src/       the website: pkc-js boot (the one shared Helia node), injected+burner
           wallet signer, directory overview + per-directory voting UI,
           leader-community loader, benchmarks panel
scripts/   generate-directory-manifest.ts — regenerate the manifest from the lists
           repo (npm run manifest); derive-topic.ts — validate every contest +
           print all topics (npm run topic)
tests/     regression tests (npm test)
```

The always-on seeder is **not** in this repo: seeding is done by
[bitsocial-seeder](https://github.com/bitsocialnet/bitsocial-seeder) (branch
`seed-pubsub-votes`), driven by this repo's `shared/directory-manifest.json`.
An earlier in-repo `seeder/` was deleted once bitsocial-seeder took over — it's in git
history if ever needed.

## Operations

### Redeploy the website

```bash
npm install
npm run build
npx netlify-cli deploy --prod --dir dist --no-build   # site: bso-board-vote
```

### The seeder (bitsocial-seeder on new-plebbit)

The canonical seeder is the `bitsocial-seeder` systemd unit on new-plebbit (checkout
`/root/bitsocial-seeder`, branch `seed-pubsub-votes`, data in
`/root/bitsocial-seeder-data`). It derives all 63 topics from
`/root/bitsocial-seeder/bso-board-vote-manifest.jsonc`, which must be a copy of this
repo's [shared/directory-manifest.json](shared/directory-manifest.json) — any manifest
change means copying it over AND redeploying the site (the changed contests' topics
fork, see below).

```bash
ssh new-plebbit
journalctl -fu bitsocial-seeder              # votes lines look like: 0x… votes [board:+1]
systemctl restart bitsocial-seeder
```

Reading the site's on-page log: gossip messages and served root records are logged
**decoded** ([shared/wire-log.ts](shared/wire-log.ts)), not just as byte counts — a
root record line shows `count` (vote bundles), checkpoint size, and the full root CID.
`0 vote bundle(s)` means the contest is genuinely empty — 82 bytes with root
`bafyreie3lvfqun…` is the canonical empty record, not a load failure. Comparing root
CIDs across peers settles any divergence question: a peer that hears a root differing
from its own answers with its own record within seconds, so matching roots everywhere
⇒ the whole topic shares one state.

**Vote state survives restarts** (pubsub-voting ≥ 0.0.10): the seeder persists its
checkpoint snapshot (debounced after each winner-set change, flushed on SIGTERM) and
restores it at join; browser tabs persist theirs to IndexedDB
(`pubsub-voting-checkpoints`). Historical note: the one vote cast before the 0.0.10
deploy (2026-07-16) was permanently lost by a seeder restart — builds of that era held
the CRDT in memory only.

### Diagnosing "I don't see votes"

`scripts/cold-join-test.ts` acts as a brand-new voter against the production seeder
and reports how long the tally takes to converge:

```bash
npx tsc -p tsconfig.coldtest.json
WAIT_SUBS=1 node dist-coldtest/scripts/cold-join-test.js   # healthy: converges in ~5 s
node dist-coldtest/scripts/cold-join-test.js               # joins as soon as connected
```

It dials the bitsocial-seeder votes node's TCP addr by default; override with
`SEEDER_ADDR=/…`.

Background: through pubsub-voting 0.0.8 the cold-join pull for past votes ran **once**,
at topic join, and only asked peers already visible in `getSubscribers(topic)`. A join
that raced the seeder's subscription exchange synced nothing and waited ~10 minutes
(jittered heartbeat) for the next chance — which looked like "votes are missing" in a
fresh tab. Fixed upstream in 0.0.10 (pubsub-voting #15): the cold-start pull re-arms on
gossipsub `subscription-change` for the first heartbeat interval after join, so this
site uses the library as-is with no join-ordering workaround.

### Changing the contest rules

The contests are defined by the generated manifest — edit
[scripts/generate-directory-manifest.ts](scripts/generate-directory-manifest.ts) (the
shared `defaults`, the contestId suffix, or the naming scheme) and run
`npm run manifest`; never hand-edit the emitted files. Changing `defaults` re-derives
EVERY directory's criteria bytes and therefore **forks all 63 topics** at once (bump
the `CONTEST_ID_SUFFIX` for a deliberate fresh start); a new directory appearing in the
lists repo adds one new contest without touching the others. Old votes don't carry over
a fork. (`ETH_RPC_URLS` in [shared/contests.ts](shared/contests.ts) is client-local
transport config since pubsub-voting 0.1.x and can change without forking.) Redeploy
the site and copy the manifest to the bitsocial-seeder (then restart it) together.
History: single-contest era — contest 4 `5chan-pass-vote-test-1` (topic
`…rs5qulu6jz5nq`, the first 5chan-Pass-gated one) was replaced by the 63 directory
contests; before it, contest
`bso-board-vote-test-1` (topic `…zm7ardh7tfnccgwhulil63ybopugfh2d4`) was gated on
holding ≥ 1 BSO (`0xB50cea4c109dc223A10d44c14f521CaeD91DaB5A`) via a vendored
`erc20-balance` rule; `bso-board-vote-test-2` dropped the gate to get more testers;
`bso-board-vote-test-3` marks the fork forced by the 0.1.x criteria schema (`rpcUrls`
removed from the document re-derives the topic regardless).

## Local development

```bash
npm install
npm run topic                  # validate criteria + print the topic
npm test                       # regression tests (router fault tolerance)
npm run dev                    # discovers the production seeder via the routers,
                               # exactly like the deployed site
```

To test against a local seeder instead, run bitsocial-seeder with this contest's
manifest. Note the site only finds seeders through the routers, so a local seeder that
doesn't announce is invisible to the browser — exercise it with
`SEEDER_ADDR=/ip4/127.0.0.1/… node dist-coldtest/scripts/cold-join-test.js` instead.

Casting a vote end-to-end needs no gas, but counting one needs a 5chan Pass: a wallet
without the NFT can sign and publish, and every peer (including your own second browser
tab) will drop the ballot at the gate — which is itself a useful thing to test locally.

## Notable implementation choices & gotchas

- **The gate is the built-in `erc5192-min-balance` rule** — hold ≥ 1
  [5chan Pass](https://sepolia.basescan.org/address/0xA8e0155E0e7d014EAF3917982db6a9A4dF98C852)
  on Base Sepolia (testnet NFT, minted for free by its owner from the
  `testnet_5chan_pass` project; duplicate an address there to stack passes). The rule
  reads the same `balanceOf` a plain ERC-721 gate would, plus one
  `supportsInterface(0xb45a3c0e)` at the same pinned block: the contract must declare its
  passes locked, so one pass cannot be walked through several wallets to back several
  concurrent votes. The pre-cutover transferable pass (`0xa0095E…`) fails that assertion. Both
  configured RPCs serve archive state, which the pinned bucket-block reads require.
  Still built-ins only, so any stock `@bitsocial/pubsub-voting` client can join this
  contest, no custom rule registration. Earlier forks of this contest used the open
  `constant` gate (test-3) and a vendored `erc20-balance` rule (test-1; see git
  history).
- **The burner key lives in localStorage** (`bso-vote:burner-private-key`), unencrypted.
  Fine for a gasless test vote; never fund that key. Clearing site data discards the
  identity, orphaning any live vote until it expires.
- **One Helia node, owned by pkc-js.** The site never builds its own libp2p node:
  [src/node.ts](src/node.ts) boots pkc-js with `libp2pJsClientsOptions` and everything —
  vote sync, seeder discovery, community loading — rides
  `pkc.clients.libp2pJsClients[key].heliaNode`. pkc-js registers gossipsub +
  `@libp2p/fetch` (the exact seams PubsubVoter's construction guards check) since
  0.0.63; never start a second Helia next to it.
- **One dead router must not blind discovery.** libp2p merges all delegated routers'
  `findProviders` streams with `it-merge`, which rejects the whole merged stream when
  any single router errors — so one Cloudflare-521 router used to kill discovery before
  the healthy routers could answer (the 2026-07-18 outage). The per-router wrapper that
  ends an erroring router's stream instead now lives **inside pkc-js** (its issue #171 —
  this repo's own src/routing.ts wrapper was retired with the shared-node move);
  `npm test` reproduces the outage against a pkc-js-built node and detects if upstream
  libp2p ever fixes the failure mode.
- **The #1 board's community loads the moment the leaderboard does.** Boards are pkc
  communities (the public key is the community address), so the page calls
  `pkc.createCommunity({ name, publicKey })` + `community.update()` for the current
  leader — both identity halves the winning bundle carries: the canonical key loads
  without resolution, and the claimed `.bso` name (when present) is resolved+verified
  by pkc-js and used as the display address — and re-targets whenever the lead changes. A board that isn't a real community keeps
  cycling `fetching-ipns → waiting-retry` ("Resolved IPNS name to undefined") — shown
  as-is, since a made-up board key provably has no community record. The Benchmarks
  panel times the node boot, the leaderboard (join + restore, and first votes), and the
  community load (from leaderboard-ready).
- **RPC URLs are client-local, not consensus bytes**: since pubsub-voting 0.1.x the
  criteria document pins only `chains: { eth: { chainId: 1 } }`; `ETH_RPC_URLS` is each
  client's own transport config, swappable without forking the topic. They must be
  CORS-enabled (browsers call them directly). The chain itself is still
  consensus-critical: it's where every peer samples bucket blocks, the ballot chainId,
  and the tie-break hash.
- **Board names are dangerous**: a vote carrying a `.bso` name is dropped by peers unless
  the name resolves on-chain to the claimed public key. The UI warns accordingly; plain
  public-key votes are always safe.
- **Republishing is the client's job** (upstream design): the seeder cannot do it for you
  — it doesn't hold your key, and the library deliberately publishes once and leaves the
  schedule to its host (`republishIntervalBuckets` is the hint it offers). So the site
  stores each vote in `localStorage` and refreshes it itself: a wall-clock due-check every
  minute re-publishes any vote older than the chosen interval, which also catches up votes
  that went stale while the tab was closed. Default **one voting window**, far more often
  than `republishIntervalBuckets` needs, because these are test contests. A window is also
  the shortest interval that does anything: a ballot is stamped with its window's boundary
  block, so two publishes inside one window are byte-identical and de-duplicate to a
  single bundle. Every duration here is derived from the manifest at runtime and rendered
  into the UI copy — with the shipped manifest a window is ~1 h, expiry ~30 days and the
  recommendation ~15 days, but nothing in the page states those as constants. Note the
  popup cost with an injected wallet — one signature prompt per held vote, per interval; a
  burner signs silently.

## License

GPL-3.0-or-later (matching `@bitsocial/pubsub-voting`).
