import { describe, expect, test } from 'bun:test';

import { InterimTextBuffer } from './claude.js';

const text = (t: string) => ({ type: 'text', text: t });
const toolUse = { type: 'tool_use', id: 'tu1', name: 'WebSearch', input: {} };
const assistant = (...content: object[]) => ({ type: 'assistant', parent_tool_use_id: null, message: { content } });

describe('InterimTextBuffer', () => {
  test('releases <message> text once a later tool_use proves it was mid-turn', () => {
    const b = new InterimTextBuffer();
    expect(b.onAssistant(assistant(text('<message to="g">first answer</message>')))).toEqual([]);
    expect(b.onAssistant(assistant(toolUse))).toEqual(['<message to="g">first answer</message>']);
  });

  test('handles text and tool_use in the same assistant message', () => {
    const b = new InterimTextBuffer();
    expect(b.onAssistant(assistant(text('<message to="g">a</message>'), toolUse))).toEqual([
      '<message to="g">a</message>',
    ]);
  });

  test('drops pending text at result — that text is the final result', () => {
    const b = new InterimTextBuffer();
    b.onAssistant(assistant(text('<message to="g">final</message>')));
    b.onResult();
    expect(b.onAssistant(assistant(toolUse))).toEqual([]);
  });

  test('ignores text without a <message> envelope (scratchpad)', () => {
    const b = new InterimTextBuffer();
    b.onAssistant(assistant(text('Let me search for that.')));
    expect(b.onAssistant(assistant(toolUse))).toEqual([]);
  });

  test('ignores subagent output', () => {
    const b = new InterimTextBuffer();
    b.onAssistant({ ...assistant(text('<message to="g">sub</message>')), parent_tool_use_id: 'task-1' });
    expect(b.onAssistant(assistant(toolUse))).toEqual([]);
  });

  test('releases each mid-turn answer once, in order', () => {
    const b = new InterimTextBuffer();
    b.onAssistant(assistant(text('<message to="g">one</message>')));
    expect(b.onAssistant(assistant(toolUse))).toEqual(['<message to="g">one</message>']);
    b.onAssistant(assistant(text('<message to="g">two</message>')));
    expect(b.onAssistant(assistant(toolUse))).toEqual(['<message to="g">two</message>']);
    expect(b.onAssistant(assistant(toolUse))).toEqual([]);
  });
});
