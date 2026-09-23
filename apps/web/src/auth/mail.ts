/**
 * The account emails. Like every message this site sends, they echo nothing the visitor
 * typed — not even a name — and carry no address literal in source (no-email.test.ts now
 * scans this directory). Links point at the canonical origin, which the caller supplies.
 */
export const verificationMail = (link: string) => ({
  subject: 'Confirm your email — Out in Simcoe',
  text: `Someone used this address to create an account on Out in Simcoe.

If that was you, confirm it here (the link works once, for 24 hours):

${link}

If it was not you, ignore this message and no account will work.`,
})

export const resetMail = (link: string) => ({
  subject: 'Reset your password — Out in Simcoe',
  text: `Someone asked to reset the password for the Out in Simcoe account on this address.

If that was you, set a new one here (the link works once, for an hour):

${link}

If it was not you, ignore this message and nothing will change.`,
})

/** Sent instead of a second verification mail when the address already has an account. */
export const existingAccountMail = (link: string) => ({
  subject: 'This address already has an account — Out in Simcoe',
  text: `Someone tried to create an Out in Simcoe account with this address, but it already has one.

If that was you, just sign in — and if the password is lost, reset it here:

${link}

If it was not you, ignore this message; the existing account is unchanged.`,
})
