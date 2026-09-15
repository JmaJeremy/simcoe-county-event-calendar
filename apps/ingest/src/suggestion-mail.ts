/**
 * The email a suggester gets when their suggestion is accepted.
 *
 * The console sends it, at the admin's hand, to the address typed into the site's form —
 * which need not be the suggester's own: anyone can put anyone's address there. So, like
 * the thank-you the web worker sends, it repeats nothing the visitor typed. What it may
 * carry is what the admin made: the published event's title and its link.
 *
 * Kept free of bindings so it runs under vitest.
 */

export const ADMIN_ADDRESS = 'contact@outinsimcoe.ca'
export const MAIL_FROM = { email: ADMIN_ADDRESS, name: 'Out in Simcoe' }

export interface Mail {
  subject: string
  text: string
}

/** Titles go on a line of their own; a line break must not start another. */
const oneLine = (value: string): string => value.replace(/[\r\n\t]+/g, ' ').replace(/\s{2,}/g, ' ').trim()

const sentOn = (iso: string): string =>
  new Date(iso).toLocaleDateString('en-CA', { timeZone: 'America/Toronto', month: 'long', day: 'numeric' })

export function acceptedMail(
  suggestion: { kind: 'event' | 'website'; createdAt: string },
  event: { title: string; url: string } | null,
): Mail {
  const when = sentOn(suggestion.createdAt)
  let opening: string
  if (event) {
    opening =
      suggestion.kind === 'website'
        ? `Good news: an event from the suggestion you sent Out in Simcoe on ${when} is now on the calendar.`
        : `Good news: the event you suggested to Out in Simcoe on ${when} is now on the calendar.`
  } else {
    opening =
      suggestion.kind === 'website'
        ? `Good news: we've accepted the website you suggested to Out in Simcoe on ${when}, and plan to include the events it lists.`
        : `Good news: we've accepted the event you suggested to Out in Simcoe on ${when}.`
  }
  return {
    subject: event ? 'Your suggestion is on Out in Simcoe' : 'Your suggestion was accepted — Out in Simcoe',
    text: [
      'Hi,',
      opening,
      ...(event ? [`${oneLine(event.title)}\n${event.url}`] : []),
      'Thanks for sending it in. Suggestions like yours are how the calendar finds the events the town calendars miss.',
      "If you didn't send a suggestion, someone typed your address into our form by mistake. You can ignore this.",
      '— Out in Simcoe\nhttps://outinsimcoe.ca',
    ].join('\n\n'),
  }
}
