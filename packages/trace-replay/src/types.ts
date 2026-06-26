export interface HttpExchangeFixture {
  readonly request: {
    readonly method: string;
    readonly url: string;
    readonly headers: Record<string, string>;
    readonly body: string | null;
  };
  readonly response: {
    readonly status: number;
    readonly statusText?: string;
    readonly headers: Record<string, string>;
    readonly body: string;
  };
  readonly meta?: Record<string, string | number | boolean | null>;
}

export interface CapturedRequest {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: string | null;
}

export type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
