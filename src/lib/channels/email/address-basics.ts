/**
 * Address helpers with no Node-only imports, so client components (the email
 * settings form) can validate with the same code the server uses.
 */

const EMAIL = /^[^\s@<>"]+@[^\s@<>"]+\.[^\s@<>"]+$/;

export function isEmail(value: string | null | undefined): value is string {
  return Boolean(value) && value!.length <= 254 && EMAIL.test(value!);
}

export function normalizeEmail(value: string): string {
  return value.trim().toLowerCase();
}


export function domainOf(address: string): string {
  return normalizeEmail(address).split('@')[1] || '';
}
