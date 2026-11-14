/** Domain error with a stable code; messages never carry raw cell values. */
export class VizError extends Error {
  constructor(
    readonly code: string,
    detail?: string,
  ) {
    super(detail ? `${code}: ${detail}` : code);
    this.name = 'VizError';
  }
}

export function fail(code: string, detail?: string): never {
  throw new VizError(code, detail);
}
