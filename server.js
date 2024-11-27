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

      connection.once('connect', () => {
        console.log('Redis connected');
        
        // Initialize Queue and store in app.locals immediately
        app.locals.harQueue = new Queue('harQueue', { connection });
        console.log('Queue initialized and stored in app.locals');
        
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

            let insights = [];
            let error = null;

            try {
              const aiResponse = await generateInsights(structuredMetrics, job.data.persona);
              // Parse AI response into structured insights
              insights = parseAIResponse(aiResponse);
            } catch (aiError) {
              console.error('AI Insights generation failed:', aiError);
              error = aiError.message;
            }

            console.log(`Inserting results for job ${job.id}...`);
            
            await pool.query(
              `INSERT INTO insights (job_id, persona, insights) 
               VALUES ($1, $2, $3) 
               ON CONFLICT (job_id) 
               DO UPDATE SET insights = $3, persona = $2`,
              [job.id, job.data.persona, JSON.stringify({ 
                metrics: structuredMetrics, 
                insights: insights || [], // Ensure insights is always an array
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
    if (!app.locals.harQueue) {
      console.error('Queue not initialized');
      return res.status(500).json({ 
        error: 'Service not ready',
        message: 'Queue not initialized'
      });
    }

    const jobStatus = await app.locals.harQueue.getJob(jobId);
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
      message: error.message,
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
  • Specific code-level improvements
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
      console.error(`OpenAI API attempt ${i + 1} failed:`, error.message);
      
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

function analyzeHAR(harContent) {
  const metrics = {
    // General metrics
    totalRequests: 0,
    totalSize: 0,
    totalTime: 0,
    
    // HTTP specific metrics
    httpMetrics: {
      requests: 0,
      totalSize: 0,
      totalTime: 0,
      statusCodes: {},
      requestsByType: {},
      slowestRequests: [],
      largestRequests: [],
      cacheHits: 0,
      cacheMisses: 0,
      securityIssues: []
    },
    
    // WebSocket specific metrics
    websocketMetrics: {
      connections: 0,
      messageCount: 0,
      sentMessages: 0,
      receivedMessages: 0,
      totalMessageSize: 0,
      averageMessageSize: 0,
      connectionDuration: 0,
      messageTypes: {},
      protocols: new Set(),
      errors: []
    },
    
    // Shared metrics
    domains: new Set(),
    timings: {
      dns: 0,
      connect: 0,
      ssl: 0,
      wait: 0,
      receive: 0
    }
  };

  harContent.log.entries.forEach(entry => {
    const domain = new URL(entry.request.url).hostname;
    metrics.domains.add(domain);
    metrics.totalRequests++;

    // Accumulate timing data if available
    if (entry.timings) {
      Object.keys(metrics.timings).forEach(timing => {
        if (entry.timings[timing] && entry.timings[timing] > 0) {
          metrics.timings[timing] += entry.timings[timing];
        }
      });
    }

    if (entry._resourceType === 'websocket') {
      // WebSocket Analysis
      const ws = metrics.websocketMetrics;
      ws.connections++;
      
      if (entry._webSocketMessages) {
        ws.messageCount += entry._webSocketMessages.length;
        
        entry._webSocketMessages.forEach(msg => {
          // Message direction tracking
          if (msg.type === 'send') ws.sentMessages++;
          if (msg.type === 'receive') ws.receivedMessages++;
          
          // Message type analysis
          try {
            const data = typeof msg.data === 'string' ? JSON.parse(msg.data) : msg.data;
            const msgType = data.cmd || data.type || 'unknown';
            ws.messageTypes[msgType] = (ws.messageTypes[msgType] || 0) + 1;
          } catch (e) {
            ws.messageTypes.binary = (ws.messageTypes.binary || 0) + 1;
          }

          // Size tracking
          if (msg.data) {
            ws.totalMessageSize += msg.data.length;
          }
        });
      }

      // Connection duration
      if (entry.time) {
        ws.connectionDuration += entry.time;
      }

      // Protocol tracking
      entry.request.headers.forEach(header => {
        if (header.name.toLowerCase() === 'sec-websocket-protocol') {
          header.value.split(',').forEach(protocol => {
            ws.protocols.add(protocol.trim());
          });
        }
      });

    } else {
      // HTTP Request Analysis
      const http = metrics.httpMetrics;
      http.requests++;
      
      // Size calculations
      const requestSize = entry.request.bodySize > 0 ? entry.request.bodySize : 0;
      const responseSize = entry.response.bodySize > 0 ? entry.response.bodySize : 0;
      const totalSize = requestSize + responseSize;
      
      http.totalSize += totalSize;
      metrics.totalSize += totalSize;

      // Timing
      if (entry.time) {
        http.totalTime += entry.time;
        metrics.totalTime += entry.time;
      }

      // Status code distribution
      const status = entry.response.status;
      http.statusCodes[status] = (http.statusCodes[status] || 0) + 1;

      // Resource types
      const type = entry._resourceType || 'other';
      http.requestsByType[type] = (http.requestsByType[type] || 0) + 1;

      // Cache analysis
      if (entry.response.headers.some(h => 
        h.name.toLowerCase() === 'cf-cache-status' && h.value === 'HIT')) {
        http.cacheHits++;
      } else {
        http.cacheMisses++;
      }

      // Track slow requests
      if (entry.time > 1000) {
        http.slowestRequests.push({
          url: entry.request.url,
          time: entry.time,
          type: type,
          size: totalSize,
          status: status
        });
      }

      // Track large requests
      if (totalSize > 100000) {
        http.largestRequests.push({
          url: entry.request.url,
          size: totalSize,
          type: type,
          time: entry.time,
          status: status
        });
      }

      // Security checks
      if (!entry.request.url.startsWith('https://')) {
        http.securityIssues.push({
          type: 'insecure-protocol',
          url: entry.request.url
        });
      }
    }
  });

  // Post-processing
  metrics.websocketMetrics.averageMessageSize = 
    metrics.websocketMetrics.messageCount > 0 
      ? metrics.websocketMetrics.totalMessageSize / metrics.websocketMetrics.messageCount 
      : 0;

  metrics.websocketMetrics.protocols = Array.from(metrics.websocketMetrics.protocols);
  metrics.domains = Array.from(metrics.domains);

  // Sort arrays
  metrics.httpMetrics.slowestRequests.sort((a, b) => b.time - a.time).slice(0, 5);
  metrics.httpMetrics.largestRequests.sort((a, b) => b.size - a.size).slice(0, 5);

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

// Helper function to parse AI response into structured insights
function parseAIResponse(aiResponse) {
  try {
    // If the response is already an array of insights, return it
    if (Array.isArray(aiResponse)) {
      return aiResponse;
    }
    
    // Otherwise, create a single insight
    return [{
      severity: 'info',
      message: aiResponse,
      timestamp: new Date().toISOString()
    }];
  } catch (error) {
    console.error('Failed to parse AI response:', error);
    return [{
      severity: 'error',
      message: 'Failed to parse AI insights',
      timestamp: new Date().toISOString()
    }];
  }
}
