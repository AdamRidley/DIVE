# The Wealth and Health of Nations (DIVE Example)

This example implements a Rosling-style, D3-driven narrative in three phases:

1. Lifespan Lines (multi-line chart)
2. Rosling Bubbles (animated scatter plot)
3. Population Blocks (zoomable treemap)

## Run the example

1. Start the dev server:

```bash
npm run dev
```

2. Open:

- `http://localhost:5173/examples/the_wealth_and_health_of_nations/`

## Data source

Data is based on the official Gapminder DDF dataset:

- `open-numbers/ddf--gapminder--gapminder_world`

Raw files are stored in `examples/the_wealth_and_health_of_nations/data/raw`.

## Rebuild derived dataset

If you update raw CSVs, regenerate the JSON payload with:

```bash
node examples/the_wealth_and_health_of_nations/scripts/build-gapminder-data.mjs
```

Output file:

- `examples/the_wealth_and_health_of_nations/data/wealth-health-gapminder.json`
