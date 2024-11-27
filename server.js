const express = require('express');
const cors = require('cors');
const { Worker } = require('bullmq');
const Redis = require('ioredis');
const analyzeHAR = require('./utils/harAnalyzer');

const app = express();
const port = process.env.PORT || 10000;

// Middleware setup
app.use(cors({
  origin: process.env.CORS_ORIGINS?.split(',') || ['http://localhost:3000', 'https://har-analyzer-frontend.onrender.com'],
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

// Add these helper functions at the top
function extractDomain(harContent) {
  try {
    const firstEntry = harContent.log.entries[0];
    const url = new URL(firstEntry.request.url);
    return url.hostname;
  } catch (error) {
    return 'Unknown Domain';
  }
}

function formatDate(date) {
  return date.toLocaleDateString().replace(/\//g, '');
}

async function generateInsights(metrics) {
  // Get base insights
  const baseInsights = [
    {
      category: 'Performance',
      content: `Analysis of ${metrics.totalRequests} requests across ${metrics.domains.size} domains. Average response time: ${(metrics.totalTime / metrics.totalRequests).toFixed(2)}ms.`,
      severity: 'info',
      timestamp: new Date().toISOString()
    },
    // ... other base insights ...
  ];

  // Get AI-powered insights for each persona
  const personas = ['Developer', 'QA Professional', 'Sales Engineer'];
  const aiInsights = {};
  
  for (const persona of personas) {
    const aiResponse = await generatePersonaInsights(metrics, persona);
    aiInsights[persona.toLowerCase().replace(' ', '')] = parseAIResponse(aiResponse);
  }

  return {
    baseInsights,
    personaInsights: aiInsights
  };
}

// Restore the analyze endpoint
app.post('/analyze', async (req, res) => {
  console.log('Analyze endpoint hit');
  try {
    const harContent = req.body;
    console.log(`Received HAR content, size: ${JSON.stringify(harContent).length}`);
    
    if (!harContent || !harContent.log) {
      throw new Error('Invalid HAR format: missing log property');
    }
    
    // Perform analysis
    const metrics = analyzeHAR(harContent);
    const jobId = Date.now();
    
    console.log('Analysis completed, metrics:', JSON.stringify(metrics, null, 2));
    
    // Store results with proper structure
    metricsStore.set(jobId, {
      metrics,
      insights: await generateInsights(metrics),
      siteInfo: {
        domainName: extractDomain(harContent),
        timestamp: new Date().toISOString(),
        reportId: `HAR-${jobId}-${formatDate(new Date())}`
      }
    });

    console.log('Analysis complete, sending response');
    res.json({ jobId });
  } catch (error) {
    console.error('Analysis failed:', error);
    console.error('Error stack:', error.stack);
    res.status(500).json({ 
      error: 'Analysis failed',
      details: error.message,
      stack: process.env.NODE_ENV === 'development' ? error.stack : undefined
    });
  }
});

// Update results endpoint to use stored metrics
app.get('/results/:jobId', (req, res) => {
  const { jobId } = req.params;
  const results = metricsStore.get(parseInt(jobId));
  
  if (!results) {
    return res.status(404).json({ error: 'Results not found' });
  }

  res.json(results);
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
