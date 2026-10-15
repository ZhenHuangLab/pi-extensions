import { Type, type Static } from "typebox";

export const DEFAULT_XAI_SEARCH_MODEL = "grok-4.5";
export const DEFAULT_XAI_SEARCH_TIMEOUT_MS = 300_000;
const MAX_X_HANDLES = 20;

export const xaiSearchSchema = Type.Object(
  {
    query: Type.String({
      description: "What to search for on X (Twitter)",
      minLength: 1,
    }),
    model: Type.Optional(
      Type.String({
        description: "xAI model override; uses configured model when omitted",
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
    allowed_x_handles: Type.Optional(
      Type.Array(
        Type.String({ description: "X handle, with or without a leading @", minLength: 1 }),
        {
          description: "Only consider posts from these X handles (maximum 20)",
          minItems: 1,
          maxItems: MAX_X_HANDLES,
          uniqueItems: true,
        },
      ),
    ),
    excluded_x_handles: Type.Optional(
      Type.Array(
        Type.String({ description: "X handle, with or without a leading @", minLength: 1 }),
        {
          description: "Exclude posts from these X handles (maximum 20)",
          minItems: 1,
          maxItems: MAX_X_HANDLES,
          uniqueItems: true,
        },
      ),
    ),
    enable_image_understanding: Type.Optional(
      Type.Boolean({ description: "Allow xAI to analyze images found in X posts" }),
    ),
    enable_video_understanding: Type.Optional(
      Type.Boolean({ description: "Allow xAI to analyze videos found in X posts" }),
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
  allowedXHandles?: string[];
  excludedXHandles?: string[];
  enableImageUnderstanding?: boolean;
  enableVideoUnderstanding?: boolean;
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

function normalizeHandles(
  values: string[] | undefined,
  field: "allowed_x_handles" | "excluded_x_handles",
): string[] | undefined {
  if (values === undefined) return undefined;
  if (values.length === 0 || values.length > MAX_X_HANDLES) {
    throw new Error(`${field} must contain between 1 and ${MAX_X_HANDLES} handles`);
  }

  const normalized: string[] = [];
  const seen = new Set<string>();
  for (const [index, value] of values.entries()) {
    const handle = value.trim().replace(/^@/, "");
    if (!/^[A-Za-z0-9_]{1,15}$/.test(handle)) {
      throw new Error(`${field}[${index}] must be a valid X handle`);
    }

    const key = handle.toLowerCase();
    if (seen.has(key)) throw new Error(`${field} must not contain duplicate handles`);
    seen.add(key);
    normalized.push(handle);
  }

  return normalized;
}

function normalizeDateFilters(params: XaiSearchParams): Partial<NormalizedXaiSearchRequest> {
  const fromDate = normalizeDate(params.from_date, "from_date");
  const toDate = normalizeDate(params.to_date, "to_date");
  if (fromDate && toDate && fromDate > toDate) {
    throw new Error("from_date must be on or before to_date");
  }
  return {
    ...(fromDate ? { fromDate } : {}),
    ...(toDate ? { toDate } : {}),
  };
}

function normalizeHandleFilters(params: XaiSearchParams): Partial<NormalizedXaiSearchRequest> {
  const allowedXHandles = normalizeHandles(params.allowed_x_handles, "allowed_x_handles");
  const excludedXHandles = normalizeHandles(params.excluded_x_handles, "excluded_x_handles");
  if (allowedXHandles && excludedXHandles) {
    throw new Error("allowed_x_handles and excluded_x_handles cannot be used together");
  }
  return {
    ...(allowedXHandles ? { allowedXHandles } : {}),
    ...(excludedXHandles ? { excludedXHandles } : {}),
  };
}

function normalizeMediaOptions(params: XaiSearchParams): Partial<NormalizedXaiSearchRequest> {
  return {
    ...(params.enable_image_understanding !== undefined
      ? { enableImageUnderstanding: params.enable_image_understanding }
      : {}),
    ...(params.enable_video_understanding !== undefined
      ? { enableVideoUnderstanding: params.enable_video_understanding }
      : {}),
  };
}

export function normalizeXaiSearchParams(
  params: XaiSearchParams,
  defaultModel = DEFAULT_XAI_SEARCH_MODEL,
): NormalizedXaiSearchRequest {
  const query = params.query.trim();
  if (!query) throw new Error("query must not be empty");

  const model = (params.model ?? defaultModel).trim();
  if (!model) throw new Error("model must not be empty");

  return {
    query,
    model,
    ...normalizeDateFilters(params),
    ...normalizeHandleFilters(params),
    ...normalizeMediaOptions(params),
  };
}
