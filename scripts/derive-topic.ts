import { resolveRegistry, topicFor, validateCriteriaRules } from "@bitsocial/pubsub-voting";
import { criteria, BSO_CONTRACT } from "../shared/criteria.js";
import { customRules } from "../shared/erc20-balance-rule.js";

/**
 * Smoke test / topic inspector: validates the criteria document against the rule
 * registry (built-ins + our erc20-balance) exactly like PubsubVoter does at
 * createContest time, then prints the derived pubsub topic. Run: npm run topic
 */
validateCriteriaRules(criteria, resolveRegistry(customRules));
console.log("criteria valid ✔");
if (BSO_CONTRACT.includes("TODO")) console.log("WARNING: BSO contract address is still the placeholder — voting will fail until it is set.");
console.log("topic:", await topicFor(criteria));
