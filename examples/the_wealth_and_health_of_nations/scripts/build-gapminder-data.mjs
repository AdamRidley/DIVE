import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { csvParse } from 'd3-dsv';

const __dirname = dirname(fileURLToPath(import.meta.url));
const rawDir = resolve(__dirname, '../data/raw');
const outDir = resolve(__dirname, '../data');
const outFile = resolve(outDir, 'wealth-health-gapminder.json');

const YEAR_START = 1800;
const YEAR_END = 2020;
const SCATTER_YEAR_START = 1950;

function round(value, digits) {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function loadCsv(fileName) {
  const fullPath = resolve(rawDir, fileName);
  const text = readFileSync(fullPath, 'utf8');
  return csvParse(text);
}

function buildMetricMap(rows, geoField, timeField, valueField) {
  const map = new Map();

  for (const row of rows) {
    const geo = (row[geoField] || '').trim();
    const year = Number(row[timeField]);
    const value = Number(row[valueField]);

    if (!geo || !Number.isFinite(year) || !Number.isFinite(value)) {
      continue;
    }

    if (!map.has(geo)) {
      map.set(geo, new Map());
    }

    map.get(geo).set(year, value);
  }

  return map;
}

function fillYears(metricByYear, years) {
  if (!metricByYear || metricByYear.size === 0) {
    return new Map();
  }

  const sortedYears = Array.from(metricByYear.keys()).sort((a, b) => a - b);
  const filled = new Map();

  let index = 0;
  let lastKnown;

  for (const year of years) {
    while (index < sortedYears.length && sortedYears[index] <= year) {
      lastKnown = metricByYear.get(sortedYears[index]);
      index += 1;
    }

    if (Number.isFinite(lastKnown)) {
      filled.set(year, Number(lastKnown));
    }
  }

  return filled;
}

function getPointByYear(values) {
  const map = new Map();
  for (const point of values) {
    map.set(point.year, point);
  }
  return map;
}

function main() {
  const years = [];
  for (let year = YEAR_START; year <= YEAR_END; year += 1) {
    years.push(year);
  }

  const lifeRows = loadCsv('ddf--datapoints--life_expectancy_at_birth_with_projections--by--geo--time.csv');
  const incomeRows = loadCsv('ddf--datapoints--income_per_person_long_series--by--geo--time.csv');
  const populationRows = loadCsv('ddf--datapoints--total_population_with_projections--by--geo--time.csv');
  const countryRows = loadCsv('ddf--entities--geo--country.csv');
  const regionRows = loadCsv('ddf--entities--geo--world_4region.csv');

  const lifeByGeo = buildMetricMap(lifeRows, 'geo', 'time', 'life_expectancy_at_birth_with_projections');
  const incomeByGeo = buildMetricMap(incomeRows, 'geo', 'time', 'income_per_person_long_series');
  const populationByGeo = buildMetricMap(populationRows, 'geo', 'time', 'total_population_with_projections');

  const regions = regionRows
    .filter((row) => row.geo)
    .map((row) => ({
      id: row.geo,
      name: row.name_short || row.name || row.geo,
      color: row.color || '#8b8b8b',
    }));

  const regionById = new Map(regions.map((region) => [region.id, region]));

  const countries = [];
  const seenCountries = new Set();

  for (const row of countryRows) {
    const id = (row.country || '').trim();
    const name = (row.name || '').trim();
    const regionId = (row.world_4region || '').trim();
    const isCountry = String(row['is--country'] || '').toUpperCase() === 'TRUE';

    if (!isCountry || !id || !name || !regionById.has(regionId)) {
      continue;
    }

    if (seenCountries.has(id)) {
      continue;
    }

    seenCountries.add(id);
    countries.push({
      id,
      name,
      regionId,
    });
  }

  countries.sort((a, b) => a.name.localeCompare(b.name));

  const regionAccumulator = new Map();
  for (const region of regions) {
    const perYear = new Map();
    for (const year of years) {
      perYear.set(year, {
        lifeWeightedSum: 0,
        populationSum: 0,
        countryCount: 0,
      });
    }
    regionAccumulator.set(region.id, perYear);
  }

  const countrySeries = [];

  for (const country of countries) {
    const lifeFilled = fillYears(lifeByGeo.get(country.id), years);
    const incomeFilled = fillYears(incomeByGeo.get(country.id), years);
    const populationFilled = fillYears(populationByGeo.get(country.id), years);

    const values = [];

    for (const year of years) {
      const lifeExp = lifeFilled.get(year);
      const income = incomeFilled.get(year);
      const population = populationFilled.get(year);

      if (!Number.isFinite(lifeExp) || !Number.isFinite(income) || !Number.isFinite(population)) {
        continue;
      }

      if (lifeExp <= 0 || income <= 0 || population <= 0) {
        continue;
      }

      const accumulator = regionAccumulator.get(country.regionId)?.get(year);
      if (accumulator) {
        accumulator.lifeWeightedSum += lifeExp * population;
        accumulator.populationSum += population;
        accumulator.countryCount += 1;
      }

      if (year >= SCATTER_YEAR_START) {
        values.push({
          year,
          lifeExp: round(lifeExp, 2),
          income: Math.round(income),
          population: Math.round(population),
        });
      }
    }

    if (values.length > 0) {
      countrySeries.push({
        id: country.id,
        name: country.name,
        regionId: country.regionId,
        values,
      });
    }
  }

  const regionLifeExpectancy = regions.map((region) => {
    const values = [];
    const yearly = regionAccumulator.get(region.id);

    for (const year of years) {
      const item = yearly?.get(year);
      if (!item || item.populationSum <= 0) {
        continue;
      }

      values.push({
        year,
        lifeExp: round(item.lifeWeightedSum / item.populationSum, 2),
        countryCount: item.countryCount,
      });
    }

    return {
      regionId: region.id,
      regionName: region.name,
      color: region.color,
      values,
    };
  });

  const countryByYear = new Map(countrySeries.map((country) => [country.id, getPointByYear(country.values)]));

  const treemapChildren = [];
  for (const region of regions) {
    const regionChildren = [];

    for (const country of countrySeries) {
      if (country.regionId !== region.id) {
        continue;
      }

      const point2020 = countryByYear.get(country.id)?.get(2020);
      if (!point2020 || point2020.population <= 0) {
        continue;
      }

      regionChildren.push({
        id: country.id,
        name: country.name,
        value: point2020.population,
      });
    }

    if (regionChildren.length === 0) {
      continue;
    }

    regionChildren.sort((a, b) => b.value - a.value);

    treemapChildren.push({
      id: region.id,
      name: region.name,
      color: region.color,
      children: regionChildren,
    });
  }

  const output = {
    meta: {
      title: 'The Wealth and Health of Nations',
      source: 'Gapminder (open-numbers/ddf--gapminder--gapminder_world)',
      generatedAt: new Date().toISOString(),
      yearRange: [YEAR_START, YEAR_END],
      scatterYearRange: [SCATTER_YEAR_START, YEAR_END],
      notes: [
        'Income uses income_per_person_long_series and is forward-filled to 2020 where needed.',
        'Life expectancy uses life_expectancy_at_birth_with_projections.',
        'Population uses total_population_with_projections.',
      ],
    },
    regions,
    focusCountries: ['chn', 'ind'],
    regionLifeExpectancy,
    countrySeries,
    treemap2020: {
      name: 'World',
      children: treemapChildren,
    },
  };

  mkdirSync(outDir, { recursive: true });
  writeFileSync(outFile, JSON.stringify(output));

  console.log(`Generated ${outFile}`);
  console.log(`Regions: ${regions.length}`);
  console.log(`Countries with series: ${countrySeries.length}`);
}

main();
