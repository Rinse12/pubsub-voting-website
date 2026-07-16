import { erc20Abi, getAddress, parseUnits } from "viem";
import { z } from "zod";
import { ChainTickerSchema, type Rule } from "@bitsocial/pubsub-voting";

/**
 * Vendored copy of @bitsocial/pubsub-voting's `erc20-balance` rule
 * (src/rules/erc20-balance.ts @ 0.0.8, GPL-3.0-or-later).
 *
 * The library ships this rule in its tree, unit-tested, but deliberately does NOT
 * register or export it in v1 (token-weighted voting is deferred; see its ROADMAP.md).
 * We use it only as the GATE (rule slot, `min: 1`) with a `constant` weight — one
 * wallet, one vote — so the deferred whale-weighting concern does not apply here.
 * Registered via `PubsubVoter({ rules })`; every participant (web client and seeder)
 * must register it identically or they recuse themselves with UnknownRuleError.
 *
 * Score = the wallet's raw balance (base units) at the bucket block if it meets `min`
 * (whole tokens), else 0n. In the rule slot the engine gates on `score > 0n`.
 */
export const Erc20BalanceOptionsSchema = z.object({
    type: z.literal("erc20-balance"),
    chain: ChainTickerSchema,
    contract: z.string(),
    decimals: z.number().int().nonnegative().default(18),
    min: z.number().nonnegative().default(0)
});

export type Erc20BalanceOptions = z.infer<typeof Erc20BalanceOptionsSchema>;

export const erc20Balance: Rule<Erc20BalanceOptions> = {
    type: "erc20-balance",
    optionsSchema: Erc20BalanceOptionsSchema,
    async evaluate({ options, walletAddress, ctx }) {
        const raw = await ctx.chain.readContract({
            address: getAddress(options.contract),
            abi: erc20Abi,
            functionName: "balanceOf",
            args: [getAddress(walletAddress)],
            blockNumber: BigInt(ctx.blockNumber)
        });
        const minUnits = parseUnits(options.min.toString(), options.decimals);
        return { score: raw >= minUnits ? raw : 0n };
    }
};

/** The `rules` override map both the web client and the seeder pass to PubsubVoter. */
export const customRules = { [erc20Balance.type]: erc20Balance };
