import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { NativeCat } from './types.js';
import type { NativeRuntime } from './bridge.js';
import { runtimeForCat } from './agents.js';

// Wire validation only. Template storage, capability discovery and creation stay native.
const choice = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('inherit') }).strict(),
  z.object({ mode: z.literal('explicit'), value: z.string().trim().min(1).max(512) }).strict(),
]);
export const catConfigSchema = z.object({
  runtimeId: z.string().min(1).max(160).nullable(),
  breed: z.discriminatedUnion('mode', [
    z.object({ mode: z.literal('auto') }).strict(),
    z.object({ mode: z.literal('explicit'), breedId: z.string().min(1).max(64) }).strict(),
  ]),
  model: choice, effort: choice,
  portrait: z.object({
    roleDescription: z.string().max(32768), personality: z.string().max(32768).optional(),
    teamStrengths: z.string().max(4096).optional(), strengths: z.array(z.string().max(200)).max(50).optional(),
    caution: z.string().max(4096).nullable().optional(),
  }).strict(),
}).strict();
export const sourceTemplateSchema = z.object({ id: z.string().min(1).max(160), revision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER - 1) }).strict();
export type CatConfig = z.infer<typeof catConfigSchema>;
export interface CatTemplate extends CatConfig {
  id: string; revision: number; name: string; nameHint: string;
  source: { kind: 'native-seed' | 'user'; breedId?: string; variantId?: string };
}
export interface SourceTemplate { id: string; revision: number; name: string }
export const avatarBreed = (id: string) => id === 'moonshot' ? 'turkish-van' : id;

export function presentTemplate(template: CatTemplate): CatTemplate {
  const { revision, ...fields } = template;
  const { source } = fields;
  if (source.kind !== 'native-seed' || !source.breedId) return template;

  // P005 retains native-seed provenance after a user edits a template. Only
  // the unedited seed has a revision equal to the digest of its own wire data.
  const ordered = JSON.stringify(fields, (_key, value) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
    return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)));
  });
  const digest = createHash('sha256').update(ordered).digest('hex').slice(0, 12);
  if (revision !== Number.parseInt(digest, 16)) return template;

  return {
    ...template,
    breed: { mode: 'explicit', breedId: source.breedId },
    model: { mode: 'inherit' },
    effort: { mode: 'inherit' },
  };
}

export function catConfiguration(cat: NativeCat, runtimes: NativeRuntime[]): CatConfig | null {
  if (cat.configurationSource !== 'native_tool') return null;
  const cli = cat.cli && typeof cat.cli === 'object' ? cat.cli as Record<string, unknown> : {};
  return {
    runtimeId: runtimeForCat(cat, runtimes)?.id ?? null,
    breed: cat.breedId ? { mode: 'explicit', breedId: cat.breedId } : { mode: 'auto' },
    model: cat.defaultModel ? { mode: 'explicit', value: cat.defaultModel } : { mode: 'inherit' },
    effort: typeof cli.effort === 'string' && cli.effort ? { mode: 'explicit', value: cli.effort } : { mode: 'inherit' },
    portrait: {
      roleDescription: cat.roleDescription,
      ...(cat.personality !== undefined ? { personality: cat.personality } : {}),
      ...(cat.teamStrengths !== undefined ? { teamStrengths: cat.teamStrengths } : {}),
      ...(Array.isArray(cat.strengths) ? { strengths: cat.strengths.filter((s): s is string => typeof s === 'string') } : {}),
      ...(typeof cat.caution === 'string' || cat.caution === null ? { caution: cat.caution } : {}),
    },
  };
}
