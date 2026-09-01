import {
  audit,
  countApplicationsToday,
  createApplication,
  getApplicationByPosting,
  now,
  uid,
} from './db.js';
import { scanForUser } from './skills/jobScraper.js';
import { scorePosting } from './skills/matchScorer.js';
import { tailorApplication } from './skills/applicationTailor.js';
import type { Application, Draft, Posting, Profile, ScoreBreakdown } from './types.js';

export interface MatchCard {
  application: Application;
  posting: Posting;
  draft: Draft;
  breakdown: ScoreBreakdown;
}

export interface ScanSummary {
  cards: MatchCard[];
  found: number;
  scoredBelowThreshold: number;
  cappedOut: boolean;
  sourceErrors: string[];
}

/**
 * One scan cycle for a user: scrape → score → (above threshold) tailor →
 * create pending application. Returns match cards for the notifier
 * (Telegram in production) to render.
 */
export async function runScanCycle(profile: Profile): Promise<ScanSummary> {
  const scan = await scanForUser(profile);
  const cards: MatchCard[] = [];
  let below = 0;
  let cappedOut = false;
  // Snapshot BEFORE the loop — applications created this cycle are already
  // counted via cards.length; querying inside the loop double-counts them.
  const alreadyToday = countApplicationsToday(profile.userId);

  for (const posting of scan.newPostings) {
    // Daily cap: don't flood the chat.
    if (alreadyToday + cards.length >= profile.dailyCap) {
      cappedOut = true;
      break;
    }
    const breakdown = await scorePosting(profile, posting);
    if (breakdown.total < profile.threshold) {
      below++;
      continue; // below-threshold postings are counted per scan, not persisted
    }
    // Idempotency: never create two applications for the same posting.
    if (getApplicationByPosting(profile.userId, posting.id)) continue;

    const draft = await tailorApplication(profile, posting);
    const application: Application = {
      id: uid(),
      userId: profile.userId,
      postingId: posting.id,
      draftId: draft.id,
      status: 'pending_approval',
      score: breakdown.total,
      breakdown,
      createdAt: now(),
    };
    if (!createApplication(application)) continue; // raced — already exists
    audit('pipeline', 'MATCH_CARD', `app=${application.id} posting=${posting.id} score=${breakdown.total}`);
    cards.push({ application, posting, draft, breakdown });
  }

  return { cards, found: scan.found, scoredBelowThreshold: below, cappedOut, sourceErrors: scan.sourceErrors };
}

export function renderBreakdown(b: ScoreBreakdown): string {
  return [
    `Skills     ${String(b.skills.score).padStart(2)}/${b.skills.max} — ${b.skills.reason}`,
    `Comp       ${String(b.comp.score).padStart(2)}/${b.comp.max} — ${b.comp.reason}`,
    `Location   ${String(b.location.score).padStart(2)}/${b.location.max} — ${b.location.reason}`,
    `Seniority  ${String(b.seniority.score).padStart(2)}/${b.seniority.max} — ${b.seniority.reason}`,
    `Culture    ${String(b.culture.score).padStart(2)}/${b.culture.max} — ${b.culture.reason}`,
  ].join('\n');
}
