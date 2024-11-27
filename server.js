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
const PERSONAS = require('./config/personas');

// Near the top, after initial requires
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

// Add Redis configuration options
const redisOptions = {
  maxRetriesPerRequest: null,
  enableReadyCheck: false,
  retryStrategy: (times) => {
    const delay = Math.min(times * 50, 2000);
    return delay;
  },
  reconnectOnError: (err) => {
    const targetError = 'READONLY';
    if (err.message.includes(targetError)) {
      return true;
    }
    return false;
  }
};

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
        job_id VARCHAR(255) NOT NULL,
        persona VARCHAR(50) NOT NULL,
        har_metrics JSONB,
        har_insights JSONB NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(job_id, persona)
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

      connection.once('connect', () => {
        console.log('Redis connected');
        
        // Initialize Queue and store in app.locals immediately
        app.locals.harQueue = new Queue('harQueue', { connection });
        console.log('Queue initialized and stored in app.locals');
        
        // Initialize Worker
        const worker = new Worker('harQueue', async job => {
          console.log(`Processing job ${job.id}...`);
          try {
            console.log(`Analyzing HAR for job ${job.id}`);
            const metrics = analyzeHAR(job.data.harContent);
            
            const sanitizedMetrics = {
              domains: metrics.domains || [],
              timeseries: metrics.timeseries?.map(point => ({
                timestamp: point.timestamp,
                value: point.responseTime || 0
              })) || [],
              requestsByType: metrics.requestsByType || {},
              primary: metrics.primary || {
                errorRate: 0,
                totalSize: 0,
                totalRequests: 0,
                avgResponseTime: 0
              },
              selected: metrics.selected || {
                errorRequests: 0,
                largestRequests: [],
                slowestRequests: []
              },
              ...metrics
            };

            // Process each persona
            for (const persona of Object.keys(PERSONAS)) {
              console.log(`Generating insights for job ${job.id} and persona ${persona}`);
              const rawInsights = await generateInsights(sanitizedMetrics, persona);
              const insights = parseAIResponse(rawInsights);

              await pool.query(
                'INSERT INTO insights (job_id, persona, har_metrics, har_insights) VALUES ($1, $2, $3, $4)',
                [
                  job.id, 
                  persona, 
                  JSON.stringify(sanitizedMetrics), 
                  JSON.stringify(insights)
                ]
              );
            }

            return { success: true };
          } catch (error) {
            console.error(`Error processing job ${job.id}:`, error);
            throw error;
          }
        }, { 
          connection,
          concurrency: 1,
          removeOnComplete: false, // Keep completed jobs for status checking
          removeOnFail: false     // Keep failed jobs for debugging
        });

        // Add proper event handlers
        worker.on('completed', job => {
          console.log(`Job ${job.id} completed with result:`, job.returnvalue);
        });

        worker.on('failed', (job, err) => {
          console.error(`Job ${job.id} failed with error:`, err);
        });

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

    // Check job status
    const jobStatus = await app.locals.harQueue.getJob(jobId);
    console.log(`Job ${jobId} status:`, jobStatus ? jobStatus.status : 'not found');
    
    if (jobStatus && !jobStatus.finishedOn) {
      console.log(`Job ${jobId} is still processing`);
      return res.status(202).json({ status: 'processing' });
    }

    const result = await pool.query(
      'SELECT har_metrics, har_insights FROM insights WHERE job_id = $1 AND persona = $2',
      [jobId, persona]
    );

    if (result.rows.length === 0) {
      console.log(`No results found for job ${jobId}`);
      return res.status(404).json({ 
        error: 'Results not found',
        jobId,
        persona 
      });
    }

    let metrics = result.rows[0].har_metrics;
    let insights = result.rows[0].har_insights;

    // Parse if stored as strings
    if (typeof metrics === 'string') {
      metrics = JSON.parse(metrics);
    }
    if (typeof insights === 'string') {
      insights = JSON.parse(insights);
    }

    // Transform timeseries data to match frontend expectations
    if (metrics.timeseries) {
      metrics.timeseries = metrics.timeseries.map(point => ({
        timestamp: point.timestamp,
        value: point.responseTime || 0
      }));
    }

    console.log('Sending metrics with timeseries:', metrics.timeseries); // Debug log

    // Log the full metrics structure for debugging
    console.log('Full metrics structure:', {
      timeseriesLength: metrics.timeseries?.length,
      timeseriesExample: metrics.timeseries?.[0],
      hasWebSocket: !!metrics.websocketMetrics,
      totalRequests: metrics.totalRequests
    });

    return res.json({ metrics, insights });

  } catch (error) {
    console.error('Error fetching results:', error);
    res.status(500).json({ 
      error: 'Failed to fetch results',
      details: error.message,
      stack: process.env.NODE_ENV === 'development' ? error.stack : undefined
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
        developer: `Analyze this HAR file considering the developer perspective:

- Performance metrics & bottlenecks:
  • Analyze timing, size, and caching patterns
  • Identify slow requests and resource bottlenecks
  • Evaluate compression and optimization opportunities

- Protocol usage & efficiency:
  • Review HTTP/WebSocket patterns
  • Assess connection reuse and multiplexing
  • Evaluate header optimization

- API behaviors & data flows:
  • Analyze request/response patterns
  • Identify redundant or inefficient calls
  • Review data transfer efficiency

- Security configurations:
  • Check HTTPS usage and certificate validity
  • Review security headers
  • Identify potential vulnerabilities

- Technical recommendations:
   Specific code-level improvements
  • Caching strategy optimizations
  • Performance enhancement priorities

${extractedData.metrics?.websocket ? `
Additional WebSocket Analysis:
- Message patterns & frequency
- Payload size optimization
- Connection lifecycle management
- Real-time behavior efficiency` : ''}

Please provide specific, actionable insights based on the metrics provided.`,

        'qa': `Analyze this HAR file considering the QA perspective:

- Error patterns & status codes:
  • Analyze status code distribution
  • Identify error patterns and frequencies
  • Review error handling effectiveness

- Edge cases & failures:
  • Identify potential failure scenarios
  • Review timeout and retry patterns
  • Assess error recovery mechanisms

- Testing coverage:
  • Highlight untested scenarios
  • Identify missing error cases
  • Suggest additional test coverage

- Response validation:
  • Review response consistency
  • Check data integrity patterns
  • Assess validation coverage

- Reliability concerns:
  • Analyze system stability indicators
  • Review error recovery patterns
  • Assess service dependencies

${extractedData.metrics?.websocket ? `
Additional WebSocket Analysis:
- Connection stability patterns
- Error handling in real-time
- Recovery mechanism effectiveness
- Testing scenario recommendations` : ''}

Please provide specific testing recommendations based on the observed patterns.`,

        'business': `Analyze this HAR file considering the business perspective:

- User experience impact:
  • Page load and interaction times
  • Error rates and reliability
  • Performance bottleneck costs

- Industry standards comparison:
  • Performance benchmarking
  • Best practices alignment
  • Competitive positioning

- Resource utilization:
  • Bandwidth consumption
  • Server resource usage
  • Infrastructure costs

- Business implications:
  • Revenue impact of performance
  • Customer satisfaction factors
  • Market positioning effects

- ROI opportunities:
  • Cost-saving recommendations
  • Performance investment returns
  • Priority improvement areas

${extractedData.metrics?.websocket ? `
Additional WebSocket Analysis:
- Real-time capability assessment
- Operational cost implications
- Scaling considerations
- User experience impact` : ''}

Please provide business-focused insights and ROI-driven recommendations.`
      };

      const messages = [
        {
          role: 'system',
          content: `You are an expert ${persona} analyzing web application performance data. Provide clear, actionable insights with specific metrics and recommendations.`
        },
        {
          role: 'user',
          content: `${personaPrompts[persona.toLowerCase()]}\n\nMetrics:\n${JSON.stringify(extractedData, null, 2)}`
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
      console.error(`OpenAI API attempt ${i + 1} failed:`, error);
      
      if (i < maxRetries - 1) {
        await delay((i + 1) * 2000);
        continue;
      }
      
      if (error.code === 'insufficient_quota') {
        throw new Error('OpenAI API quota exceeded. Please try again later.');
      }
      throw error;
    }
  }
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

// Helper function to parse AI response into structured insights
function parseAIResponse(aiResponse) {
  try {
    // If already structured, return as is
    if (Array.isArray(aiResponse)) {
      return aiResponse;
    }

    // Split the response into sections based on numbered points
    const sections = aiResponse.split(/\d+\.\s+/).filter(Boolean);
    
    return sections.map(section => {
      // Extract the section title and content
      const [title, ...contentParts] = section.split(':');
      const content = contentParts.join(':').trim();

      // Split content into bullet points
      const bulletPoints = content
        .split(/[-•]\s+/)
        .filter(Boolean)
        .map(point => point.trim());

      // Create structured insight
      return {
        category: title.trim(),
        severity: determineSeverity(content),
        message: title.trim(),
        details: bulletPoints,
        recommendations: bulletPoints.filter(point => 
          point.toLowerCase().includes('consider') || 
          point.toLowerCase().includes('implement') ||
          point.toLowerCase().includes('optimize') ||
          point.toLowerCase().includes('review')
        ),
        timestamp: new Date().toISOString()
      };
    });
  } catch (error) {
    console.error('Failed to parse AI response:', error);
    return [{
      category: 'error',
      severity: 'error',
      message: 'Failed to parse insights',
      details: [aiResponse],
      recommendations: [],
      timestamp: new Date().toISOString()
    }];
  }
}

function determineSeverity(content) {
  const lowercaseContent = content.toLowerCase();
  
  if (
    lowercaseContent.includes('critical') || 
    lowercaseContent.includes('severe') ||
    lowercaseContent.includes('high impact')
  ) {
    return 'critical';
  }
  
  if (
    lowercaseContent.includes('warning') || 
    lowercaseContent.includes('consider') ||
    lowercaseContent.includes('improve')
  ) {
    return 'warning';
  }
  
  if (
    lowercaseContent.includes('optimization') || 
    lowercaseContent.includes('enhance') ||
    lowercaseContent.includes('recommend')
  ) {
    return 'info';
  }
  
  return 'info';
}

const processHarFile = async (harContent) => {
  // Process in chunks to avoid memory spikes
  const entries = harContent.log.entries;
  const processedEntries = [];
  
  // Process 100 entries at a time
  const CHUNK_SIZE = 100;
  for (let i = 0; i < entries.length; i += CHUNK_SIZE) {
    const chunk = entries.slice(i, i + CHUNK_SIZE);
    processedEntries.push(...await processEntryChunk(chunk));
    // Allow GC to clean up between chunks
    await new Promise(resolve => setTimeout(resolve, 0));
  }

  // Clean up large objects when done
  harContent = null;
  entries = null;
  global.gc(); // Only if running Node with --expose-gc
  
  return processedEntries;
};

const redisConfig = {
  host: process.env.REDIS_HOST,
  port: process.env.REDIS_PORT,
  password: process.env.REDIS_PASSWORD,
  maxRetriesPerRequest: 3,
  maxMemoryPolicy: 'allkeys-lru', // Evict least recently used keys if memory is full
  commandTimeout: 60000, // 60s timeout for long operations
};

const checkMemoryUsage = async (redis) => {
  const info = await redis.info('memory');
  const usedMemory = parseInt(info.match(/used_memory:(\d+)/)[1]);
  const maxMemory = 256 * 1024 * 1024; // 256MB in bytes
  
  if (usedMemory > maxMemory * 0.8) { // 80% warning threshold
    console.warn(`High memory usage: ${Math.round(usedMemory/1024/1024)}MB of ${maxMemory/1024/1024}MB`);
  }
};
