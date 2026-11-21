import { createApplication } from './app.mjs';
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
const app=createApplication();
const port=Number(process.env.PORT||3210);
const url=`http://127.0.0.1:${port}`;
app.server.listen(port,'127.0.0.1',()=>{
  mkdirSync(new URL('../work/',import.meta.url),{recursive:true});
  writeFileSync(new URL('../work/server.pid',import.meta.url),String(process.pid));
  console.log(`启程驾校已启动：${url}\n数据文件：${new URL('../data/driving-school.sqlite',import.meta.url).pathname}\n按 Ctrl+C 停止服务。`);
  if(process.env.OPEN_BROWSER==='1'&&process.platform==='win32')spawn('rundll32.exe',['url.dll,FileProtocolHandler',url],{windowsHide:true,stdio:'ignore'}).unref();
});
app.server.on('error',async error=>{
  if(error.code==='EADDRINUSE'){
    try {const health=await fetch(url+'/api/health').then(r=>r.json());if(health.name==='启程驾校'){console.log('系统已经在运行：'+url);if(process.env.OPEN_BROWSER==='1'&&process.platform==='win32')spawn('rundll32.exe',['url.dll,FileProtocolHandler',url],{windowsHide:true,stdio:'ignore'}).unref();app.db.close();process.exit(0);}}catch{}
    console.error(`端口 ${port} 被其他服务占用。可在命令行设置 PORT 后重新启动。`);
  }else console.error(error.message);
  app.db.close();process.exit(1);
});
for(const signal of ['SIGINT','SIGTERM'])process.on(signal,async()=>{await app.close();process.exit(0);});
