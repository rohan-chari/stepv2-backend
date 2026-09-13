const http=require('node:http');
const {createApp}=require('../../src/app');
const server=http.createServer(createApp({adminAnalyticsObserver:event=>process.send?.({event})}));
server.listen(0,'127.0.0.1',()=>process.send?.({url:`http://127.0.0.1:${server.address().port}`}));
process.on('message',message=>{if(message==='stop')server.close(()=>process.exit(0));});
