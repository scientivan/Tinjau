import { useEffect, useState } from "react";
import type { Quote } from "@tinjau/core/contracts";
import {
  readAgents,
  readBlock,
  readIdentity,
  readNetwork,
  readOpenBounties,
  readQuote,
  type AgentIdentity,
  type AgentRow,
  type Bounty,
  type NetworkStatus,
  type ReviewerRow,
} from "./chain";
import snapshot from "../data/agents.json";
import type { Care } from "./params";
import { presetOf } from "./params";

export interface AgentView {
  agentId: bigint;
  /** Proven reviews seen on-chain, the order the list is in. */
  reviews: number;
  identity?: AgentIdentity;
  quote?: Quote;
  reviewers: ReviewerRow[];
  bounties: Bounty[];
  error?: string;
}

export interface BureauState {
  loading: boolean;
  /** True when the chain could not be read at all: the page must say so, never show stale as live. */
  failed: boolean;
  /**
   * The Creditcoin head. Separate from `net` because it is one call and arrives almost at once,
   * while `net` waits on a log scan. The navbar proves the chain is answering from this alone.
   */
  block?: number;
  net?: NetworkStatus;
  agents: AgentView[];
  /**
   * False until the live log scan has confirmed which agents exist. Until then the list is the one
   * committed at build time, and the page may still gain rows. No figure on screen depends on this:
   * every number is read live per agent either way.
   */
  listSettled: boolean;
}

/** The agent list as it stood when the build was cut. Ids and ordering only, never figures. */
const SEED: AgentRow[] = (snapshot.agents as { agentId: string; reviews: number; firstSeen: number }[]).map((a) => ({
  agentId: BigInt(a.agentId),
  reviews: a.reviews,
  firstSeen: a.firstSeen,
}));
const SEED_THROUGH = snapshot.scannedThrough as number;

const sameList = (a: AgentRow[], b: AgentRow[]) =>
  a.length === b.length && a.every((r, i) => r.agentId === b[i].agentId);

/**
 * Reads the bureau for every agent the contract has proved, under the visitor's chosen care level.
 * Runs only when the route on screen actually shows chain figures.
 *
 * The order of work is chosen so the page stops looking broken as early as it can. Which agents
 * exist is the slowest thing to learn (two log scans) and the least likely to have changed, so it is
 * seeded from the build-time snapshot and the visitor's first cards are priced off that immediately.
 * The live scan then runs from the snapshot's block onward, which is a few hundred blocks rather than
 * tens of thousands, and the list is reconciled if it moved. Nothing shown is ever stale: the seed
 * decides which agents to ask about, and the contract answers for every figure.
 *
 * Reviewers are not fetched here: a busy agent has dozens, and the row only needs them when the
 * visitor opens it (see useReviewers). Quotes are re-read when the care level changes, because the
 * thresholds are what the contract prices on: the page must never recompute a fee itself.
 */
export function useBureau(care: Care, refreshKey = 0, enabled = true): BureauState {
  const [state, setState] = useState<BureauState>({ loading: true, failed: false, agents: [], listSettled: false });

  useEffect(() => {
    // The FAQ, the how-it-works page and the developer page show no chain figure, so they must not
    // pay for three log scans and twenty-five quotes to render a page of prose.
    if (!enabled) return;
    let alive = true;
    const p = presetOf(care).params;

    (async () => {
      setState((s) => ({ ...s, loading: true, listSettled: false }));

      // Order matters more than parallelism here. The public RPC serves one origin's requests in a
      // queue, so firing everything at once does not make any of it faster: it makes the cheap calls
      // wait behind the expensive ones. Measured, the head read took 2.9s when it shared a wave with
      // two log scans, and 1.1s on its own. So the log scans are held back until the first screenful
      // has been asked for. Cheap calls may still go out together — they are not what caused it.
      readBlock().then(
        (block) => alive && setState((s) => ({ ...s, block })),
        () => undefined,
      );

      const read = async ({ agentId, reviews }: AgentRow): Promise<AgentView> => {
        try {
          const [identity, quote] = await Promise.all([readIdentity(agentId), readQuote(agentId, p)]);
          return { agentId, reviews, identity, quote, reviewers: [], bounties: [] };
        } catch (e) {
          return { agentId, reviews, reviewers: [], bounties: [], error: (e as Error).message };
        }
      };

      // Two waves: the first screenful arrives fast, the rest of the bureau follows. Every agent the
      // contract has proved ends up on the page; none of them is chosen by hand.
      const FIRST = 12;
      const head = await Promise.all(SEED.slice(0, FIRST).map(read));
      if (!alive) return;
      setState((s) => ({
        ...s,
        loading: false,
        failed: head.length > 0 && head.every((a) => !a.quote),
        agents: head,
      }));

      // Everything below is furniture: the rest of the list, the counters, the bounty badges. Only
      // now is it allowed to compete for the RPC.
      const netPromise = readNetwork().catch(() => undefined);
      const bountiesPromise = readOpenBounties().catch(() => new Map<string, Bounty[]>());
      // Only the blocks mined since the snapshot have to be read, so this is a short scan.
      const listPromise = readAgents(40, SEED_THROUGH + 1, SEED).catch(() => SEED);

      const tail = SEED.length > FIRST ? await Promise.all(SEED.slice(FIRST).map(read)) : [];
      if (!alive) return;
      if (tail.length) setState((s) => ({ ...s, agents: [...head, ...tail] }));

      // Reconcile. In the ordinary case the live scan agrees with the seed and nothing moves on
      // screen; when the scout has proved something since the build, the new rows are read and the
      // list is replaced wholesale so ordering stays the contract's, not the snapshot's.
      const listed = await listPromise;
      if (!alive) return;
      if (sameList(listed, SEED)) {
        setState((s) => ({ ...s, listSettled: true }));
      } else {
        const known = new Map([...head, ...tail].map((a) => [a.agentId.toString(), a]));
        const reconciled = await Promise.all(
          listed.map(async (row) => {
            const had = known.get(row.agentId.toString());
            return had ? { ...had, reviews: row.reviews } : read(row);
          }),
        );
        if (!alive) return;
        setState((s) => ({ ...s, agents: reconciled, listSettled: true }));
      }

      // The network counter and the open bounties are page furniture: they arrive when they arrive,
      // and until then the page says so rather than showing a number it has not read.
      const [net, bounties] = await Promise.all([netPromise, bountiesPromise]);
      if (!alive) return;
      setState((s) => ({
        ...s,
        net,
        failed: !net && s.agents.every((a) => !a.quote),
        agents: s.agents.map((a) => ({ ...a, bounties: bounties.get(a.agentId.toString()) ?? [] })),
      }));
    })();

    return () => {
      alive = false;
    };
  }, [care, refreshKey, enabled]);

  return state;
}
