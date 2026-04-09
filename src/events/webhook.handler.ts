import { supabase } from '../db/supabase';
import { notifyException } from '../notifications/cowboy.notify';
import type { ExceptionType, ExceptionSeverity, Stage } from '../types/passport';
import { logger } from '../utils/logger';

// Stage → required role mapping
const STAGE_ROLE_MAP: Record<Stage, keyof typeof ROLE_KEYS> = {
  intake: 'coordinator',
  measure: 'estimator',
  quote: 'coordinator',
  install: 'crewLead',
  invoice: 'finance',
  complete: 'coordinator',
};

const ROLE_KEYS = {
  coordinator: 'coordinator',
  estimator: 'estimator',
  crewLead: 'crewLead',
  finance: 'finance',
} as const;

const TWENTY_FOUR_HOURS_MS = 24 * 60 * 60 * 1000;
const CHANGE_ORDER_THRESHOLD = 500;

interface PassportRow {
  job_ref: string;
  stage: Stage;
  stage_history: Array<{ timestamp: string; stage: string }>;
  assigned_to: Record<string, string | undefined>;
  quote: {
    versions: Array<{ amount: number; status: string }>;
    approvedVersionId?: string;
  };
  proof: { complete: boolean };
  sla: {
    leadDue: string;
    quoteDue?: string;
    invoiceDue?: string;
    breached: boolean;
  };
}

/**
 * Event-driven exception detection.
 * Called on every passport write — NO polling, NO heartbeat.
 */
export async function checkPassportExceptions(passport: PassportRow): Promise<void> {
  const checks = [
    checkStageStallt(passport),
    checkProofMissing(passport),
    checkChangeOrder(passport),
    checkSLABreach(passport),
    checkUnassigned(passport),
  ];

  await Promise.allSettled(checks);
}

/**
 * Stage unchanged > 24hrs since last event → stage_stall
 */
async function checkStageStallt(passport: PassportRow): Promise<void> {
  if (passport.stage === 'complete') return;

  const history = passport.stage_history;
  if (history.length === 0) return;

  const lastEvent = history[history.length - 1];
  const lastTimestamp = new Date(lastEvent.timestamp).getTime();
  const now = Date.now();

  if (now - lastTimestamp > TWENTY_FOUR_HOURS_MS) {
    await raiseExceptionIfNew(passport.job_ref, 'stage_stall', 'high',
      `Stage "${passport.stage}" has been unchanged for over 24 hours`);
  }
}

/**
 * Install complete but proof.complete = false → proof_missing
 */
async function checkProofMissing(passport: PassportRow): Promise<void> {
  if (passport.stage !== 'invoice' && passport.stage !== 'complete') return;

  // Check if install stage was reached and proof is incomplete
  const reachedInstall = passport.stage_history.some((e) => e.stage === 'install');

  if (reachedInstall && !passport.proof.complete) {
    await raiseExceptionIfNew(passport.job_ref, 'proof_missing', 'high',
      'Install completed but proof photos are incomplete');
  }
}

/**
 * Quote amount changed > $500 from approved → change_order
 */
async function checkChangeOrder(passport: PassportRow): Promise<void> {
  const versions = passport.quote.versions;
  if (versions.length < 2) return;

  const approvedVersion = versions.find((v) => v.status === 'approved');
  if (!approvedVersion) return;

  const latestVersion = versions[versions.length - 1];
  const difference = Math.abs(latestVersion.amount - approvedVersion.amount);

  if (difference > CHANGE_ORDER_THRESHOLD && latestVersion.status !== 'approved') {
    await raiseExceptionIfNew(passport.job_ref, 'change_order', 'critical',
      `Quote changed by $${difference.toFixed(2)} from approved amount of $${approvedVersion.amount.toFixed(2)}`);
  }
}

/**
 * SLA due date passed → sla_breach
 */
async function checkSLABreach(passport: PassportRow): Promise<void> {
  const now = new Date();
  const sla = passport.sla;
  let breached = false;
  let breachDetail = '';

  if (new Date(sla.leadDue) < now && passport.stage === 'intake') {
    breached = true;
    breachDetail = `Lead SLA breached (due: ${sla.leadDue})`;
  }

  if (sla.quoteDue && new Date(sla.quoteDue) < now &&
      (passport.stage === 'measure' || passport.stage === 'quote')) {
    breached = true;
    breachDetail = `Quote SLA breached (due: ${sla.quoteDue})`;
  }

  if (sla.invoiceDue && new Date(sla.invoiceDue) < now &&
      passport.stage === 'invoice') {
    breached = true;
    breachDetail = `Invoice SLA breached (due: ${sla.invoiceDue})`;
  }

  if (breached) {
    // Update passport SLA breach flag
    await supabase
      .from('passports')
      .update({
        sla: { ...sla, breached: true, breachedAt: now.toISOString() },
      })
      .eq('job_ref', passport.job_ref);

    await raiseExceptionIfNew(passport.job_ref, 'sla_breach', 'critical', breachDetail);
  }
}

/**
 * No assignedTo for current stage → unassigned
 */
async function checkUnassigned(passport: PassportRow): Promise<void> {
  if (passport.stage === 'complete') return;

  const requiredRole = STAGE_ROLE_MAP[passport.stage];
  const assigned = passport.assigned_to[requiredRole];

  if (!assigned) {
    await raiseExceptionIfNew(passport.job_ref, 'unassigned', 'medium',
      `No ${requiredRole} assigned for stage "${passport.stage}"`);
  }
}

/**
 * Only raise an exception if there isn't already an open one of the same type
 * for this job. Prevents duplicate exceptions on repeated writes.
 */
async function raiseExceptionIfNew(
  jobRef: string,
  type: ExceptionType,
  severity: ExceptionSeverity,
  detail: string
): Promise<void> {
  // Check for existing open exception of same type
  const { data: existing } = await supabase
    .from('exceptions')
    .select('id')
    .eq('job_ref', jobRef)
    .eq('type', type)
    .is('resolved_at', null)
    .limit(1);

  if (existing && existing.length > 0) return;

  // Insert new exception
  const { data: exception, error } = await supabase
    .from('exceptions')
    .insert({
      job_ref: jobRef,
      type,
      severity,
    })
    .select()
    .single();

  if (error) {
    logger.error(`Failed to raise exception for ${jobRef}: ${error.message}`);
    return;
  }

  // Log event
  await supabase.from('events').insert({
    job_ref: jobRef,
    stage: 'exception',
    actor: 'cowboy',
    notes: `[${type}] ${detail}`,
    automated: true,
  });

  // Fire notification
  await notifyException({
    jobRef,
    exceptionId: exception.id as string,
    type,
    severity,
    detail,
  });

  logger.warn(`Exception raised: [${type}] ${jobRef} — ${detail}`);
}
