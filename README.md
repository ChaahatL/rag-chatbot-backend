# RAG-Powered News Chatbot Backend 🚀

### Overview

This is the backend for a full-stack chatbot that provides answers to user queries by leveraging a Retrieval-Augmented Generation (RAG) pipeline over a corpus of news articles. The application ingests articles from an RSS feed, converts them into vector embeddings, and stores them in a vector database. It uses a RESTful API to handle user queries, retrieve relevant information, and generate final answers using the Gemini API.

### Features

  * **RESTful API:** Provides endpoints for chat, fetching session history, and clearing sessions.
  * **Retrieval-Augmented Generation (RAG):** Answers user questions by retrieving relevant passages from a news corpus before generating a final response.
  * **Vector Search:** Utilizes Jina Embeddings and Qdrant to perform semantic searches for relevant articles.
  * **Session Management:** Implements per-session chat history caching using Redis for a seamless user experience.
  * **Containerized Deployment:** Packaged with Docker for consistent and portable deployment.

-----

### Technology Stack

  * **Node.js & Express:** Serves as the robust and scalable foundation for the REST API.
  * **Jina Embeddings:** Used to generate high-quality vector embeddings of news articles and user queries.
  * **Qdrant:** A dedicated vector database for efficient storage and retrieval of billions of vectors.
  * **Google Gemini API:** A powerful large language model used to generate natural language responses.
  * **Redis:** An in-memory data store used for fast, ephemeral caching of per-session chat history.

-----

### System Design & Architecture

The system is designed as a decoupled, full-stack application. The backend serves as the core of the RAG pipeline, with the following architecture:

1.  **News Ingestion:** A script scrapes news articles, chunks the text, and generates vector embeddings using Jina Embeddings.
2.  **Vector Storage:** The embeddings are stored in a Qdrant collection, which acts as the knowledge base.
3.  **Chat API:** When a user submits a query to the `/chat` endpoint:
    a.  The query is converted into a vector embedding using Jina.
    b.  The system performs a semantic search in Qdrant to retrieve the top `k` most relevant text chunks.
    c.  These chunks are combined with the user's query into a prompt for the Google Gemini API.
    d.  The final, generated answer is sent back to the user.
4.  **Caching:** Each user has a unique session ID. The chat history for each session is cached in Redis, improving performance and managing conversational context without relying on a full database.

-----

### Getting Started

#### Prerequisites

  * Node.js (v18 or higher)
  * Docker (for running Qdrant and Redis)
  * API keys for Jina Embeddings and Google AI Studio

#### Local Setup

1.  Clone this repository: `git clone [repository URL]`
2.  Navigate to the backend directory: `cd rag-chatbot-backend`
3.  Install dependencies: `npm install`
4.  Set up your environment variables by creating a `.env` file from the provided `.env.example`.
    ```bash
    # .env example
    GEMINI_API_KEY="your_gemini_key"
    JINA_API_KEY="your_jina_key"
    QDRANT_URL="your_qdrant_url"
    QDRANT_API_KEY="your_qdrant_key"
    QDRANT_COLLECTION_NAME="your_collection_name"
    REDIS_URL="your_redis_url"
    REDIS_PASSWORD="your_redis_password"
    SESSION_SECRET="a_long_random_string"
    PORT=3000
    ```
5.  Run your Docker containers for Redis and Qdrant.
6.  Run the ingestion script to populate your vector database: `node ingest.js`
7.  Start the backend server: `node server.js`

### Deployment

This application is designed for containerized deployment. The included `Dockerfile` can be used to build and deploy the backend to a cloud hosting service like **Render.com**. It's recommended to deploy the backend as a separate service from the frontend for optimal scalability and maintenance.

### Caching & Performance
To optimize performance and manage session history efficiently, this application uses Redis as an in-memory database. Each user session is stored with a unique session ID.

### TTL (Time-to-Live)
In a production environment, session data should not persist indefinitely. A Time-to-Live (TTL) would be set on each Redis key to automatically expire and delete old chat sessions after a period of inactivity. For example, a TTL of 3600 seconds (1 hour) could be configured on each session key to clear memory and improve performance. This would be implemented in the backend code where a new session is created or updated.

### Cache Warming
Since the primary data source is a news corpus, a cache-warming strategy could be implemented to pre-populate the vector store cache with the most frequently accessed or recent news articles. This would involve a background job that periodically queries the most popular news and stores their embeddings in a dedicated Redis cache. This reduces latency by ensuring that the most relevant information is readily available for the RAG pipeline, especially during peak usage times.

### License

This project is licensed under the MIT License.
