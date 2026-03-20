/**
 * Parser registry for D3 console command responses.
 *
 * Each command can register a parser that converts raw text into
 * structured data. Unknown commands pass through as raw text.
 */

export interface ParsedResponse<T = unknown> {
  command: string;
  raw: string;
  parsed: T | null;
}

type ParserFn<T = unknown> = (raw: string) => T | null;

export class ResponseParser {
  private parsers = new Map<string, ParserFn>();

  register<T>(command: string, parser: ParserFn<T>): void {
    this.parsers.set(command, parser as ParserFn);
  }

  parse<T = unknown>(command: string, raw: string): ParsedResponse<T> {
    const parser = this.parsers.get(command);
    return {
      command,
      raw,
      parsed: parser ? (parser(raw) as T | null) : null,
    };
  }

  has(command: string): boolean {
    return this.parsers.has(command);
  }
}
