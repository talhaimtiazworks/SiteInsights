import robotsParser from "robots-parser";
import type { RobotsInfo } from "./types";

export const ROBOTS_USER_AGENT_TOKEN = "SiteLensAI";
const MAX_CRAWL_DELAY_MS = 2000;

export interface RobotsChecker {
  isAllowed(url: string): boolean;
  crawlDelayMs: number | null;
}

/**
 * Builds a robots.txt checker from stored robots info.
 *  - found → standard parsing (most specific user-agent group wins)
 *  - not_found (4xx) → everything allowed (RFC 9309 §2.3.1.3)
 *  - error / unreachable (5xx, network) → complete disallow (RFC 9309 §2.3.1.4)
 */
export function buildRobotsChecker(info: RobotsInfo | null): RobotsChecker {
  if (!info || info.status === "not_found" || info.status === "not_checked") return { isAllowed: () => true, crawlDelayMs: null };
  if (info.disallowAll) return { isAllowed: () => false, crawlDelayMs: null };
  const parser = robotsParser(info.url, info.body ?? "");
  const delay = parser.getCrawlDelay(ROBOTS_USER_AGENT_TOKEN);
  return {
    isAllowed: (url: string) => parser.isAllowed(url, ROBOTS_USER_AGENT_TOKEN) !== false,
    crawlDelayMs: typeof delay === "number" && delay > 0 ? Math.min(delay * 1000, MAX_CRAWL_DELAY_MS) : null,
  };
}

export function extractRobotsSitemaps(robotsUrl: string, body: string): string[] {
  try {
    return robotsParser(robotsUrl, body).getSitemaps().slice(0, 10);
  } catch {
    return [];
  }
}
