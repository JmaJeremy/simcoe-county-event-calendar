import Anthropic from '@anthropic-ai/sdk'

/**
 * A second opinion on price, for listings whose own words the rules could not settle.
 *
 * The model is a finder, not a decider. It is asked for the sentence that states what
 * attending costs — nothing else — and `judgeCosts` then runs the ordinary cost rules
 * over that sentence and checks it really appears in the listing. A model that invents
 * "admission is $10" produces a quote that fails the check and is discarded, and one that
 * quotes a sentence about a raffle prize produces a quote the rules read as no price at
 * all. Neither can move an event on its own say-so.
 */
export interface CostJudgeInput {
  id: string
  title: string
  description: string
  source: string
}

export interface CostJudgeReading {
  /** The sentence that states the price, exactly as it appears, or null if none does. */
  quote: string | null
}

export interface CostJudge {
  name: string
  read(items: CostJudgeInput[]): Promise<Array<CostJudgeReading | null>>
}

/** Used when no API key is configured: everything stays as it was. */
export const noCostJudge: CostJudge = {
  name: 'none',
  read: async (items) => items.map(() => null),
}

const MODEL = 'claude-haiku-4-5'
const BATCH = 10

const SYSTEM = `You are reading listings for community events in Simcoe County, Ontario, to find what each one costs to attend.

For each listing, quote the ONE sentence or phrase from its text that states the cost of attending. Copy it exactly, character for character, from the text you are given. Do not paraphrase, summarise, correct or translate it.

Quote a phrase only when it is about the price of attending this event: an admission price, a ticket price, a registration fee, or a statement that it is free or by donation.

Return null instead when the text does not say. In particular, return null for:
- money that is not the price of attending: funds raised, prize money, grants, a charity's target, the value of an auction item, the cost of something sold there
- "free" used for something other than admission: free parking, free refreshments, scent-free, gluten-free, free Wi-Fi
- prices for a different activity at the same venue, such as a facility's general drop-in rates
- your own inference from the kind of event. A concert is not paid because concerts usually are.

Most listings do not state a price. Returning null is the common and correct answer.`

const TOOL: Anthropic.Tool = {
  name: 'record_quotes',
  description: 'Record one reading per numbered listing, in order.',
  strict: true,
  input_schema: {
    type: 'object',
    additionalProperties: false,
    required: ['readings'],
    properties: {
      readings: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['listing', 'quote'],
          properties: {
            listing: { type: 'integer', description: 'The listing number as given.' },
            quote: {
              type: ['string', 'null'],
              description: 'The exact words stating the cost of attending, or null if the text does not say.',
            },
          },
        },
      },
    },
  },
}

interface ReadingInput {
  readings: Array<{ listing: number; quote: string | null }>
}

const describe = (item: CostJudgeInput): string =>
  [`title: ${item.title}`, `listed on: ${item.source}`, `text: ${item.description}`].join('\n')

export function claudeCostJudge(apiKey: string): CostJudge {
  const client = new Anthropic({ apiKey, maxRetries: 2 })

  async function readBatch(batch: CostJudgeInput[]): Promise<Array<CostJudgeReading | null>> {
    const prompt = batch.map((item, i) => `## Listing ${i + 1}\n${describe(item)}`).join('\n\n')

    const response = await client.messages.create({
      model: MODEL,
      max_tokens: 2048,
      system: SYSTEM,
      tools: [TOOL],
      tool_choice: { type: 'tool', name: TOOL.name },
      messages: [{ role: 'user', content: `${prompt}\n\nRecord a reading for each of the ${batch.length} listings.` }],
    })

    const call = response.content.find((b): b is Anthropic.ToolUseBlock => b.type === 'tool_use')
    if (!call) return batch.map(() => null)
    const byListing = new Map((call.input as ReadingInput).readings.map((r) => [r.listing, r]))
    return batch.map((_, i) => {
      const reading = byListing.get(i + 1)
      return reading ? { quote: reading.quote } : null
    })
  }

  return {
    name: MODEL,
    async read(items) {
      const out: Array<CostJudgeReading | null> = []
      for (let i = 0; i < items.length; i += BATCH) {
        const batch = items.slice(i, i + BATCH)
        try {
          out.push(...(await readBatch(batch)))
        } catch (err) {
          // Nothing is cached for a failed call, so these listings come round again.
          console.error(`cost judge batch failed: ${err instanceof Error ? err.message : String(err)}`)
          out.push(...batch.map(() => null))
        }
      }
      return out
    },
  }
}
