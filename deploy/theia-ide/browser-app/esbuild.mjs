// Maintained Theia build configuration. Generated options remain upstream-owned.
import { browserOptions, watch } from './gen-esbuild.browser.mjs';
import { nodeOptions } from './gen-esbuild.node.mjs';

import esbuild from 'esbuild';
import { createRequire } from 'node:module';
import { dirname } from 'node:path';

const require = createRequire(import.meta.url);
// y-monaco shares Theia's exact Monaco modules, including cursor and selection classes.
browserOptions.alias = { ...browserOptions.alias, 'monaco-editor': dirname(require.resolve('@theia/monaco-editor-core/package.json')) };

const browserContext = await esbuild.context(browserOptions);
const nodeContext = await esbuild.context(nodeOptions);


if (watch) {
    await Promise.all([
        browserContext.watch(),
        nodeContext.watch(),
    ]);
} else {
    try {
        await browserContext.rebuild();
        await browserContext.dispose();
        await nodeContext.rebuild();
        await nodeContext.dispose();
    } catch {
        process.exit(1);
    }
}
