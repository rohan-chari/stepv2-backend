require('dotenv').config();
const {prisma}=require('../src/db');
const {repairCharacterWardrobes}=require('../src/modules/cosmetics/repairCharacterWardrobes');
async function main(){
 const apply=process.argv.includes('--apply');
 const db=new URL(process.env.DATABASE_URL);if(apply&&!decodeURIComponent(db.pathname).endsWith('_test'))throw new Error('Apply is restricted to a dedicated *_test database in this preparation command. Production repair requires a separately authorized deployment procedure.');
 const after=process.argv.find(a=>a.startsWith('--after='))?.slice(8)||null;
 console.log(JSON.stringify(await repairCharacterWardrobes({apply,after}),null,2));
}
main().catch(e=>{console.error(e.message);process.exitCode=1;}).finally(()=>prisma.$disconnect());
