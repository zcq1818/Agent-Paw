import { spawn } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// 清除所有 CI 相关的环境变量
const env = Object.assign({}, process.env);
delete env.CI;
delete env.TAURI_CI;

// 自动更新的签名私钥：只放在本机（默认 ~/.tauri/paw-updater.key），绝不进仓库。
// 没有私钥（比如别人克隆下来自己打包）就不生成更新包，安装包照常能打。
const args = [path.join(__dirname, 'node_modules', '@tauri-apps', 'cli', 'tauri.js'), 'build'];
const keyPath = env.PAW_UPDATER_KEY || path.join(os.homedir(), '.tauri', 'paw-updater.key');
if (!env.TAURI_SIGNING_PRIVATE_KEY && fs.existsSync(keyPath)) {
  env.TAURI_SIGNING_PRIVATE_KEY = fs.readFileSync(keyPath, 'utf8').trim();
  env.TAURI_SIGNING_PRIVATE_KEY_PASSWORD = env.TAURI_SIGNING_PRIVATE_KEY_PASSWORD || '';
  console.log('Signing updater artifacts with', keyPath);
} else if (!env.TAURI_SIGNING_PRIVATE_KEY) {
  console.log('No updater signing key found, skipping updater artifacts.');
  args.push('--config', JSON.stringify({ bundle: { createUpdaterArtifacts: false } }));
}

console.log('Starting Tauri build...');

const tauriProcess = spawn('node', args, {
  cwd: __dirname,
  env: env,
  stdio: 'inherit'
});

tauriProcess.on('exit', (code) => {
  console.log(`Tauri build exited with code ${code}`);
  process.exit(code);
});
