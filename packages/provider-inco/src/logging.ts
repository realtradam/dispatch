import type { Logger, Span } from "@dispatch/kernel";
import type { CreateOpenAICompatProviderOpts } from "@dispatch/openai-stream";

export type IncoFetch = NonNullable<CreateOpenAICompatProviderOpts["fetchFn"]>;

export function maskIncoSecret(value: string): string {
  const length = value.length;
  const reveal = length >= 13 ? 3 : length >= 11 ? 2 : length >= 8 ? 1 : 0;
  return reveal ? `${value.slice(0, reveal)}…redacted…${value.slice(-reveal)}` : "…redacted…";
}

export function redactIncoText(text: string, apiKey: string): string {
  return text.replaceAll(apiKey, maskIncoSecret(apiKey));
}

function safely(action: () => void): void {
  try {
    action();
  } catch {
    // Logging is one-way and must never fail an inference request.
  }
}

function headersForLog(headers: Headers, key: string): Record<string, string> {
  const result: Record<string, string> = {};
  headers.forEach((value, name) => {
    result[name] = /^(authorization|proxy-authorization|cookie|set-cookie|x-api-key)$/i.test(name)
      ? name === "authorization" && value.startsWith("Bearer ")
        ? `Bearer ${maskIncoSecret(value.slice(7))}`
        : maskIncoSecret(value)
      : redactIncoText(value, key);
  });
  return result;
}

/** Capture post-transform bytes once, without teeing/buffering ahead of the consumer. */
export function captureIncoFetch(fetchFn: IncoFetch, logger: Logger, apiKey: string): IncoFetch {
  return async (input, init) => {
    let span: Span | undefined;
    const url = String(input instanceof Request ? input.url : input);
    safely(() => {
      span = logger.span(
        "provider.request",
        { method: init?.method ?? "GET", url: redactIncoText(url, apiKey) },
        () =>
          JSON.stringify({
            headers: headersForLog(new Headers(init?.headers), apiKey),
            body: typeof init?.body === "string" ? redactIncoText(init.body, apiKey) : null,
          }),
      );
    });
    let ended = false;
    const end = (body: string, err?: unknown) => {
      if (ended) return;
      ended = true;
      safely(() =>
        span?.end({
          body: redactIncoText(body, apiKey),
          ...(err === undefined ? {} : { err: "inco upstream request failed" }),
        }),
      );
    };
    try {
      const response = await fetchFn(input, init);
      safely(() =>
        span?.setAttributes({
          status: response.status,
          responseHeaders: JSON.stringify(headersForLog(response.headers, apiKey)),
        }),
      );
      if (!response.body) {
        end("");
        return response;
      }
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let body = "";
      const stream = new ReadableStream<Uint8Array>({
        async pull(controller) {
          try {
            const part = await reader.read();
            if (part.done) {
              body += decoder.decode();
              end(body, response.ok ? undefined : "HTTP failure");
              reader.releaseLock();
              controller.close();
            } else {
              body += decoder.decode(part.value, { stream: true });
              controller.enqueue(part.value);
            }
          } catch (err) {
            end(body, err);
            reader.releaseLock();
            controller.error(err);
          }
        },
        async cancel(reason) {
          end(body);
          try {
            await reader.cancel(reason);
          } finally {
            reader.releaseLock();
          }
        },
      });
      return new Response(stream, {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
      });
    } catch (err) {
      end("", err);
      throw err;
    }
  };
}
