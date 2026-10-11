'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '127.0.0.1';
const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(__dirname, 'data'));
const DATA_FILE = path.join(DATA_DIR, 'data.json');
const BACKUP_FILE = path.join(DATA_DIR, 'data_backup.json');
if (!Number.isInteger(PORT) || PORT < 1 || PORT > 65535) throw new Error('PORT 必须是 1-65535 的整数');
fs.mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
let INDEX_HTML = null;      // 页面缓存到内存，避免每次从U盘重复读取
let INDEX_MTIME = -1;       // 缓存时文件的修改时间：文件一改就自动重读，改完刷新页面即生效（无需重启服务）
let lastBackupAt = 0;    // 自动备份节流时间戳

/* ---------------- 数据存储 ---------------- */
let data = {
  teacher: null,            // {phone, salt, hash}
  modules: [],              // {id, name, company, order}
  businesses: [],           // {id, moduleId, title, expected:{date,number,attachments,entries:[{summary,account,direction,amount}]}}
  statements: [],           // {id, moduleId, type:'balance'|'income', title, rows:[{id,label,answer}]}
  students: [],             // {sid, cls, name, stuid, submissions:{key:{...}}, grades:{...}, published:false, lastIp}
  sessions: {}              // token -> {role, ref, ts}
};

/* ---------------- 计分权重 ----------------
   每个模块在“系统评定总分”中的占比（合计 0.90，即满分 90 分）；
   剩余 0.10 为学生手写实验心得，由教师线下批改，不进系统。
   键为模块 order（1-8）。如需调整比例，改这里即可。 */
const MODULE_WEIGHTS = { 1: 0.15, 2: 0.10, 3: 0.10, 4: 0.10, 5: 0.05, 6: 0.10, 7: 0.10, 8: 0.20 };
const HANDWRITING_WEIGHT = 0.10; // 手写心得，线下，不计入系统

function load() {
  if (fs.existsSync(DATA_FILE)) {
    let d;
    try { d = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')); }
    catch (e) { throw new Error('读取 data.json 失败，已停止启动以保护原数据：' + e.message); }
    if (!d || typeof d !== 'object' || Array.isArray(d)) throw new Error('data.json 格式不正确，已停止启动');
    Object.assign(data, d);
  }
  if (!data.teacher || !data.teacher.phone || !data.teacher.salt || !data.teacher.hash) {
    throw new Error('教师账号尚未初始化，请先运行 node scripts/init-teacher.js');
  }
  seedIfEmpty();
}
let saveTimer = null;
let savingNow = false;   // 是否正在写盘
let saveQueued = false;  // 写盘期间又有新改动 -> 写完再补一次
let hasDirty = false;    // 是否有未落盘的数据

/* 清理过期会话：sessions 只增不减会让 data.json 越来越臃肿、每次保存都更慢。
   保留最近 3 天、最多 1000 个（一节课内绝不会被清掉）。 */
function pruneSessions() {
  const KEEP_MS = 3 * 24 * 3600 * 1000, MAX = 1000;
  const s = data.sessions || {};
  const now = Date.now();
  Object.keys(s).forEach(k => {
    const v = s[k];
    if (!v || now - (v.ts || 0) > KEEP_MS) delete s[k];
  });
  let keys = Object.keys(s);
  if (keys.length > MAX) {
    keys.sort((a, b) => (s[b].ts || 0) - (s[a].ts || 0));
    keys.slice(MAX).forEach(k => delete s[k]);
  }
}

/* 真正落盘：异步写 + 原子替换（先写 .tmp 再 rename）。
   - 异步：不阻塞事件循环，一个学生保存时其他人照样能点、能登录
   - 原子：任何时刻 data.json 都是完整文件，中途断电/拔 U 盘也不会写坏 */
async function writeNow() {
  pruneSessions();
  const str = JSON.stringify(data);   // 无缩进：体积更小、序列化更快、写 U 盘更快
  const tmp = DATA_FILE + '.tmp';
  try {
    await fs.promises.writeFile(tmp, str, { encoding: 'utf8', mode: 0o600 });
    await fs.promises.chmod(tmp, 0o600);
    await fs.promises.rename(tmp, DATA_FILE);
    hasDirty = false;
    const now = Date.now();
    if (now - lastBackupAt > 30000) {  // 备份节流 30 秒，避免频繁写 U 盘
      try { await fs.promises.copyFile(DATA_FILE, BACKUP_FILE); await fs.promises.chmod(BACKUP_FILE, 0o600); lastBackupAt = now; }
      catch (e) { console.error('备份失败', e.message); }
    }
  } catch (e) {
    console.error('保存失败', e.message);
  }
}

async function flushPending() {
  if (savingNow) { saveQueued = true; return; }
  savingNow = true;
  try { await writeNow(); }
  finally {
    savingNow = false;
    if (saveQueued) { saveQueued = false; await flushPending(); }
  }
}

/* 对外仍叫 save()，20 处调用点无需改动。
   改为「300 毫秒防抖 + 异步写」：全班同时提交时会自动合并成一次写盘，
   不再每人一次同步阻塞（这正是卡顿/点不动/登不上的根因）。 */
function save() {
  hasDirty = true;
  if (saveTimer) return;
  saveTimer = setTimeout(() => { saveTimer = null; flushPending(); }, 300);
}

/* 同步兜底：进程退出前把最后 300 毫秒内的改动补写，避免丢失 */
function saveSync() {
  if (!hasDirty) return;
  try {
    pruneSessions();
    const tmp = DATA_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(data), { encoding: 'utf8', mode: 0o600 });
    fs.chmodSync(tmp, 0o600);
    fs.renameSync(tmp, DATA_FILE);
    hasDirty = false;
    console.log('[已保存数据]');
  } catch (e) { console.error('退出前保存失败', e.message); }
}

/* 关窗口 / 被强制结束 / 意外崩溃时，先把数据落盘再退出，防止丢学生记录 */
['SIGINT', 'SIGTERM', 'SIGHUP'].forEach(sig => {
  process.on(sig, () => { saveSync(); process.exit(0); });
});
process.on('exit', () => { if (hasDirty) saveSync(); });
process.on('uncaughtException', e => {
  console.error('[异常]', e && e.message);
  saveSync();
  process.exit(1);
});

function seedIfEmpty() {
  let changed = false;
  if (!data.modules || data.modules.length === 0) {
    const names = ['存货', '固定资产', '交易性金融资产', '负债', '所有者权益', '销售', '费用', '财务报表'];
    data.modules = names.map((n, i) => ({ id: 'M' + (i + 1), name: n, company: '', order: i + 1 }));
    changed = true;
  }
  if (!data.statements || data.statements.length === 0) {
    const m8 = (data.modules.find(m => m.order === 8) || {}).id || 'M8';
    const bal = standardBalance();
    data.statements = [
      { id: 'S_BAL', moduleId: m8, type: 'balance', title: '资产负债表', left: bal.left, right: bal.right },
      { id: 'S_INC', moduleId: m8, type: 'income', title: '利润表', head: standardIncomeHead(), rows: standardIncomeRows() }
    ];
    changed = true;
  }
  // 兼容旧数据：balance 缺 left/right 或 income 缺 rows 时，用标准模板补齐
  (data.statements || []).forEach(s => {
    if (s.type === 'balance' && (!s.left || !s.right)) { const b = standardBalance(); s.left = b.left; s.right = b.right; s.head = b.head; changed = true; }
    if (s.type === 'income') {
      if (!s.rows) { s.rows = standardIncomeRows(); changed = true; }
      if (!s.head || !s.head.length) { s.head = standardIncomeHead(); changed = true; }
    }
  });
  if (migrateStatements()) changed = true;
  if (changed) save();
}

