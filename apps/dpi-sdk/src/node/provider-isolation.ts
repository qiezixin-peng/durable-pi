export const PROTECTED_INTERACTIVE_PROVIDER = "google" as const;

export const PROTECTED_PROVIDER_MESSAGE =
  "Antigravity is a protected upstream Provider. Start it directly in T3; Codex, DeepSeek, Durable workers, fallbacks and schedulers cannot invoke it or access its OAuth session. Antigravity may delegate work outward to eligible Providers.";

/** Keep consumer Antigravity OAuth on the upstream side of the routing boundary.
 * Outward delegation from Antigravity is allowed by the Coordinator, but no
 * worker/fallback route may select Antigravity as its execution Provider. */
export function isDurableDelegationAllowed(provider: string): boolean {
  return provider !== PROTECTED_INTERACTIVE_PROVIDER;
}
