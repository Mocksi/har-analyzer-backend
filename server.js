const express = require('express');
const cors = require('cors');
const { Worker } = require('bullmq');
const Redis = require('ioredis');
const analyzeHAR = require('./utils/harAnalyzer');

const app = express();
const port = process.env.PORT || 10000;

// Middleware setup
app.use(cors({
  origin: process.env.CORS_ORIGINS?.split(',') || 'http://localhost:3000',
  credentials: true
}));

app.use(express.json({ limit: '100mb' }));

// Add logging middleware
app.use((req, res, next) => {
  console.log(`${req.method} ${req.path}`, req.body ? 'with payload' : '');
  next();
});

// Add a simple in-memory store for metrics
const metricsStore = new Map();

// Restore the analyze endpoint
app.post('/analyze', async (req, res) => {
  console.log('Analyze endpoint hit');
  try {
    const harContent = req.body;
    console.log('Received HAR content, size:', JSON.stringify(harContent).length);
    const metrics = analyzeHAR(harContent);
    console.log('Analysis complete');
    
    const jobId = Date.now().toString();
    // Store the metrics with the jobId
    metricsStore.set(jobId, metrics);
    
    res.json({ 
      jobId,
      metrics 
    });
  } catch (error) {
    console.error('Error analyzing HAR:', error);
    res.status(500).json({ error: 'Failed to analyze HAR file' });
  }
});

// Update results endpoint to use stored metrics
app.get('/results/:jobId', async (req, res) => {
  try {
    const { jobId } = req.params;
    const metrics = metricsStore.get(jobId);
    
    if (!metrics) {
      return res.status(404).json({ error: 'Results not found' });
    }
    
    res.json({
      metrics,
      status: 'completed'
    });
  } catch (error) {
    console.error('Error fetching results:', error);
    res.status(500).json({ error: 'Failed to fetch results' });
  }
});

function parseAIResponse(aiResponse) {
  try {
    const sections = typeof aiResponse === 'string' 
      ? aiResponse.split(/(?=### )/g)
      : [aiResponse];

    return formatInsights(sections.map(section => ({
      category: section.match(/### ([^\n]+)/)?.[1] || 'General',
      content: section.replace(/^### .+?\n/gm, ''),
      severity: 'info'
    })));
  } catch (error) {
    console.error('Failed to parse AI response:', error);
    return [{
      category: 'error',
      severity: 'error',
      message: 'Failed to parse insights',
      content: aiResponse,
      timestamp: new Date().toISOString()
    }];
  }
}

app.listen(port, () => {
  console.log(`HAR Analyzer backend listening on port ${port}`);
});
