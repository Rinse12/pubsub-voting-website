import { createWalletClient, custom, getAddress, type WalletClient } from "viem";
import { generatePrivateKey, privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";
import { EIP712_SIGNATURE_TYPE, type BallotTypedData, type Signature, type VoteSigner } from "@bitsocial/pubsub-voting";

/**
 * VoteSigner over either the browser's injected EIP-1193 wallet (MetaMask, Rabby, ...)
 * or a "burner" wallet generated in the page itself for visitors with no extension.
 *
 * The wallet is what gives a vote its identity: the ballot is EIP-712 typed data,
 * every peer recovers the signer address from the signature, and the contest's open
 * `constant` gate admits any address. Signing is gasless — no transaction, and with a
 * burner not even a popup.
 *
 * The burner is a plain secp256k1 key generated with viem and persisted in
 * localStorage, so the same browser keeps the same voter identity across visits
 * (needed to replace/withdraw a previous vote — LWW is keyed by address). Clearing
 * site data discards that identity; fine for a test contest, never fund this key.
 *
 * The signer is handed to PubsubVoter at construction but delegates lazily, so the
 * voter is constructed once at page load and only actually needs the wallet when a
 * vote is published (`signBallot`). Before a wallet is chosen both methods throw the
 * connect-first error, which the UI surfaces as "connect or generate a wallet".
 */

const BURNER_KEY_STORAGE = "bso-vote:burner-private-key";

export type WalletKind = "injected" | "burner";

type ActiveWallet =
    | { kind: "injected"; address: `0x${string}`; client: WalletClient }
    | { kind: "burner"; account: PrivateKeyAccount };

export class BrowserWalletSigner implements VoteSigner {
    private active?: ActiveWallet;

    get connectedAddress(): `0x${string}` | undefined {
        if (!this.active) return undefined;
        return this.active.kind === "injected" ? this.active.address : this.active.account.address;
    }

    get kind(): WalletKind | undefined {
        return this.active?.kind;
    }

    /** True if this browser already generated a burner key on a previous visit. */
    static hasStoredBurner(): boolean {
        try {
            return localStorage.getItem(BURNER_KEY_STORAGE) !== null;
        } catch {
            return false;
        }
    }

    /** Prompt the injected wallet for an account; safe to call again to reconnect. */
    async connectInjected(): Promise<`0x${string}`> {
        const ethereum = (window as { ethereum?: { request: (args: { method: string }) => Promise<unknown> } }).ethereum;
        if (!ethereum) throw new Error("No injected wallet found — use “Generate a wallet in this browser” instead.");
        const accounts = (await ethereum.request({ method: "eth_requestAccounts" })) as string[];
        if (!accounts?.[0]) throw new Error("The wallet returned no account.");
        const address = getAddress(accounts[0]);
        this.active = {
            kind: "injected",
            address,
            client: createWalletClient({ transport: custom(ethereum as Parameters<typeof custom>[0]) })
        };
        return address;
    }

    /** Load (or generate and persist) the browser burner wallet and make it active. */
    useBurner(): `0x${string}` {
        let privateKey = localStorage.getItem(BURNER_KEY_STORAGE) as `0x${string}` | null;
        if (!privateKey) {
            privateKey = generatePrivateKey();
            localStorage.setItem(BURNER_KEY_STORAGE, privateKey);
        }
        const account = privateKeyToAccount(privateKey);
        this.active = { kind: "burner", account };
        return account.address;
    }

    address(): string {
        if (!this.active) throw new Error("Connect or generate a wallet first.");
        return this.connectedAddress as string;
    }

    async signBallot(typedData: BallotTypedData): Promise<Signature> {
        if (!this.active) throw new Error("Connect or generate a wallet first.");
        const signature =
            this.active.kind === "burner"
                ? await this.active.account.signTypedData({
                      domain: typedData.domain,
                      types: typedData.types,
                      primaryType: typedData.primaryType,
                      message: typedData.message
                  })
                : await this.active.client.signTypedData({
                      account: this.active.address,
                      domain: typedData.domain,
                      types: typedData.types,
                      primaryType: typedData.primaryType,
                      message: typedData.message
                  });
        return { signature, type: EIP712_SIGNATURE_TYPE };
    }
}
