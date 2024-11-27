const express = require('express');
const cors = require('cors');
const { Worker } = require('bullmq');
const Redis = require('ioredis');

const app = express();
const port = process.env.PORT || 3000;

// Middleware setup
app.use(cors({
  origin: process.env.CORS_ORIGINS?.split(',') || 'http://localhost:3000',
  credentials: true
}));

app.use(express.json());

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

app.listen(port, '0.0.0.0', () => {
  console.log(`HAR Analyzer backend listening on port ${port}`);
});
