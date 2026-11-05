/**
 * Every number behind tenant insights (health score, value tier, flags) lives here.
 * Changing a weight, threshold or day count must never require touching logic.
 * Defaults come from ADMIN_PROMPT_02; the product owner confirms them.
 * Money values are in the tenant's currency (XAF for every tenant today).
 */
export const insightsConfig = {
  /** Windows (days) for usage and sales metrics; each is compared with the equal window before it. */
  windows: [7, 30, 60, 90] as const,

  /** Tenant lifecycle states that replace the score. */
  states: {
    /** Approved fewer than this many days ago → Onboarding (milestones instead of a score). */
    onboardingDays: 14,
    /** Fewer snapshot days than this (for a tenant past onboarding) → Insufficient data. */
    minHistoryDays: 14,
    /** More missing snapshot days than this in the last 30 → history inconsistent → Insufficient data. */
    maxMissingDaysIn30: 2,
  },

  health: {
    /** Maximum points per factor. Must sum to 100. */
    weights: { recency: 25, frequency: 20, trend: 20, adoption: 15, breadth: 10, subscription: 10 },
    /** Days since last activity: full points within `fullWithinDays`, zero from `zeroAtDays`, linear between. */
    recency: { fullWithinDays: 3, zeroAtDays: 21 },
    /** Active days (any sales, returns, user action or active user) in the last `windowDays`. */
    frequency: { windowDays: 30, fullAtActiveDays: 20 },
    trend: {
      /** Last `windowDays` against the `windowDays` before. */
      windowDays: 30,
      /** Change (%) earning full points / zero points, linear between. */
      fullAtPct: 10,
      zeroAtPct: -30,
      /** Change is capped at ± this many percent. */
      capPct: 100,
      /**
       * Earlier window below these → low confidence (sales measure / actions measure), but only when the
       * current window has activity. No sales and no user actions in the current window → 0 trend points.
       */
      minBaseSales: 5,
      minBaseActions: 20,
      /** Share of the factor's points given when the trend is low confidence. */
      lowConfidenceShare: 0.5,
    },
    /** Active users in the window ÷ non-deactivated users. */
    adoption: { windowDays: 30, fullAtRatio: 0.7 },
    /** Modules used in the window ÷ enabled modules that have a usage signal. */
    breadth: { windowDays: 30, fullAtRatio: 0.6 },
    /** Share of subscription points per subscription status. */
    subscription: { ACTIVE: 1, TRIALING: 0.7, PAST_DUE: 0, CANCELLED: 0 } as Record<string, number>,
    /** Band cutoffs (score >= value). Below needsAttention → At risk. */
    bands: { healthy: 70, needsAttention: 40 },
  },

  value: {
    /** Weight of each component in the 0–100 value score. Must sum to 100. */
    weights: { value90: 50, activeUsers: 20, breadth: 15, plan: 15 },
    /** Value processed in 90 days earning the full value90 component (linear from 0). Proposed, owner to confirm. */
    value90FullAt: 2_500_000,
    /** Active users (30 days) earning the full activeUsers component. Proposed, owner to confirm. */
    activeUsersFullAt: 5,
    /** Plan level as a share of the plan component. */
    planLevel: { STARTER: 1 / 3, GROWTH: 2 / 3, ENTERPRISE: 1 } as Record<string, number>,
    /**
     * Tier cutoffs on the value score (score >= value). Proposed, owner to confirm. Based on the
     * 2026-10-05 distribution: 6 of 24 tenants processed anything in 90 days (2.63M, 800k, 300k,
     * 187k, 142k, 300 XAF); Key account ≈ today's top tenant, Growth = real sales plus engagement.
     */
    tiers: { keyAccount: 50, growth: 15 },
  },

  flags: {
    dormantDays: 14,
    /** Decline (%) against the prior window that raises Declining (only when the trend is not low confidence). */
    decliningPct: -30,
    trialEndingDays: 7,
    /** Active days in 30 that make a trial ending soon a conversion opportunity. */
    trialHighUsageActiveDays: 10,
    /** Returns value above this % of sales value over 30 days. */
    highReturnsPct: 15,
    /** Active users ratio (30 days) below this. */
    fewUsersRatio: 0.3,
  },

  api: {
    defaultLimit: 25,
    maxLimit: 100,
    /** Detail daily series default and maximum length (days). */
    seriesDefaultDays: 90,
    seriesMaxDays: 366,
    /** Sparkline length (days of sales counts). */
    sparklineDays: 30,
    summaryTopN: 5,
  },
} as const;

export type InsightsConfig = typeof insightsConfig;
