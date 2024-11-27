// server.js

require('dotenv').config();
const express = require('express');
const multer = require('multer');
const Ajv = require('ajv');
const harSchema = require('har-schema');
const OpenAI = require('openai');
const cors = require('cors');
const { Worker, Queue } = require('bullmq');
const Redis = require('ioredis');
const { Pool } = require('pg');
const { v4: uuidv4 } = require('uuid');
const analyzeHAR = require('./utils/harAnalyzer');
const { cleanupExpiredInsights } = require('./utils/cleanup');

// Initialize Express App
const app = express();
const corsOrigins = process.env.CORS_ORIGINS?.split(',') || [
  'https://har-analyzer-frontend.onrender.com',
  'http://localhost:3000'
];

app.use(cors({
  origin: corsOrigins,
  methods: ['GET', 'POST'],
  allowedHeaders: ['Content-Type']
}));
app.use(express.json());

// Define Redis connection options
const redisOptions = {
  maxRetriesPerRequest: null,
  enableReadyCheck: false
};

// Set up Redis Connection for BullMQ
const connection = new Redis(process.env.REDIS_URL, redisOptions);

// Set up PostgreSQL Connection
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

// Test Database Connection
pool.connect((err) => {
  if (err) {
    console.error('Database connection error', err.stack);
  } else {
    console.log('Database connected');
  }
});

// Initialize Database Tables
pool.query(
  `CREATE TABLE IF NOT EXISTS insights (
    id SERIAL PRIMARY KEY,
    job_id VARCHAR(255) UNIQUE NOT NULL,
    persona VARCHAR(50) NOT NULL,
    insights TEXT NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  )`,
  (err) => {
    if (err) {
      console.error('Error creating table', err.stack);
    } else {
      console.log('Table "insights" is ready');
    }
  }
);

// Set up OpenAI Configuration
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

// Add a debug log (temporary)
console.log('OpenAI API Key exists:', !!process.env.OPENAI_API_KEY);
console.log('OpenAI API Key length:', process.env.OPENAI_API_KEY?.length);

// Initialize Queue
const harQueue = new Queue('harQueue', { 
  connection: new Redis(process.env.REDIS_URL, redisOptions)
});

// Set up Storage for Multer
const storage = multer.memoryStorage();
const upload = multer({ storage });

// Initialize AJV for HAR validation
const ajv = new Ajv();

// API Endpoints
app.post('/analyze', upload.single('harFile'), async (req, res) => {
  try {
    // Debug logging
    console.log('Received file:', req.file ? 'yes' : 'no');
    console.log('File size:', req.file?.size);
    console.log('Persona:', req.body.persona);

    // Validate File
    if (!req.file) {
      return res.status(400).json({ error: 'No file uploaded' });
    }

    // Parse HAR Content
    let harContent;
    try {
      harContent = JSON.parse(req.file.buffer.toString());
      console.log('Successfully parsed HAR content');
    } catch (parseError) {
      console.error('Parse error:', parseError);
      return res.status(400).json({ error: 'Invalid JSON in HAR file' });
    }

    // Validate Redis connection
    if (!connection.status === 'ready') {
      console.error('Redis not connected');
      return res.status(500).json({ error: 'Queue service unavailable' });
    }

    // Add Job to Queue
    try {
      const job = await harQueue.add('processHar', {
        harContent,
        persona: req.body.persona || 'developer',
      });
      console.log('Job added to queue:', job.id);
      res.json({ jobId: job.id });
    } catch (queueError) {
      console.error('Queue error:', queueError);
      res.status(500).json({ error: 'Failed to queue analysis job' });
    }

  } catch (error) {
    console.error('Endpoint error:', error);
    res.status(500).json({ 
      error: 'Failed to process file',
      details: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
});

app.get('/results/:jobId', async (req, res) => {
  try {
    const { jobId } = req.params;
    const job = await harQueue.getJob(jobId);

    if (job === null) {
      return res.status(404).json({ error: 'Job not found' });
    }

    if (job.finishedOn) {
      const result = await pool.query(
        'SELECT * FROM insights WHERE job_id = $1',
        [jobId]
      );
      res.json(result.rows[0]);
    } else {
      res.json({ status: 'Processing' });
    }
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Failed to retrieve results' });
  }
});

// Temporary test endpoint
app.get('/test-openai', async (req, res) => {
  try {
    const response = await openai.chat.completions.create({
      model: 'gpt-3.5-turbo',
      messages: [{ role: 'user', content: 'Say hello' }],
      max_tokens: 10
    });
    res.json({ success: true, response: response.choices[0].message });
  } catch (error) {
    res.json({ 
      success: false, 
      error: error.message,
      code: error.code,
      type: error.type
    });
  }
});

// Start Server
const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`Backend server running on port ${PORT}`);
});

