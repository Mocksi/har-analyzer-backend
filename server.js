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

// Near the top, after initial requires
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

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

// Add logging middleware
app.use((req, res, next) => {
  console.log(`${new Date().toISOString()} ${req.method} ${req.url}`);
  next();
});

// Initialize services before starting server
async function initializeServices() {
  try {
    // Test database connection
    await pool.query('SELECT NOW()');
    console.log('Database connected');

    // Create table if not exists
    await pool.query(`
      CREATE TABLE IF NOT EXISTS insights (
        id SERIAL PRIMARY KEY,
        job_id VARCHAR(255) UNIQUE NOT NULL,
        persona VARCHAR(50) NOT NULL,
        insights TEXT NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    console.log('Table "insights" is ready');

    // Initialize Redis connection
    const connection = new Redis(process.env.REDIS_URL, redisOptions);
    
    // Set up Queue and Worker after Redis connects
    await new Promise((resolve, reject) => {
      connection.on('error', (err) => {
        console.error('Redis connection error:', err);
        reject(err);
      });

      connection.on('connect', () => {
        console.log('Redis connected');
        
        // Initialize Queue
        const harQueue = new Queue('harQueue', { connection });
        
        // Initialize Worker
        const worker = new Worker('harQueue', async job => {
          console.log(`Processing job ${job.id}...`);
          try {
            const metrics = analyzeHAR(job.data.harContent);
            const structuredMetrics = {
              ...metrics,
              selected: metrics.selected || {},
              primary: metrics.primary || {},
              timeseries: metrics.timeseries || [],
              requestsByType: metrics.requestsByType || {},
              statusCodes: metrics.statusCodes || {},
              domains: metrics.domains || []
            };

            let insights = null;
            let error = null;

            try {
              insights = await generateInsights(structuredMetrics, job.data.persona);
            } catch (aiError) {
              console.error('AI Insights generation failed:', aiError);
              error = aiError.message;
            }

            // Log before database insertion
            console.log(`Inserting results for job ${job.id}...`);
            
            await pool.query(
              `INSERT INTO insights (job_id, persona, insights) 
               VALUES ($1, $2, $3) 
               ON CONFLICT (job_id) 
               DO UPDATE SET insights = $3, persona = $2`,
              [job.id, job.data.persona, JSON.stringify({ 
                metrics: structuredMetrics, 
                insights,
                error 
              })]
            );
            
            console.log(`Job ${job.id} completed successfully`);
            return { jobId: job.id };
          } catch (error) {
            console.error(`Job ${job.id} failed:`, error);
            throw error;
          }
        }, { connection });

        worker.on('completed', job => {
          console.log(`Job ${job.id} completed`);
        });

        worker.on('failed', (job, err) => {
          console.error(`Job ${job.id} failed:`, err);
        });

        // Make queue available to routes
        app.locals.harQueue = harQueue;
        resolve();
      });
    });

    // Start server after all services are initialized
    const PORT = process.env.PORT || 5000;
    app.listen(PORT, () => {
      console.log(`Server running on port ${PORT}`);
    });

  } catch (error) {
    console.error('Failed to initialize services:', error);
    process.exit(1);
  }
}

// Update the results endpoint with more logging
app.get('/results/:jobId', async (req, res) => {
  try {
    const { jobId } = req.params;
    const { persona } = req.query;

    console.log(`Fetching results for job ${jobId} with persona ${persona}`);

    // First, check if the job is still in progress
    const jobStatus = await harQueue.getJob(jobId);
    if (jobStatus && !jobStatus.finishedOn) {
      console.log(`Job ${jobId} is still processing`);
      return res.status(202).json({ 
        status: 'processing',
        message: 'Analysis in progress'
      });
    }

    // Then check the database for results
    const result = await pool.query(
      'SELECT insights FROM insights WHERE job_id = $1',
      [jobId]
    );

    if (result.rows.length === 0) {
      console.log(`No results found for job ${jobId}`);
      return res.status(404).json({ 
        error: 'Results not found',
        message: 'Results not found or have expired'
      });
    }

    console.log(`Found results for job ${jobId}`);
    const insights = JSON.parse(result.rows[0].insights);
    res.json(insights);
  } catch (error) {
    console.error('Error fetching results:', error);
    res.status(500).json({ 
      error: 'Failed to fetch results',
      message: error.message 
    });
  }
});

// Start the initialization process
initializeServices().catch(error => {
  console.error('Failed to start server:', error);
  process.exit(1);
});

// Set up OpenAI Configuration
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

// Add a debug log (temporary)
console.log('OpenAI API Key exists:', !!process.env.OPENAI_API_KEY);
console.log('OpenAI API Key length:', process.env.OPENAI_API_KEY?.length);

// Set up Storage for Multer
const storage = multer.memoryStorage();
const upload = multer({ storage });

// Initialize AJV for HAR validation
const ajv = new Ajv();

// Add this middleware for cache control
app.use((req, res, next) => {
  // Cache successful responses for 1 hour
  res.set('Cache-Control', 'public, max-age=3600');
  next();
});

// API Endpoints
app.post('/analyze', upload.single('harFile'), async (req, res) => {
  try {
    console.log('Received file:', req.file ? 'yes' : 'no');
    console.log('File size:', req.file?.size);
    console.log('Persona:', req.body.persona);

    if (!req.file) {
      return res.status(400).json({ error: 'No file uploaded' });
    }

    let harContent;
    try {
      harContent = JSON.parse(req.file.buffer.toString());
      console.log('Successfully parsed HAR content');
    } catch (parseError) {
      console.error('Parse error:', parseError);
      return res.status(400).json({ error: 'Invalid JSON in HAR file' });
    }

    if (!app.locals.harQueue) {
      console.error('Queue not initialized');
      return res.status(500).json({ error: 'Service not ready' });
    }

    const job = await app.locals.harQueue.add('processHar', {
      harContent,
      persona: req.body.persona || 'developer',
    });
    
    console.log('Job added to queue:', job.id);
    res.json({ jobId: job.id });
  } catch (error) {
    console.error('Endpoint error:', error);
    res.status(500).json({ 
      error: 'Failed to process file',
      details: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
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

// Functions (move these before the worker setup)
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

async function cleanupExpiredInsights() {
  try {
    const result = await pool.query(
      'DELETE FROM insights WHERE created_at < NOW() - INTERVAL \'7 days\' RETURNING id'
    );
    console.log(`Cleaned up ${result.rowCount} expired insights`);
  } catch (error) {
    console.error('Cleanup failed:', error);
  }
}

// Add cleanup scheduling
// Run initial cleanup
cleanupExpiredInsights();

// Schedule cleanup every 24 hours
setInterval(cleanupExpiredInsights, 24 * 60 * 60 * 1000);
