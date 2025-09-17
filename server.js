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

app.listen(port, () => {
    console.log(`Server is running on port ${port}`);
});

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
connectToRedis();

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

app.post('/chat/clear', async (req, res) => {
    const sessionId = req.body.sessionId;

    if (!sessionId) {
        return res.status(400).json({ error: 'Session ID is required.' });
    }

    try {
        await redisClient.del(`session:${sessionId}`);
        res.status(200).json({ message: 'Chat history cleared successfully.' });
    } catch (error) {
        console.error('Error clearing chat history:', error);
        res.status(500).json({ error: 'Failed to clear chat history.' });
    }
});

app.post('/chat', async (req, res) => {
    const { query, sessionId } = req.body;

    if (!query) {
        return res.status(400).json({ error: 'Query is required.' });
    }

    const currentSessionId = sessionId || crypto.randomBytes(16).toString('hex');

    try {
        // Step 1: Get query embedding
        const queryEmbeddings = await getJinaEmbeddings([query]);
        const queryVector = queryEmbeddings[0];

        // Step 2: Perform a vector search in Qdrant
        const searchResults = await qdrantClient.search(qdrantCollection, {
            vector: queryVector,
            limit: 3,
            with_payload: true,
        });

        const retrievedText = searchResults.map(result => result.payload.text).join('\n\n');

        // Step 3: Construct the RAG prompt for Gemini
        const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });
        const prompt = `Based on the following news articles, answer the user's question.
        
        News Articles:
        ${retrievedText}
        
        User's Question:
        ${query}`;

        const result = await model.generateContent(prompt);
        const responseText = await result.response.text();

        // Step 4: Store history in Redis with TTL
        const chatHistory = { user: query, bot: responseText };
        await redisClient.rPush(`session:${currentSessionId}`, JSON.stringify(chatHistory));
        await redisClient.expire(`session:${currentSessionId}`, 3600); // 1-hour TTL

        res.status(200).json({ response: responseText, sessionId: currentSessionId });
    } catch (error) {
        console.error('Error in chat endpoint:', error.message);
        res.status(500).json({ error: 'Failed to generate a response.' });
    }
});

// Add this new route below your Express app initialization
app.get('/', async (req, res) => {
    res.json({
        message: "Welcome to the RAG News Chatbot API! This service is running and ready to handle requests.",
        endpoints: {
            chat: "POST /chat",
            history: "GET /chat/history",
            clear: "POST /chat/clear"
        }
    });
});

app.listen(port, () => {
    console.log(`Server is running on http://localhost:${port}`);
});