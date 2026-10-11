'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

function fail(message) {
  console.error(message);
  process.exit(1);
}

const args = process.argv.slice(2);
const sourceFlag = args.indexOf('--source');
const modeFlag = args.indexOf('--mode');
const apply = args.includes('--apply');
if (sourceFlag < 0 || !args[sourceFlag + 1] || modeFlag < 0 || !args[modeFlag + 1]) {
  fail('用法：node scripts/restore-progress.js --source /path/to/backup.json --mode content|all [--apply]');
}
const mode = args[modeFlag + 1];
if (!['content', 'all'].includes(mode)) fail('mode 只能是 content 或 all');

const dataDir = path.resolve(process.env.DATA_DIR || path.join(__dirname, '..', 'data'));
const dataFile = path.join(dataDir, 'data.json');
const sourceFile = path.resolve(args[sourceFlag + 1]);
if (sourceFile === dataFile) fail('来源文件不能是正在运行的 data.json');
if (!fs.existsSync(dataFile)) fail('当前 data.json 不存在，先初始化教师账号');

function readData(file) {
  let value;
  try { value = JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (error) { fail(`读取 ${file} 失败：${error.message}`); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`${file} 不是有效的数据对象`);
  for (const key of ['modules', 'businesses', 'statements', 'students']) {
    if (!Array.isArray(value[key])) fail(`${file} 缺少数组字段 ${key}`);
  }
  return value;
}

const current = readData(dataFile);
const source = readData(sourceFile);
if (!current.teacher?.phone || !current.teacher?.salt || !current.teacher?.hash) fail('当前教师账号不完整，已拒绝恢复');

const next = {
  teacher: current.teacher,
  modules: source.modules,
  businesses: source.businesses,
  statements: source.statements,
  students: mode === 'all' ? source.students : current.students,
  sessions: {}
};
const rawSource = fs.readFileSync(sourceFile);
console.log(JSON.stringify({
  mode,
  source: sourceFile,
  sourceSha256: crypto.createHash('sha256').update(rawSource).digest('hex'),
  before: { modules: current.modules.length, businesses: current.businesses.length, statements: current.statements.length, students: current.students.length },
  after: { modules: next.modules.length, businesses: next.businesses.length, statements: next.statements.length, students: next.students.length },
  teacher: '保留服务器现有账号', sessions: '清空旧登录会话'
}, null, 2));
if (!apply) {
  console.log('仅预览；确认后加 --apply 执行。执行前请停止 silvia 服务。');
  process.exit(0);
}

const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const backupFile = path.join(dataDir, `data-before-restore-${stamp}.json`);
fs.copyFileSync(dataFile, backupFile, fs.constants.COPYFILE_EXCL);
fs.chmodSync(backupFile, 0o600);
const tempFile = path.join(dataDir, `.data-restore-${process.pid}.tmp`);
try {
  fs.writeFileSync(tempFile, JSON.stringify(next), { encoding: 'utf8', mode: 0o600, flag: 'wx' });
  fs.renameSync(tempFile, dataFile);
  const backupTemp = path.join(dataDir, `.data-backup-restore-${process.pid}.tmp`);
  try {
    fs.copyFileSync(dataFile, backupTemp, fs.constants.COPYFILE_EXCL);
    fs.chmodSync(backupTemp, 0o600);
    fs.renameSync(backupTemp, path.join(dataDir, 'data_backup.json'));
  } catch (error) {
    try { fs.unlinkSync(backupTemp); } catch (_) { /* 临时文件可能不存在 */ }
    console.warn(`主数据已恢复，但即时副本更新失败：${error.message}`);
  }
} catch (error) {
  try { fs.unlinkSync(tempFile); } catch (_) { /* 临时文件可能不存在 */ }
  fail(`恢复失败，原数据备份位于 ${backupFile}：${error.message}`);
}
console.log(`恢复完成；原数据备份：${backupFile}`);
