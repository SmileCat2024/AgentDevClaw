import type { PanelPresentation } from './feature-communication.js';

/** Claw presentation contracts; neither BackgroundAccess nor domain engines depend on these. */
export const PROCESS_BACKGROUND_PRESENTATION: PanelPresentation = {
  panel: 'background', protocol: 'claw.background.process', version: 1,
};
export const AGENT_BACKGROUND_PRESENTATION: PanelPresentation = {
  panel: 'background', protocol: 'claw.background.agent', version: 1,
};

export interface AgentBackgroundTask {
  id: string;
  revision: number;
  title: string;
  agentId: string;
  threadId: string;
  commandId: string;
  sessionId?: string;
  status: 'submitted' | 'executing' | 'suspended' | 'rotating' | 'completed' | 'failed'
    | 'cancelled' | 'blocked' | 'monitor_lost';
  summary: string;
  startedAt: number;
  updatedAt: number;
  endedAt?: number;
}
