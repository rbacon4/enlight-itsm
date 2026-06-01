import type { Job } from 'bullmq';
import { runOffboarding } from '../../../api/src/lib/offboarding.js';

interface OffboardingJobData {
  eventId: string;
}

/** Executes a previously-created offboarding event (suspend / move OU / Drive transfer). */
export async function handleOffboardingJob(job: Job<OffboardingJobData>): Promise<void> {
  const { eventId } = job.data;
  if (!eventId) return;
  await runOffboarding(eventId);
}
