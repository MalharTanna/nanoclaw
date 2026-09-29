import { describe, expect, it } from 'vitest';

import { documentMimetype } from './whatsapp.js';

describe('documentMimetype', () => {
  it('names common document types so phones can open them (not ".bin")', () => {
    expect(documentMimetype('.pdf')).toBe('application/pdf');
    expect(documentMimetype('.PDF')).toBe('application/pdf');
    expect(documentMimetype('.docx')).toBe('application/vnd.openxmlformats-officedocument.wordprocessingml.document');
    expect(documentMimetype('.xlsx')).toBe('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  });

  it('falls back to octet-stream for unknown types', () => {
    expect(documentMimetype('.xyz')).toBe('application/octet-stream');
  });
});
