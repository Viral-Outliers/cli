// The command manifest is GENERATED from the Viral Outliers skill registry
// (social-outliers/src/app/lib/publicApi/cliManifest.ts) and mirrored into
// src/manifest.json. Never hand-edit the JSON; these types are a copy of the
// generator's interfaces so the runtime can stay dependency-free.
import manifestJson from './manifest.json';

export type CliParamType = 'string' | 'number' | 'boolean' | 'string[]' | 'object[]';

export interface CliManifestParam {
  /** Registry name, also the JSON key sent to the API (e.g. includeTranscript). */
  name: string;
  /** CLI flag without the leading dashes (e.g. include-transcript). */
  flag: string;
  type: CliParamType;
  /** Substituted into the path template instead of being sent in the query/body. */
  inPath: boolean;
  required: boolean;
  description: string;
}

export interface CliManifestCommand {
  /** Skill key with underscores turned into hyphens (search_outliers -> search-outliers). */
  name: string;
  key: string;
  title: string;
  summary: string;
  description: string;
  method: 'GET' | 'POST' | 'DELETE';
  /** REST path template, e.g. /api/v1/posts/{postId}. */
  path: string;
  cost: number;
  isAsync: boolean;
  requiresAuth: boolean;
  readOnly: boolean;
  params: CliManifestParam[];
}

export interface CliManifest {
  /** Bumped only when the shape above changes; the runtime refuses unknown versions. */
  schemaVersion: 1;
  generatedAt: string;
  apiBase: string;
  envVar: string;
  commands: CliManifestCommand[];
}

export const MANIFEST_SCHEMA_VERSION = 1;

export function loadManifest(): CliManifest {
  const raw = manifestJson as unknown as { schemaVersion?: unknown };
  if (raw.schemaVersion !== MANIFEST_SCHEMA_VERSION) {
    throw new Error(
      `Unsupported manifest schemaVersion ${String(raw.schemaVersion)} (this build understands ${MANIFEST_SCHEMA_VERSION}). Update the viral-outliers package.`,
    );
  }
  return manifestJson as unknown as CliManifest;
}

export function findCommand(manifest: CliManifest, name: string): CliManifestCommand | undefined {
  return manifest.commands.find((c) => c.name === name);
}
