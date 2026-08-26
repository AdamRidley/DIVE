(function (global) {
  const COPY = {
    en: {
      langEnglish: 'English',
      langWelsh: 'Cymraeg',
      langLegend: 'Language',
      lifespanTitle: 'Lifespan Lines: Life Expectancy by Continent',
      lifespanSubtitle: 'Population-weighted averages from Gapminder data',
      lifespanY: 'Life expectancy (years)',
      lifespanX: 'Year',
      lifespanAnnotation: '1918 pandemic + global conflict era',
      bubblesTitle: 'Rosling Bubbles: Health vs Wealth',
      bubblesSubtitle: 'Income per person (log scale), life expectancy, and population by country',
      bubblesX: 'Income per person (PPP, inflation-adjusted)',
      bubblesY: 'Life expectancy (years)',
      bubblesYear: 'Explore Year',
      blocksTitle: 'Population Blocks: The Modern Distribution',
      blocksSubtitle: 'Treemap of world population around 2020. Click a continent to zoom in.',
      blocksBack: 'Back to World',
      blocksPopulation: 'Population',
    },
    cy: {
      langEnglish: 'English',
      langWelsh: 'Cymraeg',
      langLegend: 'Iaith',
      lifespanTitle: 'Llinellau Oes: Disgwyliad Oes yn ôl Cyfandir',
      lifespanSubtitle: 'Cyfartaleddau wedi’u pwysoli yn ôl poblogaeth o ddata Gapminder',
      lifespanY: 'Disgwyliad oes (blynyddoedd)',
      lifespanX: 'Blwyddyn',
      lifespanAnnotation: 'Pandemig 1918 + cyfnod gwrthdaro byd-eang',
      bubblesTitle: 'Swigod Rosling: Iechyd vs Cyfoeth',
      bubblesSubtitle: 'Incwm y pen (graddfa log), disgwyliad oes, a phoblogaeth yn ôl gwlad',
      bubblesX: 'Incwm y pen (PPP, wedi’i addasu am chwyddiant)',
      bubblesY: 'Disgwyliad oes (blynyddoedd)',
      bubblesYear: 'Archwilio blwyddyn',
      blocksTitle: 'Blociau Poblogaeth: Y Dosbarthiad Modern',
      blocksSubtitle: 'Map coeden o boblogaeth y byd tua 2020. Cliciwch gyfandir i chwyddo i mewn.',
      blocksBack: 'Yn ôl i’r Byd',
      blocksPopulation: 'Poblogaeth',
    },
  };

  let lang = 'en';

  function t(key) {
    return (COPY[lang] && COPY[lang][key]) || COPY.en[key] || key;
  }

  function setLang(next) {
    const resolved = COPY[next] ? next : 'en';
    lang = resolved;
    document.documentElement.lang = resolved;
    global.dispatchEvent(new CustomEvent('dive-lang', { detail: { lang: resolved } }));
  }

  function postLang(next) {
    if (window.parent && window.parent !== window) {
      window.parent.postMessage({ type: 'DIVE_LANG', lang: next }, '*');
    }
    setLang(next);
  }

  window.addEventListener('message', (event) => {
    const data = event.data || {};
    if ((data.type === 'DIVE_INIT' || data.type === 'DIVE_LANG') && typeof data.lang === 'string') {
      setLang(data.lang);
    }
  });

  global.diveT = t;
  global.diveSetLang = setLang;
  global.divePostLang = postLang;
  global.diveGetLang = () => lang;
})(window);
