/**
 * Custom ticket fields (Settings → Tickets → Ticket fields). Definitions live
 * in ticket_fields; values in tickets.custom_fields, keyed by the field's key
 * (migration 20261105090000). These helpers are shared by the server actions
 * (the real check) and the forms (inline errors).
 */

export type TicketFieldType = 'text' | 'number' | 'dropdown' | 'checkbox' | 'date';

export const TICKET_FIELD_TYPES: { id: TicketFieldType; label: string }[] = [
  { id: 'text', label: 'Text' },
  { id: 'number', label: 'Number' },
  { id: 'dropdown', label: 'Dropdown' },
  { id: 'checkbox', label: 'Checkbox' },
  { id: 'date', label: 'Date' },
];

export interface TicketField {
  id: string;
  key: string;
  label: string;
  type: TicketFieldType;
  options: string[];
  description: string;
  required: boolean;
  is_active: boolean;
  position: number;
}

export type TicketFieldValue = string | number | boolean | null;

/** "Order number" → "order_number" (a stable key for the values). */
export function fieldKeyFrom(label: string): string {
  const base = label
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 40);
  if (!base) return 'field';
  return /^[a-z]/.test(base) ? base : `f_${base}`.slice(0, 40);
}

export function validateFieldDefinition(input: { label: string; type: string; options?: string[] }): string | null {
  const label = (input.label || '').trim();
  if (!label) return 'Give the field a name.';
  if (label.length > 60) return 'Keep the name under 60 characters.';
  if (!TICKET_FIELD_TYPES.some((t) => t.id === input.type)) return 'Choose a field type.';
  if (input.type === 'dropdown') {
    const options = cleanOptions(input.options || []);
    if (!options.length) return 'A dropdown needs at least one option.';
    if (options.length > 50) return 'A dropdown can have at most 50 options.';
  }
  return null;
}

/** Trimmed, non-empty, unique, at most 80 characters each. */
export function cleanOptions(options: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const o of options) {
    const v = String(o || '').trim().slice(0, 80);
    if (v && !seen.has(v.toLowerCase())) {
      seen.add(v.toLowerCase());
      out.push(v);
    }
  }
  return out;
}

/**
 * Checks and normalises one value for its field. Empty means "clear it".
 * Returns the value to store, or an error message.
 */
export function normalizeFieldValue(field: Pick<TicketField, 'type' | 'options' | 'label'>, raw: unknown): { value: TicketFieldValue } | { error: string } {
  if (raw === null || raw === undefined || raw === '') return { value: null };
  switch (field.type) {
    case 'text': {
      const v = String(raw).trim();
      if (v.length > 500) return { error: `${field.label}: at most 500 characters.` };
      return { value: v || null };
    }
    case 'number': {
      const n = typeof raw === 'number' ? raw : Number(String(raw).trim());
      if (!Number.isFinite(n)) return { error: `${field.label}: enter a number.` };
      return { value: n };
    }
    case 'dropdown': {
      const v = String(raw);
      if (!field.options.includes(v)) return { error: `${field.label}: choose one of the options.` };
      return { value: v };
    }
    case 'checkbox':
      return { value: raw === true || raw === 'true' };
    case 'date': {
      const v = String(raw);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(v) || Number.isNaN(Date.parse(v))) return { error: `${field.label}: enter a date.` };
      return { value: v };
    }
    default:
      return { error: 'Unknown field type.' };
  }
}
