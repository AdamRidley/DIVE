export interface DiveManifestScene {
  id: string;
  files: string[];
  offset: number;
  length: number;
}

export interface DiveByteRange {
  offset: number;
  length: number;
}

export interface DiveManifest {
  version: 1 | 2;
  story: 'story.json';
  defaultLanguage: string;
  languages: string[];
  shared: string[];
  /** V1 shared prefix; V2 metadata/non-audio shared prefix. */
  prefixEnd: number;
  /** V2 ranges include the local ZIP header and compressed payload, not the central directory. */
  files?: Record<string, DiveByteRange & { audio?: boolean }>;
  scenes: DiveManifestScene[];
}

export const DIVE_MANIFEST_NAME = 'dive.json';
export const DIVE_STORY_NAME = 'story.json';
export const MAX_DIVE_MANIFEST_SIZE = 1024 * 1024;
