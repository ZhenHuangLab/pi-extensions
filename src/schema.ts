import { Type, type Static } from "typebox";

export const DEFAULT_XAI_SEARCH_MODEL = "grok-4.5";
export const DEFAULT_XAI_SEARCH_TIMEOUT_MS = 300_000;

export const xaiSearchSchema = Type.Object(
  {
    query: Type.String({
      description: "What to search for on X (Twitter)",
      minLength: 1,
    }),
    model: Type.Optional(
      Type.String({
        description: "xAI model for this search (default: grok-4.5)",
        minLength: 1,
      }),
    ),
    from_date: Type.Optional(
      Type.String({
        description: "Include posts on or after this date (YYYY-MM-DD, UTC)",
      }),
    ),
    to_date: Type.Optional(
      Type.String({
        description: "Include posts on or before this date (YYYY-MM-DD, UTC)",
      }),
    ),
  },
  { additionalProperties: false },
);

export type XaiSearchParams = Static<typeof xaiSearchSchema>;

export interface NormalizedXaiSearchRequest {
  query: string;
  model: string;
  fromDate?: string;
  toDate?: string;
}

function normalizeDate(
  value: string | undefined,
  field: "from_date" | "to_date",
): string | undefined {
  if (value === undefined) return undefined;

  const normalized = value.trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(normalized)) {
    throw new Error(`${field} must use YYYY-MM-DD format`);
  }

  const parsed = new Date(`${normalized}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== normalized) {
    throw new Error(`${field} must be a valid calendar date`);
  }

  return normalized;
}

export function normalizeXaiSearchParams(params: XaiSearchParams): NormalizedXaiSearchRequest {
  const query = params.query.trim();
  if (!query) throw new Error("query must not be empty");

  const model = params.model?.trim() ?? DEFAULT_XAI_SEARCH_MODEL;
  if (!model) throw new Error("model must not be empty");

  const fromDate = normalizeDate(params.from_date, "from_date");
  const toDate = normalizeDate(params.to_date, "to_date");
  if (fromDate && toDate && fromDate > toDate) {
    throw new Error("from_date must be on or before to_date");
  }

  return {
    query,
    model,
    ...(fromDate ? { fromDate } : {}),
    ...(toDate ? { toDate } : {}),
  };
}
