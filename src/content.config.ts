import { defineCollection, z } from 'astro:content';
import { glob } from 'astro/loaders';

const projects = defineCollection({
    loader: glob({ pattern: '**/*.md', base: './src/content/projects' }),
    schema: z.object({
        title: z.string(),
        description: z.string(),
        date: z.coerce.date(),
        tech: z.array(z.string()),
        tags: z.array(z.string()),
        featured: z.boolean().default(false),
        draft: z.boolean().default(false),
    }),
});

const articles = defineCollection({
    loader: glob({ pattern: '**/*.md', base: './src/content/articles' }),
    schema: z.object({
        title: z.string(),
        description: z.string(),
        date: z.coerce.date(),
        tags: z.array(z.string()),
        draft: z.boolean().default(false),
    }),
});

export const collections = { projects, articles };
