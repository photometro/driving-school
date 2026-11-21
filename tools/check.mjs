import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
const files=['server','public','tests','tools'].flatMap(dir=>readdirSync(new URL('../'+dir+'/',import.meta.url)).filter(x=>/\.(mjs|js)$/.test(x)).map(x=>dir+'/'+x));
for(const file of files){const r=spawnSync(process.execPath,['--check',file],{stdio:'inherit'});if(r.status)process.exit(r.status);}
console.log(`语法检查通过：${files.length} 个 JavaScript 文件。`);
