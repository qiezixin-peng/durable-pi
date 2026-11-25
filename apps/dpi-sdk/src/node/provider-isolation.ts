export const PROTECTED_INTERACTIVE_PROVIDER = "google" as const;

export const PROTECTED_PROVIDER_MESSAGE =
  "Antigravity is a protected interactive Provider. Start it directly in T3; Durable Agents, fallbacks and schedulers cannot invoke or delegate work to it.";

/** Keep consumer Antigravity OAuth on the user-facing side of the routing boundary.
 * The official runtime may manage native subagents, but Durable must never turn
 * Antigravity into a worker or fallback for another model. */
export function isDurableDelegationAllowed(provider: string): boolean {
  return provider !== PROTECTED_INTERACTIVE_PROVIDER;
}
