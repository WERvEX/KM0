import type { ResolvedProfile, TokenUsage } from "./types";

/** USD cost of one call, or null when the user has not entered prices for the profile. */
export function callCost(profile: ResolvedProfile, usage: TokenUsage): number | null {
  if (profile.priceInPerMTok === null || profile.priceOutPerMTok === null) return null;
  return (usage.inputTokens * profile.priceInPerMTok + usage.outputTokens * profile.priceOutPerMTok) / 1_000_000;
}
