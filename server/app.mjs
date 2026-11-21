import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve, extname, sep } from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { openDatabase, hashPassword, checkPassword, day, now } from './database.mjs';

class HttpError extends Error { constructor(status,message) { super(message); this.status=status; } }
const fail = (message,status=400) => { throw new HttpError(status,message); };
const text = (v,label,max=120) => { if(typeof v!=='string'||!v.trim()||v.trim().length>max) fail(`${label}不能为空，且不能超过 ${max} 个字符`); return v.trim(); };
const num = (v,label,min,max) => { if(!Number.isInteger(v)||v<min||v>max) fail(`${label}必须是 ${min}～${max} 之间的整数`); return v; };
const choice = (v,allowed,label) => { if(!allowed.includes(v)) fail(`${label}无效`); return v; };
const date = v => { const parsed=typeof v==='string'?new Date(v+'T00:00:00Z'):new Date(NaN); if(typeof v!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(v)||!Number.isFinite(parsed.getTime())||parsed.toISOString().slice(0,10)!==v) fail('日期格式无效'); return v; };
const time = v => { if(typeof v!=='string'||!/^([01]\d|2[0-3]):[0-5]\d$/.test(v)) fail('时间格式无效'); return v; };
const phone = v => { if(typeof v!=='string'||!/^1\d{10}$/.test(v)) fail('请输入 11 位手机号码'); return v; };
const password = v => { if(typeof v!=='string'||v.length<8||v.length>72) fail('密码长度应为 8～72 位'); return v; };
const digest = v => createHash('sha256').update(v).digest('hex');
const userFields = 'id,username,name,role,phone,license,coach_id,status,created_at';
const publicRoot = fileURLToPath(new URL('../public/',import.meta.url));
const mime = {'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.svg':'image/svg+xml','.ico':'image/x-icon','.woff2':'font/woff2','.jpg':'image/jpeg','.png':'image/png','.webp':'image/webp'};

