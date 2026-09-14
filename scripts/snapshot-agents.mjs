/**
 * Commits the agent list as it stood at a known Creditcoin block, so a visitor's browser does not
 * have to rescan twelve thousand blocks of logs before it can show a single card. The snapshot holds
 * no figure the page displays: only agent ids, a review count used for ordering, and the block the
 * scan reached. Everything a visitor reads on screen is still fetched live, per agent, at runtime.
 *
 * Run by hand after the scout adds agents, then commit the result:
 *   pnpm snapshot:agents
 *
 * Deliberately not part of `build`: a deploy must not fail because a public RPC was slow.
 */
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { JsonRpcProvider } from "ethers";
// Imported by path rather than by package name: this is a one-off maintenance script run from the
// repo root, where the workspace link for @tinjau/core is not on the resolution path.
import { CC3_TESTNET } from "../packages/core/src/config.ts";
import { Tinjau } from "../packages/core/src/contracts.ts";

const CHAIN_KEY = 3;
const DEPLOY_BLOCK = 5_475_585;
const OUT = fileURLToPath(new URL("../apps/web/src/data/agents.json", import.meta.url));

const provider = new JsonRpcProvider(CC3_TESTNET.rpc, CC3_TESTNET.chainId, { staticNetwork: true });
const t = new Tinjau(provider);

const scannedThrough = await provider.getBlockNumber();
const [registered, reviewed] = await Promise.all([
  t.facts.queryFilter(t.facts.filters.AgentProven(CHAIN_KEY), DEPLOY_BLOCK, scannedThrough),
  t.facts.queryFilter(t.facts.filters.ReviewProven(CHAIN_KEY), DEPLOY_BLOCK, scannedThrough),
]);

const rows = new Map();
const touch = (id, block) => {
  const key = id.toString();
  const row = rows.get(key) ?? { agentId: key, reviews: 0, firstSeen: block };
  row.firstSeen = Math.min(row.firstSeen, block);
  rows.set(key, row);
  return row;
};
for (const e of registered) touch(e.args[1], e.blockNumber);
for (const e of reviewed) touch(e.args[1], e.blockNumber).reviews += 1;

const agents = [...rows.values()].sort((a, b) => b.reviews - a.reviews || a.firstSeen - b.firstSeen);
writeFileSync(
  OUT,
  JSON.stringify({ generatedAt: new Date().toISOString(), chainKey: CHAIN_KEY, scannedThrough, agents }, null, 2) + "\n",
);
console.log(`${agents.length} agents through block ${scannedThrough} -> ${OUT}`);
