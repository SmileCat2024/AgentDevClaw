import { BasicAgent, UserInputFeature } from '@agentdevjs/core';

class InputAgent extends BasicAgent {
  constructor(options) {
    super({ ...options, llm: { modelName: 'fixture', async onCall() { throw new Error('Fixture must not call a model'); } } });
    this.use(new UserInputFeature());
  }
}
export const agents = { main: InputAgent, reviewer: InputAgent };
export default InputAgent;
