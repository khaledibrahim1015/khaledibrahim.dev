// @ts-check
import { defineConfig } from 'astro/config';
import sitemap from '@astrojs/sitemap';

export default defineConfig({
  site: 'https://khaledibrahim1015.github.io',
  // base: '/khaledibrahim.dev', // This is required because your repo is a project page
  integrations: [sitemap()],
  markdown: {
    shikiConfig: {
      theme: 'github-dark',
    },
  },
});