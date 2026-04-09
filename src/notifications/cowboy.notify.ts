import { logger } from '../utils/logger';
import type { ExceptionType, ExceptionSeverity } from '../types/passport';

// ============================================================
// Channel configuration
// ============================================================

const SLACK_WEBHOOK_URL = process.env.SLACK_WEBHOOK_URL ?? '';
const GHL_API_KEY = process.env.GHL_API_KEY ?? '';
const GHL_API_URL = process.env.GHL_API_URL ?? '';
const TRAVIS_PHONE = process.env.TRAVIS_PHONE ?? '';
const TRAVIS_SLACK_ID = process.env.TRAVIS_SLACK_ID ?? '';

type SlackChannel =
  | '#cowboy-ops'
  | '#cowboy-research'
  | '#cowboy-relay';

// Exception type → notification routing
const NOTIFICATION_ROUTES: Record<ExceptionType, {
  slackChannel: SlackChannel;
  smsRequired: boolean;
  directToTravis: boolean;
}> = {
  sla_breach: { slackChannel: '#cowboy-ops', smsRequired: false, directToTravis: false },
  proof_missing: { slackChannel: '#cowboy-ops', smsRequired: true, directToTravis: false },
  no_response: { slackChannel: '#cowboy-ops', smsRequired: false, directToTravis: false },
  change_order: { slackChannel: '#cowboy-ops', smsRequired: true, directToTravis: true },
  stage_stall: { slackChannel: '#cowboy-ops', smsRequired: false, directToTravis: false },
  unassigned: { slackChannel: '#cowboy-ops', smsRequired: true, directToTravis: true },
};

const SEVERITY_EMOJI: Record<ExceptionSeverity, string> = {
  low: ':white_circle:',
  medium: ':large_yellow_circle:',
  high: ':large_orange_circle:',
  critical: ':red_circle:',
};

// ============================================================
// Public API
// ============================================================

export interface ExceptionNotification {
  jobRef: string;
  exceptionId: string;
  type: ExceptionType;
  severity: ExceptionSeverity;
  detail: string;
}

/**
 * Route an exception notification to the correct channels.
 * Fires on every exception — event-driven, no polling.
 */
export async function notifyException(notification: ExceptionNotification): Promise<void> {
  const route = NOTIFICATION_ROUTES[notification.type];

  const tasks: Promise<void>[] = [
    sendSlackNotification(route.slackChannel, notification),
  ];

  if (route.smsRequired) {
    if (route.directToTravis && TRAVIS_PHONE) {
      tasks.push(sendSMS(TRAVIS_PHONE, notification));
    } else {
      // SMS to crew via GHL
      tasks.push(sendGHLSMS(notification));
    }
  }

  if (route.directToTravis && TRAVIS_SLACK_ID) {
    tasks.push(sendSlackDM(TRAVIS_SLACK_ID, notification));
  }

  await Promise.allSettled(tasks);
}

/**
 * Send a general update to a Slack channel.
 */
export async function notifyChannel(
  channel: SlackChannel,
  message: string
): Promise<void> {
  await postToSlack(channel, message);
}

// ============================================================
// Slack
// ============================================================

async function sendSlackNotification(
  channel: SlackChannel,
  notification: ExceptionNotification
): Promise<void> {
  const emoji = SEVERITY_EMOJI[notification.severity];
  const message = [
    `${emoji} *RELAY Exception — ${notification.type.toUpperCase()}*`,
    `*Job:* \`${notification.jobRef}\``,
    `*Severity:* ${notification.severity}`,
    `*Detail:* ${notification.detail}`,
    `*Exception ID:* ${notification.exceptionId}`,
  ].join('\n');

  await postToSlack(channel, message);
}

async function sendSlackDM(
  slackUserId: string,
  notification: ExceptionNotification
): Promise<void> {
  const emoji = SEVERITY_EMOJI[notification.severity];
  const message = [
    `${emoji} *Direct Alert — ${notification.type.toUpperCase()}*`,
    `*Job:* \`${notification.jobRef}\``,
    `*Detail:* ${notification.detail}`,
    `Action required.`,
  ].join('\n');

  await postToSlack(slackUserId, message);
}

async function postToSlack(channel: string, text: string): Promise<void> {
  if (!SLACK_WEBHOOK_URL) {
    logger.warn(`Slack not configured — would send to ${channel}: ${text.substring(0, 100)}...`);
    return;
  }

  try {
    const response = await fetch(SLACK_WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ channel, text }),
    });

    if (!response.ok) {
      logger.error(`Slack notification failed: ${response.status} ${response.statusText}`);
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error(`Slack notification error: ${message}`);
  }
}

// ============================================================
// SMS via GoHighLevel (GHL)
// ============================================================

async function sendSMS(
  phone: string,
  notification: ExceptionNotification
): Promise<void> {
  const message = `RELAY [${notification.severity.toUpperCase()}]: ${notification.type} on ${notification.jobRef} — ${notification.detail}`;
  await postGHLSMS(phone, message);
}

async function sendGHLSMS(notification: ExceptionNotification): Promise<void> {
  // For crew SMS, the phone would come from the passport's assignedTo
  // For now, route to Travis as fallback
  if (TRAVIS_PHONE) {
    await sendSMS(TRAVIS_PHONE, notification);
  } else {
    logger.warn(`GHL SMS: No phone number available for ${notification.type} on ${notification.jobRef}`);
  }
}

async function postGHLSMS(phone: string, message: string): Promise<void> {
  if (!GHL_API_KEY || !GHL_API_URL) {
    logger.warn(`GHL not configured — would SMS ${phone}: ${message.substring(0, 100)}...`);
    return;
  }

  try {
    const response = await fetch(`${GHL_API_URL}/conversations/messages`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${GHL_API_KEY}`,
      },
      body: JSON.stringify({
        type: 'SMS',
        phone,
        message,
      }),
    });

    if (!response.ok) {
      logger.error(`GHL SMS failed: ${response.status} ${response.statusText}`);
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error(`GHL SMS error: ${message}`);
  }
}