// Worker to Process HAR Files
const worker = new Worker('harQueue', async job => {
  try {
    const metrics = analyzeHAR(job.data.harContent);
    let insights = null;
    let error = null;

    try {
      insights = await generateInsights(metrics, job.data.persona);
    } catch (aiError) {
      console.error('AI Insights generation failed:', aiError);
      error = aiError.message;
    }

    // Store results even if AI insights failed
    await pool.query(
      'INSERT INTO insights (job_id, persona, insights) VALUES ($1, $2, $3)',
      [job.id, job.data.persona, JSON.stringify({ 
        metrics, 
        insights,
        error 
      })]
    );
    
    return { jobId: job.id };
  } catch (error) {
    console.error('Analysis failed:', error);
    throw error;
  }
}, {
  connection: new Redis(process.env.REDIS_URL, redisOptions)
});

worker.on('failed', (job, err) => {
  console.error(`Job ${job.id} failed:`, err);
});

worker.on('completed', (job) => {
  console.log(`Job ${job.id} completed`);
});

// Functions
function extractData(harContent) {
  const entries = harContent.log.entries;
  
  // Aggregate metrics
  const metrics = {
    totalRequests: entries.length,
    totalTime: 0,
    totalSize: 0,
    requestsByType: {},
    statusCodes: {},
    slowestRequests: [],
    largestRequests: [],
    domains: new Set(),
    errors: []
  };

  entries.forEach(entry => {
    // Basic metrics
    const size = entry.response.bodySize > 0 ? entry.response.bodySize : 0;
    const time = entry.time;
    const contentType = entry.response.content.mimeType.split(';')[0];
    const domain = new URL(entry.request.url).hostname;
    
    // Aggregate data
    metrics.totalTime += time;
    metrics.totalSize += size;
    metrics.domains.add(domain);
    
    // Track by content type
    metrics.requestsByType[contentType] = (metrics.requestsByType[contentType] || 0) + 1;
    
    // Track status codes
    metrics.statusCodes[entry.response.status] = 
      (metrics.statusCodes[entry.response.status] || 0) + 1;

    // Track slow requests (>500ms)
    if (time > 500) {
      metrics.slowestRequests.push({
        url: entry.request.url,
        time,
        size
      });
    }

    // Track large requests (>1MB)
    if (size > 1000000) {
      metrics.largestRequests.push({
        url: entry.request.url,
        size,
        type: contentType
      });
    }

    // Track errors (4xx and 5xx)
    if (entry.response.status >= 400) {
      metrics.errors.push({
        url: entry.request.url,
        status: entry.response.status,
        statusText: entry.response.statusText
      });
    }
  });

  // Sort and limit arrays
  metrics.slowestRequests.sort((a, b) => b.time - a.time).slice(0, 5);
  metrics.largestRequests.sort((a, b) => b.size - a.size).slice(0, 5);
  metrics.domains = Array.from(metrics.domains);

  return metrics;
}

async function generateInsights(extractedData, persona) {
  const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
  const maxRetries = 3;
  
  for (let i = 0; i < maxRetries; i++) {
    try {
      const personaPrompts = {
        Developer: `Analyze this HAR file data from a developer's perspective:
        - Highlight performance bottlenecks and optimization opportunities
        - Identify problematic API calls or slow requests
        - Suggest specific code-level improvements
        - Point out any security concerns or best practices violations`,
        
        'QA Professional': `Review this HAR file data from a QA perspective:
        - Identify potential testing gaps and error patterns
        - Analyze HTTP status code distribution
        - Highlight reliability concerns
        - Suggest test scenarios based on the traffic patterns`,
        
        'Sales Engineer': `Evaluate this HAR file data from a business perspective:
        - Translate technical metrics into business impact
        - Identify opportunities for improving user experience
        - Compare performance against industry standards
        - Highlight competitive advantages and areas for improvement`
      };

      const messages = [
        {
          role: 'system',
          content: `You are an expert ${persona} analyzing web application performance data.`
        },
        {
          role: 'user',
          content: `${personaPrompts[persona]}\n\nData:\n${JSON.stringify(extractedData, null, 2)}`
        }
      ];

      const response = await openai.chat.completions.create({
        model: 'gpt-3.5-turbo-0125',
        messages,
        temperature: 0.7,
        max_tokens: 1000
      });

      return response.choices[0].message.content.trim();
    } catch (error) {
      console.error(`OpenAI API attempt ${i + 1} failed:`, error.message);
      
      if (i < maxRetries - 1) {
        // Wait longer between each retry
        await delay((i + 1) * 2000); // 2s, 4s, 6s
        continue;
      }
      
      // On final attempt, throw the error
      if (error.code === 'insufficient_quota') {
        throw new Error('OpenAI API quota exceeded. Please try again later.');
      }
      throw error;
    }
  }
}

// Start cleanup process
cleanupExpiredInsights();

// Update Redis connection with error handling
connection.on('error', (err) => {
  console.error('Redis connection error:', err);
});

connection.on('connect', () => {
  console.log('Redis connected');
});
