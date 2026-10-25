import { defineConfig } from 'astro/config';
import react from '@astrojs/react';
import caloriesPwa from './scripts/calories-pwa.mjs';

// GitHub Pages serves this project repository at https://xingkai03.github.io/calories/.
export default defineConfig({
  site: 'https://xingkai03.github.io',
  base: '/calories',
  trailingSlash: 'ignore',
  integrations: [react(), caloriesPwa()],
});
