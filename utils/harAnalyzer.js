function analyzeHAR(harContent) {
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

  // Convert Set to Array for JSON serialization
  metrics.domains = Array.from(metrics.domains);
  
  // Sort and limit arrays
  metrics.slowestRequests.sort((a, b) => b.time - a.time).slice(0, 5);
  metrics.largestRequests.sort((a, b) => b.size - a.size).slice(0, 5);

  return metrics;
}

module.exports = analyzeHAR; 