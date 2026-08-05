import { zodToJsonSchema } from 'zod-to-json-schema';
import type { ZodTypeAny } from 'zod';

type JsonObject = Record<string, unknown>;

export function toMcpInputSchema(schema: ZodTypeAny): Record<string, unknown> {
  const jsonSchema = zodToJsonSchema(schema, {
    target: 'jsonSchema7',
    $refStrategy: 'none',
  }) as JsonObject;
  const normalized = normalizeDraft202012InputSchema(jsonSchema);
  return isJsonObject(normalized) ? normalized : {};
}

function normalizeDraft202012InputSchema(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalizeDraft202012InputSchema);
  if (!isJsonObject(value)) return value;

  const normalized: JsonObject = {};
  for (const [key, child] of Object.entries(value)) {
    if (key === '$schema' || key === 'definitions') continue;
    if (key === 'items' && Array.isArray(child)) {
      normalized['prefixItems'] = child.map(normalizeDraft202012InputSchema);
      continue;
    }
    if (key === 'additionalItems') {
      normalized['items'] =
        typeof child === 'boolean' ? child : normalizeDraft202012InputSchema(child);
      continue;
    }
    normalized[key] = normalizeDraft202012InputSchema(child);
  }
  return normalized;
}

function isJsonObject(value: unknown): value is JsonObject {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
