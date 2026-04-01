# DIVE (Directed Interactive Video/Visualisation Experience)

DIVE is a framework for creating "Interruptible Narrative Visualizations (INV)." It bridges the gap between curated, author-driven data stories (like videos) and user-driven exploratory tools (like interactive dashboards).

## Core Concept

- **Watch Mode:** An automated narrative plays, panning, zooming, and highlighting data to tell a specific story.
- **Explore Mode:** Users can pause the narrative at any time to freely interact with and explore the underlying data using the native visualization tool's capabilities.
- **Resume Handoff:** Resuming playback instantly snaps the visualization back to the curated narrative path, continuing the story seamlessly.

## Architecture Overview

- **Library Agnostic:** Uses an Adapter Pattern to integrate with any interactive library (e.g., D3.js, Apache ECharts, Mapbox).
- **Web Component:** Delivered as a Custom Web Element (`<dive-video>`) for simple integration and encapsulation.
- **State Management:** A Sequencer and Virtual State Cache maintain perfect synchronization between the narrative timeline and the interactive chart.

For full technical details, see the [DIVE Framework Specification](DIVE-framework-spec.md).

## CI/CD

This repository now includes two GitHub Actions workflows:

- `.github/workflows/ci.yml`
- Runs on pull requests and pushes to `main`.
- Installs dependencies with `npm ci`.
- Runs `npm run test:ci` (typecheck + production build).
- Performs a Docker smoke build for `examples/the_wealth_and_health_of_nations/Dockerfile`.

- `.github/workflows/release.yml`
- Runs on tags matching `v*.*.*` and on manual dispatch.
- Builds and publishes release artifacts (`dist.tar.gz`, `dist-example.tar.gz`) to GitHub Releases.
- Builds and pushes the example Docker image.

### Release image registry settings

By default, the release workflow pushes to `ghcr.io`.

To push to a custom/private registry, configure these GitHub repository settings:

- Variables: `DOCKER_REGISTRY`, `DOCKER_IMAGE_REPO` (example: `dive-example` or `myorg/dive-example`)
- Secrets: `DOCKER_REGISTRY_USERNAME`, `DOCKER_REGISTRY_PASSWORD`

### Triggering a release

Create and push a semantic version tag:

```bash
git tag v1.0.0
git push origin v1.0.0
```
