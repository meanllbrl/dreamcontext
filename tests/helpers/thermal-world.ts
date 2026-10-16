// A fake process table for the thermal governor's tests: `ps` renders it, `taskpolicy -b/-B`
// change a process's pri the way macOS does (31 ↔ 4), `osascript` answers a scripted reading.
import type { MacThermalState } from '../../src/lib/handsfree/mac/contract.js';
import type { ThermalRun } from '../../src/lib/handsfree/mac/thermal.js';

/** The test process's own uid: the governor slows only its own user's processes. */
export const UID = process.getuid?.() ?? 501;
export const NORMAL_PRI = 31;
export const BG_PRI = 4;

export interface FakeProc {
  uid: number;
  pid: number;
  ppid: number;
  pcpu: number;
  pri: number;
  etimeSec: number;
  /** ms epoch of birth (rendered as a C-locale UTC lstart). */
  born: number;
  args: string;
}

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const p2 = (n: number) => String(n).padStart(2, '0');

/** `ps -o lstart` in the C locale with TZ=UTC: `Sat Oct  3 15:35:39 2026`. */
export function lstartOf(ms: number): string {
  const d = new Date(ms);
  return `${DAYS[d.getUTCDay()]} ${MONTHS[d.getUTCMonth()]} ${String(d.getUTCDate()).padStart(2, ' ')} ${p2(d.getUTCHours())}:${p2(d.getUTCMinutes())}:${p2(d.getUTCSeconds())} ${d.getUTCFullYear()}`;
}

export function etimeOf(sec: number): string {
  const d = Math.floor(sec / 86400); const h = Math.floor((sec % 86400) / 3600); const m = Math.floor((sec % 3600) / 60); const s = sec % 60;
  return `${d ? `${d}-` : ''}${d || h ? `${p2(h)}:` : ''}${p2(m)}:${p2(s)}`;
}

export function psLine(p: FakeProc): string {
  return `  ${p.uid} ${String(p.pid).padStart(5)} ${String(p.ppid).padStart(5)} ${String(p.pid).padStart(5)} ${p.pcpu.toFixed(1).padStart(5)} ${String(p.pri).padStart(3)} ${etimeOf(p.etimeSec).padStart(11)} ${lstartOf(p.born)}     ${p.args}`;
}

export const T0 = Date.UTC(2026, 9, 17, 10, 0, 0);

export class World {
  procs = new Map<number, FakeProc>();
  calls: string[] = [];
  thermal: Array<MacThermalState | null> = [];
  /** The reading once the scripted sequence is used up. */
  steady: MacThermalState | null = 'nominal';
  psFails = false;
  clock = T0 + 60_000;
  /** Runs before a taskpolicy call is answered (fork a child mid-release, slow it down, …). */
  onTaskpolicy?: (flag: string, pid: number) => void | Promise<void>;

  add(p: Partial<FakeProc> & { pid: number }): FakeProc {
    const proc: FakeProc = { uid: UID, ppid: 1, pcpu: 80, pri: NORMAL_PRI, etimeSec: 120, born: T0, args: '/usr/local/bin/node burn.js', ...p };
    this.procs.set(proc.pid, proc);
    return proc;
  }

  count(prefix: string): number { return this.calls.filter((c) => c.startsWith(prefix)).length; }

  run: ThermalRun = async (file, args) => {
    const line = [file, ...args].join(' ');
    this.calls.push(line);
    if (file.endsWith('osascript')) {
      const s = this.thermal.length ? this.thermal.shift()! : this.steady;
      return s === null ? { code: 1, stdout: '' } : { code: 0, stdout: `${['nominal', 'fair', 'serious', 'critical'].indexOf(s)}\n` };
    }
    if (file.endsWith('/ps')) {
      if (this.psFails) return { code: 1, stdout: '' };
      return { code: 0, stdout: [...this.procs.values()].map(psLine).join('\n') + '\n' };
    }
    if (file.endsWith('taskpolicy')) {
      const pid = Number(args[2]);
      await this.onTaskpolicy?.(args[0], pid);
      const p = this.procs.get(pid);
      if (!p) return { code: 70, stdout: '' };
      p.pri = args[0] === '-b' ? BG_PRI : NORMAL_PRI;
      return { code: 0, stdout: '' };
    }
    return { code: 1, stdout: '' };
  };

  readThermal = async (): Promise<MacThermalState | null> => {
    this.calls.push('read');
    return this.thermal.length ? this.thermal.shift()! : this.steady;
  };
}
