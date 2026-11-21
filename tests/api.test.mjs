import test from 'node:test';
import assert from 'node:assert/strict';
import { createApplication } from '../server/app.mjs';
import { day, now } from '../server/database.mjs';
import { mkdirSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

test('驾校系统：权限、数据持久化与教学业务闭环',async t=>{
  const directory=fileURLToPath(new URL('../work/test-database/',import.meta.url));
  mkdirSync(directory,{recursive:true});
  const file=directory+'integration.sqlite';
  rmSync(file,{force:true});rmSync(file+'-wal',{force:true});rmSync(file+'-shm',{force:true});
  let app=createApplication({databasePath:file});
  await new Promise(r=>app.server.listen(0,'127.0.0.1',r));
  let base=`http://127.0.0.1:${app.server.address().port}/api/`;
  const call=async(path,method='GET',body,cookie='',extra={})=>{
    const response=await fetch(base+path,{method,headers:{...(method!=='GET'?{'Content-Type':'application/json','X-Requested-With':'DrivingSchool'}:{}),...(cookie?{Cookie:cookie}:{}),...extra},...(body?{body:JSON.stringify(body)}:{})});
    return {status:response.status,body:await response.json(),cookie:response.headers.get('set-cookie')?.split(';')[0]};
  };
  const login=async(username,pw)=>{const r=await call('login','POST',{username,password:pw});assert.equal(r.status,200,JSON.stringify(r.body));return r.cookie;};
  const examInfo=(subject_id,exam_date=day())=>({subject_id,exam_date,exam_time:'09:00',location:'测试交管考场',booking_reference:'TEST-EXTERNAL-001'});
  let admin,student,lin,zhou,newStudentId,newStudentCookie,exam1,exam2,newSchedule,secondSchedule,bookingId;
  const req=(path,method,body,cookie=admin)=>call(path,method,body,cookie);
  const ok=async(p,m,b,c)=>{const r=await req(p,m,b,c);assert.ok(r.status<300,`${p}: ${JSON.stringify(r.body)}`);return r.body;};
  try {
    await t.test('未登录和错误密码不可访问；两个角色可登录',async()=>{
      assert.equal((await call('state')).status,401);
      assert.equal((await call('login','POST',{username:'admin',password:'bad'})).status,401);
      admin=await login('admin','Admin2026!');student=await login('student','Drive2026!');lin=await login('lin','Drive2026!');zhou=await login('zhou','Drive2026!');
    });
    await t.test('学员只读自己的记录，不能录入学时、创建排班或查看他人预约',async()=>{
      const s=await ok('state','GET',null,student);assert.equal(s.students.length,1);assert.ok(s.hours.every(h=>h.student_id===2));assert.ok(s.exams.every(e=>e.student_id===2));assert.equal(s.logs.length,0);assert.equal(s.user.password_hash,undefined);
      assert.equal((await req('hours','POST',{},student)).status,403);
      assert.equal((await req('schedules','POST',{},student)).status,403);
      assert.equal((await req('bookings/1','PATCH',{status:'cancelled'},lin)).status,403);
    });
    await t.test('跨来源的写入请求会被拒绝',async()=>{
      assert.equal((await req('logout','POST',{},student,)).status,200);
      student=await login('student','Drive2026!');
      const r=await call('hours','POST',{},admin,{Origin:'https://foreign.example'});assert.equal(r.status,403);
    });
    await t.test('新增学员、账号唯一和教练车型匹配',async()=>{
      const body={username:'journey_test',password:'Test2026!',name:'流程测试学员',phone:'13800009901',license:'C1',coach_id:1};
      newStudentId=(await ok('students','POST',body)).id;
      assert.equal((await req('students','POST',body)).status,400);
      assert.equal((await req('students','POST',{...body,username:'mismatch',coach_id:2})).status,400);
      newStudentCookie=await login('journey_test','Test2026!');
    });
    await t.test('学时分钟、未来日期、每日上限均在后端校验',async()=>{
      const baseBody={student_id:newStudentId,subject_id:1,minutes:720,date:day(-4),note:'科目一理论学习'};
      assert.equal((await req('hours','POST',{...baseBody,minutes:0})).status,400);
      assert.equal((await req('hours','POST',{...baseBody,minutes:1.5})).status,400);
      assert.equal((await req('hours','POST',{...baseBody,date:day(1)})).status,400);
      assert.equal((await req('hours','POST',{...baseBody,date:'2026-13-01'})).status,400);
      assert.equal((await req('hours','POST',{...baseBody,date:'2026-02-30'})).status,400);
      await ok('hours','POST',baseBody);
      assert.equal((await req('hours','POST',{...baseBody,minutes:721})).status,400);
      assert.equal((await req('exams','POST',examInfo(2,day(1)),newStudentCookie)).status,400);
    });
    await t.test('科目一：登记外部通知→核对→同步外部成绩→通过',async()=>{
      await ok('exams','POST',examInfo(1,day()),newStudentCookie);
      let s=await ok('state');exam1=s.exams.find(e=>e.student_id===newStudentId&&e.subject_id===1).id;
      assert.equal((await req('exams','POST',examInfo(1,day()),newStudentCookie)).status,400);
      await ok('exams/'+exam1,'PATCH',{action:'verify'});
      await ok('exams/'+exam1,'PATCH',{action:'record-result',score:95,result_source:'交管考试结果通知（测试）'});
      s=await ok('state','GET',null,newStudentCookie);assert.equal(s.exams.find(e=>e.id===exam1).status,'passed');
    });
    await t.test('科目二差一分钟不能申请；达标后申请，并阻止破坏资格的学时作废',async()=>{
      const h={student_id:newStudentId,subject_id:2,date:day(-3),note:'场地训练',minutes:959};await ok('hours','POST',h);
      assert.equal((await req('exams','POST',examInfo(2,day()),newStudentCookie)).status,400);
      await ok('hours','POST',{...h,minutes:1});
      await ok('exams','POST',examInfo(2,day()),newStudentCookie);
      const s=await ok('state');exam2=s.exams.find(e=>e.student_id===newStudentId&&e.subject_id===2).id;
      const record=s.hours.find(h=>h.student_id===newStudentId&&h.subject_id===2&&h.minutes===1);
      assert.equal((await req('hours/'+record.id,'DELETE',{reason:'测试资格保护'})).status,400);
    });
    await t.test('未通过允许重考，通过后不可重复申请',async()=>{
      await ok('exams/'+exam2,'PATCH',{action:'verify'});
      await ok('exams/'+exam2,'PATCH',{action:'record-result',score:79,result_source:'交管考试结果通知（测试）'});
      let s=await ok('state');assert.equal(s.exams.find(e=>e.id===exam2).status,'failed');
      await ok('exams','POST',examInfo(2,day()),newStudentCookie);
      s=await ok('state');exam2=s.exams.find(e=>e.student_id===newStudentId&&e.subject_id===2&&e.status==='pending').id;
      await ok('exams/'+exam2,'PATCH',{action:'verify'});
      await ok('exams/'+exam2,'PATCH',{action:'record-result',score:88,result_source:'交管考试结果通知（测试）'});
      assert.equal((await req('exams','POST',examInfo(2,day()),newStudentCookie)).status,400);
    });
    await t.test('外部考试信息完整性、权限和禁止管理员改期',async()=>{
      assert.equal((await req('exams','POST',{subject_id:2,exam_date:day(2)},newStudentCookie)).status,400);
      const legacy=(await ok('state')).exams.find(e=>e.student_id===4&&e.status==='pending');
      assert.equal((await req('exams/'+legacy.id,'PATCH',{action:'verify'},zhou)).status,403);
      assert.equal((await req('exams/'+legacy.id,'PATCH',{action:'verify',exam_date:day(5)})).status,400);
      const unchanged=(await ok('state')).exams.find(e=>e.id===legacy.id);assert.equal(unchanged.exam_date,legacy.exam_date);assert.equal(unchanged.status,'pending');
      await ok('exams/'+legacy.id,'PATCH',{action:'verify'});
      assert.equal((await req('exams/'+legacy.id,'PATCH',{action:'record-result',score:95,result_source:'外部结果'})).status,400);
    });
    await t.test('考试日与训练预约双向互斥，撤回不取消外部预约',async()=>{
      await ok('hours','POST',{student_id:2,subject_id:2,minutes:240,date:day(-2),note:'补足场地训练'});
      const conflict=await req('exams','POST',examInfo(2,day(1)),student);assert.equal(conflict.status,400);assert.match(conflict.body.error,/练车/);
      const booking=(await ok('state')).bookings.find(b=>b.student_id===2&&b.status==='booked');await ok('bookings/'+booking.id,'PATCH',{status:'cancelled'},student);
      await ok('exams','POST',examInfo(2,day(1)),student);
      let current=await ok('state');const e=current.exams.find(e=>e.student_id===2&&e.subject_id===2&&e.status==='pending');
      const next=current.schedules.find(s=>s.date===day(1)&&s.coach_id===1&&s.start_time==='10:30');
      const blocked=await req('bookings','POST',{schedule_id:next.id},student);assert.equal(blocked.status,400);assert.match(blocked.body.error,/考试/);
      await ok('exams/'+e.id,'PATCH',{action:'verify'});
      await ok('exams/'+e.id,'PATCH',{action:'cancel'},student);
      current=await ok('state');assert.match(current.exams.find(x=>x.id===e.id).note,/外部预约/);
    });
    await t.test('同步成绩必须记录外部来源',async()=>{
      const e=(await ok('state')).exams.find(x=>x.student_id===newStudentId&&x.subject_id===2&&x.status==='passed');
      assert.equal(e.result_source,'交管考试结果通知（测试）');
      const original=app.db.prepare("INSERT INTO exams(student_id,subject_id,status,desired_date,exam_date,exam_time,location,booking_reference,created_at) VALUES(?,3,'approved',?,?,'09:00','测试交管考场','TEST-003',?)").run(newStudentId,day(),day(),now());
      assert.equal((await req('exams/'+Number(original.lastInsertRowid),'PATCH',{action:'record-result',score:90})).status,400);
    });
    await t.test('排班：教练与车辆冲突、时间及车型检查',async()=>{
      const body={subject_id:2,coach_id:1,vehicle_id:1,date:day(1),start_time:'19:00',end_time:'20:00',capacity:1,location:'晚间训练区'};
      await ok('schedules','POST',body);let s=await ok('state');newSchedule=s.schedules.find(x=>x.date===day(1)&&x.start_time==='19:00').id;
      assert.equal((await req('schedules','POST',{...body,start_time:'19:30',end_time:'20:30'})).status,400);
      assert.equal((await req('schedules','POST',{...body,start_time:'21:00',end_time:'20:00'})).status,400);
      assert.equal((await req('schedules','POST',{...body,coach_id:3,vehicle_id:2,start_time:'21:00',end_time:'22:00'})).status,400);
      await ok('schedules','POST',{...body,coach_id:3,vehicle_id:3});s=await ok('state');secondSchedule=s.schedules.find(x=>x.date===day(1)&&x.start_time==='19:00'&&x.coach_id===3).id;
      assert.equal((await req('vehicles/1','PATCH',{plate:'沪A·JX021',model:'大众 桑塔纳',license:'C1',status:'maintenance'})).status,400);
    });
    await t.test('预约：车型、重复、容量与学员时间冲突',async()=>{
      assert.equal((await req('bookings','POST',{schedule_id:newSchedule},lin)).status,400);
      await ok('bookings','POST',{schedule_id:newSchedule},newStudentCookie);
      assert.equal((await req('bookings','POST',{schedule_id:newSchedule},newStudentCookie)).status,400);
      assert.equal((await req('bookings','POST',{schedule_id:newSchedule},zhou)).status,400);
      assert.equal((await req('bookings','POST',{schedule_id:secondSchedule},newStudentCookie)).status,400);
      const s=await ok('state');bookingId=s.bookings.find(b=>b.student_id===newStudentId&&b.schedule_id===newSchedule).id;
    });
    await t.test('取消后释放名额，取消场次同步取消关联预约',async()=>{
      await ok('bookings/'+bookingId,'PATCH',{status:'cancelled'},newStudentCookie);
      await ok('bookings','POST',{schedule_id:newSchedule},zhou);
      await ok('schedules/'+newSchedule,'PATCH',{status:'cancelled'});
      const s=await ok('state');assert.ok(s.bookings.filter(b=>b.schedule_id===newSchedule).every(b=>b.status==='cancelled'));
      assert.equal((await req('bookings','POST',{schedule_id:newSchedule},newStudentCookie)).status,400);
    });
    await t.test('并发抢一个名额时，恰好一个预约成功',async()=>{
      const r=await Promise.all([req('bookings','POST',{schedule_id:secondSchedule},newStudentCookie),req('bookings','POST',{schedule_id:secondSchedule},zhou)]);
      assert.equal(r.filter(x=>x.status===201).length,1);assert.equal(r.filter(x=>x.status===400).length,1);
    });
    await t.test('训练完成由管理员录入时长，只能计入一次',async()=>{
      const s=(await ok('state')).schedules.find(s=>s.date===day(-1)&&s.coach_id===1);
      const result=app.db.prepare("INSERT INTO bookings(student_id,schedule_id,status,created_at) VALUES(?,?,'booked',?)").run(newStudentId,s.id,now());const bid=Number(result.lastInsertRowid);
      await ok('bookings/'+bid,'PATCH',{status:'completed',minutes:60});
      assert.equal((await req('bookings/'+bid,'PATCH',{status:'completed',minutes:60})).status,400);
      const current=await ok('state');assert.equal(current.hours.filter(h=>h.booking_id===bid).length,1);
      const record=current.hours.find(h=>h.booking_id===bid);await ok('hours/'+record.id,'DELETE',{reason:'重复登记纠正'});
      assert.equal((await ok('state')).hours.find(h=>h.id===record.id).status,'void');
    });
    await t.test('规则配置、新增教学资源、审计日志可读回',async()=>{
      await ok('subjects/4','PATCH',{required_minutes:660,pass_score:90});
      await ok('coaches','POST',{name:'测试教练',phone:'13800009903',license:'C1',experience:3,status:'active',description:'测试用'});
      await ok('vehicles','POST',{plate:'沪T·TEST1',model:'测试教学车',license:'C1',status:'active'});
      const s=await ok('state');assert.equal(s.subjects[3].required_minutes,660);assert.ok(s.coaches.some(c=>c.name==='测试教练'));assert.ok(s.logs.length>10);
    });
    await t.test('停用学员使现有会话失效，并取消待处理预约',async()=>{
      const s=(await ok('state')).students.find(s=>s.id===newStudentId);
      await ok('students/'+s.id,'PATCH',{name:s.name,phone:s.phone,coach_id:1,status:'inactive'});
      assert.equal((await req('state','GET',null,newStudentCookie)).status,401);
      assert.equal((await call('login','POST',{username:'journey_test',password:'Test2026!'})).status,401);
    });
    await t.test('关闭并重启后保留数据库记录',async()=>{
      await app.close();app=createApplication({databasePath:file});await new Promise(r=>app.server.listen(0,'127.0.0.1',r));base=`http://127.0.0.1:${app.server.address().port}/api/`;
      admin=await login('admin','Admin2026!');const s=await ok('state');assert.ok(s.students.some(u=>u.id===newStudentId&&u.status==='inactive'));assert.equal(s.subjects[3].required_minutes,660);
    });
    await t.test('个人资料更新与错误原密码处理',async()=>{
      const profile=(await ok('state')).user;
      assert.equal((await req('profile','PATCH',{name:profile.name,phone:profile.phone,old_password:'wrong',new_password:'Changed2026!'})).status,400);
      await ok('profile','PATCH',{name:profile.name,phone:profile.phone});
      const cookie=await login('admin','Admin2026!');assert.ok(cookie);
    });
    await t.test('静态页面、脚本、样式正常响应且无路径越界',async()=>{
      const origin=base.replace(/api\/$/,'');for(const path of ['','app.js','styles.css','favicon.svg'])assert.equal((await fetch(origin+path)).status,200);
      assert.equal((await fetch(origin+'server/database.mjs')).status,404);
      const r=await fetch(origin+'app.js');assert.match(r.headers.get('content-security-policy'),/default-src 'self'/);
    });
  } finally {await app.close();}
});
