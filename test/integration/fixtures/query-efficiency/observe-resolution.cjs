// Observation only; the normal production entrypoint starts the real worker.
const {prisma}=require('../../../../src/db');
prisma.$on('query',event=>{if(process.send)process.send({kind:'query',query:event.query,params:event.params,duration:event.duration});});
