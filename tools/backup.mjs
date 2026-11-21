import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
const source=fileURLToPath(new URL('../data/driving-school.sqlite',import.meta.url));
if(!existsSync(source)){console.log('尚未创建数据库，请先启动系统。');process.exit(1);}
const directory=fileURLToPath(new URL('../backups/',import.meta.url));mkdirSync(directory,{recursive:true});
const stamp=new Date(Date.now()+8*3600000).toISOString().slice(0,19).replace(/[:T]/g,'-');
const target=directory+'driving-school-'+stamp+'.sqlite';
const db=new DatabaseSync(source);db.prepare('VACUUM INTO ?').run(target);db.close();
console.log('数据库一致性备份已保存：'+target);
