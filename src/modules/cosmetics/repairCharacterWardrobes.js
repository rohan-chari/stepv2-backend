const {prisma:defaultPrisma}=require('../../db');
const {withWriter,activeKey,slotMap,sameSlots,writeWardrobe}=require('./characterWardrobeState');
// Resumable batches. The projection always wins, including a pre-A null
// unequip. Never use a stored wardrobe to repair public appearance.
async function repairCharacterWardrobes({prisma=defaultPrisma,after=null,limit=200,apply=false}={}) {
 if(!Number.isInteger(limit)||limit<1||limit>200)throw new Error('limit must be 1–200');
 const users=await prisma.user.findMany({where:after?{id:{gt:after}}:{},select:{id:true},orderBy:{id:'asc'},take:limit});
 let mismatches=0,repaired=0;
 for(const {id:userId} of users) {
 const result=await withWriter(userId,[],async(tx,state)=>{
 const key=activeKey(state.equipment),saved=state.wardrobes.find(w=>w.characterKey===key);
 if(!saved||sameSlots(slotMap(saved.items),slotMap(state.equipment)))return {appearanceChanged:false,mismatch:false};
 if(apply){await writeWardrobe(tx,userId,key,saved,state.equipment);await tx.user.update({where:{id:userId},data:{appearanceRevision:{increment:1}}});}
 return {appearanceChanged:apply,mismatch:true};
 },{prisma});if(result.mismatch)mismatches++;if(result.appearanceChanged)repaired++;
 }
 return {usersChecked:users.length,mismatches,repaired,nextCheckpoint:users.length===limit?users.at(-1).id:null};
}
module.exports={repairCharacterWardrobes};
