import { describe, expect, it } from 'vitest';
import { mentionQuery, mentionedIds, splitMentions } from './mentions';

const people = [
  { id: 'ali', name: 'Ali' },
  { id: 'alik', name: 'Ali Khan' },
  { id: 'sara', name: 'Sara' },
];

describe('team chat mentions', () => {
  it('finds the people whose @name is in the text', () => {
    expect(mentionedIds('@Sara can you check?', people)).toEqual(['sara']);
    expect(mentionedIds('Ask @Ali Khan and @sara', people).sort()).toEqual(['alik', 'sara']);
  });

  it('a longer name is not also counted as the shorter one', () => {
    expect(mentionedIds('@Ali Khan please', people)).toEqual(['alik']);
  });

  it('ignores emails and names glued to words', () => {
    expect(mentionedIds('mail ali@Sara.com', people)).toEqual([]);
    expect(mentionedIds('@Saraa', people)).toEqual([]);
  });

  it('knows when an @name is being typed', () => {
    expect(mentionQuery('hey @Sa', 7)).toEqual({ start: 4, query: 'Sa' });
    expect(mentionQuery('hey @', 5)).toEqual({ start: 4, query: '' });
    expect(mentionQuery('mail a@b', 8)).toBeNull();
  });

  it('splits text for highlighting', () => {
    expect(splitMentions('hi @Sara, look', ['Sara'])).toEqual([
      { text: 'hi ', mention: false },
      { text: '@Sara', mention: true },
      { text: ', look', mention: false },
    ]);
  });
});
