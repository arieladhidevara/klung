import fs from 'node:fs';
import path from 'node:path';
const source = path.resolve('node_modules/@spotify/basic-pitch/model');
const dest = path.resolve('public/model');
if (!fs.existsSync(source)) { console.error('Spotify Basic Pitch model files not found:',source); process.exit(1); }
fs.mkdirSync(dest,{recursive:true});
fs.cpSync(source,dest,{recursive:true,force:true});
const walk = dir => fs.readdirSync(dir,{withFileTypes:true}).flatMap(e => e.isDirectory()?walk(path.join(dir,e.name)):[path.join(dir,e.name)]);
const models = walk(dest).filter(f=>f.endsWith('.json'));
const main = models.find(f=>path.basename(f)==='model.json')||models[0];
if(!main){console.error('No model JSON found');process.exit(1)}
fs.writeFileSync('public/model-path.json',JSON.stringify({path:'/'+path.relative('public',main).replaceAll('\\','/')}));
console.log('Basic Pitch model copied:',main);
