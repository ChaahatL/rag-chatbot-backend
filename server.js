const express = require('express');
const { createClient } = require('redis');
const { QdrantClient } = require('@qdrant/js-client-rest');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const axios = require('axios');
const crypto = require('crypto');
const cors = require('cors');
require('dotenv').config();

const app = express();
const port = process.env.PORT || 3000;

// Middleware
app.use(express.json());
app.use(cors());

// Clients for Redis, Qdrant, and Gemini
const redisClient = createClient({
    url: process.env.REDIS_URL,
    password: process.env.REDIS_PASSWORD
});

const qdrantClient = new QdrantClient({ url: process.env.QDRANT_URL, apiKey: process.env.QDRANT_API_KEY });
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const qdrantCollection = process.env.QDRANT_COLLECTION_NAME;

// Helper function to get Jina Embeddings
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

// Connect to Redis
async function connectToRedis() {
    try {
        await redisClient.connect();
        console.log('Connected to Redis.');
    } catch (err) {
        console.error('Failed to connect to Redis:', err);
    }
}

// --- API Endpoints ---
app.get('/chat/history', async (req, res) => {
    const sessionId = req.query.sessionId;

    if (!sessionId) {
        return res.status(400).json({ error: 'Session ID is required.' });
    }

    try {
        const history = await redisClient.lRange(`session:${sessionId}`, 0, -1);
        const parsedHistory = history.map(item => JSON.parse(item));
        res.status(200).json({ history: parsedHistory });
    } catch (error) {
        console.error('Error fetching chat history:', error);
        res.status(500).json({ error: 'Failed to retrieve chat history.' });
    }
});

// Endpoint to delete a specific session
app.delete('/chat/session/:sessionId', async (req, res) => {
    const sessionId = req.params.sessionId;

    if (!sessionId) {
        return res.status(400).json({ error: 'Session ID is required.' });
    }

    try {
        await redisClient.del(`session:${sessionId}`);
        res.status(200).json({ message: `Session ${sessionId} deleted successfully.` });
    } catch (error) {
        console.error('Error deleting session:', error);
        res.status(500).json({ error: 'Failed to delete session.' });
    }
});

// A robust /chat endpoint
app.post('/chat', async (req, res) => {
    const { query, sessionId } = req.body;

    if (!query) {
        return res.status(400).json({ error: 'Query is required.' });
    }

    const currentSessionId = sessionId || crypto.randomBytes(16).toString('hex');

    res.setHeader('Content-Type', 'text/plain');
    res.setHeader('Transfer-Encoding', 'chunked');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('Cache-Control', 'no-cache');

    try {
        // Step 1: Get query embeddings
        const queryEmbeddings = await getJinaEmbeddings([query]);
        if (!queryEmbeddings || queryEmbeddings.length === 0) {
            res.status(500).end('Failed to get Jina embeddings. Please check your API key and network connection.');
            return;
        }
        const queryVector = queryEmbeddings[0];

        // Step 2: Perform a vector search in Qdrant
        const searchResults = await qdrantClient.search(qdrantCollection, {
            vector: queryVector,
            limit: 3,
            with_payload: true,
        });

        // Step 3: Handle empty search results gracefully
        const retrievedText = searchResults && searchResults.length > 0
            ? searchResults.map(result => result.payload.text).join('\n\n')
            : "No relevant news articles were found in the database. Please try a different query.";

        // Step 4: Construct the RAG prompt for Gemini
        const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });
        const prompt = `Based on the following news articles, answer the user's question.

        News Articles:
        ${retrievedText}

        User's Question:
        ${query}`;

        // CORRECT: Use generateContentStream for streaming
        const result = await model.generateContentStream({
            contents: [{ role: 'user', parts: [{ text: prompt }] }]
        });

        let fullBotResponse = '';

        // Process the stream and send chunks to the frontend
        for await (const chunk of result.stream) {
            const textChunk = chunk.text();
            res.write(textChunk);
            fullBotResponse += textChunk;
        }

        // Step 6: Save the full messages to Redis after the stream is complete
        await redisClient.rPush(`session:${currentSessionId}`, JSON.stringify({ user: query }));
        await redisClient.rPush(`session:${currentSessionId}`, JSON.stringify({ bot: fullBotResponse }));
        await redisClient.expire(`session:${currentSessionId}`, 3600);

        res.end();
    } catch (error) {
        console.error('Error in chat endpoint:', error.message);
        res.status(500).end('Failed to generate a response. Please check your API keys and configuration.');
    }
});

app.get('/', async (req, res) => {
    res.json({
        message: "Welcome to the RAG News Chatbot API! This service is running and ready to handle requests.",
        endpoints: {
            chat: "POST /chat",
            history: "GET /chat/history",
            clear_session: "DELETE /chat/session/:sessionId"
        }
    });
});

async function startServer() {
    await connectToRedis();
    app.listen(port, () => {
        console.log(`Server is running on http://localhost:${port}`);
    });
}

startServer();