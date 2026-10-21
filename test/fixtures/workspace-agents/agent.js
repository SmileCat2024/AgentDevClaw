import { BasicAgent } from '@agentdevjs/core';

class Main extends BasicAgent {
  constructor(options) {
    super({ ...options, llm: { modelName: 'fixture', async onCall() { throw new Error('Fixture must not call a model'); } } });
    process.send({ type: 'assembly-probe', assembly: 'main', sessionId: options.sessionId, name: options.name });
  }
}
class Reviewer extends BasicAgent {
  constructor(options) {
    super({ ...options, llm: { modelName: 'fixture', async onCall() { throw new Error('Fixture must not call a model'); } } });
    process.send({ type: 'assembly-probe', assembly: 'reviewer', sessionId: options.sessionId, name: options.name });
  }
}
export const agents = { main: Main, reviewer: Reviewer };
export default Main;