/* 报表结构升级（存量数据原地迁移，已填答案按行名保留）：
   资产负债表 → 补"长期股权投资"行、补表头三要素、补"上年年末余额"列；
   利润表     → 投资收益下方补"信用减值损失/资产减值损失/资产处置收益"，并给营业收入/营业利润/利润总额/净利润加"一、二、三、四"。 */
function migrateStatements() {
  let changed = false;
  (data.statements || []).forEach(s => {
    if (s.type === 'balance') {
      const b = standardBalance();
      if (!s.head || !s.head.length) { s.head = b.head.map(h => Object.assign({}, h)); changed = true; }
      ['left', 'right'].forEach(side => {
        const arr = s[side] || [];
        if (side === 'left' && !arr.some(r => rowKey(r.label) === '长期股权投资')) {
          const idx = arr.findIndex(r => rowKey(r.label) === '固定资产');
          const row = { id: 'bl_new', label: '长期股权投资', answer: null, answerPrev: null };
          if (idx >= 0) arr.splice(idx, 0, row); else arr.splice(8, 0, row);
          changed = true;
        }
        arr.forEach((r, i) => {
          if (r.answerPrev === undefined) { r.answerPrev = null; changed = true; }
          const nid = (side === 'left' ? 'bl' : 'br') + i;
          if (r.id !== nid) { r.id = nid; changed = true; }
        });
      });
    } else if (s.type === 'income') {
      if (!s.head || !s.head.length) { s.head = standardIncomeHead(); changed = true; }
      const rows = s.rows || [];
      if (!rows.some(r => rowKey(r.label) === '资产处置收益')) {
        const map = {};
        rows.forEach(r => { map[rowKey(r.label)] = { answer: r.answer }; });
        s.rows = standardIncomeRows().map(r => {
          const old = map[rowKey(r.label)];
          return Object.assign({}, r, { answer: (old && old.answer != null) ? old.answer : null });
        });
        changed = true;
      } else {
        rows.forEach((r, i) => { if (r.id !== 'i' + i) { r.id = 'i' + i; changed = true; } });
      }
    }
  });
  return changed;
}

/* ---------------- 工具 ---------------- */
function hashPwd(pwd, salt) { return crypto.scryptSync(pwd, salt, 32).toString('hex'); }
function genToken() { return crypto.randomBytes(24).toString('hex'); }
function sidOf(cls, name, stuid) { return (cls + '|' + name + '|' + stuid); }
function norm(s) { return String(s == null ? '' : s).trim().replace(/\s+/g, ''); }
function num(s) { const n = parseFloat(s); return isNaN(n) ? 0 : n; }
/* 日期归一化：只比较"年月日"本身，忽略书写格式差异。
   2025/3/3、2025-3-3、2025.3.3、2025年3月3日、2025年03月03日 全部等价。 */
function normDate(s) {
  let t = String(s == null ? '' : s).trim();
  if (!t) return '';
  t = t.replace(/\s+\d{1,2}:\d{2}(:\d{2})?(\.\d+)?$/, ''); // 去掉" 0:00:00"这类时间后缀（Excel 常见）
  t = norm(t);
  if (!t) return '';
  t = t.replace(/[年月]/g, '-').replace(/[日号]/g, '').replace(/[\/\.\\]/g, '-');
  t = t.replace(/-+/g, '-').replace(/^-|-$/g, '');
  const m = t.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (m) return m[1] + '-' + parseInt(m[2], 10) + '-' + parseInt(m[3], 10);
  return t;
}
function parseAccount(acc) {
  const s = norm(acc);
  if (s.indexOf('—') >= 0) { const p = s.split('—'); return { l1: p[0], l2: p.slice(1).join('—') }; }
  if (s.indexOf('-') >= 0) { const p = s.split('-'); return { l1: p[0], l2: p.slice(1).join('-') }; }
  return { l1: s, l2: '' };
}

/* -------- 摘要模糊判分（保守规则：核心字双向包含）--------
   规则：去掉标点空格与常见虚词后取"核心字"；
        ① 完全一致 → 判对；② 标准答案核心字⊆学生答案核心字 → 判对（学生写得更详细，如"购料"/"购买原材料"）；
        ③ 学生核心字⊆标准答案核心字 → 判对（学生写了简称，如"提取现金"/"提现"）；
        ④ 学生写简称时，至少要覆盖标准答案一半的核心字（防止"缴纳增值税"写成"缴税"也算对）；
        ⑤ 任一方核心字少于 2 个字时，只认完全一致（防止只写一个字也被判对）。
   可调：下面 SUMMARY_SHORT_COVER 是"学生写简称"的覆盖门槛，想更宽松可改成 0.4，想更严改成 0.6。 */
const SUMMARY_SHORT_COVER = 0.4;   // 简写覆盖门槛（0.4 = 允许学生用约4成核心字概括）
/* -------- 摘要同义词表（规范化后匹配）--------
   格式：[标准词, [可接受的同义词列表]]
   判分时先把学生填的摘要里的同义词替换成标准词，再走核心字匹配逻辑。
   需要新增同义词时，直接在下面数组里照格式加一行即可。 */
const SUMMARY_SYNONYMS = [
  ['购买', ['采购', '购进', '买入', '购入']],
  ['销售', ['售出', '卖出', '销货']],
  ['支付', ['缴纳', '付出', '付给', '付款']],
  ['收到', ['收取', '收进', '收款']],
  ['报销', ['报账']],
  ['领用', ['领料', '领']],
  ['结算', ['结清']],
  ['摊销', ['分摊']],
  ['工资', ['薪酬', '薪资', '人工费']],
  ['租金', ['房租', '租赁费']],
  ['运费', ['运输费', '搬运费']],
  ['手续费', ['服务费', '佣金']],
  ['差旅费', ['出差费', '旅差费']],
  ['办公费', ['办公支出']],
  ['广告费', ['宣传费', '推广费']],
  ['商品', ['产品', '货物', '物品']],
  ['费用', ['支出', '开支']],
];
function normSummary(text) {
  let s = norm(text);
  for (const [canonical, variants] of SUMMARY_SYNONYMS) {
    const re = new RegExp(variants.join('|'), 'g');
    if (re.test(s)) s = s.replace(re, canonical);
  }
  return s;
}

