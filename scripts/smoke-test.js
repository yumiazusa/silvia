'use strict';

const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'silvia-smoke-'));
const dataDir = path.join(tmp, 'data');
fs.mkdirSync(dataDir, { mode: 0o700 });
const salt = crypto.randomBytes(16).toString('hex');
const password = 'test-password';
const dataFile = path.join(dataDir, 'data.json');
fs.writeFileSync(dataFile, JSON.stringify({
  teacher: { phone: '10000000000', salt, hash: crypto.scryptSync(password, salt, 32).toString('hex') },
  modules: [], businesses: [], statements: [], students: [], sessions: {}
}), { mode: 0o600 });

function freePort() {
  return new Promise((resolve, reject) => {
    const socket = net.createServer();
    socket.once('error', reject);
    socket.listen(0, '127.0.0.1', () => {
      const port = socket.address().port;
      socket.close(() => resolve(port));
    });
  });
}

async function start(port) {
  const child = spawn(process.execPath, [path.join(root, 'server.js')], {
    env: { ...process.env, HOST: '127.0.0.1', PORT: String(port), DATA_DIR: dataDir },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let output = '';
  child.stdout.on('data', chunk => { output += chunk; });
  child.stderr.on('data', chunk => { output += chunk; });
  for (let i = 0; i < 60; i++) {
    if (child.exitCode !== null) throw new Error('服务启动失败：' + output);
    try {
      const response = await fetch(`http://127.0.0.1:${port}/`);
      if (response.status === 200) return child;
    } catch (_) { /* 等待监听 */ }
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  child.kill('SIGTERM');
  throw new Error('服务启动超时：' + output);
}

function stop(child) {
  return new Promise(resolve => {
    if (child.exitCode !== null) return resolve();
    child.once('exit', resolve);
    child.kill('SIGTERM');
  });
}

async function request(port, route, method = 'GET', body, token) {
  const response = await fetch(`http://127.0.0.1:${port}${route}`, {
    method,
    headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined
  });
  return { status: response.status, data: await response.json() };
}

async function main() {
  const port = await freePort();
  let child;
  try {
    child = await start(port);
    const setup = await request(port, '/api/teacher/setup', 'POST', { phone: 'attacker', password: 'test' });
    assert.equal(setup.status, 401);
    const login = await request(port, '/api/teacher/login', 'POST', { phone: '10000000000', password });
    assert.equal(login.status, 200);
    const state = await request(port, '/api/teacher/state', 'GET', null, login.data.token);
    assert.equal(state.data.modules.length, 8);
    assert.equal(state.data.statements.length, 2);
    assert.equal(state.data.businesses.length, 0);
    const student = await request(port, '/api/student/login', 'POST', { cls: '测试班', name: '测试学生', stuid: '01' });
    assert.equal(student.status, 200);
    const tasks = await request(port, '/api/student/tasks', 'GET', null, student.data.token);
    assert.equal(tasks.status, 200);
    await stop(child);
    child = await start(port);
    const login2 = await request(port, '/api/teacher/login', 'POST', { phone: '10000000000', password });
    const students = await request(port, '/api/teacher/students', 'GET', null, login2.data.token);
    assert.equal(students.data.students.length, 1);
    await stop(child);
    child = null;
    fs.writeFileSync(dataFile, '{bad json', { mode: 0o600 });
    const bad = spawn(process.execPath, [path.join(root, 'server.js')], {
      env: { ...process.env, DATA_DIR: dataDir, PORT: String(port) }, stdio: 'ignore'
    });
    const exitCode = await new Promise(resolve => bad.once('exit', resolve));
    assert.notEqual(exitCode, 0);
    console.log('冒烟测试通过：教师登录、初始题库、学生建档、重启持久化、损坏数据拒绝启动');
  } finally {
    if (child) await stop(child);
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
