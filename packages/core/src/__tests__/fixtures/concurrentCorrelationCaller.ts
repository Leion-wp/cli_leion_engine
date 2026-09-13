import * as fs from 'fs';
import * as cp from 'child_process';
import { RunSupervisorService } from '../../services/runSupervisorService';

const [workspaceRoot, correlationId, readyPath, barrierPath, spawnLogPath] = process.argv.slice(2);
fs.writeFileSync(readyPath, String(process.pid), 'utf8');
while (!fs.existsSync(barrierPath)) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
}

const supervisor = new RunSupervisorService(workspaceRoot, {
    spawn: ((..._args: any[]) => {
        fs.appendFileSync(spawnLogPath, `${process.pid}\n`, 'utf8');
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 300);
        return {
            pid: process.pid,
            unref() { /* test double */ }
        } as cp.ChildProcess;
    }) as typeof cp.spawn
});

const result = supervisor.start_detached({
    pipeline: 'demo',
    dryRun: true,
    correlationId
});
process.stdout.write(JSON.stringify(result));