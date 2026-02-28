/**
 * Rules-based optimization recommendations engine.
 * Analyzes stored analytics data to suggest improvements.
 * No external infrastructure needed — pure rule evaluation.
 */

import type { MonitorDatabase } from "../storage/database.js";

/** A recommendation produced by the engine. */
export interface Recommendation {
  type: "cost" | "efficiency" | "reliability";
  severity: "info" | "warning";
  message: string;
  detail: string;
}

/**
 * Generate recommendations based on current analytics data.
 * Rules:
 * - High error rate tools (>20% failure, min 10 invocations) → reliability warning
 * - Expensive sessions (>$10) → cost warning
 * - Low cache utilization (<10% of input from cache) → efficiency info
 */
export function generateRecommendations(db: MonitorDatabase): Recommendation[] {
  const recommendations: Recommendation[] = [];

  // ---- High error rate tools ----
  const toolRates = db.getToolSuccessRates();
  for (const tool of toolRates) {
    if (tool.total >= 10 && tool.successRate < 0.8) {
      const errorPct = ((1 - tool.successRate) * 100).toFixed(1);
      recommendations.push({
        type: "reliability",
        severity: "warning",
        message: `${tool.toolName} has a ${errorPct}% error rate`,
        detail: `${tool.errors} of ${tool.total} invocations failed. Consider reviewing common failure patterns.`,
      });
    }
  }

  // ---- Expensive sessions ----
  const expensiveSessions = db.getMostExpensiveSessions(5);
  for (const session of expensiveSessions) {
    if (session.estimatedCostUsd > 10) {
      recommendations.push({
        type: "cost",
        severity: "warning",
        message: `Session in ${session.projectName} cost $${session.estimatedCostUsd.toFixed(2)}`,
        detail: `${session.totalToolUses} tool uses over ${Math.round(session.durationSeconds / 60)} minutes. Consider breaking complex tasks into smaller sessions.`,
      });
    }
  }

  // ---- Low cache utilization ----
  const analyticsStats = db.getAnalyticsStats();
  if (analyticsStats) {
    const totalInput = analyticsStats.totalInputTokens;
    const cacheRead = analyticsStats.totalCacheReadTokens;
    if (totalInput > 100000 && cacheRead / totalInput < 0.1) {
      const cachePct = ((cacheRead / totalInput) * 100).toFixed(1);
      recommendations.push({
        type: "efficiency",
        severity: "info",
        message: `Only ${cachePct}% of input tokens served from cache`,
        detail: `Cache read tokens: ${cacheRead.toLocaleString()} of ${totalInput.toLocaleString()} total input. Longer conversations and prompt caching can improve this.`,
      });
    }
  }

  return recommendations;
}
