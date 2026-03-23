// Interfaces for the D.I.V.E. Story script

export interface Story {
  title: string;
  duration: number; // total duration in milliseconds
  scenes: Scene[];
}

export interface Scene {
  id: string;
  tool: string; // Which adapter to load from the tool registry
  startTime: number; // in milliseconds
  endTime: number;
  data: string; // url to the dataset or inline data
  keyframes: Keyframe[];
  overlays: Overlay[];
}

export interface Keyframe {
  time: number; // milliseconds from START OF SCENE
  state: any;   // Visual state (e.g. { zoom: 2, center: [x,y], filter: "EU" })
  duration?: number; // How long to morph to this state
}

export interface Overlay {
  time: number; 
  duration: number;
  type: "text" | "image";
  content: string; // The HTML or URL
  position: "top" | "bottom" | "center" | "left" | "right";
}

export interface NarrativeState {
  time: number;
  scene?: Scene;
  visualState: any; // The interpolated/active state for the visual
  activeOverlays: Overlay[];
}

