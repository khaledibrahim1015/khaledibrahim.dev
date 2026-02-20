# khaledibrahim.dev

Minimal portfolio site built with Astro + Markdown. Engineering-documentation aesthetic.

## Quick Start

```bash
npm install
npm run dev          # http://localhost:4321
npm run build        # static output in dist/
npm run preview      # preview production build
```

## Project Structure

```
src/
├── components/       # Astro components (ProjectCard, TagFilter, etc.)
├── content/
│   ├── projects/     # Project markdown files
│   └── articles/     # Article markdown files
├── data/
│   └── skills.json   # Skills grouped by category
├── layouts/
│   └── BaseLayout.astro
├── pages/            # File-based routing
├── styles/
│   └── global.css    # Design system + theming
└── content.config.ts # Content collection schemas
```

## Adding Content

### New Project

Create `src/content/projects/my-project.md`:

```yaml
---
title: "My Project"
description: "What it does."
date: 2025-12-01
tech: ["C#", ".NET 8", "Redis"]
tags: ["caching", "performance"]
featured: false
draft: false
---

Write your project documentation here using Markdown.
```

### New Article

Create `src/content/articles/my-article.md`:

```yaml
---
title: "My Article"
description: "What it covers."
date: 2025-12-01
tags: ["distributed-systems"]
draft: false
---

Write your article content here.
```

### New Skill

Edit `src/data/skills.json`. Add items to an existing category or create a new one:

```json
{
  "New Category": ["Skill A", "Skill B"]
}
```

The skills page renders dynamically — no code changes needed.

### Hiding Drafts

Set `draft: true` in any markdown frontmatter. The content won't appear in listings, detail pages, or the RSS feed.

## Deployment

### Vercel

1. Push repo to GitHub
2. Go to [vercel.com/new](https://vercel.com/new)
3. Import the repository
4. Framework: **Astro** (auto-detected)
5. Click **Deploy**

Vercel auto-detects Astro and uses `npm run build` with output in `dist/`.

### GitHub Pages

1. In `astro.config.mjs`, set `site` to your GitHub Pages URL
2. Add `.github/workflows/deploy.yml`:

```yaml
name: Deploy to GitHub Pages
on:
  push:
    branches: [main]
permissions:
  contents: read
  pages: write
  id-token: write
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 20
      - run: npm ci
      - run: npm run build
      - uses: actions/upload-pages-artifact@v3
        with:
          path: dist
  deploy:
    needs: build
    runs-on: ubuntu-latest
    environment:
      name: github-pages
      url: ${{ steps.deployment.outputs.page_url }}
    steps:
      - id: deployment
        uses: actions/deploy-pages@v4
```

### Custom Domain

**Vercel**: Settings → Domains → Add your domain → Update DNS records as shown.

**GitHub Pages**: Add a `CNAME` file in `public/` containing your domain. Update DNS to point to GitHub.

## Tech Stack

- **Astro** — Static site generation
- **Markdown** — Content authoring
- **Vanilla CSS** — Custom properties + dark mode
- **Vanilla JS** — Theme toggle + tag filtering (~40 lines total)
- **@astrojs/sitemap** — Auto-generated sitemap
- **@astrojs/rss** — RSS feed for articles

Zero UI frameworks. Zero CSS frameworks. Minimal JavaScript.
