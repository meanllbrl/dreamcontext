import { describe, expect, it } from 'vitest';
import { humaniseSlug, knowledgeTitle, taskTitle } from '../../dashboard/src/components/whiteboard/widgetModel.js';

/** A19: a knowledge or task card shows the entity's title, never its bare slug. */
describe('whiteboard widget titles', () => {
  it('humanises a slug: last segment, hyphens to spaces, first letter capitalised', () => {
    expect(humaniseSlug('onboarding-playbook')).toBe('Onboarding playbook');
    expect(humaniseSlug('features/sleep-cycle')).toBe('Sleep cycle');
  });

  it('knowledge: a frontmatter title wins, then a real name, then the first heading, then the humanised slug', () => {
    expect(knowledgeTitle({ slug: 'a-b', name: 'a-b', title: 'The A of B', content: '# Heading' })).toBe('The A of B');
    expect(knowledgeTitle({ slug: 'a-b', name: 'Pricing notes', content: '# Heading' })).toBe('Pricing notes');
    expect(knowledgeTitle({ slug: 'onboarding-playbook', name: 'onboarding-playbook', content: '# Onboarding playbook\n\nBody.' }))
      .toBe('Onboarding playbook');
    expect(knowledgeTitle({ slug: 'onboarding-playbook', name: 'onboarding-playbook', content: 'No heading here.' }))
      .toBe('Onboarding playbook');
    // A `## sub` heading is not the title.
    expect(knowledgeTitle({ slug: 'x-y', name: 'x-y', content: '## Sub\ntext' })).toBe('X y');
  });

  it('task: the sentence-style name, or the humanised slug when the name is only the slug', () => {
    expect(taskTitle({ slug: 'draft-the-checklist', name: 'Draft the checklist' })).toBe('Draft the checklist');
    expect(taskTitle({ slug: 'draft-the-checklist', name: 'draft-the-checklist' })).toBe('Draft the checklist');
  });
});
