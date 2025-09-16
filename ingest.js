// ingest.js
const { config } = require('dotenv');
const { QdrantClient } = require('@qdrant/js-client-rest');
const axios = require('axios');
const cheerio = require('cheerio');
const puppeteer = require('puppeteer');

config(); // This loads the environment variables from your .env file

const client = new QdrantClient({ url: process.env.QDRANT_URL, apiKey: process.env.QDRANT_API_KEY });
const collectionName = process.env.QDRANT_COLLECTION_NAME;

let browser;

async function initializePuppeteer() {
  browser = await puppeteer.launch({ headless: true });
}

async function closePuppeteer() {
  if (browser) {
    await browser.close();
  }
}

async function fetchXmlUrls(sitemapUrl) {
  try {
    const response = await axios.get(sitemapUrl);
    const $ = cheerio.load(response.data, { xmlMode: true });
    const urls = [];
    $('loc').each((i, element) => {
      const url = $(element).text();
      if (url.startsWith('https://www.theguardian.com/') && !url.includes('.xml')) {
        urls.push(url);
      }
    });
    console.log(`Found ${urls.length} article URLs in this sitemap.`);
    return urls;
  } catch (error) {
    console.error(`Error fetching sitemap from ${sitemapUrl}:`, error.message);
    return [];
  }
}

async function fetchArticleContent(url) {
  let page;
  try {
    page = await browser.newPage();
    await page.goto(url, { waitUntil: 'networkidle0', timeout: 60000 });

    const content = await page.evaluate(() => {
      const title = document.querySelector('h1')?.innerText.trim() || '';
      const bodyText = Array.from(document.querySelectorAll('div[itemprop="articleBody"] p, .dcr-article-body p, .article-body-commercial-selector p, .dcr-body p'))
        .map(el => el.innerText)
        .join('\n\n');
      return { title, bodyText };
    });

    await page.close();

    const fullText = `${content.title}\n\n${content.bodyText}`.trim();

    return fullText.length > 200 ? fullText : null;
  } catch (error) {
    console.error(`Error fetching article content from ${url}:`, error.message);
    if (page) {
      await page.close();
    }
    return null;
  }
}

async function upsertPoints(pointsToUpload) {
    if (pointsToUpload.length === 0) {
        console.log('No points to upload for this article.');
        return;
    }

    await client.upsert(collectionName, { wait: true, points: pointsToUpload });
    console.log(`Successfully uploaded ${pointsToUpload.length} points to Qdrant.`);
}

function chunkText(text, maxChars = 500) {
    const sentences = text.split(/(?<=[.?!])\s+/);
    const chunks = [];
    let currentChunk = '';

    for (const sentence of sentences) {
        if (currentChunk.length + sentence.length <= maxChars) {
            currentChunk += (currentChunk.length > 0 ? ' ' : '') + sentence;
        } else {
            if (currentChunk.length > 0) {
                chunks.push(currentChunk);
            }
            currentChunk = sentence;
        }
    }
    if (currentChunk.length > 0) {
        chunks.push(currentChunk);
    }
    return chunks;
}

async function getJinaEmbeddings(texts) {
    if (!texts || texts.length === 0) return [];
    try {
        const response = await axios.post('https://api.jina.ai/v1/embeddings', {
            input: texts,
            model: 'jina-embeddings-v2-base-en'
        }, {
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${process.env.JINA_API_KEY}`,
            },
        });
        return response.data.data.map(item => item.embedding);
    } catch (error) {
        console.error('Failed to get embeddings from Jina:', error.response?.data?.detail || error.message);
        return [];
    }
}

async function main() {
    try {
        await client.deleteCollection(collectionName);
        console.log(`Collection "${collectionName}" deleted.`);
    } catch (error) {
        // This will handle the case where the collection doesn't exist on the first run
        console.log(`Collection "${collectionName}" not found. Proceeding with creation.`);
    }

    // Create the new collection before ingesting data
    await client.createCollection(collectionName, {
        vectors: {
            size: 768, // Jina Embeddings v2 base model size
            distance: 'Cosine',
        },
    });
    console.log(`Collection "${collectionName}" created.`);

    await initializePuppeteer();
    console.log(`Initialized Puppeteer.`);

    const sitemapUrls = [
        'https://www.theguardian.com/sitemaps/news.xml',
        'https://www.theguardian.com/sitemaps/sport.xml',
        'https://www.theguardian.com/sitemaps/business.xml',
    ];

    const MAX_ARTICLES = 50;
    let articlesProcessed = 0;

    for (const sitemapUrl of sitemapUrls) {
        if (articlesProcessed >= MAX_ARTICLES) break;

        console.log(`\nFetching sitemap from: ${sitemapUrl}`);
        const urls = await fetchXmlUrls(sitemapUrl);
        
        for (const url of urls) {
            if (articlesProcessed >= MAX_ARTICLES) break;

            const content = await fetchArticleContent(url);

            if (content) {
                // Step 1: Chunk the article content
                const chunks = chunkText(content);
                
                // Step 2: Get embeddings for all chunks in a single API call
                const embeddings = await getJinaEmbeddings(chunks);
                
                if (embeddings.length === chunks.length) {
                    const pointsToUpload = chunks.map((chunk, i) => ({
                        id: Math.floor(Math.random() * 1000000), // Unique ID for each chunk
                        payload: {
                            url: url,
                            text: chunk,
                        },
                        vector: embeddings[i],
                    }));

                    // Step 3: Upload all points for this article
                    await upsertPoints(pointsToUpload);
                    articlesProcessed++;
                }
            }
        }
    }

    console.log(`\nTotal articles processed: ${articlesProcessed}.`);
    await closePuppeteer();
}

main().catch(error => {
    console.error("An error occurred:", error);
    closePuppeteer();
});