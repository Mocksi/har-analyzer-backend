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

    // Process entries
    harContent.log.entries.forEach(entry => {
      try {
        processEntry(entry, metrics);
      } catch (err) {
        console.error('Error processing entry:', err);
      }
    });

    return metrics;
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

module.exports = analyzeHAR; 