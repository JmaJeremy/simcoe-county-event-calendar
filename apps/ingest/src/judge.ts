import Anthropic from '@anthropic-ai/sdk'
import type { Listing } from '@scec/core'
import type { Judge, JudgeInput, JudgeVerdict } from './dedup.ts'

/**
 * The Claude judge for ambiguous pairs.
 *
 * Only pairs the deterministic scorer could not settle get here (a few dozen per run,
 * measured), so the model sees the hard cases: the same fair with different wording, or
 * two churches' harvest suppers on the same evening. Pairs are batched ten to a request
 * and the verdict comes back through a strict tool call, so there is nothing to parse.
 * Every verdict is cached by the caller; a pair is judged once per content hash.
 *
 * Model choice is Jeremy's: Haiku 4.5 (`claude-haiku-4-5`), the cheapest current model,
 * which is plenty for a yes/no with two short listings in front of it.
 */

const MODEL = 'claude-haiku-4-5'
const BATCH = 10

const SYSTEM = `You decide whether two community event listings from different websites describe the SAME real-world event occurrence.

Both listings are in Simcoe County, Ontario, and overlap in date. Sources copy events from each other with edited titles, so wording differences alone do not make them different. They ARE the same when the title, timing and place are consistent with one gathering. They are DIFFERENT when the venues or organisers clearly differ, the times are incompatible (not just imprecise), or one is a specific part of a larger event (a single workshop inside a festival is not the festival). When one listing is a multi-day run (a play with several performances, a week-long exhibition) and the other is a single date inside it, they are DIFFERENT unless the single-date listing clearly describes the whole run. A generic listing that names only a national day or holiday is not the same as a specific local ceremony unless the place matches.

Be conservative: when the listings could plausibly be two separate gatherings, answer distinct with lower confidence. Give a one-sentence reason.`

const describe = (l: Listing): string =>
  [
    `source: ${l.sourceSlug} (${l.sourceKind})`,
    `title: ${l.title}`,
    `when: ${l.localDate} ${l.allDay || l.timePrecision === 'date-only' ? '(all day / no time given)' : l.localTime}${l.endsAtUtc ? ' (has end time)' : ''}`,
    `venue: ${l.venueName ?? '-'}`,
    `address: ${l.address ?? '-'}`,
    `municipality: ${l.municipalitySlug ?? '-'}`,
    `cost: ${l.costText ?? l.cost}`,
    `organizer: ${l.organizer ?? '-'}`,
    `description: ${(l.description ?? '').slice(0, 300) || '-'}`,
  ].join('\n')

const VERDICT_TOOL: Anthropic.Tool = {
  name: 'record_verdicts',
  description: 'Record one verdict per numbered pair, in order.',
  strict: true,
  input_schema: {
    type: 'object',
    additionalProperties: false,
    required: ['verdicts'],
    properties: {
      verdicts: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['pair', 'same', 'confidence', 'reason'],
          properties: {
            pair: { type: 'integer', description: 'The pair number as given.' },
            same: { type: 'boolean' },
            confidence: { type: 'number', description: '0 to 1' },
            reason: { type: 'string' },
          },
        },
      },
    },
  },
}

interface VerdictInput {
  verdicts: Array<{ pair: number; same: boolean; confidence: number; reason: string }>
}

export function claudeJudge(apiKey: string): Judge {
  const client = new Anthropic({ apiKey, maxRetries: 2 })

  async function judgeBatch(batch: JudgeInput[]): Promise<Array<JudgeVerdict | null>> {
    const prompt = batch
      .map(({ a, b, score }, i) => `## Pair ${i + 1} (similarity score ${score.score.toFixed(2)})\n\n### A\n${describe(a)}\n\n### B\n${describe(b)}`)
      .join('\n\n')

    const response = await client.messages.create({
      model: MODEL,
      max_tokens: 4096,
      system: SYSTEM,
      tools: [VERDICT_TOOL],
      tool_choice: { type: 'tool', name: VERDICT_TOOL.name },
      messages: [{ role: 'user', content: `${prompt}\n\nRecord a verdict for each of the ${batch.length} pairs.` }],
    })

    const call = response.content.find((b): b is Anthropic.ToolUseBlock => b.type === 'tool_use')
    if (!call) return batch.map(() => null)
    const input = call.input as VerdictInput
    const byPair = new Map(input.verdicts.map((v) => [v.pair, v]))
    return batch.map((_, i) => {
      const v = byPair.get(i + 1)
      return v ? { same: v.same, confidence: Math.max(0, Math.min(1, v.confidence)), reason: v.reason } : null
    })
  }

  return {
    name: 'claude-haiku-4-5',
    async judge(pairs) {
      const out: Array<JudgeVerdict | null> = []
      for (let i = 0; i < pairs.length; i += BATCH) {
        const batch = pairs.slice(i, i + BATCH)
        try {
          out.push(...(await judgeBatch(batch)))
        } catch (err) {
          // A failed call leaves the pairs unresolved for this run; they are retried next
          // time because nothing was cached. Never let the judge take the ingest down.
          console.error(`judge batch failed: ${err instanceof Error ? err.message : String(err)}`)
          out.push(...batch.map(() => null))
        }
      }
      return out
    },
  }
}
