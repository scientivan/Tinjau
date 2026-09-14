import { JsonRpcProvider } from "ethers";
import { CC3_TESTNET, DEPLOYMENT } from "@tinjau/core/config";
import { Tinjau, type Bounty, type HireParams, type Quote } from "@tinjau/core/contracts";

/**
 * All chain access for the page. Reads only: the page never holds a key, and a hire is signed by the
 * visitor's own wallet (see wallet.ts). The public CC3 RPC answers browser origins
 * (access-control-allow-origin: *, verified 12 Sep 2026), so no server sits in this path.
 */

export const CHAIN_KEY = 3; // Ethereum mainnet, as Attestcoin numbers it on CC3 testnet

/** CC3 block that carried DEPLOYMENT.txs.facts; the TxAdmitted log cannot start earlier. */
const DEPLOY_BLOCK = 5_475_585;

let bureau: Tinjau | undefined;

export function readonlyBureau(): Tinjau {
  if (!bureau) {
    // import.meta.env only exists under Vite; the same module is exercised by Node probes.
    const rpc = (import.meta as { env?: Record<string, string> }).env?.VITE_CC3_RPC ?? CC3_TESTNET.rpc;
    // batchMaxCount: 1 matters more than it looks. Ethers otherwise folds every call made in the
    // same tick into one JSON-RPC batch, so the head read — a single cheap call — was posted in the
    // same request as two multi-thousand-block log scans and could not answer until they did. One
    // request per call lets the fast reads land first, which is the whole point of splitting them.
    bureau = new Tinjau(new JsonRpcProvider(rpc, CC3_TESTNET.chainId, { staticNetwork: true, batchMaxCount: 1 }));
  }
  return bureau;
}

export interface NetworkStatus {
  /** Highest Ethereum block Creditcoin's attestors have signed off on, per ChainInfo 0x0FD3. */
  attestedTip: bigint;
  /** Source transactions admitted so far; the scout keeps adding to this until the deadline. */
  admitted: number;
}

/**
 * The Creditcoin head, on its own. This is one RPC call and answers in a fraction of a second, so it
 * is never bundled with anything slower: the navbar's proof that the chain is answering must not sit
 * behind a log scan that takes seconds. Bundling it was the whole reason the page said "connecting"
 * for thirteen seconds while it already had everything else it needed.
 */
export async function readBlock(): Promise<number> {
  return readonlyBureau().facts.runner!.provider!.getBlockNumber();
}

/** The two figures that do need a full scan, read apart from the block so neither holds the other up. */
export async function readNetwork(): Promise<NetworkStatus> {
  const t = readonlyBureau();
  const [attestedTip, events] = await Promise.all([
    t.facts.attestedTip(CHAIN_KEY) as Promise<bigint>,
    // There is no counter on the contract: the admitted set is the TxAdmitted log, which is also
    // what anyone auditing the bureau replays.
    t.facts.queryFilter(t.facts.filters.TxAdmitted(), DEPLOY_BLOCK),
  ]);
  return { attestedTip, admitted: events.length };
}

export const readQuote = (agentId: bigint, p: HireParams): Promise<Quote> =>
  readonlyBureau().readQuote(CHAIN_KEY, agentId, p);

export interface AgentRow {
  agentId: bigint;
  /** Proven reviews seen for this agent, used only to order the list. */
  reviews: number;
  /** Creditcoin block that first proved this agent, so the newest entries can be found. */
  firstSeen: number;
}

/**
 * The agent list, read from the bureau itself rather than written by hand: every agent the contract
 * has ever proved emits AgentProven, and every proven review emits ReviewProven. An agent whose
 * reviews were proved before its registration still belongs on the list, so both are unioned.
 *
 * `from` and `seed` exist so a visitor does not pay for the same scan twice. The build commits the
 * scan as it stood at a known block (see data/agents.json); passing that list as `seed` and the next
 * block as `from` leaves only the blocks mined since to be read, which is a scan of hundreds of
 * blocks rather than tens of thousands. The result is identical either way: the seed carries no
 * figure the page displays, only which agents to ask the contract about. Every number on screen is
 * still read live, per agent, after this returns.
 */
