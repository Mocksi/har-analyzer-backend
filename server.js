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

// Initialize Express App
const app = express();
app.use(cors());
app.use(express.json());

// Set up Redis Connection for BullMQ
const connection = new Redis(process.env.REDIS_URL);

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

// Set up OpenAI Configuration
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

// Initialize Queue
const harQueue = new Queue('harQueue', { connection });

// Set up Storage for Multer
const storage = multer.memoryStorage();
const upload = multer({ storage });

// Initialize AJV for HAR validation
const ajv = new Ajv();

// API Endpoints
app.post('/upload', upload.single('harfile'), async (req, res) => {
  try {
    // Validate File
    if (!req.file) {
      return res.status(400).json({ error: 'No file uploaded' });
    }

    // Parse HAR Content
    let harContent;
    try {
      harContent = JSON.parse(req.file.buffer.toString());
    } catch (parseError) {
      return res.status(400).json({ error: 'Invalid JSON in HAR file' });
    }

    // Validate HAR File
    const validate = ajv.compile(harSchema);
    const valid = validate(harContent);
    if (!valid) {
      return res.status(400).json({ error: 'Invalid HAR file format', details: validate.errors });
    }

    // Add Job to Queue
    const job = await harQueue.add('processHar', {
      harContent,
      persona: req.body.persona,
    });

    res.json({ jobId: job.id });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Failed to process file' });
  }
});

app.get('/results/:jobId', async (req, res) => {
  try {
    const { jobId } = req.params;
    const job = await harQueue.getJob(jobId);

    if (job.finishedOn) {
      const result = await pool.query('SELECT * FROM insights WHERE job_id = $1', [jobId]);
      res.json(result.rows[0]);
    } else {
      res.json({ status: 'Processing' });
    }
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Failed to retrieve results' });
  }
});

// Start Server
const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`Backend server running on port ${PORT}`);
});

// Worker to Process HAR Files
const harWorker = new Worker(
  'harQueue',
  async (job) => {
    const { harContent, persona } = job.data;

    // Extract Relevant Data
    const extractedData = extractData(harContent);

    // Generate Insights
    const insights = await generateInsights(extractedData, persona);

    // Save to Database
    await pool.query(
      'INSERT INTO insights (job_id, persona, insights) VALUES ($1, $2, $3)',
      [job.id, persona, insights]
    );
  },
  { connection }
);

// Functions
function extractData(harContent) {
  // Implement data extraction logic here
  return harContent.log.entries.map((entry) => ({
    url: entry.request.url,
    status: entry.response.status,
    timings: entry.timings,
    // Add more fields as needed
  }));
}

async function generateInsights(extractedData, persona) {
  // Prepare messages for Chat Completion
  const messages = [
    {
      role: 'system',
      content: `You are an expert ${persona} analyzing HAR file data.`,
    },
    {
      role: 'user',
      content: `Provide detailed insights for the following HAR data:\n${JSON.stringify(
        extractedData
      )}`,
    },
  ];

  // Call OpenAI Chat Completion API
  const response = await openai.chat.completions.create({
    model: 'gpt-3.5-turbo',
    messages,
  });

  return response.choices[0].message.content.trim();
}
