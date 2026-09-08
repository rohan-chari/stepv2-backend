const {it}=require('node:test');const assert=require('node:assert/strict');const {Readable}=require('node:stream');
const {readCsv}=require('../../../src/modules/billing/services/transactionExport');
it('parses quoted fields across stream chunks, CRLF, escaped quotes and embedded newline',async()=>{
 const rows=[];for await(const row of readCsv(Readable.from(['a,b\r\n"a','""b","x\ny"\r\n'])))rows.push(row);assert.deepEqual(rows,[['a','b'],['a"b','x\ny']]);
});
it('rejects an unterminated quoted export record',async()=>{await assert.rejects(async()=>{for await(const row of readCsv(Readable.from(['a,b\n"oops'])))void row;},/unterminated/i);});
