import { Command } from 'commander';
import { registerMarketingInit } from './marketing/init.js';
import { registerMarketingCompetitor } from './marketing/competitor.js';

export function registerMarketingCommand(program: Command): void {
  const cmd = program
    .command('marketing')
    .alias('mk')
    .description('Meta marketing skill: cohorts, campaigns, competitor ingest, learnings.');

  registerMarketingInit(cmd);
  registerMarketingCompetitor(cmd);
}
