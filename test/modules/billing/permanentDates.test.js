const {it}=require('node:test');const assert=require('node:assert/strict');
const {boundaryAt}=require('../../../src/modules/billing/models/permanentState');
it('clamps UTC month-end anniversaries against the original day, including leap years',()=>{
 const anchor=new Date('2023-08-31T18:42:51.123Z');
 assert.equal(boundaryAt(anchor,1).toISOString(),'2023-09-30T18:42:51.123Z');
 assert.equal(boundaryAt(anchor,2).toISOString(),'2023-10-31T18:42:51.123Z');
 assert.equal(boundaryAt(anchor,6).toISOString(),'2024-02-29T18:42:51.123Z');
 assert.equal(boundaryAt(anchor,18).toISOString(),'2025-02-28T18:42:51.123Z');
});
