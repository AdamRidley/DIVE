# DIVE (Directed Interactive Video/Visualisation Experience)

DIVE is a framework for creating "Interruptible Narrative Visualizations." It bridges the gap between curated, author-driven data stories (like videos) and user-driven exploratory tools (like interactive dashboards).

## Core Concept
- **Watch Mode:** An automated narrative plays, panning, zooming, and highlighting data to tell a specific story.
- **Explore Mode:** Users can pause the narrative at any time to freely interact with and explore the underlying data using the native visualization tool's capabilities.
- **Resume Handoff:** Resuming playback instantly snaps the visualization back to the curated narrative path, continuing the story seamlessly.

## Architecture Overview
- **Library Agnostic:** Uses an Adapter Pattern to integrate with any interactive library (e.g., D3.js, Apache ECharts, Mapbox).
- **Web Component:** Delivered as a Custom Web Element (`<dive-video>`) for simple integration and encapsulation.
- **State Management:** A Sequencer and Virtual State Cache maintain perfect synchronization between the narrative timeline and the interactive chart.

For full technical details, see the [DIVE Framework Specification](DIVE-framework-spec.md).
