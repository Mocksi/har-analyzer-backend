const express = require('express');
const cors = require('cors');
const { Worker } = require('bullmq');
const Redis = require('ioredis');
const analyzeHAR = require('./utils/harAnalyzer');

const app = express();
const port = process.env.PORT || 3000;

// Middleware setup
app.use(cors({
  origin: process.env.CORS_ORIGINS?.split(',') || 'http://localhost:3000',
  credentials: true
}));

app.use(express.json({ limit: '100mb' }));

// Restore the analyze endpoint
app.post('/analyze', async (req, res) => {
  try {
    const harContent = req.body;
    const metrics = analyzeHAR(harContent);
    
    res.json({ 
      jobId: Date.now().toString(),
      metrics 
    });
  } catch (error) {
    console.error('Error analyzing HAR:', error);
    res.status(500).json({ error: 'Failed to analyze HAR file' });
  }
});

// Add results endpoint
app.get('/results/:jobId', async (req, res) => {
  try {
    const { jobId } = req.params;
    const { persona } = req.query;
    
    // Since we're not using a queue anymore, just return the error
    res.status(404).json({ 
      error: 'Results not found. Please try uploading the file again.' 
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
