/**
 * The one place this worker's outgoing mail is shaped. Factored out of worker.ts so the
 * account routes can send without importing the whole worker; the interfaces describe
 * only the part of the Email Service binding this site uses.
 *
 * ADMIN_ADDRESS is the one email literal allowed in apps/web/src — it belongs in mail
 * headers only, never in a served body, and no-email.test.ts pins exactly that.
 */
export interface EmailAddress {
  email: string
  name?: string
}

export interface SendEmail {
  send(message: {
    to: string | EmailAddress
    from: string | EmailAddress
    replyTo?: string | EmailAddress
    subject: string
    text: string
  }): Promise<unknown>
}

export const ADMIN_ADDRESS = 'contact@outinsimcoe.ca'
export const MAIL_FROM: EmailAddress = { email: ADMIN_ADDRESS, name: 'Out in Simcoe' }

/**
 * Send, and answer with the outcome as a string for the caller's records. Mail here is a
 * notification, never the transaction: a failure is recorded, not thrown, so a reader is
 * never shown an error because a mailbox was slow.
 */
export async function sendMail(email: SendEmail | undefined, message: Parameters<SendEmail['send']>[0]): Promise<string> {
  if (!email) return 'error: no EMAIL binding'
  try {
    await email.send(message)
    return 'sent'
  } catch (err) {
    return `error: ${err instanceof Error ? err.message : String(err)}`.slice(0, 500)
  }
}
