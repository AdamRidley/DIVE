export interface IAdapter {
  /**
   * Mount the visualization onto the provided DOM element.
   * Takes the initial data and configuration.
   */
  mount(container: HTMLElement, data: any): void;

  /**
   * Update the visualization state based on the virtual state 
   * derived from the Sequencer.
   */
  setState(state: any, timeMs?: number): void;

  /**
   * Unmount and clean up memory/events.
   */
  unmount(): void;

  /**
   * Optional: Hook for when the user takes over.
   */
  onInteract?(callback: () => void): void;
}