const { prisma: defaultPrisma } = require("../../db");
const { findConflictingEquipment } = require("./accessoryCompatibility");

// Deterministic legacy repair policy: newest equipment wins, then the UUID is
// a stable tie-breaker. Walk newest-to-oldest and keep an item only when it is
// compatible with every already-kept (therefore newer) item.
function partitionCompatibleEquipment(equippedAccessories) {
  const ordered = [...equippedAccessories].sort(
    (a, b) =>
      new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime() ||
      String(a.id).localeCompare(String(b.id))
  );
  const kept = [];
  const removed = [];
  for (const accessory of ordered) {
    if (findConflictingEquipment(accessory.shopItem, kept).length > 0) {
      removed.push(accessory);
    } else {
      kept.push(accessory);
    }
  }
  return { kept, removed };
}

// Bounded operational repair, sharing the same user lock and dual-write
// protocol as all runtime equipment mutations. Dry-run never writes.
async function cleanupAccessoryCompatibility({ prisma = defaultPrisma, apply = false } = {}) {
  const {withWriter,checkpoint,writeWardrobe,outfitState,activeKey,project}=require('./characterWardrobeState');
  const summary={usersChecked:0,conflictingRows:0,removed:0};
  let cursor;
  for (;;) {
    const users=await prisma.user.findMany({where:cursor?{id:{gt:cursor}}:{},select:{id:true},orderBy:{id:'asc'},take:200});
    if(!users.length)break;
    for(const {id:userId} of users) {
      const outcome=await withWriter(userId,[],async(tx,state)=>{
        const {kept,removed}=partitionCompatibleEquipment(state.equipment);
        if(apply&&removed.length){
          await checkpoint(tx,userId,state);
          const key=activeKey(kept);
          await writeWardrobe(tx,userId,key,outfitState(state,key),kept,{force:true});
          await project(tx,userId,state.equipment,kept);
        }
        return {appearanceChanged:apply&&removed.length>0,count:removed.length};
      },{prisma});
      summary.usersChecked++;summary.conflictingRows+=outcome.count;
      if(apply)summary.removed+=outcome.count;
    }
    cursor=users.at(-1).id;
  }
  return summary;
}
module.exports = { partitionCompatibleEquipment, cleanupAccessoryCompatibility };
