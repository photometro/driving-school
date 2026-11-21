import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdirSync,rmSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {openDatabase} from '../server/database.mjs';

test('旧版考试流程升级：保留成绩和学时，不把旧申请伪装成外部预约',()=>{
  const directory=fileURLToPath(new URL('../work/migration-test/',import.meta.url));mkdirSync(directory,{recursive:true});const path=directory+'migration.sqlite';
  for(const suffix of ['','-wal','-shm'])rmSync(path+suffix,{force:true});
  let db=openDatabase(path);const hours=db.prepare('SELECT COUNT(*) AS n FROM hour_records').get().n,passed=db.prepare("SELECT COUNT(*) AS n FROM exams WHERE status='passed'").get().n;
  db.exec("PRAGMA user_version=0;UPDATE exams SET exam_date='',exam_time='',booking_reference='' WHERE status='pending';UPDATE exams SET location='启程第一考场' WHERE status='passed';");
  db.close();db=openDatabase(path);
  assert.equal(db.prepare('PRAGMA user_version').get().user_version,1);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM hour_records').get().n,hours);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM exams WHERE status='passed'").get().n,passed);
  const old=db.prepare("SELECT * FROM exams WHERE student_id=4 AND subject_id=2").get();assert.equal(old.status,'rejected');assert.match(old.note,/重新登记/);assert.equal(old.exam_date,'');
  const result=db.prepare("SELECT * FROM exams WHERE status='passed' LIMIT 1").get();assert.equal(result.result_source,'历史导入');assert.match(result.note,/启程第一考场/);assert.equal(result.location,'历史考场信息待补充');
  const count=db.prepare('SELECT COUNT(*) AS n FROM audit_logs').get().n;db.close();db=openDatabase(path);assert.equal(db.prepare('SELECT COUNT(*) AS n FROM audit_logs').get().n,count);db.close();
});