export async function readAgents(limit = 40, from = DEPLOY_BLOCK, seed: AgentRow[] = []): Promise<AgentRow[]> {
  const t = readonlyBureau();
  const [registered, reviewed] = await Promise.all([
    t.facts.queryFilter(t.facts.filters.AgentProven(CHAIN_KEY), from),
    t.facts.queryFilter(t.facts.filters.ReviewProven(CHAIN_KEY), from),
  ]);

  const rows = new Map<string, AgentRow>(seed.map((r) => [r.agentId.toString(), { ...r }]));
  const touch = (id: bigint, block: number) => {
    const key = id.toString();
    const row = rows.get(key) ?? { agentId: id, reviews: 0, firstSeen: block };
    row.firstSeen = Math.min(row.firstSeen, block);
    rows.set(key, row);
    return row;
  };
  for (const e of registered) touch((e as unknown as { args: [bigint, bigint] }).args[1], e.blockNumber);
  for (const e of reviewed) touch((e as unknown as { args: [bigint, bigint] }).args[1], e.blockNumber).reviews += 1;

  // Most-reviewed first: the record with the most proven evidence is the one worth reading.
  return [...rows.values()].sort((a, b) => b.reviews - a.reviews || a.firstSeen - b.firstSeen).slice(0, limit);
}

export interface AgentIdentity {
  agentId: bigint;
  owner: string;
  registeredAtEthBlock: bigint;
}

export async function readIdentity(agentId: bigint): Promise<AgentIdentity | undefined> {
  const t = readonlyBureau();
  if (!(await t.facts.isRegistered(CHAIN_KEY, agentId))) return undefined;
  const a = await t.facts.agentOf(CHAIN_KEY, agentId);
  return { agentId, owner: a.owner as string, registeredAtEthBlock: a.registeredHeight as bigint };
}

export interface ReviewerRow {
  address: string;
  /** How long the reviewer had been active on Ethereum before their first review here. */
  historyBlocks: bigint;
  stretches: number;
  ownsAgents: bigint;
  highestReview: bigint;
  provenReviews: bigint;
  /** Reviews that exist above a proven one but were never proven: the reason a hire is held back. */
  missingReviews: bigint;
}

export async function readReviewers(agentId: bigint): Promise<ReviewerRow[]> {
  const t = readonlyBureau();
  const clients: string[] = await t.facts.clientsOf(CHAIN_KEY, agentId);
  return Promise.all(
    clients.map(async (address) => {
      const [pair, activity, owns] = await Promise.all([
        t.facts.pairOf(CHAIN_KEY, agentId, address),
        t.facts.reviewerSeniority(CHAIN_KEY, address),
        t.facts.reviewerOwnsAgents(CHAIN_KEY, address),
      ]);
      const first = pair.firstHeight as bigint;
      const oldest = activity.oldest as bigint;
      const maxIndex = pair.maxIndex as bigint;
      const known = pair.known as bigint;
      return {
        address,
        historyBlocks: oldest > 0n && first > oldest ? first - oldest : 0n,
        stretches: Number(activity.buckets),
        ownsAgents: owns as bigint,
        highestReview: maxIndex,
        provenReviews: known,
        missingReviews: maxIndex > known ? maxIndex - known : 0n,
      };
    }),
  );
}

/** Open bounties on the bounty contract, grouped by agent. Anyone may claim one with decision-changing proofs. */
export async function readOpenBounties(): Promise<Map<string, Bounty[]>> {
  const all = await readonlyBureau().openBounties();
  const by = new Map<string, Bounty[]>();
  for (const b of all) {
    if (b.chainKey !== CHAIN_KEY) continue;
    const k = b.agentId.toString();
    by.set(k, [...(by.get(k) ?? []), b]);
  }
  return by;
}

export type { Bounty };

export { CC3_TESTNET, DEPLOYMENT };
export const EXPLORER_CC3 = "https://creditcoin-testnet.blockscout.com";
export const EXPLORER_ETH = "https://etherscan.io";
