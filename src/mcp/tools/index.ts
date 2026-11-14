import type { SanctumTool } from '../tool-kit.js';
import { coreTools } from './core.js';
import { crmTools } from './crm.js';
import { moneyTools } from './money.js';
import { workTools } from './work.js';
import { peopleTools } from './people.js';

export const ALL_TOOLS: SanctumTool[] = [
  ...coreTools,
  ...crmTools,
  ...moneyTools,
  ...workTools,
  ...peopleTools,
];

// Tool names must be unique (MCP clients key on them).
const seen = new Set<string>();
for (const t of ALL_TOOLS) {
  if (seen.has(t.name)) throw new Error(`Duplicate MCP tool name: ${t.name}`);
  seen.add(t.name);
}
