import { DatabaseSync } from 'node:sqlite';
import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export const day = (delta = 0) => new Date(Date.now() + delta * 86400000 + 8 * 3600000).toISOString().slice(0, 10);
export const now = () => new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 19).replace('T', ' ');
export function hashPassword(password) {
  const salt = randomBytes(16).toString('hex');
  return `${salt}:${scryptSync(password, salt, 64).toString('hex')}`;
}
export function checkPassword(password, stored) {
  const [salt, hash] = stored.split(':');
  const value = scryptSync(password, salt, 64);
  return timingSafeEqual(value, Buffer.from(hash, 'hex'));
}

export function openDatabase(filename, seed = true) {
  if (filename !== ':memory:') mkdirSync(dirname(filename), { recursive: true });
  const db = new DatabaseSync(filename);
  db.exec(`PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
    CREATE TABLE IF NOT EXISTS coaches (
      id INTEGER PRIMARY KEY, name TEXT NOT NULL, phone TEXT NOT NULL, license TEXT NOT NULL CHECK(license IN ('C1','C2','C1/C2')),
      experience INTEGER NOT NULL DEFAULT 1, status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','inactive')), description TEXT NOT NULL DEFAULT ''
    );
    CREATE TABLE IF NOT EXISTS vehicles (
      id INTEGER PRIMARY KEY, plate TEXT UNIQUE NOT NULL, model TEXT NOT NULL, license TEXT NOT NULL CHECK(license IN ('C1','C2')),
      status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','maintenance','inactive'))
    );
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY, username TEXT UNIQUE NOT NULL, password_hash TEXT NOT NULL, name TEXT NOT NULL,
      role TEXT NOT NULL CHECK(role IN ('admin','student')), phone TEXT NOT NULL DEFAULT '', license TEXT NOT NULL DEFAULT 'C1' CHECK(license IN ('C1','C2')),
      coach_id INTEGER REFERENCES coaches(id), status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','inactive')), created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS subjects (
      id INTEGER PRIMARY KEY CHECK(id BETWEEN 1 AND 4), name TEXT NOT NULL, subtitle TEXT NOT NULL,
      required_minutes INTEGER NOT NULL CHECK(required_minutes > 0), pass_score INTEGER NOT NULL CHECK(pass_score BETWEEN 1 AND 100)
    );
    CREATE TABLE IF NOT EXISTS schedules (
      id INTEGER PRIMARY KEY, subject_id INTEGER NOT NULL REFERENCES subjects(id) CHECK(subject_id IN (2,3)),
      coach_id INTEGER NOT NULL REFERENCES coaches(id), vehicle_id INTEGER NOT NULL REFERENCES vehicles(id),
      date TEXT NOT NULL, start_time TEXT NOT NULL, end_time TEXT NOT NULL, capacity INTEGER NOT NULL CHECK(capacity BETWEEN 1 AND 8),
      location TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open','cancelled')), created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS bookings (
      id INTEGER PRIMARY KEY, student_id INTEGER NOT NULL REFERENCES users(id), schedule_id INTEGER NOT NULL REFERENCES schedules(id),
      status TEXT NOT NULL DEFAULT 'booked' CHECK(status IN ('booked','completed','cancelled','absent')), created_at TEXT NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS one_active_booking ON bookings(student_id,schedule_id) WHERE status != 'cancelled';
    CREATE TABLE IF NOT EXISTS hour_records (
      id INTEGER PRIMARY KEY, student_id INTEGER NOT NULL REFERENCES users(id), subject_id INTEGER NOT NULL REFERENCES subjects(id),
      minutes INTEGER NOT NULL CHECK(minutes BETWEEN 1 AND 1440), date TEXT NOT NULL, note TEXT NOT NULL, operator_id INTEGER NOT NULL REFERENCES users(id),
      booking_id INTEGER UNIQUE REFERENCES bookings(id), status TEXT NOT NULL DEFAULT 'valid' CHECK(status IN ('valid','void')),
      void_reason TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS exams (
      id INTEGER PRIMARY KEY, student_id INTEGER NOT NULL REFERENCES users(id), subject_id INTEGER NOT NULL REFERENCES subjects(id),
      status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','approved','rejected','passed','failed','cancelled')),
      desired_date TEXT NOT NULL, exam_date TEXT NOT NULL DEFAULT '', location TEXT NOT NULL DEFAULT '', score INTEGER CHECK(score BETWEEN 0 AND 100),
      note TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS one_active_exam ON exams(student_id,subject_id) WHERE status IN ('pending','approved');
    CREATE TABLE IF NOT EXISTS audit_logs (
      id INTEGER PRIMARY KEY, operator_id INTEGER NOT NULL REFERENCES users(id), action TEXT NOT NULL, detail TEXT NOT NULL, created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS sessions ( token_hash TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id), expires_at INTEGER NOT NULL );
  `);
  migrateExamRegistration(db);
  if (seed && !db.prepare('SELECT id FROM users LIMIT 1').get()) seedDatabase(db);
  return db;
}

