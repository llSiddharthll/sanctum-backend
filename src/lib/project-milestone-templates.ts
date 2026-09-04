/**
 * Milestone presets by service.
 *
 * Always-on work (social media, graphic design, content, ads…) is delivered
 * continuously — inventing "phases" for it creates milestones nobody ever ticks
 * off, so those services intentionally have NO preset. Deliverable-shaped work
 * (a website, a rebrand, an SEO engagement, a video) runs in phases, so those
 * carry a preset the team can edit before the project is created.
 *
 * `offsetDays` is relative to the project start date; the caller turns it into a
 * real due date. Presets are a starting point, never enforced.
 */
export interface MilestonePreset {
  title: string;
  description?: string;
  offsetDays: number;
}

/** Services delivered continuously — deliberately no milestones. */
export const CONTINUOUS_SERVICES = [
  'social_media',
  'graphic_design',
  'content',
  'ads',
  'influencer',
  'email',
] as const;

export const MILESTONE_TEMPLATES: Record<string, MilestonePreset[]> = {
  // Continuous services — explicitly empty so the UI can explain why.
  ...Object.fromEntries(CONTINUOUS_SERVICES.map((s) => [s, [] as MilestonePreset[]])),

  web: [
    { title: 'Discovery & sitemap', description: 'Requirements, sitemap and content inventory signed off.', offsetDays: 7 },
    { title: 'Wireframes approved', description: 'Low-fidelity structure for every key template.', offsetDays: 14 },
    { title: 'Visual design approved', description: 'High-fidelity designs for all pages.', offsetDays: 28 },
    { title: 'Development complete', description: 'Responsive build with CMS wired up.', offsetDays: 49 },
    { title: 'QA & revisions', description: 'Cross-browser testing and final fixes.', offsetDays: 56 },
    { title: 'Go live', description: 'DNS cutover, analytics and handover.', offsetDays: 63 },
  ],
  branding: [
    { title: 'Discovery workshop', description: 'Positioning, audience and competitive audit.', offsetDays: 7 },
    { title: 'Moodboard & direction', description: 'Art direction agreed.', offsetDays: 14 },
    { title: 'Logo concepts', description: 'Initial routes presented.', offsetDays: 24 },
    { title: 'Identity system', description: 'Colour, type and applications.', offsetDays: 38 },
    { title: 'Brand guidelines & handover', description: 'Final files and usage guide.', offsetDays: 49 },
  ],
  seo: [
    { title: 'Technical audit', description: 'Crawl, indexation and Core Web Vitals baseline.', offsetDays: 10 },
    { title: 'Keyword & content plan', description: 'Target map and content calendar agreed.', offsetDays: 21 },
    { title: 'On-page fixes shipped', description: 'Titles, schema and internal linking.', offsetDays: 42 },
    { title: 'Authority building', description: 'Digital PR and link acquisition underway.', offsetDays: 70 },
    { title: 'Performance review', description: 'Rankings, traffic and conversion report.', offsetDays: 90 },
  ],
  video: [
    { title: 'Script & storyboard', description: 'Concept and shot list approved.', offsetDays: 10 },
    { title: 'Pre-production', description: 'Cast, location and schedule locked.', offsetDays: 18 },
    { title: 'Shoot', description: 'Principal photography complete.', offsetDays: 25 },
    { title: 'First cut', description: 'Rough edit for review.', offsetDays: 35 },
    { title: 'Final delivery', description: 'Grade, sound and master files delivered.', offsetDays: 45 },
  ],
  photography: [
    { title: 'Shot list & moodboard', offsetDays: 7 },
    { title: 'Shoot day', offsetDays: 18 },
    { title: 'Retouched delivery', offsetDays: 28 },
  ],
};

/**
 * Merge presets for the selected services, de-duplicated by title and ordered
 * by offset. A project covering both a continuous and a deliverable service
 * still gets the deliverable's phases.
 */
export function presetFor(services: string[]): MilestonePreset[] {
  const seen = new Set<string>();
  const out: MilestonePreset[] = [];
  for (const s of services) {
    for (const m of MILESTONE_TEMPLATES[s] ?? []) {
      const key = m.title.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(m);
    }
  }
  return out.sort((a, b) => a.offsetDays - b.offsetDays);
}
