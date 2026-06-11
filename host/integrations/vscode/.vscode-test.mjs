import { defineConfig } from '@vscode/test-cli';
import * as os from 'os';
import * as path from 'path';

// macOS Unix domain socket 路径上限 103 字符：默认 user-data-dir 在深层目录会超限，放到短 /tmp 下。
const userDataDir = path.join(os.tmpdir(), 'ohprev-vsct-ud');

export default defineConfig({
  files: 'test/suite/**/*.test.js',
  launchArgs: ['--user-data-dir', userDataDir],
  mocha: { ui: 'bdd', timeout: 120000 },
});
