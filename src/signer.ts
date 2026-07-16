import { createWalletClient, custom, getAddress, type WalletClient } from "viem";
import { EIP712_SIGNATURE_TYPE, type BallotTypedData, type Signature, type VoteSigner } from "@bitsocial/pubsub-voting";

/**
 * VoteSigner over the browser's injected EIP-1193 wallet (MetaMask, Rabby, ...).
 *
 * Connecting a wallet is what gives a vote its identity: the ballot is EIP-712
 * typed data signed by the wallet that holds the BSO, every peer recovers the signer
 * address from the signature and checks its token balance on-chain before counting or
 * forwarding the vote. Signing is gasless — no transaction, just a signature popup.
 *
 * The signer is handed to PubsubVoter at construction but delegates lazily, so the
 * voter is constructed once at page load and only actually needs the wallet when a
 * vote is published (`signBallot`). Before `connect()` both methods throw the
 * connect-first error, which the UI surfaces as "connect your wallet".
 */
export class InjectedWalletSigner implements VoteSigner {
    private wallet?: { address: `0x${string}`; client: WalletClient };

    get connectedAddress(): `0x${string}` | undefined {
        return this.wallet?.address;
    }

    /** Prompt the injected wallet for an account; safe to call again to reconnect. */
    async connect(): Promise<`0x${string}`> {
        const ethereum = (window as { ethereum?: { request: (args: { method: string }) => Promise<unknown> } }).ethereum;
        if (!ethereum) throw new Error("No injected wallet found. Install MetaMask (or any EIP-1193 wallet) and reload.");
        const accounts = (await ethereum.request({ method: "eth_requestAccounts" })) as string[];
        if (!accounts?.[0]) throw new Error("The wallet returned no account.");
        const address = getAddress(accounts[0]);
        this.wallet = {
            address,
            client: createWalletClient({ transport: custom(ethereum as Parameters<typeof custom>[0]) })
        };
        return address;
    }

    address(): string {
        if (!this.wallet) throw new Error("Connect your wallet first.");
        return this.wallet.address;
    }

    async signBallot(typedData: BallotTypedData): Promise<Signature> {
        if (!this.wallet) throw new Error("Connect your wallet first.");
        const signature = await this.wallet.client.signTypedData({
            account: this.wallet.address,
            domain: typedData.domain,
            types: typedData.types,
            primaryType: typedData.primaryType,
            message: typedData.message
        });
        return { signature, type: EIP712_SIGNATURE_TYPE };
    }
}
