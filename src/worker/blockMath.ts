/**
 * Block math and ticket-ID formatting utilities.
 *
 * A "block" is a contiguous range of 500 ticket IDs issued by a single
 * device/officer lane. Block boundaries use 1-based alignment:
 *   - blockStart = floor((n - 1) / 500) * 500 + 1
 *   - blockEnd   = blockStart + 499
 *
 * Ticket IDs are padded numeric strings (e.g. "100000064501"), optionally
 * prefixed with letters. All helpers here preserve the original prefix and
 * width so the resulting IDs round-trip through the portal unchanged.
 *
 * We use regular `number` arithmetic rather than `BigInt`; 12-digit ticket
 * IDs (~1e11) fit comfortably inside Number.MAX_SAFE_INTEGER (~9e15).
 */

export const BLOCK_SIZE = 500;

export type ParsedTicketId = {
  prefix: string;
  numeric: number;
  width: number;
};

export const parseTicketId = (ticketId: string): ParsedTicketId | null => {
  const match = /^([A-Za-z]*)(\d+)$/.exec(ticketId);
  if (!match) return null;
  const numericStr = match[2];
  return {
    prefix: match[1],
    numeric: Number(numericStr),
    width: numericStr.length,
  };
};

/** Throws if the ID doesn't parse — use only when a parse failure is a bug. */
export const parseTicketIdOrThrow = (ticketId: string): ParsedTicketId => {
  const parsed = parseTicketId(ticketId);
  if (!parsed) throw new Error(`Unparseable ticket ID: ${ticketId}`);
  return parsed;
};

export const formatTicketId = (
  prefix: string,
  numeric: number,
  width: number,
): string => `${prefix}${numeric.toString().padStart(width, '0')}`;

/** Reformats a numeric value using the prefix/width of an anchor ticket ID. */
export const formatLike = (anchorId: string, numeric: number): string => {
  const { prefix, width } = parseTicketIdOrThrow(anchorId);
  return formatTicketId(prefix, numeric, width);
};

/** Numeric start of the block that contains `n` (1-indexed, 500-wide). */
export const blockStartNumeric = (n: number): number =>
  Math.floor((n - 1) / BLOCK_SIZE) * BLOCK_SIZE + 1;

export const blockEndNumeric = (blockStart: number): number =>
  blockStart + BLOCK_SIZE - 1;

export const nextBlockStartNumeric = (blockStart: number): number =>
  blockStart + BLOCK_SIZE;

/** Full ID for the start of the block containing `ticketId`. */
export const blockStartIdOf = (ticketId: string): string => {
  const { prefix, numeric, width } = parseTicketIdOrThrow(ticketId);
  return formatTicketId(prefix, blockStartNumeric(numeric), width);
};

export const blockEndIdOf = (blockStartId: string): string => {
  const { prefix, numeric, width } = parseTicketIdOrThrow(blockStartId);
  return formatTicketId(prefix, blockEndNumeric(numeric), width);
};

export const incrementTicketId = (ticketId: string): string => {
  const parsed = parseTicketId(ticketId);
  if (!parsed) {
    console.warn(`⚠️  Unexpected ticket ID format: ${ticketId}`);
    return `${ticketId}1`;
  }
  return formatTicketId(parsed.prefix, parsed.numeric + 1, parsed.width);
};

/** True if `ticketId`'s numeric value lies in the closed block range. */
export const isWithinBlock = (ticketId: string, blockStartId: string): boolean => {
  const a = parseTicketId(ticketId);
  const b = parseTicketId(blockStartId);
  if (!a || !b) return false;
  const start = blockStartNumeric(b.numeric);
  return a.numeric >= start && a.numeric <= start + BLOCK_SIZE - 1;
};

/**
 * Offset from the start of the block (0 = first ID, 499 = last).
 */
export const offsetInBlock = (ticketId: string): number => {
  const { numeric } = parseTicketIdOrThrow(ticketId);
  return numeric - blockStartNumeric(numeric);
};

/** Remaining IDs in the block at or after this cursor (inclusive of cursor). */
export const remainingInBlock = (cursorId: string): number => {
  const { numeric } = parseTicketIdOrThrow(cursorId);
  return blockEndNumeric(blockStartNumeric(numeric)) - numeric + 1;
};
