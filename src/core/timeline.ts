import type { LocalizedString, Scene, TimelineSection } from './types';

/** One entry on the timeline: a scene, or an authored timeline section. */
export interface TimelineItem {
  id: string;
  label?: LocalizedString;
  startTime: number;
  endTime: number;
  /** Authored band colour, when the story set one. */
  color?: string;
}

/** A timeline act with the finer items it contains. */
export interface TimelineAct extends TimelineItem {
  children: TimelineItem[];
}

export interface TimelineModel {
  acts: TimelineAct[];
  /** True when acts came from nesting two levels, false for the flat track. */
  nested: boolean;
}

const isFiniteSpan = (item: { startTime: number; endTime: number }): boolean =>
  Number.isFinite(item.startTime) && Number.isFinite(item.endTime) && item.endTime > item.startTime;

const sceneItems = (scenes: Scene[]): TimelineItem[] => scenes
  .filter(isFiniteSpan)
  .map((scene) => ({
    id: scene.id,
    label: scene.label || scene.id,
    startTime: scene.startTime,
    endTime: scene.endTime,
  }))
  .sort((a, b) => a.startTime - b.startTime);

const sectionItems = (sections: TimelineSection[]): TimelineItem[] => sections
  .filter(isFiniteSpan)
  .map((section) => ({
    id: section.id || `${section.startTime}-${section.endTime}`,
    label: section.label,
    startTime: section.startTime,
    endTime: section.endTime,
    color: section.color,
  }))
  .sort((a, b) => a.startTime - b.startTime);

const overlap = (a: TimelineItem, b: TimelineItem): number =>
  Math.max(0, Math.min(a.endTime, b.endTime) - Math.max(a.startTime, b.startTime));

const contains = (outer: TimelineItem, inner: TimelineItem): boolean =>
  inner.startTime >= outer.startTime && inner.endTime <= outer.endTime;

/** The finer list is simply the one with more entries, provided it at least partly sits inside. */
function isFiner(inner: TimelineItem[], outer: TimelineItem[]): boolean {
  if (!inner.length || !outer.length || inner.length <= outer.length) {
    return false;
  }
  return inner.some((item) => outer.some((host) => contains(host, item)));
}

/**
 * Group the finer list under the coarser one. Items go to the host they overlap most and
 * are clamped to it, so a straddling section cannot draw outside its act.
 */
function nest(parents: TimelineItem[], children: TimelineItem[]): TimelineAct[] {
  const acts: TimelineAct[] = parents.map((parent) => ({ ...parent, children: [] }));
  for (const child of children) {
    let best: { act: TimelineAct; overlap: number } | null = null;
    for (const act of acts) {
      const shared = overlap(act, child);
      if (shared > 0 && (!best || shared > best.overlap)) {
        best = { act, overlap: shared };
      }
    }
    if (!best) {
      continue;
    }
    const startTime = Math.max(child.startTime, best.act.startTime);
    const endTime = Math.min(child.endTime, best.act.endTime);
    if (endTime > startTime) {
      best.act.children.push({ ...child, startTime, endTime });
    }
  }
  for (const act of acts) {
    act.children.sort((a, b) => a.startTime - b.startTime);
  }
  return acts;
}

/**
 * Resolve the timeline for a story.
 *
 * Flat by default: the authored `timelineSections` are the track, or one entry per scene when
 * there are none. With `nestedTimeline` on, two levels are built by containment: whichever list
 * is finer becomes the sub-items and the coarser list becomes the acts. That covers both
 * authoring shapes, sections tiled inside scenes and scenes tiled inside sections, without
 * either project having to restructure its story.
 */
export function resolveTimeline(
  scenes: Scene[] = [],
  sections: TimelineSection[] = [],
  nested = false,
): TimelineModel {
  const sceneList = sceneItems(scenes);
  const sectionList = sectionItems(sections);

  if (nested && sceneList.length && sectionList.length) {
    if (isFiner(sectionList, sceneList)) {
      return { acts: nest(sceneList, sectionList), nested: true };
    }
    if (isFiner(sceneList, sectionList)) {
      return { acts: nest(sectionList, sceneList), nested: true };
    }
  }

  const flat = sectionList.length ? sectionList : sceneList;
  return { acts: flat.map((item) => ({ ...item, children: [] })), nested: false };
}

/** The act covering `timeMs`, and the child within it, for tooltips and hover. */
export function timelineAt(
  model: TimelineModel,
  timeMs: number,
): { act: TimelineItem | undefined; child: TimelineItem | undefined } {
  const act = model.acts.find((item) => timeMs >= item.startTime && timeMs < item.endTime)
    || model.acts[model.acts.length - 1];
  if (!act) {
    return { act: undefined, child: undefined };
  }
  const child = act.children.find((item) => timeMs >= item.startTime && timeMs < item.endTime)
    || act.children[act.children.length - 1];
  return { act, child };
}
