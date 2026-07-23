import { GrammyError } from 'grammy';

/**
 * The one place a message actually leaves for Telegram.
 *
 * Telegram rejects an entire message — it does not truncate — when it is over
 * 4096 characters, when HTML entities do not parse, or when the chat is being
 * flooded. Each of those turns into a user staring at a chat where nothing
 * arrived, so every one is handled here rather than at ~60 call sites:
 *
 *   1. Over-long text is split on line boundaries (see `chunkMessage`).
 *   2. A 429 is retried once, honouring the `retry_after` Telegram supplies.
 *   3. A parse failure re-sends the same text as plain text. Losing bold is a
 *      cosmetic failure; losing the shortlist the user paid for is not.
 */

/** Telegram's hard limit. We chunk below it to leave room for a continuation marker. */
export const TELEGRAM_LIMIT = 4096;
const CHUNK_TARGET = 3900;

type Replier = (text: string, other?: Record<string, unknown>) => Promise<unknown>;

/**
 * Split text so that no chunk exceeds `limit`.
 *
 * Prefers line boundaries; a single line longer than the limit is hard-split
 * rather than emitted oversized, because an oversized chunk is rejected whole.
 */
export function chunkForTelegram(text: string, limit = CHUNK_TARGET): string[] {
  if (text.length <= limit) return [text];
  const chunks: string[] = [];
  let current = '';

  const flush = (): void => {
    if (current) chunks.push(current);
    current = '';
  };

  for (const line of text.split('\n')) {
    if (line.length > limit) {
      flush();
      for (let i = 0; i < line.length; i += limit) chunks.push(line.slice(i, i + limit));
      continue;
    }
    if (current.length + line.length + 1 > limit) flush();
    current += (current ? '\n' : '') + line;
  }
  flush();
  return chunks;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * Send one already-sized chunk, absorbing the two failures that are ours to
 * handle. Anything else propagates — an unknown error should not be silently
 * downgraded into a half-working chat.
 */
async function sendChunk(reply: Replier, text: string, options: Record<string, unknown>): Promise<void> {
  try {
    await reply(text, options);
    return;
  } catch (err) {
    if (err instanceof GrammyError && err.error_code === 429) {
      const wait = Number(err.parameters?.retry_after ?? 1);
      // Telegram tells us exactly how long to wait; honour it once. A second
      // 429 means sustained flooding, which retrying would only worsen.
      await sleep(Math.min(wait, 30) * 1000 + 250);
      await reply(text, options);
      return;
    }
    // 400 "can't parse entities": some field held markup we failed to escape.
    // Deliver the content unformatted rather than not at all.
    if (err instanceof GrammyError && err.error_code === 400 && /can't parse entities/i.test(err.description)) {
      console.error(`[telegram] HTML parse failed, resending as plain text: ${err.description}`);
      const { parse_mode: _drop, ...rest } = options;
      await reply(stripHtml(text), rest);
      return;
    }
    throw err;
  }
}

/**
 * Reply, chunking and recovering as needed.
 *
 * The keyboard belongs on the LAST chunk only — buttons attached to a middle
 * chunk scroll away above the content they act on.
 */
export async function send(reply: Replier, text: string, options: Record<string, unknown> = {}): Promise<void> {
  const chunks = chunkForTelegram(text);
  for (let i = 0; i < chunks.length; i++) {
    const isLast = i === chunks.length - 1;
    const { reply_markup, ...common } = options;
    await sendChunk(reply, chunks[i], isLast ? options : common);
  }
}

/** Last-resort de-formatting for a message Telegram refused to parse. */
export function stripHtml(text: string): string {
  return text
    .replace(/<a href="[^"]*">([\s\S]*?)<\/a>/g, '$1')
    .replace(/<\/?(b|i|u|s|code|pre|blockquote)>/g, '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}
