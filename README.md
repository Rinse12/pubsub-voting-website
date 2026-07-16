# pubsub-voting website (test on a real deployment)

A static website where people vote over libp2p **pubsub** — no server counts the votes.
Voting is gated by an ERC-20 balance: **any wallet holding ≥ 1 BSO gets exactly one vote**
(constant weight, not balance-weighted). Voters pick an existing board from the live tally
or submit a new board (a `12D3KooW…` public key, optionally a verified `.bso` name).

Built on [`@bitsocial/pubsub-voting`](https://github.com/bitsocialnet/pubsub-voting):
votes are EIP-712 ballots signed by the token-holding wallet, gossiped on a topic derived
from the contest rules, validated by every peer (signature + on-chain balance at a
bucketed block) **before** re-forwarding, and merged with a last-write-wins CRDT.

## Architecture

```
Netlify (static HTML/JS)                     new-plebbit (public server)
┌──────────────────────────┐                ┌────────────────────────────────┐
│ browser voter            │   WSS          │ seeder: Node.js Helia node     │
│  - in-page Helia/libp2p ─┼───────────────▶│  - AutoTLS cert (libp2p.direct)│
│  - MetaMask signs ballot │  (AutoTLS)     │  - joins the contest topic     │
│  - renders live tally    │                │  - validates + forwards votes  │
└──────────────────────────┘                │  - serves checkpoint to        │
        ▲    ▲                              │    cold-joining browsers       │
        │    └── other browsers, meshed     └────────────────────────────────┘
        │        through the seeder                       │
        └── Ethereum mainnet RPC (balanceOf reads) ◀──────┘
```

Browsers can't accept inbound connections, so they all dial the seeder's WSS address and
the gossipsub mesh forms through it. The seeder never votes (read-only, no signer) and
can't forge or drop votes without honest peers noticing — validation is done by every
participant.

## Before launch — two required TODOs

1. **BSO contract address** — [shared/criteria.ts](shared/criteria.ts): the address
   provided so far (`0x4c109dc223a10d44c14f521caed91dab5a`) is **truncated** (34 hex
   chars; a real EVM address has 40). Fill in the full Ethereum-mainnet address.
   ⚠️ Changing the criteria changes the pubsub topic (it's the CID of the rules), so
   redeploy the site and restart the seeder together.
2. **Seeder multiaddr** — [src/config.ts](src/config.ts): after starting the seeder on
   new-plebbit, paste the `/dns4/….libp2p.direct/tcp/4003/tls/ws/p2p/…` address it prints
   (also written to `seeder-data/multiaddrs.txt`).

## Local development

```bash
npm install
npm run topic        # validate the criteria + print the pubsub topic
AUTO_TLS=off npm run seeder   # local seeder: plain /ws listener on 127.0.0.1:4003, no cert
# paste its /ip4/127.0.0.1/tcp/4003/ws/p2p/… addr into src/config.ts, then:
npm run dev          # vite dev server; plain ws works from http://localhost
```

Voting end-to-end needs a wallet with ≥ 1 BSO on mainnet (the balance check is real even
locally). The tally, connectivity, and read-only sync all work without one.

## Deploy the seeder on new-plebbit

```bash
ssh new-plebbit
# Node.js 22+ required
git clone <this-repo> pubsub-voting-website && cd pubsub-voting-website
npm install
npm run seeder       # first run: watch it provision the AutoTLS certificate
```

Requirements for AutoTLS (certificates from the free libp2p.direct CA):

- Ports **4002** (TCP) and **4003** (WSS) open/forwarded to the machine
  (override with `TCP_PORT`/`WS_PORT`).
- The node must be publicly dialable. It confirms its public address via AutoNAT
  (it bootstraps to public libp2p peers for dial-backs). If after ~10 minutes no
  certificate is provisioned, set `PUBLIC_IP=<the server's IP>` and restart.
- First provisioning takes a few minutes (ACME + DNS propagation). The peer key is
  persisted in `seeder-data/`, so the peer id — and therefore the `libp2p.direct`
  hostname and the multiaddr in `src/config.ts` — is stable across restarts. Don't
  delete `seeder-data/peer.key`.

When it logs `AutoTLS certificate provisioned ✔` copy the printed multiaddr into
[src/config.ts](src/config.ts). Then install it as a service:

```bash
# edit User= and paths first
sudo cp seeder/pubsub-voting-seeder.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now pubsub-voting-seeder
journalctl -fu pubsub-voting-seeder
```

## Deploy the site on Netlify

[netlify.toml](netlify.toml) is already set up (`npm run build` → `dist/`). Either
connect the git repo in the Netlify UI, or:

```bash
npm run build
npx netlify-cli deploy --prod --dir dist
```

Any HTTPS host works — the page is fully static; all networking happens from the
visitor's browser (WSS to the seeder, HTTPS to the Ethereum RPCs).

## How a vote works

1. The visitor connects an injected wallet (MetaMask etc.). Connecting is what gives the
   vote an identity — no transaction, no gas, just an EIP-712 signature popup.
2. The library builds the ballot (chosen board, current block bucket, the contest's
   criteria CID) and the wallet signs it.
3. The signed bundle is gossiped on the topic. Every receiving peer recovers the signer
   address from the signature and reads `balanceOf(signer)` at the bucket's sampled
   mainnet block; bundles that don't hold ≥ 1 BSO are dropped and never forwarded.
4. One wallet, one vote: a newer ballot from the same wallet replaces the older one
   (last-write-wins), and an empty ballot withdraws.
5. Votes expire after ~30 days (`voteExpiryBuckets`); voters keep a vote alive by simply
   voting again (the site shows the expiry estimate).

## Notable implementation choices

- **`erc20-balance` rule is vendored** ([shared/erc20-balance-rule.ts](shared/erc20-balance-rule.ts)).
  The library ships it in its tree but deliberately unregistered (token-*weighted* voting
  is deferred upstream). We use it only as the eligibility **gate** with a `constant`
  weight, and register it via `PubsubVoter({ rules })` on both the site and the seeder.
  Stock clients that don't register it recuse themselves (`UnknownRuleError`) instead of
  miscounting — that's by design.
- **RPCs are consensus-critical**: the RPC URLs live inside the criteria document, which
  derives the topic. They must be CORS-enabled (browsers call them directly) and
  archive-capable (verifiers read balances at up to 30-day-old blocks).
- **Board names are dangerous**: a vote carrying a `.bso` name is dropped by peers unless
  the name resolves on-chain to the claimed public key. The UI warns accordingly; plain
  public-key votes are always safe.
- **Republishing is the client's job** (upstream design): this site stores your vote in
  `localStorage` and shows the expiry; re-voting refreshes it. The seeder cannot do it
  for you — it doesn't hold your key.
