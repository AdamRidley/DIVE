// Interfaces for the D.I.V.E. Story script

export interface Story {
  title: string;
  duration: number; // total duration in milliseconds
  scenes: Scene[];
  timelineSections?: TimelineSection[];
}

export interface TimelineSection {
  id?: string;
  startTime: number;
  endTime: number;
  label: string;
  description?: string;
  color?: string;
}

export interface Scene {
  id: string;
  tool: string; // Which adapter to load from the tool registry
  startTime: number; // in milliseconds
  endTime: number;
  data?: string | object; // optional URL or inline data to provide to the tool
  sendData?: boolean; // if false, DIVE mounts the tool without sending scene.data
  pauseOnInteract?: boolean; // If true, tool interaction pauses playback for this scene
  keyframes: Keyframe[];
  overlays: Overlay[];
}

export interface Keyframe {
  time: number; // milliseconds from START OF SCENE
  state: any;   // Visual state (e.g. { zoom: 2, center: [x,y], filter: "EU" })
  duration?: number; // How long to morph to this state
}

export type OverlayCanonicalAnchor =
  | "topLeft"
  | "topCenter"
  | "topRight"
  | "centerLeft"
  | "center"
  | "centerRight"
  | "bottomLeft"
  | "bottomCenter"
  | "bottomRight";

// Convenience aliases for common anchor intent.
export type OverlayAnchorAlias = "top" | "bottom" | "left" | "right";

export type OverlayAnchor = OverlayCanonicalAnchor | OverlayAnchorAlias;

export type OverlayPlacementUnit = "px" | "%";

export type OverlayLength = number | string;

export interface OverlayAnchorPlacement {
  mode?: "anchor";
  anchor: OverlayAnchor;
  // CSS-like shorthand: one value applies to both axes, two values split into x then y.
  // Examples: 10, "10px", "5%", "10px 15px", "2% 4%"
  offset?: OverlayLength;
  // Optional default unit for shorthand/numeric offsets when no unit is embedded.
  offsetUnit?: OverlayPlacementUnit;
  // Axis-specific offsets override shorthand when both are provided.
  offsetX?: OverlayLength;
  offsetY?: OverlayLength;
  offsetXUnit?: OverlayPlacementUnit;
  offsetYUnit?: OverlayPlacementUnit;
}

export interface OverlayAbsolutePlacement {
  mode: "absolute";
  x: number;
  y: number;
  xUnit?: OverlayPlacementUnit;
  yUnit?: OverlayPlacementUnit;
}

export type OverlayPlacement = OverlayAnchorPlacement | OverlayAbsolutePlacement;

export interface Overlay {
  time: number; 
  duration: number;
  type: "text" | "image";
  content: string; // The HTML or URL
  placement: OverlayPlacement;
  hideWhenPaused?: boolean;
}

export interface NarrativeState {
  time: number;
  scene?: Scene;
  visualState: any; // The interpolated/active state for the visual
  activeOverlays: Overlay[];
}