function migrateExamRegistration(db) {
  if (db.prepare('PRAGMA user_version').get().user_version>=1) return;
  db.exec('BEGIN IMMEDIATE');
  try {
    const columns=new Set(db.prepare('PRAGMA table_info(exams)').all().map(c=>c.name));
    for (const [name,definition] of [
      ['exam_time',"TEXT NOT NULL DEFAULT ''"],['booking_reference',"TEXT NOT NULL DEFAULT ''"],
      ['result_source',"TEXT NOT NULL DEFAULT ''"],['verified_by','INTEGER REFERENCES users(id)'],
      ['verified_at',"TEXT NOT NULL DEFAULT ''"]
    ]) if(!columns.has(name)) db.exec(`ALTER TABLE exams ADD COLUMN ${name} ${definition}`);
    const legacy=db.prepare("SELECT COUNT(*) AS n FROM exams WHERE status IN ('pending','approved')").get().n;
    db.prepare("UPDATE exams SET status='rejected',note=note||' 旧版记录未包含完整外部预约信息，请重新登记交管考场通知。' WHERE status IN ('pending','approved')").run();
    db.prepare("UPDATE exams SET result_source='历史导入',note=note||' 原考场名称：'||location,location='历史考场信息待补充' WHERE location='启程第一考场'").run();
    const operator=db.prepare("SELECT id FROM users WHERE role='admin' ORDER BY id LIMIT 1").get();
    if(operator) db.prepare('INSERT INTO audit_logs(operator_id,action,detail,created_at) VALUES(?,?,?,?)').run(operator.id,'考试登记流程升级',`驾校仅核对外部预约信息；保留 ${legacy} 条旧记录，等待学员重新登记。`,now());
    db.exec('PRAGMA user_version=1; COMMIT');
  }catch(error){db.exec('ROLLBACK');throw error;}
}

function seedDatabase(db) {
  db.exec('BEGIN');
  try {
    const coaches = [
      ['陈远航','13800001001','C1/C2',8,'稳扎稳打，从细节建立驾驶习惯。'],
      ['林晓岚','13800001002','C2',6,'耐心教学，专注自动挡驾驶训练。'],
      ['周志成','13800001003','C1',12,'熟悉考场路线，擅长道路驾驶教学。']
    ];
    for (const c of coaches) db.prepare('INSERT INTO coaches(name,phone,license,experience,description) VALUES(?,?,?,?,?)').run(...c);
    for (const v of [['沪A·JX021','大众 桑塔纳','C1','active'],['沪A·JX036','大众 朗逸','C2','active'],['沪A·JX052','大众 桑塔纳','C1','active'],['沪A·JX068','大众 朗逸','C2','maintenance']])
      db.prepare('INSERT INTO vehicles(plate,model,license,status) VALUES(?,?,?,?)').run(...v);
    const shared = hashPassword('Drive2026!');
    db.prepare('INSERT INTO users(username,password_hash,name,role,phone,created_at) VALUES(?,?,?,?,?,?)').run('admin',hashPassword('Admin2026!'),'教学管理员','admin','13800000000',now());
    const students = [['student','许知夏','13800002001','C1',1],['lin','林清越','13800002002','C2',2],['zhou','周亦然','13800002003','C1',3],['chen','陈予安','13800002004','C1',1],['xu','徐书宁','13800002005','C2',2],['song','宋嘉禾','13800002006','C1',3],['tang','唐映雪','13800002007','C2',2],['lu','陆景行','13800002008','C1',1]];
    for (const s of students) db.prepare("INSERT INTO users(username,password_hash,name,role,phone,license,coach_id,created_at) VALUES(?,?,?,'student',?,?,?,?)").run(s[0],shared,s[1],s[2],s[3],s[4],day(-28)+' 09:00:00');
    for (const s of [[1,'科目一','道路交通安全法律法规',720,90],[2,'科目二','场地驾驶技能',960,80],[3,'科目三','道路驾驶技能',1440,90],[4,'科目四','安全文明驾驶常识',600,90]])
      db.prepare('INSERT INTO subjects VALUES(?,?,?,?,?)').run(...s);
    const hour = (student,subject,minutes,date,note) => db.prepare('INSERT INTO hour_records(student_id,subject_id,minutes,date,note,operator_id,created_at) VALUES(?,?,?,?,?,1,?)').run(student,subject,minutes,date,note,now());
    for (let id=2; id<=9; id++) {
      hour(id,1,id===5?360:720,day(-20),'理论学习记录');
      if (id!==5) db.prepare("INSERT INTO exams(student_id,subject_id,status,desired_date,exam_date,location,score,result_source,created_at) VALUES(?,1,'passed',?,?,'东湖机动车驾驶人考试中心',?,'历史导入（演示数据）',?)").run(id,day(-18),day(-18),92+(id%8),now());
      if (id!==5) hour(id,2,[720,480,960,0,600,360,960,240][id-2],day(-5),'场地训练累计记录');
    }
    db.prepare("INSERT INTO exams(student_id,subject_id,status,desired_date,exam_date,exam_time,location,booking_reference,created_at) VALUES(4,2,'pending',?,?,'09:00','东湖机动车驾驶人考试中心','DEMO-EXAM-1026',?)").run(day(4),day(4),now());
    const periods = [['08:00','10:00'],['10:30','12:30'],['14:00','16:00']];
    for (let d=-1; d<=7; d++) for (let j=0;j<3;j++) {
      const [start,end]=periods[j];
      for (const [coach,vehicle] of [[1,1],[2,2],[3,3]]) db.prepare('INSERT INTO schedules(subject_id,coach_id,vehicle_id,date,start_time,end_time,capacity,location,created_at) VALUES(?,?,?,?,?,?,1,?,?)').run(j===2?3:2,coach,vehicle,day(d),start,end,j===2?'东湖道路训练区':'启程一号训练场',now());
    }
    const booked = db.prepare('SELECT id FROM schedules WHERE date=? AND coach_id=1 AND start_time=?').get(day(1),'08:00');
    db.prepare("INSERT INTO bookings(student_id,schedule_id,created_at) VALUES(2,?,?)").run(booked.id,now());
    db.prepare("INSERT INTO audit_logs(operator_id,action,detail,created_at) VALUES(1,'系统初始化','创建教学资源与演示学员档案',?)").run(now());
    db.exec('COMMIT');
  } catch(e) { db.exec('ROLLBACK'); throw e; }
}
