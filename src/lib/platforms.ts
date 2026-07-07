export const SUPPORTED_PLATFORMS = ['claude'] as const;

export type PlatformId = typeof SUPPORTED_PLATFORMS[number];

export const DEFAULT_PLATFORMS: PlatformId[] = ['claude'];

export interface PlatformMeta {
  id: PlatformId;
  label: string;
  description: string;
}

export const PLATFORM_CATALOG: PlatformMeta[] = [
  {
    id: 'claude',
    label: 'Claude',
    description: 'Install .claude skills, agents, and hooks',
  },
];

const SUPPORTED_SET = new Set<string>(SUPPORTED_PLATFORMS);

export function isPlatformId(value: string): value is PlatformId {
  return SUPPORTED_SET.has(value);
}

export function normalizePlatforms(values: Iterable<string>): PlatformId[] {
  const seen = new Set<PlatformId>();
  const ordered: PlatformId[] = [];

  for (const raw of values) {
    const normalized = raw.trim().toLowerCase();
    if (!normalized) continue;
    if (!isPlatformId(normalized)) continue;
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    ordered.push(normalized);
  }

  return ordered;
}

export function parsePlatformList(input: string): {
  platforms: PlatformId[];
  invalid: string[];
} {
  const tokens = input
    .split(',')
    .map((token) => token.trim())
    .filter(Boolean);

  const invalid: string[] = [];
  const seen = new Set<PlatformId>();
  const platforms: PlatformId[] = [];

  for (const token of tokens) {
    const normalized = token.toLowerCase();
    if (!isPlatformId(normalized)) {
      invalid.push(token);
      continue;
    }
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    platforms.push(normalized);
  }

  return { platforms, invalid };
}

export function formatSupportedPlatforms(): string {
  return SUPPORTED_PLATFORMS.join(', ');
}

export function ensurePlatformSelection(platforms: PlatformId[]): PlatformId[] {
  if (platforms.length > 0) return platforms;
  return [...DEFAULT_PLATFORMS];
}
