// バックエンドと同じ、trim後のUnicodeコードポイント数。
export interface TextLimits { characters?: number; bytes?: number }
function positiveInteger(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n <= 0) throw new Error('本文上限の設定は正の整数にしてください。');
  return n;
}
export const textLimits: TextLimits = {
  characters: positiveInteger(import.meta.env.VITE_POST_MAX_CHARACTERS) ?? 500,
  bytes: positiveInteger(import.meta.env.VITE_POST_MAX_BYTES),
};
export function measureText(text: string) {
  return { characters: Array.from(text).length, bytes: new TextEncoder().encode(text).length };
}
export function validateText(text: string, limits: TextLimits = textLimits): string | null {
  const value = text.trim();
  const { characters, bytes } = measureText(value);
  if (!value) return '本文を入力してください。';
  if (limits.characters && characters > limits.characters) return `本文は${limits.characters.toLocaleString()}文字以内にしてください。`;
  if (limits.bytes && bytes > limits.bytes) return `本文のデータ量は${limits.bytes.toLocaleString()}バイト以内にしてください。`;
  return null;
}
