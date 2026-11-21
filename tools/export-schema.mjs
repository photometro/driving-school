import { DatabaseSync } from 'node:sqlite';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
const db=new DatabaseSync(fileURLToPath(new URL('../data/driving-school.sqlite',import.meta.url)),{readOnly:true});
const records=db.prepare("SELECT sql FROM sqlite_schema WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' ORDER BY type DESC,name").all();
writeFileSync(new URL('../docs/schema.sql',import.meta.url),'-- 启程驾校 SQLite 数据库结构\nPRAGMA foreign_keys=ON;\n\n'+records.map(r=>r.sql+';').join('\n\n')+'\n');
db.close();console.log('数据库结构已导出至 docs/schema.sql');
