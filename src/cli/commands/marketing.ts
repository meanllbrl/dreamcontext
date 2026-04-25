import { Command } from 'commander';
import { registerMarketingInit } from './marketing/init.js';
import { registerMarketingCompetitor } from './marketing/competitor.js';
import { registerMarketingConfig } from './marketing/config.js';
import { registerMarketingAccount } from './marketing/account.js';
import { registerMarketingCohort } from './marketing/cohort.js';
import { registerMarketingInsights } from './marketing/insights.js';
import { registerMarketingToday } from './marketing/today.js';
import { registerMarketingDiff } from './marketing/diff.js';
import { registerMarketingPause, registerMarketingResume } from './marketing/status-flip.js';
import { registerMarketingScale } from './marketing/scale.js';
import { registerMarketingKill } from './marketing/kill.js';
import { registerMarketingDoctor } from './marketing/doctor.js';
import { registerMarketingCampaign } from './marketing/campaign.js';
import { registerMarketingAdSet } from './marketing/adset.js';
import { registerMarketingCreative } from './marketing/creative.js';
import { registerMarketingAsset } from './marketing/asset.js';
import { registerMarketingAd } from './marketing/ad.js';
import { registerMarketingLaunch } from './marketing/launch.js';
import { registerMarketingLearnings } from './marketing/learnings.js';
import { registerMarketingRemSleep } from './marketing/rem-sleep.js';
import { registerMarketingHooks } from './marketing/hooks.js';

export function registerMarketingCommand(program: Command): void {
  const cmd = program
    .command('marketing')
    .alias('mk')
    .description('Meta marketing skill: cohorts, campaigns, competitor ingest, learnings.');

  // Bootstrap + competitor (PR 0)
  registerMarketingInit(cmd);
  registerMarketingCompetitor(cmd);

  // PR 2 — CLI surface
  registerMarketingConfig(cmd);
  registerMarketingAccount(cmd);
  registerMarketingCohort(cmd);
  registerMarketingInsights(cmd);
  registerMarketingToday(cmd);
  registerMarketingDiff(cmd);
  registerMarketingPause(cmd);
  registerMarketingResume(cmd);
  registerMarketingScale(cmd);
  registerMarketingKill(cmd);
  registerMarketingDoctor(cmd);

  // PR 3 — mutation verbs + launch
  registerMarketingCampaign(cmd);
  registerMarketingAdSet(cmd);
  registerMarketingCreative(cmd);
  registerMarketingAsset(cmd);
  registerMarketingAd(cmd);
  registerMarketingLaunch(cmd);

  // PR 4 — learnings + rem-sleep
  registerMarketingLearnings(cmd);
  registerMarketingRemSleep(cmd);

  // PR 8 — git hooks
  registerMarketingHooks(cmd);
}
