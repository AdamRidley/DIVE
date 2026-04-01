# Build and run Docker image for this example

Build and run the self-contained example image. Build from the **repo root** so the build context
includes the top-level `package.json`:

```bash
# from repository root
docker build -f examples/the_wealth_and_health_of_nations/Dockerfile -t dive-example .
docker run -p 8080:80 --rm dive-example
```

Open http://localhost:8080 to view the example and tools.
