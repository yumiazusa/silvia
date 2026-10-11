'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const dataDir = path.resolve(process.env.DATA_DIR || path.join(__dirname, '..', 'data'));
const dataFile = path.join(dataDir, 'data.json');

function prompt(label, secret = false) {
  if (!process.stdin.isTTY) throw new Error('请在交互式终端运行教师初始化');
  return new Promise((resolve, reject) => {
    let value = '';
    const input = process.stdin;
    process.stdout.write(label);
    input.setRawMode(true);
    input.resume();
    const finish = (error) => {
      input.off('data', onData);
      input.setRawMode(false);
      input.pause();
      process.stdout.write('\n');
      if (error) reject(error);
      else resolve(value.trim());
    };
    const onData = (buffer) => {
      for (const char of buffer.toString('utf8')) {
        if (char === '\r' || char === '\n') return finish();
        if (char === '\u0003') return finish(new Error('已取消'));
        if (char === '\u007f' || char === '\b') {
          if (value.length) {
            value = value.slice(0, -1);
            if (!secret) process.stdout.write('\b \b');
          }
          continue;
        }
        value += char;
        if (!secret) process.stdout.write(char);
      }
    };
    input.on('data', onData);
  });
}

async function main() {
  fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const data = fs.existsSync(dataFile)
    ? JSON.parse(fs.readFileSync(dataFile, 'utf8'))
    : { teacher: null, modules: [], businesses: [], statements: [], students: [], sessions: {} };
  if (data.teacher) throw new Error('教师账号已存在，初始化不会覆盖现有账号');

  const phone = await prompt('教师手机号：');
  const password = await prompt('教师密码（输入时不显示）：', true);
  const confirmation = await prompt('再次输入密码：', true);
  if (!phone || !password) throw new Error('手机号和密码不能为空');
  if (password !== confirmation) throw new Error('两次输入的密码不一致');

  const salt = crypto.randomBytes(16).toString('hex');
  data.teacher = { phone, salt, hash: crypto.scryptSync(password, salt, 32).toString('hex') };
  data.sessions = {};
  const tmp = dataFile + '.init.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data), { encoding: 'utf8', mode: 0o600 });
  fs.chmodSync(tmp, 0o600);
  fs.renameSync(tmp, dataFile);
  console.log('教师账号已初始化；密码未保存为明文。');
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
