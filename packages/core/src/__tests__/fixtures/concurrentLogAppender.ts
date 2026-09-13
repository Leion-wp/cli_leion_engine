import * as fs from 'fs';
import { appendEventRecord } from '../../services/runSupervisorService';

const [eventPath, runId, prefix, readyPath, barrierPath, countRaw] = process.argv.slice(2);
const count = Number(countRaw);

fs.writeFileSync(readyPath, String(process.pid), 'utf8');
while (!fs.existsSync(barrierPath)) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
}

for (let index = 0; index < count; index += 1) {
    appendEventRecord(eventPath, {
        eventVersion: 1,
        ts: 1_700_000_000_000 + index,
        runId,
        type: 'pipelineStep',
        payload: { nodeId: `${prefix}-${index}`, index, success: true }
    });
}
