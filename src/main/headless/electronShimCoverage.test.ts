// @vitest-environment node
/**
 * Every Electron member reachable from the headless server must exist on the shim.
 *
 * A missing named export already fails the headless build, but a missing *member*
 * (`BrowserWindow.getFocusedWindow`, `shell.showItemInFolder`, …) compiles and only throws
 * "is not a function" when a user hits that path. This walks the real bundle graph and checks
 * each `name.member` used by a module that imports from `electron`.
 */
import fs from 'node:fs';
import path from 'node:path';

import * as esbuild from 'esbuild';
import { describe, expect, it } from 'vitest';

import * as shim from './electronShim';

const ROOT = path.resolve(__dirname, '../../..');

async function bundleInputs(): Promise<string[]> {
  const result = await esbuild.build({
    absWorkingDir: ROOT,
    entryPoints: ['src/main/headless/index.ts'],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    write: false,
    metafile: true,
    logLevel: 'silent',
    alias: {
      electron: './src/main/headless/electronShim.ts',
      'electron-updater': './src/main/headless/electronUpdaterUnavailable.ts',
    },
    define: { __MESH_CLIENT_APP_VERSION__: '"0"', __MESH_CLIENT_BUILD_INFO__: '""' },
  });
  return Object.keys(result.metafile.inputs).filter(
    (f) => f.startsWith('src/') && f.endsWith('.ts') && !f.startsWith('src/main/headless/'),
  );
}

/** Value (non-type) names a source imports from 'electron' (`import { a, type B } from 'electron'`). */
function electronValueImports(source: string): string[] {
  const names: string[] = [];
  let from = 0;
  for (;;) {
    const at = source.indexOf("from 'electron'", from);
    if (at < 0) break;
    from = at + 1;
    const start = source.lastIndexOf('import', at);
    const clause = source.slice(start + 'import'.length, at).trim();
    if (clause.startsWith('type ')) continue;
    const open = clause.indexOf('{');
    const close = clause.indexOf('}');
    if (open < 0 || close < open) continue;
    for (const part of clause.slice(open + 1, close).split(',')) {
      const p = part.trim();
      if (!p || p.startsWith('type ')) continue;
      names.push(p.split(' as ').pop()?.trim() ?? p);
    }
  }
  return names;
}

describe('headless electron shim coverage', () => {
  it('provides every Electron member the bundled main-process modules use', async () => {
    const shimExports = shim as unknown as Record<string, unknown>;
    const missing: string[] = [];
    for (const file of await bundleInputs()) {
      const source = fs.readFileSync(path.join(ROOT, file), 'utf8');
      for (const name of electronValueImports(source)) {
        const target = shimExports[name];
        if (target === undefined) {
          missing.push(`${file}: ${name}`);
          continue;
        }
        for (const m of source.matchAll(/\b([A-Za-z_$][\w$]*)\.([A-Za-z_$][\w$]*)/g)) {
          if (m[1] !== name) continue;
          const member = m[2] ?? '';
          if ((target as Record<string, unknown>)[member] === undefined) {
            missing.push(`${file}: ${name}.${member}`);
          }
        }
      }
    }
    expect([...new Set(missing)]).toEqual([]);
  }, 60_000);
});
