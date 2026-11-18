import { describe, expect, it } from 'vitest';
import { measureText, validateText } from '../src/textValidation';

describe('共通の本文検証', () => {
  it('日本語・絵文字の文字数とUTF-8バイト数を区別する', () => {
    expect(measureText('田🙂')).toEqual({ characters: 2, bytes: 7 });
    expect(validateText('田🙂', { characters: 2, bytes: 7 })).toBeNull();
    expect(validateText('田🙂', { characters: 1 })).toContain('1文字');
    expect(validateText('田🙂', { bytes: 6 })).toContain('6バイト');
  });
  it.each(['田', '🙂', 'a'])('500文字は許可し501文字を拒否する: %s', char => {
    expect(validateText(' ' + char.repeat(500) + '\n')).toBeNull();
    expect(validateText(char.repeat(501))).toContain('500文字');
  });
  it('上限が未合意なら独自に5000文字で切り捨てず、空白のみは拒否する', () => {
    expect(validateText('田'.repeat(5001), {})).toBeNull();
    expect(validateText(' \n ', {})).toBe('本文を入力してください。');
  });
});