export function createApplication({databasePath,seed=true}={}) {
  const db = openDatabase(databasePath || fileURLToPath(new URL('../data/driving-school.sqlite',import.meta.url)),seed);
  const get = (sql,...args) => db.prepare(sql).get(...args);
  const all = (sql,...args) => db.prepare(sql).all(...args);
  const run = (sql,...args) => db.prepare(sql).run(...args);
  const transaction = fn => { db.exec('BEGIN IMMEDIATE'); try {const result=fn();db.exec('COMMIT');return result;} catch(e){db.exec('ROLLBACK');throw e;} };
  const audit = (u,action,detail) => run('INSERT INTO audit_logs(operator_id,action,detail,created_at) VALUES(?,?,?,?)',u.id,action,detail,now());
  const byId = (table,id) => { const row=get(`SELECT * FROM ${table} WHERE id=?`,id); if(!row) fail('记录不存在',404); return row; };
  const admin = u => { if(u.role!=='admin') fail('此操作需要管理员权限',403); };
  const student = id => {const s=byId('users',id);if(s.role!=='student')fail('请选择有效学员');return s;};
  const minutes = (uid,sid) => get("SELECT COALESCE(SUM(minutes),0) AS total FROM hour_records WHERE student_id=? AND subject_id=? AND status='valid'",uid,sid).total;
  const passed = (uid,sid) => !!get("SELECT id FROM exams WHERE student_id=? AND subject_id=? AND status='passed'",uid,sid);
  const eligibility = (uid,sid,excludeId=0) => {
    const subject=byId('subjects',sid), reasons=[];
    if(minutes(uid,sid)<subject.required_minutes) reasons.push(`有效学时尚差 ${((subject.required_minutes-minutes(uid,sid))/60).toFixed(1)} 小时`);
    for(let i=1;i<sid;i++) if(!passed(uid,i)) {reasons.push(`请先通过科目${['','一','二','三'][i]}`);break;}
    if(passed(uid,sid)) reasons.push('该科目已经通过');
    if(get("SELECT id FROM exams WHERE student_id=? AND subject_id=? AND status IN ('pending','approved') AND id!=?",uid,sid,excludeId)) reasons.push('已有待核对或已核对的考试登记');
    return reasons;
  };
  const loginAttempts = new Map();
  const safeUser = u => {const {password_hash,...safe}=u;return safe;};
  const state = u => {
    const isAdmin=u.role==='admin';
    return {user:safeUser(byId('users',u.id)), today:day(), server_time:now(),
      students:all(`SELECT ${userFields} FROM users WHERE role='student'${isAdmin?'':' AND id=?'} ORDER BY id DESC`,...(isAdmin?[]:[u.id])),
      coaches:all('SELECT * FROM coaches ORDER BY id'), vehicles:all('SELECT * FROM vehicles ORDER BY id'), subjects:all('SELECT * FROM subjects ORDER BY id'),
      hours:all(`SELECT h.*,u.name AS operator_name FROM hour_records h JOIN users u ON h.operator_id=u.id ${isAdmin?'':'WHERE h.student_id=?'} ORDER BY h.date DESC,h.id DESC`,...(isAdmin?[]:[u.id])),
      schedules:all(`SELECT s.*, (SELECT COUNT(*) FROM bookings b WHERE b.schedule_id=s.id AND b.status!='cancelled') AS booked_count FROM schedules s ORDER BY s.date,s.start_time,s.id`),
      bookings:all(`SELECT * FROM bookings ${isAdmin?'':'WHERE student_id=?'} ORDER BY id DESC`,...(isAdmin?[]:[u.id])),
      exams:all(`SELECT * FROM exams ${isAdmin?'':'WHERE student_id=?'} ORDER BY id DESC`,...(isAdmin?[]:[u.id])),
      eligibility:isAdmin?{}:Object.fromEntries([1,2,3,4].map(sid=>[sid,eligibility(u.id,sid)])),
      logs:isAdmin?all('SELECT a.*,u.name AS operator_name FROM audit_logs a JOIN users u ON u.id=a.operator_id ORDER BY a.id DESC LIMIT 80'):[]};
  };

  async function handleApi(req,res,url) {
    res.setHeader('Cache-Control','no-store');
    const send = (value,status=200) => {res.writeHead(status,{'Content-Type':'application/json; charset=utf-8'});res.end(JSON.stringify(value));};
    if(req.method==='GET'&&url.pathname==='/api/health') return send({ok:true,name:'启程驾校',time:now()});
    let body={};
    if(!['GET','HEAD'].includes(req.method)) {
      if(req.headers['x-requested-with']!=='DrivingSchool') fail('请求来源校验失败',403);
      if(req.headers.origin) {let origin;try{origin=new URL(req.headers.origin);}catch{fail('请求来源校验失败',403);}if(origin.host!==req.headers.host)fail('请求来源校验失败',403);}
      if(!(req.headers['content-type']||'').startsWith('application/json')) fail('请使用 JSON 请求');
      let raw='';for await (const chunk of req) {raw+=chunk;if(Buffer.byteLength(raw)>65536)fail('请求内容过大',413);}
      try{body=raw?JSON.parse(raw):{};}catch{fail('请求格式无效');}
      if(!body||typeof body!=='object'||Array.isArray(body))fail('请求格式无效');
    }
    if(req.method==='POST'&&url.pathname==='/api/login') {
      const key=(req.socket.remoteAddress||'local')+':'+String(body.username).slice(0,80);
      if(loginAttempts.size>3000)loginAttempts.clear();
      const attempt=loginAttempts.get(key);if(attempt&&attempt.until>Date.now()&&attempt.count>=10)fail('尝试次数过多，请 10 分钟后重试',429);
      const username=text(body.username,'账号',32),pw=text(body.password,'密码',72);
      const u=get('SELECT * FROM users WHERE username=?',username);
      if(!u||!checkPassword(pw,u.password_hash)||u.status!=='active'){
        loginAttempts.set(key,{count:attempt&&attempt.until>Date.now()?attempt.count+1:1,until:Date.now()+600000});
        fail('账号、密码不正确，或账号已停用',401);
      }
      loginAttempts.delete(key);
      const token=randomBytes(32).toString('hex');
      run('DELETE FROM sessions WHERE expires_at<?',Date.now());
      run('INSERT INTO sessions VALUES(?,?,?)',digest(token),u.id,Date.now()+12*3600000);
      res.setHeader('Set-Cookie',`ds_session=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=43200`);
      return send({user:safeUser(u)});
    }
    const cookie=(req.headers.cookie||'').split(';').map(x=>x.trim()).find(x=>x.startsWith('ds_session='))?.slice(11);
    const u=cookie?get(`SELECT u.* FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=? AND s.expires_at>? AND u.status='active'`,digest(cookie),Date.now()):null;
    if(!u)fail('请先登录',401);
    if(req.method==='GET'&&url.pathname==='/api/state')return send(state(u));
    if(req.method==='POST'&&url.pathname==='/api/logout'){
      run('DELETE FROM sessions WHERE token_hash=?',digest(cookie));res.setHeader('Set-Cookie','ds_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0');return send({ok:true});
    }
    const parts=url.pathname.split('/').filter(Boolean), collection=parts[1],id=parts[2]?Number(parts[2]):null;
    if(parts.length>3||(parts[2]&&(!Number.isSafeInteger(id)||id<1)))fail('接口不存在',404);
    if(req.method==='PATCH'&&collection==='profile') {
      const name=text(body.name,'姓名',30),tel=phone(body.phone);
      transaction(()=>{
        if(body.new_password) {if(!checkPassword(String(body.old_password||''),u.password_hash))fail('原密码不正确');run('UPDATE users SET password_hash=? WHERE id=?',hashPassword(password(body.new_password)),u.id);run('DELETE FROM sessions WHERE user_id=? AND token_hash!=?',u.id,digest(cookie));}
        run('UPDATE users SET name=?,phone=? WHERE id=?',name,tel,u.id);audit(u,'更新个人资料',name);
      });return send({ok:true});
    }
    if(collection==='students'){
      admin(u);
      if(req.method==='POST'&&!id){
        const username=text(body.username,'账号',32);if(!/^[a-zA-Z0-9_]{3,32}$/.test(username))fail('账号需为 3～32 位字母、数字或下划线');
        const name=text(body.name,'姓名',30),tel=phone(body.phone),license=choice(body.license,['C1','C2'],'报考车型'),coachId=body.coach_id?num(body.coach_id,'教练',1,999999):null;
        if(coachId){const c=byId('coaches',coachId);if(c.status!=='active'||!c.license.includes(license))fail('教练不可用或教学车型不匹配');}
        const hash=hashPassword(password(body.password));
        const result=transaction(()=>{if(get('SELECT id FROM users WHERE username=?',username))fail('该账号已存在');const r=run("INSERT INTO users(username,password_hash,name,role,phone,license,coach_id,created_at) VALUES(?,?,?,'student',?,?,?,?)",username,hash,name,tel,license,coachId,now());audit(u,'新增学员',name);return r;});return send({id:Number(result.lastInsertRowid)},201);
      }
      if(req.method==='PATCH'&&id){
        const s=student(id),name=text(body.name,'姓名',30),tel=phone(body.phone),status=choice(body.status,['active','inactive'],'账号状态'),coachId=body.coach_id?num(body.coach_id,'教练',1,999999):null;
        if(coachId){const c=byId('coaches',coachId);if(c.status!=='active'||!c.license.includes(s.license))fail('教练不可用或教学车型不匹配');}
        transaction(()=>{run('UPDATE users SET name=?,phone=?,coach_id=?,status=? WHERE id=?',name,tel,coachId,status,id);if(body.password)run('UPDATE users SET password_hash=? WHERE id=?',hashPassword(password(body.password)),id);if(status==='inactive'){run('DELETE FROM sessions WHERE user_id=?',id);run("UPDATE bookings SET status='cancelled' WHERE student_id=? AND status='booked'",id);run("UPDATE exams SET status='cancelled',note='账号停用，申请已取消' WHERE student_id=? AND status IN ('pending','approved')",id);}audit(u,'更新学员',s.name);});return send({ok:true});
      }
    }
    if(['coaches','vehicles'].includes(collection)){
      admin(u);
      if(['POST','PATCH'].includes(req.method)){
        const previous=id?byId(collection,id):null;
        const status=choice(body.status,collection==='coaches'?['active','inactive']:['active','maintenance','inactive'],'资源状态');
        const license=choice(body.license,collection==='coaches'?['C1','C2','C1/C2']:['C1','C2'],'车型');
        if(previous&&(previous.license!==license||status!=='active')&&get(`SELECT id FROM schedules WHERE ${collection==='coaches'?'coach_id':'vehicle_id'}=? AND status='open' AND date||' '||end_time>?`,id,now()))fail('该资源仍有未结束的排班，请先取消相关排班');
        if(previous&&collection==='coaches'&&previous.license!==license&&get("SELECT id FROM users WHERE coach_id=? AND status='active' AND role='student' AND instr(?,license)=0",id,license))fail('该教练仍负责其他车型的学员，请先调整学员分配');
        if(collection==='coaches'){
          const name=text(body.name,'教练姓名',30),tel=phone(body.phone),experience=num(body.experience,'教龄',0,60),description=String(body.description||'').slice(0,240);
          transaction(()=>{if(id)run('UPDATE coaches SET name=?,phone=?,license=?,experience=?,status=?,description=? WHERE id=?',name,tel,license,experience,status,description,id);else run('INSERT INTO coaches(name,phone,license,experience,status,description) VALUES(?,?,?,?,?,?)',name,tel,license,experience,status,description);audit(u,id?'更新教练':'新增教练',name);});
        }else{
          const plate=text(body.plate,'车牌',16),model=text(body.model,'车辆品牌型号',40);
          if(get('SELECT id FROM vehicles WHERE plate=? AND id!=?',plate,id||0))fail('该车牌已存在');
          transaction(()=>{if(id)run('UPDATE vehicles SET plate=?,model=?,license=?,status=? WHERE id=?',plate,model,license,status,id);else run('INSERT INTO vehicles(plate,model,license,status) VALUES(?,?,?,?)',plate,model,license,status);audit(u,id?'更新车辆':'新增车辆',plate);});
        }return send({ok:true},id?200:201);
      }
    }
    if(collection==='schedules'){
      admin(u);
      if(req.method==='POST'&&!id){
        const sid=num(body.subject_id,'训练科目',2,3),cid=num(body.coach_id,'教练',1,999999),vid=num(body.vehicle_id,'车辆',1,999999),d=date(body.date),start=time(body.start_time),end=time(body.end_time),capacity=num(body.capacity,'预约名额',1,8),location=text(body.location,'训练地点',80);
        if(start>=end)fail('结束时间必须晚于开始时间');if(d+' '+start<=now())fail('只能创建未来的训练场次');
        const c=byId('coaches',cid),v=byId('vehicles',vid);if(c.status!=='active'||v.status!=='active')fail('教练或车辆当前不可用');if(!c.license.includes(v.license))fail('教练与车辆的车型不匹配');
        transaction(()=>{if(get("SELECT id FROM schedules WHERE status='open' AND date=? AND (coach_id=? OR vehicle_id=?) AND start_time<? AND end_time>?",d,cid,vid,end,start))fail('该时段的教练或车辆已有排班');run('INSERT INTO schedules(subject_id,coach_id,vehicle_id,date,start_time,end_time,capacity,location,created_at) VALUES(?,?,?,?,?,?,?,?,?)',sid,cid,vid,d,start,end,capacity,location,now());audit(u,'发布训练场次',`${d} ${start} ${c.name} ${v.plate}`);});return send({ok:true},201);
      }
      if(req.method==='PATCH'&&id){const s=byId('schedules',id);if(body.status!=='cancelled')fail('仅支持取消排班');if(s.date+' '+s.start_time<=now())fail('已开始的场次不能取消');if(s.status!=='open')fail('场次已取消');transaction(()=>{run("UPDATE schedules SET status='cancelled' WHERE id=?",id);run("UPDATE bookings SET status='cancelled' WHERE schedule_id=? AND status='booked'",id);audit(u,'取消训练场次',`${s.date} ${s.start_time}`);});return send({ok:true});}
    }
    if(collection==='bookings'){
      if(req.method==='POST'&&!id){
        if(u.role!=='student')fail('请使用学员账号预约',403);
        const sid=num(body.schedule_id,'训练场次',1,999999);
        transaction(()=>{
          const s=byId('schedules',sid),v=byId('vehicles',s.vehicle_id),c=byId('coaches',s.coach_id);
          if(s.status!=='open'||s.date+' '+s.start_time<=now())fail('该场次已开始或已取消');
          if(v.status!=='active'||c.status!=='active')fail('该场次的教学资源不可用');if(v.license!==u.license)fail('训练车型与报考车型不符');
          if(!passed(u.id,1))fail('请先通过科目一，再预约实际驾驶训练');
          if(get("SELECT id FROM exams WHERE student_id=? AND status IN ('pending','approved') AND exam_date=?",u.id,s.date))fail('当天已登记交管考试，请选择其他日期练车');
          if(get("SELECT id FROM bookings WHERE student_id=? AND schedule_id=? AND status!='cancelled'",u.id,sid))fail('你已预约过这个场次');
          if(get("SELECT COUNT(*) AS n FROM bookings WHERE schedule_id=? AND status!='cancelled'",sid).n>=s.capacity)fail('该场次已约满');
          if(get("SELECT b.id FROM bookings b JOIN schedules s ON b.schedule_id=s.id WHERE b.student_id=? AND b.status='booked' AND s.status='open' AND s.date=? AND s.start_time<? AND s.end_time>?",u.id,s.date,s.end_time,s.start_time))fail('你在这个时间段已有练车预约');
          run('INSERT INTO bookings(student_id,schedule_id,created_at) VALUES(?,?,?)',u.id,sid,now());audit(u,'预约练车',`${s.date} ${s.start_time}`);
        });return send({ok:true},201);
      }
      if(req.method==='PATCH'&&id){
        const b=byId('bookings',id),s=byId('schedules',b.schedule_id),status=choice(body.status,['cancelled','completed','absent'],'预约状态');
        if(u.role!=='admin'&&b.student_id!==u.id)fail('无权操作他人的预约',403);if(b.status!=='booked')fail('该预约已处理');
        if(status==='cancelled'){if(s.date+' '+s.start_time<=now())fail('训练已开始，不能取消预约');}
        else{admin(u);if(s.date+' '+s.end_time>now())fail('训练结束后才能登记训练结果');}
        transaction(()=>{run('UPDATE bookings SET status=? WHERE id=?',status,id);if(status==='completed'){
          const duration=Number(s.end_time.slice(0,2))*60+Number(s.end_time.slice(3))-Number(s.start_time.slice(0,2))*60-Number(s.start_time.slice(3));
          const value=num(body.minutes,'有效训练分钟',1,duration);
          if(get("SELECT COALESCE(SUM(minutes),0) AS n FROM hour_records WHERE student_id=? AND date=? AND status='valid'",b.student_id,s.date).n+value>1440)fail('同一学员一天的学时总数不能超过 24 小时');
          run('INSERT INTO hour_records(student_id,subject_id,minutes,date,note,operator_id,booking_id,created_at) VALUES(?,?,?,?,?,?,?,?)',b.student_id,s.subject_id,value,s.date,`预约训练完成：${s.location}`,u.id,id,now());
        }audit(u,'处理练车预约',`预约 #${id} → ${status}`);});return send({ok:true});
      }
    }
    if(collection==='hours'){
      admin(u);
      if(req.method==='POST'&&!id){
        const uid=num(body.student_id,'学员',1,999999),sid=num(body.subject_id,'科目',1,4),value=num(body.minutes,'学时分钟',1,1440),d=date(body.date),note=text(body.note,'学习内容',200);const s=student(uid);
        if(s.status!=='active')fail('该学员账号已停用');if(d>day())fail('不能录入未来日期的学时');
        transaction(()=>{if(get("SELECT COALESCE(SUM(minutes),0) AS n FROM hour_records WHERE student_id=? AND date=? AND status='valid'",uid,d).n+value>1440)fail('同一学员一天的学时总数不能超过 24 小时');run('INSERT INTO hour_records(student_id,subject_id,minutes,date,note,operator_id,created_at) VALUES(?,?,?,?,?,?,?)',uid,sid,value,d,note,u.id,now());audit(u,'录入学时',`${s.name} 科目${sid} ${value}分钟`);});return send({ok:true},201);
      }
      if(req.method==='DELETE'&&id){const h=byId('hour_records',id);if(h.status!=='valid')fail('记录已经作废');const reason=text(body.reason,'作废原因',120);
        transaction(()=>{if(minutes(h.student_id,h.subject_id)-h.minutes<byId('subjects',h.subject_id).required_minutes&&get("SELECT id FROM exams WHERE student_id=? AND subject_id=? AND status IN ('pending','approved')",h.student_id,h.subject_id))fail('作废后将不满足当前考试申请的学时条件，请先处理考试申请');run("UPDATE hour_records SET status='void',void_reason=? WHERE id=?",reason,id);audit(u,'作废学时',`记录 #${id}：${reason}`);});return send({ok:true});}
    }
    if(collection==='exams'){
      if(req.method==='POST'&&!id){
        if(u.role!=='student')fail('请使用学员账号登记考试信息',403);
        const sid=num(body.subject_id,'科目',1,4),d=date(body.exam_date),at=time(body.exam_time),location=text(body.location,'交管考场名称',80),reference=text(body.booking_reference,'预约凭证编号或通知摘要',120);
        if(d<day())fail('考试日期不能早于今天');
        transaction(()=>{
          const reasons=eligibility(u.id,sid);if(reasons.length)fail(reasons.join('；'));
          if(get("SELECT id FROM exams WHERE student_id=? AND status IN ('pending','approved') AND exam_date=?",u.id,d))fail('当天已有考试登记，请先核对已有信息');
          if(get("SELECT b.id FROM bookings b JOIN schedules s ON s.id=b.schedule_id WHERE b.student_id=? AND b.status='booked' AND s.date=?",u.id,d))fail('考试当天已有练车预约，请先调整练车安排');
          run('INSERT INTO exams(student_id,subject_id,desired_date,exam_date,exam_time,location,booking_reference,created_at) VALUES(?,?,?,?,?,?,?,?)',u.id,sid,d,d,at,location,reference,now());
          audit(u,'登记外部考试',`科目${sid}，${d} ${at}，${location}`);
        });return send({ok:true},201);
      }
      if(req.method==='PATCH'&&id){
        const e=byId('exams',id);if(u.role!=='admin'&&e.student_id!==u.id)fail('无权操作他人的考试登记',403);
        const action=choice(body.action,['cancel','verify','return','record-result'],'操作');
        transaction(()=>{
          if(action==='cancel'){if(!['pending','approved'].includes(e.status))fail('该登记已处理');run("UPDATE exams SET status='cancelled',note='已撤回本系统登记，外部预约状态请另行核对' WHERE id=?",id);}
          else{admin(u);
            if(action==='verify'){
              if(e.status!=='pending')fail('仅待核对的登记可以确认');
              if(['exam_date','exam_time','location','booking_reference'].some(key=>Object.hasOwn(body,key)))fail('核对不能修改外部考试安排，请退回由学员更正');
              if(!e.exam_date||!e.exam_time||!e.location||!e.booking_reference)fail('缺少外部预约信息，请退回补充');
              if(student(e.student_id).status!=='active')fail('学员已停用');
              const reasons=eligibility(e.student_id,e.subject_id,id);if(reasons.length)fail(reasons.join('；'));
              run("UPDATE exams SET status='approved',verified_by=?,verified_at=?,note=? WHERE id=?",u.id,now(),String(body.note||'已核对学员提供的外部预约通知').slice(0,200),id);
            }
            if(action==='return'){if(!['pending','approved'].includes(e.status))fail('该登记无法退回');run("UPDATE exams SET status='rejected',note=? WHERE id=?",text(body.note,'需要补充或更正的信息',200),id);}
            if(action==='record-result'){
              if(e.status!=='approved')fail('请先核对外部考试登记');if(e.exam_date>day())fail('考试日期尚未到达');
              const score=num(body.score,'外部考试成绩',0,100),source=text(body.result_source,'外部成绩来源',120),threshold=byId('subjects',e.subject_id).pass_score;
              run('UPDATE exams SET status=?,score=?,result_source=? WHERE id=?',score>=threshold?'passed':'failed',score,source,id);
            }
          }audit(u,action==='record-result'?'登记外部成绩':'核对考试信息',`登记 #${id}：${action}`);
        });return send({ok:true});
      }
    }
    if(collection==='subjects'&&req.method==='PATCH'&&id){admin(u);const s=byId('subjects',id),required=num(body.required_minutes,'要求分钟数',1,60000),score=num(body.pass_score,'通过分数',1,100);
      transaction(()=>{if(required>s.required_minutes&&get("SELECT e.id FROM exams e WHERE e.subject_id=? AND e.status IN ('pending','approved') AND (SELECT COALESCE(SUM(h.minutes),0) FROM hour_records h WHERE h.student_id=e.student_id AND h.subject_id=e.subject_id AND h.status='valid')<?",id,required))fail('修改后有正在处理的考试申请不再达标，请先处理这些申请');run('UPDATE subjects SET required_minutes=?,pass_score=? WHERE id=?',required,score,id);audit(u,'修改科目规则',`${s.name}：${required}分钟，通过线${score}`);});return send({ok:true});}
    fail('接口不存在',404);
  }
  const server=http.createServer(async(req,res)=>{
    res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Referrer-Policy','same-origin');res.setHeader('X-Frame-Options','DENY');
    res.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    try{
      const url=new URL(req.url,'http://localhost');
      if(url.pathname.startsWith('/api/'))return await handleApi(req,res,url);
      if(!['GET','HEAD'].includes(req.method))fail('方法不支持',405);
      const pathname=decodeURIComponent(url.pathname),file=resolve(publicRoot,'.'+(pathname==='/'?'/index.html':pathname));
      if(!file.startsWith(resolve(publicRoot)+sep))fail('文件不存在',404);
      let content;try{content=await readFile(file);}catch{fail('文件不存在',404);}
      res.writeHead(200,{'Content-Type':mime[extname(file)]||'application/octet-stream','Cache-Control':'no-cache'});res.end(req.method==='HEAD'?undefined:content);
    }catch(e){
      let status=e.status||500,message=e.status?e.message:'服务处理失败，请稍后重试';
      if(e.code?.startsWith('ERR_SQLITE_CONSTRAINT')){status=409;message='操作与现有记录冲突，请刷新后重试';}
      if(!e.status)console.error(e);
      if(!res.headersSent)res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});res.end(JSON.stringify({error:message}));
    }
  });
  return {server,db,close:()=>new Promise(resolve=>server.close(()=>{db.close();resolve();}))};
}
