import { promises as fs } from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import { z } from 'zod';
import { PROJECT_ROOT } from './paths.js';

export const WeekdaySchema = z.enum(['mon', 'tue', 'wed', 'thu', 'fri', '*']);
export type Weekday = z.infer<typeof WeekdaySchema>;

export const RecurringBlockSchema = z.object({
  label: z.string().min(1),
  weekday: WeekdaySchema,
  minutes: z.number().int().positive(),
  issue: z.string().default(''),
});
export type RecurringBlock = z.infer<typeof RecurringBlockSchema>;

export const SeasonalSchema = z.object({
  from: z.string().regex(/^\d{2}-\d{2}$/, 'Expected MM-DD'),
  to: z.string().regex(/^\d{2}-\d{2}$/, 'Expected MM-DD'),
  hours: z.number().positive(),
});

export const HolidayRangeSchema = z.object({
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Expected YYYY-MM-DD'),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Expected YYYY-MM-DD'),
});

export const PersonSchema = z.object({
  id: z.string().min(1),
  githubLogin: z.string().default(''),
  emails: z.array(z.string()).default([]),
  default: z.boolean().default(false),
});
export type Person = z.infer<typeof PersonSchema>;

export const DistributionSchema = z.enum([
  'weighted-by-churn',
  'equal',
  'weighted-by-commits',
]);
export type Distribution = z.infer<typeof DistributionSchema>;

export const ConfigSchema = z.object({
  workday: z
    .object({
      defaultHours: z.number().positive().default(8),
      seasonal: z.array(SeasonalSchema).default([]),
    })
    .default({ defaultHours: 8, seasonal: [] }),
  recurring: z.array(RecurringBlockSchema).default([]),
  fallbackIssue: z.string().default(''),
  distribution: DistributionSchema.default('weighted-by-churn'),
  ticketRegex: z.string().default('[A-Z][A-Z0-9]+-\\d+'),
  holidays: z.array(HolidayRangeSchema).default([]),
  people: z.array(PersonSchema).default([]),
  defaultComments: z
    .object({
      commits: z.string().default('Development work'),
      fallback: z.string().default('Administrative work'),
    })
    .default({}),
  issueComments: z.record(z.string(), z.string()).default({}),
});
export type Config = z.infer<typeof ConfigSchema>;

const DEFAULT_CONFIG: Config = ConfigSchema.parse({});

/** Reads and validates config.yaml. Returns defaults if the file does not exist. */
export async function loadConfig(configPath: string): Promise<Config> {
  let raw: string;
  try {
    raw = await fs.readFile(configPath, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return DEFAULT_CONFIG;
    }
    throw err;
  }
  const parsed = YAML.parse(raw) ?? {};
  return ConfigSchema.parse(parsed);
}

/** Validates and writes config.yaml (used by the web Config page). */
export async function saveConfig(configPath: string, input: unknown): Promise<Config> {
  const config = ConfigSchema.parse(input);
  await fs.mkdir(path.dirname(configPath), { recursive: true });
  const header =
    '# Reglas de imputacion (SIN secretos). Gestionadas desde la web.\n';
  await fs.writeFile(configPath, header + YAML.stringify(config), 'utf8');
  return config;
}

export { PROJECT_ROOT };
