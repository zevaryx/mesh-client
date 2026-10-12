// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';

import { isWebHost, usesInlineEmojiPicker } from './hostKind';

function stubApi(hostKind: 'desktop' | 'web', platform: string): void {
  Object.defineProperty(window, 'electronAPI', {
    value: { hostKind, getPlatform: () => platform },
    configurable: true,
    writable: true,
  });
}

describe('hostKind', () => {
  beforeEach(() => {
    stubApi('desktop', 'linux');
  });

  it.each(['linux', 'darwin', 'win32'])(
    'uses the inline emoji picker in a browser tab on any server OS (%s)',
    (platform) => {
      stubApi('web', platform);
      expect(isWebHost()).toBe(true);
      expect(usesInlineEmojiPicker()).toBe(true);
    },
  );

  it('keeps the desktop rule: inline on Linux, the OS panel on macOS and Windows', () => {
    expect(isWebHost()).toBe(false);
    expect(usesInlineEmojiPicker()).toBe(true);
    stubApi('desktop', 'darwin');
    expect(usesInlineEmojiPicker()).toBe(false);
    stubApi('desktop', 'win32');
    expect(usesInlineEmojiPicker()).toBe(false);
  });
});
