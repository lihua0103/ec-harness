import {DatabaseSync} from 'node:sqlite';
import {parentPort,workerData} from 'node:worker_threads';
const db=new DatabaseSync(workerData.path);
db.exec('PRAGMA busy_timeout=5000; BEGIN IMMEDIATE');
parentPort.postMessage('locked');
setTimeout(()=>{db.exec('COMMIT');db.close();parentPort.postMessage('released');},workerData.holdMs);
