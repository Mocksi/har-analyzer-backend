function analyzeHAR(harContent) {
  try {
    if (!harContent?.log?.entries) {
      throw new Error('Invalid HAR format: missing log.entries');
    }

    const metrics = {
      // General metrics
      totalRequests: 0,
      totalSize: 0,
      totalTime: 0,
      
      // Primary metrics for overview
      primary: {
        totalRequests: 0,
        avgResponseTime: 0,
        totalSize: 0,
        errorRate: 0
      },

      // Selected metrics for drilldown
      selected: {
        slowestRequests: [],
        largestRequests: [],
        errorRequests: []
      },

      // Time series data
      timeseries: [],

      // Request categorization
      requestsByType: {},
      statusCodes: {},
      domains: new Set(),

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
      }
    };

    const insights = [];
    
    // Performance insights
    insights.push({
      category: 'Performance',
      severity: calculateSeverity(metrics.primary.avgResponseTime, 300, 1000),
      content: `Analysis of ${metrics.totalRequests} requests across ${Object.keys(metrics.domains).length} domains. Average response time: ${metrics.primary.avgResponseTime.toFixed(2)}ms.`,
      details: generatePerformanceDetails(metrics),
      recommendations: generatePerformanceRecommendations(metrics)
    });

    // Cache insights
    const cacheRate = (metrics.httpMetrics.cacheHits / 
      (metrics.httpMetrics.cacheHits + metrics.httpMetrics.cacheMisses)) * 100;
    insights.push({
      category: 'Cache',
      severity: calculateSeverity(100 - cacheRate, 20, 40),
      content: `Cache hit rate: ${cacheRate.toFixed(2)}%`,
      details: generateCacheDetails(metrics),
      recommendations: generateCacheRecommendations(metrics)
    });

    // Error insights
    if (metrics.primary.errorRate > 0) {
      insights.push({
        category: 'Errors',
        severity: calculateSeverity(metrics.primary.errorRate * 100, 1, 5),
        content: `Error rate: ${(metrics.primary.errorRate * 100).toFixed(2)}%`,
        details: generateErrorDetails(metrics),
        recommendations: generateErrorRecommendations(metrics)
      });
    }

    // Process entries
    harContent.log.entries.forEach(entry => {
      try {
        processEntry(entry, metrics);
      } catch (err) {
        console.error('Error processing entry:', err);
      }
    });

    return {
      metrics,
      insights  // Add insights to the return object
    };
  } catch (error) {
    console.error('Error analyzing HAR:', error);
    throw error;
  }
}

function processWebSocketEntry(entry, metrics) {
  metrics.websocketMetrics.connections++;
  
  if (entry._webSocketMessages) {
    entry._webSocketMessages.forEach(msg => {
      metrics.websocketMetrics.messageCount++;
      if (msg.type === 'send') metrics.websocketMetrics.sentMessages++;
      if (msg.type === 'receive') metrics.websocketMetrics.receivedMessages++;
      metrics.websocketMetrics.totalMessageSize += msg.data?.length || 0;
      metrics.websocketMetrics.messageTypes[msg.type] = 
        (metrics.websocketMetrics.messageTypes[msg.type] || 0) + 1;
    });
  }

  metrics.websocketMetrics.connectionDuration += entry.time;
}

function processEntry(entry, metrics) {
  // Update total metrics
  metrics.totalRequests++;
  metrics.totalSize += calculateEntrySize(entry);
  metrics.totalTime += entry.time;
  
  // Track domain
  const domain = new URL(entry.request.url).hostname;
  metrics.domains.add(domain);
  
  // Process by entry type
  if (entry._resourceType === 'websocket') {
    processWebSocketEntry(entry, metrics);
  } else {
    processHTTPEntry(entry, metrics);
  }
  
  // Add to timeseries
  metrics.timeseries.push({
    timestamp: new Date(entry.startedDateTime).getTime(),
    value: entry.time
  });
}

function processHTTPEntry(entry, metrics) {
  const size = calculateEntrySize(entry);
  const type = entry._resourceType || 'other';
  
  // Update HTTP metrics
  metrics.httpMetrics.requests++;
  metrics.httpMetrics.totalSize += size;
  metrics.httpMetrics.totalTime += entry.time;
  
  // Track status codes
  const statusCategory = `${Math.floor(entry.response.status / 100)}xx`;
  metrics.httpMetrics.statusCodes[statusCategory] = 
    (metrics.httpMetrics.statusCodes[statusCategory] || 0) + 1;
  
  // Track slow requests
  if (entry.time > 1000) {
    metrics.httpMetrics.slowestRequests.push({
      url: entry.request.url,
      time: entry.time,
      type: type
    });
  }
  
  // Track large requests
  if (size > 1000000) {
    metrics.httpMetrics.largestRequests.push({
      url: entry.request.url,
      size: size,
      type: type
    });
  }
  
  // Track cache
  const cacheControl = entry.response.headers.find(h => 
    h.name.toLowerCase() === 'cache-control'
  );
  if (cacheControl) {
    if (cacheControl.value.includes('no-cache') || cacheControl.value.includes('no-store')) {
      metrics.httpMetrics.cacheMisses++;
    } else {
      metrics.httpMetrics.cacheHits++;
    }
  }
}

function calculateEntrySize(entry) {
  return entry.response.bodySize > 0 ? entry.response.bodySize : 0;
}

function calculateErrorRate(statusCodes) {
  const errors = (statusCodes['4xx'] || 0) + (statusCodes['5xx'] || 0);
  const total = Object.values(statusCodes).reduce((sum, count) => sum + count, 0);
  return total > 0 ? errors / total : 0;
}

// Helper functions for insights generation
function calculateSeverity(value, warningThreshold, errorThreshold) {
  if (value >= errorThreshold) return 'error';
  if (value >= warningThreshold) return 'warning';
  return 'info';
}

function generatePerformanceDetails(metrics) {
  const details = [];
  if (metrics.httpMetrics.slowestRequests.length > 0) {
    details.push(`Slowest request: ${metrics.httpMetrics.slowestRequests[0].url} (${metrics.httpMetrics.slowestRequests[0].time.toFixed(2)}ms)`);
  }
  return details;
}

function generatePerformanceRecommendations(metrics) {
  const recommendations = [];
  if (metrics.primary.avgResponseTime > 300) {
    recommendations.push('Consider implementing caching strategies');
    recommendations.push('Optimize server response times');
  }
  return recommendations;
}

// ... Add similar helper functions for cache and error insights ...

module.exports = analyzeHAR; 