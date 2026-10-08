import type { FastifyInstance } from "fastify";
import { pyrodeckConfig } from "./pyrodeck-config.js";
import { serverEvents } from "../events/ServerEvents.js";
import { ServerProfileManager } from "../config/ServerProfile.js";
import {
  MAILABLE_EVENTS,
  MailBatcher,
  composeMail,
  describeEvent,
  isSelected,
  sendMail,
  type MailableEventName,
  type SendResult,
} from "../ops/MailNotifier.js";
import { toMailView, validateMailSettings } from "../ops/mailSettings.js";
import { VERSION } from "../version.js";

/** Email alerts on server events: settings, a test mail, and the bus listeners that queue alerts. */

const CONFIG_DIR = process.env.PYRODECK_CONFIG_DIR ?? "./config";

const mailStatus: { lastSentAt: string | null; lastError: string | null; lastErrorAt: string | null } = {
  lastSentAt: null,
  lastError: null,
  lastErrorAt: null,
};

function recordSend(result: SendResult): void {
  const now = new Date().toISOString();
  if (result.ok) {
    mailStatus.lastSentAt = now;
    mailStatus.lastError = null;
    mailStatus.lastErrorAt = null;
  } else {
    mailStatus.lastError = result.error;
    mailStatus.lastErrorAt = now;
  }
}

const mailBatcher = new MailBatcher({
  send: async (events, dropped) => {
    const settings = pyrodeckConfig.get().mail;
    if (!settings.enabled) return;
    const profiles = await new ServerProfileManager(CONFIG_DIR, "").list().catch(() => []);
    const names = new Map(profiles.map((p) => [p.id, p.name] as const));
    const result = await sendMail(settings, composeMail(events, names, { dropped }));
    recordSend(result);
    if (result.ok) {
      console.log(`[Mail] Sent ${events.length + dropped} event(s) to ${settings.recipients.length} recipient(s)`);
    } else {
      console.warn(`[Mail] Send failed: ${result.error}`);
    }
  },
});

function listenForMail<K extends MailableEventName>(name: K): void {
  serverEvents.onEvent(name, (payload) => {
    const mail = pyrodeckConfig.get().mail;
    if (!mail.enabled) return;
    const event = describeEvent(name, payload);
    if (isSelected(event, mail.events)) mailBatcher.push(event);
  });
}
for (const name of MAILABLE_EVENTS) listenForMail(name);

const statusPayload = () => ({ ...mailStatus, pending: mailBatcher.pending() });

export async function alertRoutes(app: FastifyInstance): Promise<void> {
  app.addHook("onClose", async () => {
    mailBatcher.clear();
  });

  /** GET /api/alerts/mail: settings (never the password) and the last send's outcome. */
  app.get("/api/alerts/mail", async () => ({
    settings: toMailView(pyrodeckConfig.get().mail),
    status: statusPayload(),
  }));

  /**
   * PUT /api/alerts/mail  { enabled, host, port, tls, user, password?, from, recipients, events }
   * A missing password keeps the stored one; "" clears it.
   */
  app.put("/api/alerts/mail", async (request, reply) => {
    const check = validateMailSettings(request.body, pyrodeckConfig.get().mail);
    if (check.errors.length > 0) {
      return reply.status(400).send({ error: check.errors.join(" "), errors: check.errors });
    }
    await pyrodeckConfig.save({ mail: check.settings });
    if (!check.settings.enabled) mailBatcher.clear();
    return { settings: toMailView(check.settings), status: statusPayload(), warnings: check.warnings };
  });

  /**
   * POST /api/alerts/mail/test  (optional body: unsaved settings, as for PUT)
   * Send one test mail now, whether alerts are on or not.
   */
  app.post("/api/alerts/mail/test", async (request, reply) => {
    const body = request.body && typeof request.body === "object" ? request.body : {};
    const check = validateMailSettings({ ...body, enabled: false }, pyrodeckConfig.get().mail);
    const s = check.settings;
    const missing = [!s.host && "the SMTP host", !s.from && "the From address", s.recipients.length === 0 && "a recipient"]
      .filter(Boolean)
      .join(", ");
    const errors = [...check.errors, ...(missing ? [`Set ${missing} first.`] : [])];
    if (errors.length > 0) return reply.status(400).send({ error: errors.join(" "), errors });
    const result = await sendMail(s, {
      subject: "[Pyrodeck] Test mail",
      text: `This is a test mail from Pyrodeck ${VERSION}. Email alerts reach this address.\n`,
    });
    recordSend(result);
    return result;
  });
}
