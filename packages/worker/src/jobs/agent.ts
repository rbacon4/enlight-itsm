import type { Job } from 'bullmq';
import { runAgentTurn } from '../../../api/src/agent/agent.js';

interface AgentJobData {
  requestId: string;
  projectId: string;
  triggerType?: 'triage' | 'comment_received' | 'slack_message';
  userMessage?: string;
  slackUserId?: string;
  /** Global role of the requester — passed through so the agent can decide
   *  whether to send a reply without an extra DB round-trip. */
  requesterRole?: string;
}

export async function handleAgentJob(job: Job<AgentJobData>): Promise<void> {
  await runAgentTurn({
    requestId: job.data.requestId,
    projectId: job.data.projectId,
    triggerType: job.data.triggerType ?? 'triage',
    ...(job.data.userMessage !== undefined ? { userMessage: job.data.userMessage } : {}),
    ...(job.data.slackUserId !== undefined ? { slackUserId: job.data.slackUserId } : {}),
    ...(job.data.requesterRole !== undefined ? { requesterRole: job.data.requesterRole } : {}),
  });
}
