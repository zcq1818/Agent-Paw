import { spawn } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// 清除所有 CI 相关的环境变量
const env = Object.assign({}, process.env);
delete env.CI;
delete env.TAURI_CI;

console.log('Starting Tauri build...');

const tauriProcess = spawn(
  'node',
  [path.join(__dirname, 'node_modules', '@tauri-apps', 'cli', 'tauri.js'), 'build'],
  {
    cwd: __dirname,
    env: env,
    stdio: 'inherit'
  }
);

tauriProcess.on('exit', (code) => {
  console.log(`Tauri build exited with code ${code}`);
  process.exit(code);
});
