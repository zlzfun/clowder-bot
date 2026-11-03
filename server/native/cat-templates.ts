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
export interface SourceTemplate { id: string; revision: number; name: string }
export const avatarBreed = (id: string) => id === 'moonshot' ? 'turkish-van' : id;

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
