import rss from '@astrojs/rss';
import { getCollection } from 'astro:content';
import type { APIContext } from 'astro';

export async function GET(context: APIContext) {
    const articles = await getCollection('articles', ({ data }) => !data.draft);
    const sorted = articles.sort(
        (a, b) => b.data.date.getTime() - a.data.date.getTime()
    );

    return rss({
        title: 'Khaled Ibrahim — Articles',
        description:
            'Technical articles on distributed systems, backend engineering, and infrastructure.',
        site: context.site!.toString(),
        items: sorted.map((article) => ({
            title: article.data.title,
            description: article.data.description,
            pubDate: article.data.date,
            link: `/articles/${article.id}/`,
        })),
        customData: '<language>en-us</language>',
    });
}
