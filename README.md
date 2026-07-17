# BSO board vote — pubsub voting on a real website

**Live site: <https://bso-board-vote.netlify.app>**

A static website where people vote over libp2p **pubsub** — no server counts the votes.
The contest is **open: any EVM wallet gets exactly one vote** (the built-in `constant`
rule as the gate — no token, no gas; knowingly sybil-open because this test wants
maximum participation). Visitors without an extension wallet can have the page
**generate a burner wallet in the browser** (key persisted in localStorage). Voters pick
an existing board from the live tally or submit a new board (a `12D3KooW…` public key,
optionally a verified `.bso` name).

Built on [`@bitsocial/pubsub-voting`](https://github.com/bitsocialnet/pubsub-voting):
votes are EIP-712 ballots signed by the voter's wallet, gossiped on a topic derived
from the contest rules, validated by every peer (signature + bucketed-block freshness)
**before** re-forwarding, and merged with a last-write-wins CRDT.

Contest topic: `bitsocial-votes/bafyreih53ht6eu6zeup7rfn7yxomvxo35tfkd3zadacxq66kr62pip47ay`

## Architecture

```
Netlify (static HTML/JS)                     new-plebbit (89.36.231.48)
┌──────────────────────────┐                ┌────────────────────────────────┐
│ browser voter            │   WSS          │ seeder: Node.js Helia node     │
│  - in-page Helia/libp2p ─┼───────────────▶│  - AutoTLS cert (libp2p.direct)│
│  - MetaMask signs ballot │  (AutoTLS)     │  - joins the contest topic     │
│  - renders live tally    │                │  - validates + forwards votes  │
└──────────────────────────┘                │  - serves checkpoint to        │
        ▲    ▲                              │    cold-joining browsers       │
        │    └── other browsers, meshed     └────────────────────────────────┘
        │        through the seeder
        └── Ethereum mainnet RPC (bucket-block head reads; no balance checks)
```

Browsers can't accept inbound connections, so they all dial the seeder's WSS address
(pinned in [src/config.ts](src/config.ts)) and the gossipsub mesh forms through it. The
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
   address from the signature and checks the ballot's bucket freshness; the open
   `constant` gate admits every address, so no balance is read.
4. One wallet, one vote: a newer ballot from the same wallet replaces the older one
   (last-write-wins), and an empty ballot withdraws.
5. Votes expire after ~30 days (`voteExpiryBuckets`); voters keep a vote alive by simply
   voting again (the site shows the expiry estimate).

## Repo layout

```
shared/    criteria document (defines the contest AND the topic), viem chain
           factory, .bso name resolvers, wire-log decoders
src/       the website: in-browser Helia/libp2p node, injected+burner wallet signer, UI
seeder/    the always-on node: AutoTLS/WSS seeder script + systemd unit
scripts/   derive-topic.ts — validate criteria + print the topic (npm run topic)
```

## Operations

### Redeploy the website

```bash
npm install
npm run build
npx netlify-cli deploy --prod --dir dist --no-build   # site: bso-board-vote
```

### The seeder (new-plebbit)

Runs as systemd unit `pubsub-voting-seeder` from `/root/pubsub-voting-website`
(see [seeder/pubsub-voting-seeder.service](seeder/pubsub-voting-seeder.service)).

```bash
ssh new-plebbit
journalctl -fu pubsub-voting-seeder          # watch tally updates / cert renewals
tail -f /root/pubsub-voting-website/seeder-data/seeder.log   # same lines, plain file
systemctl restart pubsub-voting-seeder       # after code changes: recompile first:
cd /root/pubsub-voting-website && ./node_modules/.bin/tsc -p tsconfig.seeder.json
```

The seeder logs connection open/close, contest-topic subscribe/unsubscribe, gossip
messages on the topic, checkpoint (root record) fetch serves, and tally updates — to
stdout (journald) and to `seeder-data/seeder.log` (rotated once at 10 MB). Gossip
messages and served root records are logged **decoded** ([shared/wire-log.ts](shared/wire-log.ts)),
not just as byte counts: a root record line shows `count` (vote bundles), checkpoint
size, and the full root CID. `0 vote bundle(s)` means the contest is genuinely empty —
82 bytes with root `bafyreie3lvfqun…` is the canonical empty record, not a load
failure. Comparing root CIDs across peers' log lines settles any divergence question:
a peer that hears a root differing from its own answers with its own record within
seconds, so matching roots everywhere ⇒ the whole topic shares one state. The website
logs the same decoded lines (plus its `tally update`) in the on-page log.

Do **not** delete `seeder-data/peer.key`: the peer id determines the
`….libp2p.direct` hostname and the multiaddr baked into `src/config.ts`.

**Vote state survives restarts** (pubsub-voting ≥ 0.0.10): the seeder persists its
checkpoint snapshot to `seeder-data/voting/checkpoints.db` (debounced after each
winner-set change, flushed on SIGTERM) and restores it at join; browser tabs persist
theirs to IndexedDB (`pubsub-voting-checkpoints`). Historical note: the one vote cast
before the 0.0.10 deploy (2026-07-16) was permanently lost by a seeder restart —
builds of that era held the CRDT in memory only.

### Diagnosing "I don't see votes"

`scripts/cold-join-test.ts` acts as a brand-new voter against the production seeder
and reports how long the tally takes to converge:

```bash
npx tsc -p tsconfig.coldtest.json
WAIT_SUBS=1 node dist-seeder/scripts/cold-join-test.js   # healthy: converges in ~5 s
node dist-seeder/scripts/cold-join-test.js               # joins as soon as connected
```

Background: through pubsub-voting 0.0.8 the cold-join pull for past votes ran **once**,
at topic join, and only asked peers already visible in `getSubscribers(topic)`. A join
that raced the seeder's subscription exchange synced nothing and waited ~10 minutes
(jittered heartbeat) for the next chance — which looked like "votes are missing" in a
fresh tab. Fixed upstream in 0.0.10 (pubsub-voting #15): the cold-start pull re-arms on
gossipsub `subscription-change` for the first heartbeat interval after join, so this
site uses the library as-is with no join-ordering workaround.

### Changing the contest rules

Anything in the `criteria` object in [shared/criteria.ts](shared/criteria.ts) (gate
rule, expiry, `contestId`) changes the criteria bytes and therefore **forks the
topic** — old votes don't carry over. (`ETH_RPC_URLS` in the same file is client-local
transport config since pubsub-voting 0.1.x and can change without forking.) Redeploy the site and restart the seeder together. History: contest
`bso-board-vote-test-1` (topic `…zm7ardh7tfnccgwhulil63ybopugfh2d4`) was gated on
holding ≥ 1 BSO (`0xB50cea4c109dc223A10d44c14f521CaeD91DaB5A`) via a vendored
`erc20-balance` rule; `bso-board-vote-test-2` dropped the gate to get more testers;
`bso-board-vote-test-3` marks the fork forced by the 0.1.x criteria schema (`rpcUrls`
removed from the document re-derives the topic regardless).

## Local development

```bash
npm install
npm run topic                  # validate criteria + print the topic
AUTO_TLS=off npm run seeder    # local seeder: plain ws on 127.0.0.1:4003, no cert
# paste its /ip4/127.0.0.1/tcp/4003/ws/p2p/… addr into src/config.ts, then:
npm run dev                    # plain ws works from http://localhost
```

Casting a vote end-to-end needs no tokens — any wallet works, including the
browser-generated burner, so the full flow is testable locally.

## Notable implementation choices & gotchas

- **The gate is the built-in `constant` rule** — deliberately sybil-open for this test
  (wallets are free to generate; the burner button makes that one click). A nice side
  effect of using only built-ins: any stock `@bitsocial/pubsub-voting` client can join
  this contest, no custom rule registration. The BSO-gated variant used a vendored
  `erc20-balance` rule (see git history / test-1) registered via `PubsubVoter({ rules })`.
- **The burner key lives in localStorage** (`bso-vote:burner-private-key`), unencrypted.
  Fine for a gasless test vote; never fund that key. Clearing site data discards the
  identity, orphaning any live vote until it expires.
- **AutoTLS needs a plain `/ws` listen.** An explicit `/tls/ws` listen creates a
  certificate-less https server that the certificate-provision event refuses to replace,
  and every TLS handshake then fails with alert 40. Listen on `/ws`; the listener
  upgrades itself in place when the cert arrives.
- **Behind provider NAT, set `PUBLIC_IP`.** new-plebbit's interfaces only carry private
  addresses, so AutoNAT alone never confirms the public address and AutoTLS never
  triggers. `PUBLIC_IP=…` (see the systemd unit) announces it explicitly; the cert
  provisioned seconds after.
- **systemd + nvm**: `npm` isn't on systemd's PATH — the unit runs the precompiled
  `dist-seeder/seeder/seeder.js` with the absolute node binary.
- **RPC URLs are client-local, not consensus bytes**: since pubsub-voting 0.1.x the
  criteria document pins only `chains: { eth: { chainId: 1 } }`; `ETH_RPC_URLS` is each
  client's own transport config, swappable without forking the topic. They must be
  CORS-enabled (browsers call them directly). The chain itself is still
  consensus-critical: it's where every peer samples bucket blocks, the ballot chainId,
  and the tie-break hash.
- **Board names are dangerous**: a vote carrying a `.bso` name is dropped by peers unless
  the name resolves on-chain to the claimed public key. The UI warns accordingly; plain
  public-key votes are always safe.
- **Republishing is the client's job** (upstream design): the site stores your vote in
  `localStorage` and shows the expiry; re-voting refreshes it. The seeder cannot do it
  for you — it doesn't hold your key.

## License

GPL-3.0-or-later (matching `@bitsocial/pubsub-voting`).
