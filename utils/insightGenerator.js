async function generatePersonaInsights(analysis, persona) {
  const prompts = {
    Developer: `As a developer, analyze this HAR file data focusing on:
      - Performance bottlenecks and optimization opportunities
      - API issues and error patterns
      - Frontend asset optimization
      - Security concerns
      
      Data: ${JSON.stringify(analysis.metrics)}
      
      Provide specific, actionable insights with code examples where relevant.`,

    'QA Professional': `As a QA professional, analyze this HAR file data focusing on:
      - Test coverage gaps
      - Error patterns and reproduction steps
      - Performance regression indicators
      - Environment-specific issues
      
      Data: ${JSON.stringify(analysis.metrics)}
      
      Provide detailed testing recommendations and validation steps.`,

    'Sales Engineer': `As a sales engineer, analyze this HAR file data focusing on:
      - Customer-facing impact
      - Integration patterns
      - Performance benchmarks
      - Business value propositions
      
      Data: ${JSON.stringify(analysis.metrics)}
      
      Provide insights that highlight business benefits and technical advantages.`
  };

  const response = await openai.chat.completions.create({
    model: 'gpt-3.5-turbo',
    messages: [
      {
        role: 'system',
        content: `You are an expert ${persona} analyzing web application performance data.`
      },
      {
        role: 'user',
        content: prompts[persona]
      }
    ],
    temperature: 0.7,
    max_tokens: 1500
  });

  return response.choices[0].message.content;
} 