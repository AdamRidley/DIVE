export interface DiveManifestScene {
  id: string;
  files: string[];
  offset: number;
  length: number;
}

export interface DiveManifest {
  version: 1;
  story: 'story.json';
  defaultLanguage: string;
  languages: string[];
  shared: string[];
  scenes: DiveManifestScene[];
}

export const DIVE_MANIFEST_NAME = 'dive.json';
export const DIVE_STORY_NAME = 'story.json';
