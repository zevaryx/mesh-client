// @vitest-environment node
import { describe, expect, it } from 'vitest';

import { parseSmokeArgs } from './headless-smoke.mjs';

describe('headless-smoke args', () => {
  it('reads url, token, browser and screenshot and trims trailing slashes', () => {
    expect(
      parseSmokeArgs([
        '--url',
        'http://127.0.0.1:9000//',
        '--token',
        'tok',
        '--browser',
        '/usr/bin/google-chrome',
        '--screenshot',
        'out.png',
      ]),
    ).toEqual({
      url: 'http://127.0.0.1:9000',
      token: 'tok',
      browser: '/usr/bin/google-chrome',
      screenshot: 'out.png',
    });
  });

  it('rejects unknown flags and missing values', () => {
    expect(() => parseSmokeArgs(['--nope', 'x'])).toThrow('unknown argument');
    expect(() => parseSmokeArgs(['--token'])).toThrow('--token needs a value');
  });
});
