import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useApi } from '../context/VaultContext';

// ─── Types (duplicated client-side — can't import from src/lib) ───────────────

export type PlatformId = 'claude';

export interface ClickUpConfig {
  teamId?: string;
  spaceId?: string;
  listId?: string;
  changelogTarget?: 'comments';
}

export interface GitHubConfig {
  owner?: string;
  repo?: string;
  changelogTarget?: 'comments';
}

/** The six sleep specialists whose model/effort are tunable (mirrors SLEEP_SPECIALISTS). */
export const SLEEP_SPECIALISTS = [
  'sleep-tasks', 'sleep-state', 'sleep-product', 'sleep-migration', 'sleep-federation', 'sleep-learn',
] as const;
export type SleepSpecialist = (typeof SLEEP_SPECIALISTS)[number];

/** Models the UI offers. The CLI additionally accepts an unknown id behind
 *  `--allow-unknown`; the UI deliberately does not — a picker is not the place
 *  to type a model this build has never heard of. */
export const SLEEP_MODEL_OPTIONS = ['claude-opus-5', 'claude-sonnet-5', 'claude-haiku-4-5'] as const;
export const SLEEP_EFFORT_OPTIONS = ['low', 'medium', 'high'] as const;

export interface SleepSpecialistConfig {
  model?: string;
  effort?: 'low' | 'medium' | 'high';
}

export interface SleepConfig {
  thresholds?: { drowsy?: number; sleepy?: number; mustSleep?: number };
  specialists?: Partial<Record<SleepSpecialist, SleepSpecialistConfig>>;
  maxNewTasksPerCycle?: number;
}

/** A PATCH of the sleep block. `null` on any field means "reset to default". */
export interface SleepConfigPatch {
  thresholds?: { drowsy?: number | null; sleepy?: number | null; mustSleep?: number | null } | null;
  specialists?: Partial<Record<SleepSpecialist, SleepSpecialistConfig | null>> | null;
  maxNewTasksPerCycle?: number | null;
}

export interface SetupConfig {
  platforms: PlatformId[];
  packs: string[];
  multiProduct: false | string[];
  setupVersion: string;
  disableNativeMemory: boolean;
  taskBackend?: 'local' | 'clickup' | 'github';
  cloudTaskManagement?: boolean;
  clickup?: ClickUpConfig;
  github?: GitHubConfig;
  sleep?: SleepConfig;
  /** Cross-project federation read gate (issue #25). Default FALSE (private). */
}

interface ConfigResponse {
  config: SetupConfig | null;
}

interface ConfigUpdateResponse {
  config: SetupConfig;
}

/** Allowed PATCH fields — deliberately restricted to prevent allow-list bypass. */
export interface ConfigPatch {
  platforms?: PlatformId[];
  packs?: string[];
  disableNativeMemory?: boolean;
  taskBackend?: 'local' | 'clickup' | 'github';
  cloudTaskManagement?: boolean;
  clickup?: ClickUpConfig;
  github?: GitHubConfig;
  sleep?: SleepConfigPatch;
}

// ─── Hooks ────────────────────────────────────────────────────────────────────

export function useConfig() {
  const api = useApi();
  return useQuery({
    queryKey: ['config'],
    queryFn: () => api.get<ConfigResponse>('/config'),
    select: (data) => data.config,
  });
}

/**
 * What each INSTALLED sleep agent currently declares in its frontmatter.
 *
 * The "Package default" option is meaningless on its own — this is what lets the
 * picker name the value it would fall back to. Read-only; the same source
 * `dreamcontext sleep config` prints.
 */
export interface SleepSpecialistDefaults {
  defaults: Record<SleepSpecialist, { model: string | null; effort: string | null }>;
}

export function useSleepSpecialistDefaults() {
  const api = useApi();
  return useQuery({
    queryKey: ['sleep-specialist-defaults'],
    queryFn: () => api.get<SleepSpecialistDefaults>('/sleep/specialists'),
    select: (d) => d.defaults,
  });
}

export function useUpdateConfig() {
  const queryClient = useQueryClient();
  const api = useApi();
  return useMutation({
    mutationFn: (patch: ConfigPatch) =>
      api.patch<ConfigUpdateResponse>('/config', patch),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['config'] });
      // A threshold change re-levels every sleep surface, so the /api/sleep
      // payload (which carries the resolved ladder) has to be refetched too.
      queryClient.invalidateQueries({ queryKey: ['sleep'] });
      // A model/effort change is written into the agent file, so the "package
      // default" the picker reports changes with it.
      queryClient.invalidateQueries({ queryKey: ['sleep-specialist-defaults'] });
    },
  });
}