const SUMMARY_STOP = /[的了和与及为把被从向给对之其一二三四五六七八九十批项元整]/g;
function summaryCore(s) {
  return norm(s)
    .replace(/[\s，。、；：,\.;:!！\?？"'"'（）()\[\]【】·\/\\]/g, '')
    .replace(SUMMARY_STOP, '');
}
function summaryMatch(expected, student) {
  const e = normSummary(expected), s = normSummary(student);
  if (e === '' || s === '') return false;
  if (e === s) return true;
  const ec = summaryCore(e), sc = summaryCore(s);
  if (ec.length < 2 || sc.length < 2) return e === s; // 过短只认完全一致
  const eset = new Set(ec.split('')), sset = new Set(sc.split(''));
  let eInS = true; eset.forEach(c => { if (!sset.has(c)) eInS = false; });
  if (eInS) return true;                    // 学生写得更详细（"购料"→"购买原材料"）
  let sInE = true; sset.forEach(c => { if (!eset.has(c)) sInE = false; });
  if (!sInE) return false;                  // 学生写了无关内容
  // 学生写的是简称（"提取现金"→"提现"）：要求至少覆盖标准答案一半的核心字，
  // 否则过于简略（如"缴纳增值税"→"缴税"只覆盖 2/5）仍判错。
  let hit = 0; eset.forEach(c => { if (sset.has(c)) hit++; });
  return hit / eset.size >= SUMMARY_SHORT_COVER;
}

/* -------- 科目简称对照（明细科目常用简称，如"工行"="工商银行"）--------
   需要新增简称时，直接在下面数组里照格式加一行即可。 */
const ACCOUNT_ALIASES = [
  ['中国工商银行', ['中国工商银行', '工商银行', '工行']],
  ['中国建设银行', ['中国建设银行', '建设银行', '建行']],
  ['中国农业银行', ['中国农业银行', '农业银行', '农行']],
  ['中国银行', ['中国银行', '中行']],
  ['交通银行', ['交通银行', '交行']],
  ['招商银行', ['招商银行', '招行']],
  ['中国邮政储蓄银行', ['中国邮政储蓄银行', '邮政储蓄银行', '邮储银行', '邮储']],
  ['中信银行', ['中信银行', '中信']],
  ['中国光大银行', ['中国光大银行', '光大银行', '光大']],
  ['中国民生银行', ['中国民生银行', '民生银行', '民生']],
  ['上海浦东发展银行', ['上海浦东发展银行', '浦东发展银行', '浦发银行', '浦发']],
  ['兴业银行', ['兴业银行', '兴业']],
  ['华夏银行', ['华夏银行', '华夏']],
  ['平安银行', ['平安银行', '平安']],
  ['广发银行', ['广发银行', '广发']],
  ['浙商银行', ['浙商银行', '浙商']],
  ['渤海银行', ['渤海银行', '渤海']],
  ['恒丰银行', ['恒丰银行', '恒丰']],
  ['北京银行', ['北京银行', '京行']],
  ['上海银行', ['上海银行', '上行']],
  ['农村信用合作社', ['农村信用合作社', '农信社', '信用社']]
];
// 科目规范化：先查简称对照表，再去掉企业组织形式后缀（股份有限公司/有限公司/公司/支行等）
function canonAccount(s) {
  let t = norm(s);
  if (t === '') return '';
  for (let i = 0; i < ACCOUNT_ALIASES.length; i++) {
    const canon = ACCOUNT_ALIASES[i][0], list = ACCOUNT_ALIASES[i][1];
    for (let j = 0; j < list.length; j++) { if (t === norm(list[j])) return norm(canon); }
  }
  t = t.replace(/(股份有限公司|有限责任公司|有限公司|股份公司|集团公司|分公司|营业部|支行|公司)$/, '');
  return t;
}

/* -------- 最小 XLSX 生成（只用 Node 内置模块，不依赖任何第三方库） --------
   说明：xlsx 本质是 zip 包 + 若干 xml，这里手写 zip(存储模式) 与必需的 xml。 */
function crc32(buf) {
  let table = crc32._t;
  if (!table) {
    table = crc32._t = new Int32Array(256);
    for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1); table[n] = c; }
  }
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = (c >>> 8) ^ table[(c ^ buf[i]) & 0xFF];
  return (c ^ -1) >>> 0;
}
function makeZip(files) {
  const parts = [], central = []; let offset = 0;
  files.forEach(f => {
    const nameBuf = Buffer.from(f.name, 'utf8');
    const data = Buffer.isBuffer(f.data) ? f.data : Buffer.from(String(f.data), 'utf8');
    const crc = crc32(data);
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(0, 6);
    lh.writeUInt16LE(0, 8); lh.writeUInt16LE(0, 10); lh.writeUInt16LE(0, 12);
    lh.writeUInt32LE(crc, 14); lh.writeUInt32LE(data.length, 18); lh.writeUInt32LE(data.length, 22);
    lh.writeUInt16LE(nameBuf.length, 26); lh.writeUInt16LE(0, 28);
    parts.push(lh, nameBuf, data);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6);
    ch.writeUInt16LE(0, 8); ch.writeUInt16LE(0, 10); ch.writeUInt16LE(0, 12); ch.writeUInt16LE(0, 14);
    ch.writeUInt32LE(crc, 16); ch.writeUInt32LE(data.length, 20); ch.writeUInt32LE(data.length, 24);
    ch.writeUInt16LE(nameBuf.length, 28); ch.writeUInt16LE(0, 30); ch.writeUInt16LE(0, 32);
    ch.writeUInt16LE(0, 34); ch.writeUInt16LE(0, 36); ch.writeUInt32LE(0, 38); ch.writeUInt32LE(offset, 42);
    central.push(ch, nameBuf);
    offset += 30 + nameBuf.length + data.length;
  });
  const cd = Buffer.concat(central);
  const eo = Buffer.alloc(22);
  eo.writeUInt32LE(0x06054b50, 0); eo.writeUInt16LE(0, 4); eo.writeUInt16LE(0, 6);
  eo.writeUInt16LE(files.length, 8); eo.writeUInt16LE(files.length, 10);
  eo.writeUInt32LE(cd.length, 12); eo.writeUInt32LE(offset, 16); eo.writeUInt16LE(0, 20);
  return Buffer.concat([Buffer.concat(parts), cd, eo]);
}
function colName(n) { let s = ''; while (n > 0) { const m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = Math.floor((n - 1) / 26); } return s; }
function xmlEsc(s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }
// rows: 二维数组；元素可为 字符串 / 数字 / {f:'公式'}（如 {f:'L2+M2'}）
function buildXlsx(rows) {
  let body = '';
  rows.forEach((row, ri) => {
    let cells = '';
    (row || []).forEach((val, ci) => {
      const ref = colName(ci + 1) + (ri + 1);
      if (val && typeof val === 'object' && val.f != null) {
        cells += '<c r="' + ref + '"><f>' + xmlEsc(val.f) + '</f></c>';
      } else if (typeof val === 'number' && isFinite(val)) {
        cells += '<c r="' + ref + '"><v>' + val + '</v></c>';
      } else {
        const t = String(val == null ? '' : val);
        if (t !== '') cells += '<c r="' + ref + '" t="inlineStr"><is><t xml:space="preserve">' + xmlEsc(t) + '</t></is></c>';
      }
    });
    body += '<row r="' + (ri + 1) + '">' + cells + '</row>';
  });
  const files = [
    { name: '[Content_Types].xml', data: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>' },
    { name: '_rels/.rels', data: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>' },
    { name: 'xl/workbook.xml', data: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="学生成绩" sheetId="1" r:id="rId1"/></sheets></workbook>' },
    { name: 'xl/_rels/workbook.xml.rels', data: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>' },
    { name: 'xl/styles.xml', data: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fonts count="1"><font><sz val="11"/><name val="宋体"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/></cellXfs></styleSheet>' },
    { name: 'xl/worksheets/sheet1.xml', data: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>' + body + '</sheetData></worksheet>' }
  ];
  return makeZip(files);
}

/* 标准报表模板：账户式资产负债表（左资产 / 右负债及权益）/ 多步式利润表，参考《企业会计准则》一般企业报表格式 */
function standardBalance() {
  const left = [
    '货币资金', '交易性金融资产', '应收票据', '应收账款', '预付款项', '其他应收款', '存货', '流动资产合计',
    '长期股权投资', '固定资产', '在建工程', '固定资产清理', '无形资产', '长期待摊费用', '非流动资产合计',
    '资产总计'
  ];
  const right = [
    '短期借款', '应付票据', '应付账款', '预收款项', '应付职工薪酬', '应交税费', '其他应付款', '流动负债合计',
    '长期借款', '长期应付款', '非流动负债合计', '负债合计',
    '实收资本（或股本）', '资本公积', '盈余公积', '未分配利润', '所有者权益合计', '负债和所有者权益总计'
  ];
  return {
    // 表头三要素（学生填写，参与计分）：编制单位 / 日期 / 单位
    head: [
      { id: 'bh_org', label: '编制单位', answer: null },
      { id: 'bh_date', label: '日期', answer: null },
      { id: 'bh_unit', label: '单位', answer: null }
    ],
    // answer = 期末余额；answerPrev = 上年年末余额
    left: left.map((label, i) => ({ id: 'bl' + i, label, answer: null, answerPrev: null })),
    right: right.map((label, i) => ({ id: 'br' + i, label, answer: null, answerPrev: null }))
  };
}
/* 利润表表头三要素（与资产负债表一致，学生填写并参与计分） */
function standardIncomeHead() {
  return [
    { id: 'ih_org', label: '编制单位', answer: null },
    { id: 'ih_date', label: '日期', answer: null },
    { id: 'ih_unit', label: '单位', answer: null }
  ];
}
function standardIncomeRows() {
  const labels = [
    '一、营业收入', '减：营业成本', '税金及附加', '销售费用', '管理费用', '财务费用',
    '加：公允价值变动收益', '投资收益', '信用减值损失', '资产减值损失', '资产处置收益',
    '二、营业利润', '加：营业外收入', '减：营业外支出',
    '三、利润总额', '减：所得税费用', '四、净利润'
  ];
  return labels.map((label, i) => ({ id: 'i' + i, label, answer: null }));
}
/* 行项目"识别名"：去掉序号（一、二、）和加减前缀（加：/减：），用于新旧模板对答案时按名称匹配 */
function rowKey(s) { return norm(s).replace(/^[一二三四五六七八九十]+、/, '').replace(/^(加|减)：/, ''); }

/* ---------------- 批改引擎 ---------------- */
// 凭证批改权重（方案A，合计100%）：摘要降为5%，科目升为40%（主科目15%+明细25%，明细更重）
const W = { subject: 0.40, amount: 0.10, direction: 0.10, summary: 0.05, date: 0.10, number: 0.10, attach: 0.10, preparer: 0.05 };
const SUBJ_MAIN = 0.15;   // 主科目（一级科目）占分
const SUBJ_DETAIL = 0.25; // 明细科目占分（更重）；SUBJ_MAIN+SUBJ_DETAIL 须等于 W.subject
function firstNonEmpty(arr) {
  for (let i = 0; i < arr.length; i++) { const x = arr[i]; if (x && norm(x) !== '') return x; }
  return '';
}

function gradeVoucher(expected, sub, stuName) {
  const errors = [];
  if (!expected) return { percent: 0, errors: ['无标准答案'] };
  // 表头（日期忽略书写格式差异；老师未设答案的项目不参与计分，不扣分）
  const headItems = [
    { k: 'date',   label: '日期',     exp: expected.date,        stuVal: sub.date,        ok: normDate(sub.date) !== '' && normDate(sub.date) === normDate(expected.date) },
    { k: 'number', label: '编号',     exp: expected.number,      stuVal: sub.number,      ok: norm(sub.number) !== '' && norm(sub.number) === norm(expected.number) },
    { k: 'attach', label: '附件张数', exp: expected.attachments, stuVal: sub.attachments, ok: String(sub.attachments == null ? '' : sub.attachments).trim() !== '' && num(sub.attachments) === num(expected.attachments) }
  ];
  let headerGot = 0, headerTot = 0;
  headItems.forEach(function (it) {
    if (norm(it.exp) === '') return; // 老师未填标准答案 → 跳过，不计分不扣分
    headerTot += W[it.k];
    if (it.ok) headerGot += W[it.k];
    else errors.push(it.label + '：应为『' + (it.exp === '' ? '空' : it.exp) + '』，你填『' + (it.stuVal === '' || it.stuVal == null ? '空' : it.stuVal) + '』');
  });

  // 制单（sign4）：必须与登录姓名一致且非空，用于识别抄袭同学答案（连制单一起抄）
  const prep = ((sub.signs && sub.signs.sign4) || '').trim();
  const nm = (stuName || '').trim();
  if (nm !== '') {
    headerTot += W.preparer;
    if (prep === '') {
      errors.push('制单：不能为空，应填本人姓名『' + nm + '』');
    } else if (prep !== nm) {
      errors.push('制单：应填本人姓名『' + nm + '』，你填『' + prep + '』（与登录姓名不一致，疑似非本人制单）');
    } else {
      headerGot += W.preparer;
    }
  }

  const exp = expected.entries || [];
  const stu = (sub.entries || []).map(e => {
    const d = num(e.debit), c = num(e.credit);
    return { summary: e.summary, account: e.account, direction: d > 0 ? '借' : (c > 0 ? '贷' : ''), amount: d > 0 ? d : c };
  });
  const n = Math.max(exp.length, stu.length);
  let lineGot = 0, lineTot = 0;
  for (let i = 0; i < n; i++) {
    const e = exp[i], s = stu[i];
    lineTot += (W.subject + W.amount + W.direction);
    if (!e || !s) { errors.push('第' + (i + 1) + '行：缺分录（应' + (e ? '有' : '无') + '）'); continue; }
      // 科目：主科目（一级）与明细科目独立计分（明细更重）
      const ea = parseAccount(e.account), sa = parseAccount(s.account);
      const mainOk = canonAccount(sa.l1) === canonAccount(ea.l1);
      const detailOk = mainOk && (canonAccount(sa.l2) === canonAccount(ea.l2));
      let subjGot = 0;
      if (mainOk) {
        subjGot += SUBJ_MAIN;                 // 一级科目对 → 拿主科目分
        if (detailOk) subjGot += SUBJ_DETAIL; // 明细也对 → 再拿明细分
      }
      // 方向
      const dirOk = s.direction === e.direction;
      // 金额
      const amtOk = Math.abs(s.amount - num(e.amount)) < 0.005;
      lineGot += subjGot + (amtOk ? W.amount : 0) + (dirOk ? W.direction : 0);
      if (!mainOk) errors.push('第' + (i + 1) + '行科目：一级科目错误，整笔分录判定错误，应为『' + (e.account || '') + '』');
      else if (!detailOk) errors.push('第' + (i + 1) + '行科目：明细科目错误（仅扣明细科目分），应为『' + (e.account || '') + '』');
      if (!dirOk) errors.push('第' + (i + 1) + '行方向：应为『' + (e.direction || '') + '』');
      if (!amtOk) errors.push('第' + (i + 1) + '行金额：应为『' + (e.amount || 0) + '』');
  }
  // 凭证级摘要判定：取凭证首行非空摘要，写≥2个汉字即正确，空白才扣分（不再逐行、不比对标准答案）
  const stuSum = firstNonEmpty(stu.map(x => x && x.summary));
  const hanCount = (stuSum.match(/[\u4e00-\u9fa5]/g) || []).length;
  const sumOk = hanCount >= 2;
  if (n > 0) {
    lineTot += W.summary;
    if (sumOk) lineGot += W.summary;
    else errors.push('摘要：应填写至少两个汉字（以凭证首行摘要为准），你填写为『' + (stuSum || '空') + '』');
  }
  const denom = headerTot + lineTot;
  const percent = denom > 0 ? (headerGot + lineGot) / denom * 100 : 0;
  return { percent: Math.round(percent * 10) / 10, errors };
}

function gradeStatement(stmt, sub) {
  const cells = sub && sub.cells ? sub.cells : {};
  let total = 0, got = 0; const errors = [];
  // 表头文本项（编制单位 / 日期 / 单位）：日期忽略书写格式，其余按文本比对
  function checkHead(r) {
    if (!r || r.answer == null || norm(r.answer) === '') return; // 老师未填答案不参与批改
    total++;
    const v = cells[r.id];
    if (v === undefined || norm(v) === '') { errors.push(r.label + '：未填'); return; }
    const isDate = (r.id === 'bh_date' || r.id === 'ih_date');
    const ok = isDate ? (normDate(v) === normDate(r.answer)) : (norm(v) === norm(r.answer));
    if (ok) got++;
    else errors.push(r.label + '：应为『' + r.answer + '』，你填『' + v + '』');
  }
  // 数字项：col 'c' = 期末余额/本期金额（answer）；col 'p' = 上年年末余额（answerPrev）
  function checkNum(r, col, colName) {
    if (!r) return;
    const ans = col === 'p' ? r.answerPrev : r.answer;
    if (ans == null || norm(ans) === '') return; // 老师未填答案不参与批改
    total++;
    const key = col === 'p' ? r.id + '#p' : r.id;
    const v = cells[key];
    if (v === undefined || norm(v) === '') { errors.push(r.label + '（' + colName + '）：未填'); return; }
    if (Math.abs(num(v) - num(ans)) < 0.005) got++;
    else errors.push(r.label + '（' + colName + '）：应为『' + ans + '』，你填『' + v + '』');
  }
  (stmt.head || []).forEach(checkHead);
  if (stmt.type === 'balance') {
    (stmt.left || []).forEach(r => { checkNum(r, 'p', '上年年末余额'); checkNum(r, 'c', '期末余额'); });
    (stmt.right || []).forEach(r => { checkNum(r, 'p', '上年年末余额'); checkNum(r, 'c', '期末余额'); });
  } else {
    (stmt.rows || []).forEach(r => { checkNum(r, 'c', '本期金额'); });
  }
  const percent = total ? got / total * 100 : 0;
  return { percent: Math.round(percent * 10) / 10, errors };
}

function gradeModuleScore(stu, m) {
  const order = m.order;
  const details = {};
  let modSum = 0, modCount = 0;
  if (order === 8) {
    data.statements.filter(s => s.moduleId === m.id).forEach(s => {
      const sub = stu.submissions && stu.submissions['S_' + s.id];
      const g = (sub && sub.locked) ? gradeStatement(s, sub) : { percent: 0, errors: ['未提交'] };
      details['S_' + s.id] = { title: s.title, percent: g.percent, errors: g.errors };
      modSum += g.percent; modCount++;
    });
  } else {
    const ans = data.businesses.filter(b => b.moduleId === m.id); // 顺序即数组顺序
    const vsub = stu.submissions && stu.submissions.vouchers && stu.submissions.vouchers[m.id];
    const stuList = (vsub && vsub.locked) ? (vsub.list || []) : [];
    const n = Math.max(ans.length, stuList.length);
    for (let i = 0; i < n; i++) {
      const e = ans[i], s = stuList[i];
      let g;
      if (!e) g = { percent: 0, errors: ['第' + (i + 1) + '张凭证：无对应标准答案（多余凭证）'] };
      else if (!s) g = { percent: 0, errors: ['第' + (i + 1) + '张凭证：缺失未填'] };
      else g = gradeVoucher(e.expected, s, stu.name);
      // 用学生自己填的"凭证编号"做标题，便于教师按编号对照；学生没填编号时回退为"第N张"
      const vnum = (s && norm(s.number) !== '') ? String(s.number) : ('第' + (i + 1) + '张');
      details['V_' + m.id + '_' + i] = { title: '模块' + order + ' ' + m.name + ' · 凭证编号 ' + vnum, vnum: vnum, percent: g.percent, errors: g.errors };
      modSum += g.percent; modCount++;
    }
  }
  const composite = modCount ? Math.round(modSum / modCount * 10) / 10 : 0; // 本模块综合分 0-100
  return { composite, details };
}

function recomputeWeighted(grades) {
  let weightedSum = 0;
  (grades.moduleScores || []).forEach((ms, i) => {
    if (ms != null) weightedSum += ms * (MODULE_WEIGHTS[i + 1] || 0);
  });
  grades.weighted = Math.round(weightedSum * 10) / 10; // 系统评定加权总分（满分 90）
  grades.overall = grades.weighted;
}

// 批改某学生成绩。moduleId 缺省时批改全部模块；传入时仅批改该模块，
// 其余模块分数保持不变（各模块可分开批改）。
function gradeStudent(stu, moduleId) {
  if (!stu.grades) stu.grades = { details: {}, modules: {}, moduleScores: [], weighted: 0 };
  if (!stu.grades.moduleScores) stu.grades.moduleScores = [];
  if (!stu.grades.modules) stu.grades.modules = {};
  if (!stu.grades.details) stu.grades.details = {};
  const target = moduleId ? data.modules.filter(m => m.id === moduleId) : data.modules;
  target.forEach(m => {
    const r = gradeModuleScore(stu, m);
    const idx = (m.order || 1) - 1;
    stu.grades.moduleScores[idx] = r.composite;
    stu.grades.modules[m.id] = {
      order: m.order, name: m.name, weight: MODULE_WEIGHTS[m.order] || 0,
      composite: r.composite, contribution: Math.round(r.composite * (MODULE_WEIGHTS[m.order] || 0) * 10) / 10
    };
    Object.assign(stu.grades.details, r.details);
  });
  recomputeWeighted(stu.grades);
  return stu.grades;
}

// 把 grades.moduleScores 规范为数组（兼容旧数据：无该字段/对象格式/数组格式）
function normModScores(g) {
  if (!g) return [];
  const raw = g.moduleScores;
  if (Array.isArray(raw)) return raw;
  if (raw && typeof raw === 'object') {
    const idByOrder = {}; data.modules.forEach(m => idByOrder[m.order] = m.id);
    return [1, 2, 3, 4, 5, 6, 7, 8].map(o => (idByOrder[o] != null && raw[idByOrder[o]] != null) ? raw[idByOrder[o]] : '');
  }
  return [];
}

/* ---------------- HTTP 辅助 ---------------- */
function send(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(body);
}
function readBody(req) {
  return new Promise((resolve) => {
    let buf = '', aborted = false;
    req.on('data', c => {
      if (aborted) return;
      buf += c;
      if (buf.length > 8 * 1024 * 1024) {   // 8MB 上限，防止异常大请求拖垮服务
        aborted = true;
        req.destroy();
        resolve({});
      }
    });
    req.on('end', () => {
      if (aborted) return;
      try { resolve(buf ? JSON.parse(buf) : {}); } catch (e) { resolve({}); }
    });
    req.on('error', () => { if (!aborted) resolve({}); });
  });
}
function getToken(req) {
  const h = req.headers['authorization'] || '';
  if (h.startsWith('Bearer ')) return h.slice(7);
  return '';
}
function authTeacher(req) {
  const t = getToken(req);
  const s = data.sessions[t];
  return s && s.role === 'teacher' && Date.now() - (s.ts || 0) <= 3 * 24 * 3600 * 1000 ? s : null;
}
function authStudent(req) {
  const t = getToken(req);
  const s = data.sessions[t];
  return s && s.role === 'student' && Date.now() - (s.ts || 0) <= 3 * 24 * 3600 * 1000 ? s : null;
}

/* ---------------- 路由 ---------------- */
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const p = url.pathname;
  try {
    // 静态前端
    if (req.method === 'GET' && (p === '/' || p === '/index.html')) {
      // 只要 public/index.html 被改动过（mtime 变了）就重新读取，
      // 这样改完页面刷新即可生效，不必重启服务、也不必强刷缓存。
      const ip = path.join(__dirname, 'public', 'index.html');
      try {
        const st = fs.statSync(ip);
        if (INDEX_HTML === null || INDEX_MTIME !== st.mtimeMs) {
          INDEX_HTML = fs.readFileSync(ip);
          INDEX_MTIME = st.mtimeMs;
        }
      } catch (e) { /* 读不到就沿用旧缓存，不影响已打开的页面 */ }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' });
      return res.end(INDEX_HTML);
    }
    if (req.method === 'GET' && p.startsWith('/public/')) {
      try {
        const f = fs.readFileSync(path.join(__dirname, p));
        res.writeHead(200); return res.end(f);
      } catch (e) { return send(res, 404, { error: 'not found' }); }
    }

    if (!p.startsWith('/api/')) return send(res, 404, { error: 'not found' });

    const body = (req.method === 'POST' || req.method === 'PUT') ? await readBody(req) : {};

    /* ---- 老师：登录。账号只能在服务器终端初始化。 ---- */
    if (p === '/api/teacher/login' && req.method === 'POST') {
      if (!data.teacher) return send(res, 400, { error: '尚未初始化，请先设置手机号与密码' });
      if (body.phone !== data.teacher.phone || data.teacher.hash !== hashPwd(body.password, data.teacher.salt))
        return send(res, 401, { error: '手机号或密码错误' });
      const token = genToken();
      data.sessions[token] = { role: 'teacher', ref: 'teacher', ts: Date.now() };
      save();
      return send(res, 200, { token });
    }

    const tAuth = authTeacher(req);
    if (p.startsWith('/api/teacher/')) {
      if (!tAuth) return send(res, 401, { error: '未登录' });

      if (p === '/api/teacher/me' && req.method === 'GET') return send(res, 200, { phone: data.teacher.phone });

      if (p === '/api/teacher/state' && req.method === 'GET') {
        return send(res, 200, { modules: data.modules, businesses: data.businesses, statements: data.statements });
      }

      if (p === '/api/teacher/module' && req.method === 'POST') {
        if (body.id) {
          const m = data.modules.find(x => x.id === body.id);
          if (m) { m.name = body.name || m.name; m.company = body.company || m.company; m.order = body.order || m.order; }
        } else {
          const id = 'M' + (data.modules.length + 1) + '_' + Date.now().toString(36);
          data.modules.push({ id, name: body.name || '新模块', company: body.company || '', order: data.modules.length + 1 });
        }
        save(); return send(res, 200, { ok: true, modules: data.modules });
      }
      if (p === '/api/teacher/module' && req.method === 'DELETE') {
        data.modules = data.modules.filter(m => m.id !== body.id);
        data.businesses = data.businesses.filter(b => b.moduleId !== body.id);
        save(); return send(res, 200, { ok: true });
      }

      if (p === '/api/teacher/business' && req.method === 'POST') {
        // body: {id?, moduleId, title(选填), expected:{date,number,attachments,entries:[{summary,account,direction,amount}]}}
        if (!body.moduleId) return send(res, 400, { error: '模块必填' });
        if (body.id) {
          const b = data.businesses.find(x => x.id === body.id);
          if (b) { b.moduleId = body.moduleId; b.title = body.title; b.expected = body.expected || b.expected; }
        } else {
          const id = 'B' + Date.now().toString(36);
          data.businesses.push({ id, moduleId: body.moduleId, title: body.title, expected: body.expected || { entries: [] } });
        }
        save(); return send(res, 200, { ok: true, businesses: data.businesses });
      }
      if (p === '/api/teacher/business' && req.method === 'DELETE') {
        data.businesses = data.businesses.filter(b => b.id !== body.id);
        save(); return send(res, 200, { ok: true });
      }
      if (p === '/api/teacher/statement/rows' && req.method === 'POST') {
        // body: {id, left:[labels], right:[labels]}（balance） 或 {id, rows:[labels]}（income）
        const s = data.statements.find(x => x.id === body.id);
        if (!s) return send(res, 404, { error: '报表不存在' });
        if (s.type === 'balance') {
          const keep = (arr, i, extra) => {
            const o = arr[i] || {};
            return Object.assign({ id: '', label: '', answer: (o.answer != null ? o.answer : null), answerPrev: (o.answerPrev != null ? o.answerPrev : null) }, extra);
          };
          s.left = (body.left || []).map((label, i) => keep(s.left, i, { id: 'bl' + i, label }));
          s.right = (body.right || []).map((label, i) => keep(s.right, i, { id: 'br' + i, label }));
        } else {
          s.rows = (body.rows || []).map((label, i) => ({ id: 'i' + i, label, answer: (s.rows[i] && s.rows[i].answer != null) ? s.rows[i].answer : null }));
        }
        save(); return send(res, 200, { ok: true, statements: data.statements });
      }
      if (p === '/api/teacher/statement/answer' && req.method === 'POST') {
        // body: {id, cells:{rowId:value}}
        const s = data.statements.find(x => x.id === body.id);
        if (!s) return send(res, 404, { error: '报表不存在' });
        // cells: {rowId: 期末余额/本期金额, rowId+'#p': 上年年末余额, bh_org/bh_date/bh_unit: 表头三要素}
        const setAns = (arr) => {
          (arr || []).forEach(r => {
            if (!body.cells) return;
            if (body.cells[r.id] !== undefined) r.answer = body.cells[r.id];
            if (body.cells[r.id + '#p'] !== undefined) r.answerPrev = body.cells[r.id + '#p'];
          });
        };
        setAns(s.head); setAns(s.left); setAns(s.right); setAns(s.rows);
        save(); return send(res, 200, { ok: true, statements: data.statements });
      }
      if (p === '/api/teacher/report-template' && req.method === 'POST') {
        // 恢复标准账户式资产负债表 / 多步式利润表行项目（清空已填答案）
        data.statements.forEach(s => {
          if (s.type === 'balance') { const b = standardBalance(); s.head = b.head; s.left = b.left; s.right = b.right; }
          else if (s.type === 'income') { s.head = standardIncomeHead(); s.rows = standardIncomeRows(); }
        });
        save(); return send(res, 200, { ok: true, statements: data.statements });
      }
      if (p === '/api/teacher/grade' && req.method === 'POST') {
        // 支持按模块分开批改：body.moduleId 可选
        const mid = body.moduleId || null;
        if (body.scope === 'all') {
          data.students.forEach(stu => { gradeStudent(stu, mid); });
        } else if (body.studentId) {
          const stu = data.students.find(s => s.sid === body.studentId);
          if (!stu) return send(res, 404, { error: '学生不存在' });
          gradeStudent(stu, mid);
        } else return send(res, 400, { error: 'scope 或 studentId 必填' });
        save(); return send(res, 200, { ok: true });
      }
      if (p === '/api/teacher/publish' && req.method === 'POST') {
        if (body.scope === 'all') data.students.forEach(s => s.published = true);
        else if (body.studentId) { const stu = data.students.find(s => s.sid === body.studentId); if (stu) stu.published = true; }
        else return send(res, 400, { error: 'scope 必填' });
        save(); return send(res, 200, { ok: true });
      }
      if (p === '/api/teacher/unpublish' && req.method === 'POST') {
        if (body.scope === 'all') data.students.forEach(s => s.published = false);
        else if (body.studentId) { const stu = data.students.find(s => s.sid === body.studentId); if (stu) stu.published = false; }
        save(); return send(res, 200, { ok: true });
      }

      if (p === '/api/teacher/students' && req.method === 'GET') {
        const cls = url.searchParams.get('cls');
        const list = data.students
          .filter(s => !cls || s.cls === cls)
          .sort((a, b) => (a.stuid || '').localeCompare(b.stuid || '', 'zh', { numeric: true }))
          .map(s => ({
            sid: s.sid, cls: s.cls, name: s.name, stuid: s.stuid,
            submitted: countSubmitted(s), published: s.published,
            modSubmitted: data.modules.slice().sort((a, b) => (a.order || 0) - (b.order || 0)).map(m => moduleSubmitted(s, m)),
            moduleScores: normModScores(s.grades),
            weighted: s.grades ? s.grades.weighted : null,
            overall: s.grades ? s.grades.overall : null
          }));
        return send(res, 200, { students: list });
      }
      if (p === '/api/teacher/student' && req.method === 'GET') {
        const stu = data.students.find(s => s.sid === url.searchParams.get('sid'));
        if (!stu) return send(res, 404, { error: 'not found' });
        const out = JSON.parse(JSON.stringify(stu));
        if (out.grades) out.grades.moduleScores = normModScores(out.grades);
        out.modSubmitted = data.modules.slice().sort((a, b) => (a.order || 0) - (b.order || 0)).map(m => moduleSubmitted(out, m));
        return send(res, 200, { student: out });
      }
      if (p === '/api/teacher/export' && req.method === 'GET') {
        const cls = url.searchParams.get('cls');
        const idByOrder = {}; const nameByOrder = {};
        data.modules.forEach(m => { idByOrder[m.order] = m.id; nameByOrder[m.order] = m.name; });
        // 导出真正的 Excel(.xlsx)：班级/姓名/学号 + 8个模块分 + 系统加权总分 + 手写心得(留空由教师线下填) + 总评(公式自动相加)
        const header = ['班级', '姓名', '学号']
          .concat([1,2,3,4,5,6,7,8].map(o => '模块' + o + '_' + (nameByOrder[o] || '')))
          .concat(['系统加权总分(满分90)', '手写实验心得(满分10·教师线下填)', '实验报告总评(满分100)']);
        const rows = [header];
        const list = data.students
          .filter(s => !cls || s.cls === cls)
          .sort((a, b) => (a.stuid || '').localeCompare(b.stuid || '', 'zh', { numeric: true }));
        list.forEach((s, i) => {
          const r = i + 2; // 第1行是表头，数据从第2行开始
          const mods = normModScores(s.grades).map(v => (v === '' || v == null) ? '' : Number(v));
          rows.push([s.cls, s.name, s.stuid]
            .concat(mods)
            .concat([
              (s.grades && s.grades.weighted != null) ? Number(s.grades.weighted) : '',
              '',                          // 手写实验心得：留空，教师线下批改后填
              { f: 'L' + r + '+M' + r }    // 实验报告总评 = 系统加权总分 + 手写心得
            ]));
        });
        const buf = buildXlsx(rows);
        const starName = encodeURIComponent((cls ? '成绩_' + cls : '成绩') + '.xlsx');
        res.writeHead(200, {
          'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
          'Content-Disposition': 'attachment; filename="grades.xlsx"; filename*=UTF-8\'\'' + starName,
          'Content-Length': buf.length
        });
        return res.end(buf);
      }
    }

    /* ---- 学生端 ---- */
    if (p === '/api/student/login' && req.method === 'POST') {
      if (!body.cls || !body.name || !body.stuid) return send(res, 400, { error: '班级/姓名/学号必填' });
      const sidv = sidOf(body.cls, body.name, body.stuid);
      let stu = data.students.find(s => s.sid === sidv);
      if (!stu) { stu = { sid: sidv, cls: body.cls, name: body.name, stuid: body.stuid, submissions: {}, grades: null, published: false }; data.students.push(stu); }
      stu.lastIp = req.socket.remoteAddress;
      const token = genToken();
      data.sessions[token] = { role: 'student', ref: sidv, ts: Date.now() };
      save();
      return send(res, 200, { token, student: { cls: stu.cls, name: stu.name, stuid: stu.stuid, published: stu.published } });
    }

    const sAuth = authStudent(req);
    if (p.startsWith('/api/student/')) {
      if (!sAuth) return send(res, 401, { error: '未登录' });
      const stu = data.students.find(s => s.sid === sAuth.ref);
      if (!stu) return send(res, 401, { error: '登录已失效，请重新登录' });
      if (!stu.submissions) stu.submissions = {};   // 兼容旧数据：缺少 submissions 字段时补上，避免提交报错丢数据

      if (p === '/api/student/tasks' && req.method === 'GET') {
        const tasks = data.modules.map(m => {
          if (m.order === 8) {
            return {
              module: m,
              vouchers: null,
              statements: data.statements.filter(s => s.moduleId === m.id).map(s => {
                const base = { id: s.id, title: s.title, type: s.type };
                if (s.type === 'balance') {
                  base.head = s.head ? s.head.map(r => ({ id: r.id, label: r.label })) : [];
                  base.left = s.left.map(r => ({ id: r.id, label: r.label }));
                  base.right = s.right.map(r => ({ id: r.id, label: r.label }));
                } else {
                  // 利润表同样下发表头三要素（编制单位/日期/单位），学生需填写并参与计分
                  base.head = s.head ? s.head.map(r => ({ id: r.id, label: r.label })) : [];
                  base.rows = s.rows.map(r => ({ id: r.id, label: r.label }));
                }
                base.submitted = !!(stu.submissions['S_' + s.id] && stu.submissions['S_' + s.id].locked);
                base.sub = stu.submissions['S_' + s.id] ? { cells: stu.submissions['S_' + s.id].cells } : null;
                return base;
              })
            };
          } else {
            const vsub = stu.submissions && stu.submissions.vouchers && stu.submissions.vouchers[m.id];
            const list = (vsub && vsub.list) || [];
            return {
              module: m,
              statements: null,
              vouchers: {
                locked: !!(vsub && vsub.locked),
                list: list.map(v => ({ date: v.date, number: v.number, attachments: v.attachments, entries: v.entries || [], signs: v.signs || {} }))
              }
            };
          }
        });
        return send(res, 200, { tasks, student: { cls: stu.cls, name: stu.name, stuid: stu.stuid }, published: stu.published, grades: stu.published ? stu.grades : null });
      }

      if (p === '/api/student/vouchers' && req.method === 'POST') {
        // 保存某模块凭证草稿（不锁定）
        const mId = body.moduleId;
        if (!mId) return send(res, 400, { error: 'moduleId 必填' });
        if (!stu.submissions.vouchers) stu.submissions.vouchers = {};
        if (stu.submissions.vouchers[mId] && stu.submissions.vouchers[mId].locked) return send(res, 400, { error: '已提交锁定，不能修改' });
        stu.submissions.vouchers[mId] = { list: body.list || [], locked: false };
        save(); return send(res, 200, { ok: true });
      }
      if (p === '/api/student/vouchers/submit' && req.method === 'POST') {
        // 提交某模块凭证（锁定）
        const mId = body.moduleId;
        if (!mId) return send(res, 400, { error: 'moduleId 必填' });
        if (!stu.submissions.vouchers) stu.submissions.vouchers = {};
        if (stu.submissions.vouchers[mId] && stu.submissions.vouchers[mId].locked) return send(res, 400, { error: '已提交锁定，不能修改' });
        stu.submissions.vouchers[mId] = { list: body.list || [], locked: true, submittedAt: new Date().toISOString() };
        save(); return send(res, 200, { ok: true });
      }
      if (p === '/api/student/submit/statement' && req.method === 'POST') {
        const key = 'S_' + body.statementId;
        if (stu.submissions[key] && stu.submissions[key].locked) return send(res, 400, { error: '已提交锁定，不能修改' });
        stu.submissions[key] = { cells: body.cells || {}, submittedAt: new Date().toISOString(), locked: true };
        save(); return send(res, 200, { ok: true });
      }
      // 学生撤回已提交的模块，解锁以便继续修改（保留已填内容）
      if (p === '/api/student/withdraw' && req.method === 'POST') {
        let found = false;
        if (body.type === 'statement') {
          const key = 'S_' + body.statementId;
          if (stu.submissions[key] && stu.submissions[key].locked) { stu.submissions[key].locked = false; found = true; }
          else return send(res, 400, { error: '该报表尚未提交，无需撤回' });
        } else {
          const mId = body.moduleId;
          if (!mId) return send(res, 400, { error: 'moduleId 必填' });
          if (!stu.submissions.vouchers) stu.submissions.vouchers = {};
          if (stu.submissions.vouchers[mId] && stu.submissions.vouchers[mId].locked) { stu.submissions.vouchers[mId].locked = false; found = true; }
          else return send(res, 400, { error: '该模块尚未提交，无需撤回' });
        }
        if (stu.published) stu.published = false; // 撤回后成绩需重新批改发布
        save(); return send(res, 200, { ok: true });
      }
      if (p === '/api/student/save/draft' && req.method === 'POST') {
        if (body.kind !== 'statement') return send(res, 400, { error: '无效请求' });
        const key = 'S_' + body.id;
        if (stu.submissions[key] && stu.submissions[key].locked) return send(res, 400, { error: '已提交锁定' });
        stu.submissions[key] = { cells: body.cells || {}, locked: false };
        save(); return send(res, 200, { ok: true });
      }
      if (p === '/api/student/result' && req.method === 'GET') {
        if (!stu.published) return send(res, 200, { published: false });
        return send(res, 200, { published: true, grades: stu.grades });
      }
    }

    return send(res, 404, { error: 'not found' });
  } catch (e) {
    console.error('处理出错', e);
    send(res, 500, { error: e.message });
  }
});

function countSubmitted(stu) {
  let c = 0;
  Object.keys(stu.submissions || {}).forEach(k => { if (stu.submissions[k].locked) c++; });
  return c;
}
// 某学生某模块是否已提交并锁定（用于教师端分模块提交状态显示）
function moduleSubmitted(stu, m) {
  if (m.order === 8) {
    const stmts = data.statements.filter(s => s.moduleId === m.id);
    if (!stmts.length) return false;
    return stmts.every(s => { const sub = stu.submissions && stu.submissions['S_' + s.id]; return !!(sub && sub.locked); });
  }
  const vsub = stu.submissions && stu.submissions.vouchers && stu.submissions.vouchers[m.id];
  return !!(vsub && vsub.locked);
}

/* 生产环境端口固定，避免代理指向错误端口。 */
load();
server.on('error', e => {
  console.error('启动失败：', e && e.message);
  process.exitCode = 1;
});
server.listen(PORT, HOST, () => {
  console.log('实训平台已启动: http://' + HOST + ':' + PORT);
  console.log('数据目录: ' + DATA_DIR);
});
