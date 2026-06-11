import { defineConfig } from '@vscode/test-cli';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';

// macOS Unix domain socket 路径上限 103 字符：默认 user-data-dir 在深层目录会超限，放到短 /tmp 下。
const userDataDir = path.join(os.tmpdir(), 'ohprev-vsct-ud');
// 以 sample_in_harmonyos 作工作区 → 自动发现/自动选择 E2E（Stage→rich）有真实工程根可探测。
const ws = process.env.OHPREV_WS || '/Users/sanchuan/Documents/sample_in_harmonyos';

export default defineConfig({
  files: 'test/suite/**/*.test.js',
  workspaceFolder: fs.existsSync(ws) ? ws : undefined,
  launchArgs: ['--user-data-dir', userDataDir],
  mocha: { ui: 'bdd', timeout: 120000 },
});
