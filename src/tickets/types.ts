import type { Ticket } from "@prisma/client";

export enum TicketSearchResult {
  ACCESSIBLE = 'accessible',
  CAPTCHA = 'captcha',
  CLOSED = 'closed',
  FAILED_CHALLENGE = 'failed_challenge',
  NO_RESULTS = 'no_results',
}

export type TicketSearchResponse = {
  result: TicketSearchResult;
  ticket: Ticket | null;
};

export enum TicketMessage {
  REMITTANCE = 'that are able to be remitted today',
  CLOSED = "The ticket number you are searching is in a Closed",
  FAILED_CHALLENGE = "Failed Challenge. Please Try Again.",
  NO_RESULTS = "No results found that match your search"
}

enum Backoff {
  TEN_SECONDS = 10000,
  THIRTY_SECONDS = 30000,
  ONE_MINUTE = 60000,
  FIVE_MINUTES = 300000,
}

type BackoffNode = {
  backoff: Backoff;
  next: BackoffNode | null;
}

export const BACKOFF_LIST: BackoffNode = {
  backoff: Backoff.TEN_SECONDS,
  next: {
    backoff: Backoff.THIRTY_SECONDS,
    next: {
      backoff: Backoff.ONE_MINUTE,
      next: null,
    },
  },
};
